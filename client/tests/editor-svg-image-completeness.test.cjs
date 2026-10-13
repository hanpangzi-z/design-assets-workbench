const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const Module = require('node:module');
const nativeCanvas = require('@napi-rs/canvas');
// The project uses napi canvas; adapt jsdom's optional canvas package boundary
// so this regression exercises real Fabric and real native image decoding on
// Windows without installing a second native canvas implementation.
const originalLoad = Module._load;
let fabric;
let JSDOM;
try {
  Module._load = function(request, parent, isMain) {
    return request === 'canvas' ? nativeCanvas : originalLoad.call(this, request, parent, isMain);
  };
  fabric = require('fabric/node');
  ({ JSDOM } = require('jsdom'));
} finally { Module._load = originalLoad; }

// Run the actual fresh SVG loader through real Fabric's SVG image URL failure
// behavior, plus the complete-image guard with a real SVG DOM.
const editorPath = path.resolve(__dirname, '../src/pages/Editor/index.tsx');
const source = ts.createSourceFile(editorPath, fs.readFileSync(editorPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['loadAiSvgObjects', 'ensureEditableSvgRasterObjectsComplete', 'normalizeSvgObjectRole',
  'parseSvgTextBoundsAttr', 'parseSvgNumberList', 'toFiniteNumber', 'resolveSvgDimension', 'parseSvgDimension', 'isSkippedSvgObjectRole'];
const js = ts.transpileModule([...names.map(name => {
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, name);
  return declaration.getText(source);
}), `module.exports = { ${names.join(',')} };`].join('\n'),
{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function harness(svgText = '', svgLoader = fabric.loadSVGFromString) {
  const dom = new JSDOM('');
  const context = { module: { exports: {} }, console: { log() {}, warn() {}, info() {} },
    DOMParser: dom.window.DOMParser, fabric: { loadSVGFromString: svgLoader },
    normalizePdfRasterRoleForSvgObject: () => {}, flattenSvgObjects: objects => objects,
    groupDecorationSvgObjects: objects => objects,
    parseEditableRasterPageFallbackSvg: () => null,
    loadSvgTextWithUploadCacheBuster: async () => svgText };
  vm.runInNewContext(js, context);
  return { ...context.module.exports, close: () => dom.window.close() };
}

test('real Fabric image URL 404 rejects fresh loading before attaching any source', { timeout: 10000 }, async () => {
  const server = http.createServer((_request, response) => { response.writeHead(404); response.end('missing image'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24">
    <path data-object-role="editable-vector" d="M 0 0 L 20 0 L 20 20 z" />
    <image data-object-role="editable-raster" href="http://127.0.0.1:${port}/missing.png" width="8" height="8" />
  </svg>`;
  const h = harness(svg);
  const attached = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  try {
    console.error = () => {}; // The failure is intentional; assert it instead of printing its native stack.
    console.warn = () => {};
    await assert.rejects(h.loadAiSvgObjects({ getWidth: () => 32, getHeight: () => 24,
      add: object => attached.push(object) }, '/uploads/example.svg', 'example.pdf', () => {}), /Error loading|Cannot read properties of null|图片加载不完整/);
    assert.equal(attached.length, 0);
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
    h.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('a Fabric partial-null SVG result cannot mark the remaining path as a complete editable page', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path data-object-role="editable-vector" d="M 0 0 L 1 1" />'
    + '<image data-object-role="editable-raster" href="missing.png" width="8" height="8" /></svg>';
  const realPath = new fabric.Path('M 0 0 L 1 1');
  realPath._svgObjectRole = 'editable-vector';
  const h = harness(svg, async () => ({ objects: [realPath, null], options: { width: 32, height: 24 } }));
  const attached = [];
  try {
    await assert.rejects(h.loadAiSvgObjects({ getWidth: () => 32, getHeight: () => 24,
      add: object => attached.push(object) }, '/uploads/example.svg', 'example.pdf', () => {}), /图片加载不完整（0\/1）/);
    assert.equal(attached.length, 0);
  } finally { h.close(); }
});

test('editable raster completeness counts rendered SVG instances and ignores defs and clip/mask definitions', () => {
  const h = harness();
  try {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><defs>
      <image data-object-role="editable-raster" id="definition" />
      <clipPath><image data-object-role="editable-raster" /></clipPath></defs>
      <g><image data-object-role="editable-raster" href="rendered.png" /></g>
    </svg>`;
    assert.throws(() => h.ensureEditableSvgRasterObjectsComplete(svg, [new fabric.Path('M 0 0 L 1 1')]), /0\/1/);
    const loadedImage = { type: 'image', _svgObjectRole: 'editable-raster' };
    assert.doesNotThrow(() => h.ensureEditableSvgRasterObjectsComplete(svg, [null, loadedImage]));
    assert.doesNotThrow(() => h.ensureEditableSvgRasterObjectsComplete(svg, [{ type: 'group', getObjects: () => [loadedImage] }]));
    assert.throws(() => h.ensureEditableSvgRasterObjectsComplete('<svg><image></svg>', []), /格式无效/);
  } finally { h.close(); }
});

test('real Fabric empty SVG and defs-only SVG cannot become a successful editable PDF load', async () => {
  for (const body of ['', '<defs><path d="M 0 0 L 20 0 L 20 20 z" /></defs>']) {
    const h = harness(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24">${body}</svg>`);
    const attached = [];
    try {
      await assert.rejects(h.loadAiSvgObjects({ getWidth: () => 32, getHeight: () => 24,
        add: object => attached.push(object) }, '/uploads/empty.svg', 'empty.pdf', () => {},
      { requireEditableObjects: true }), /未解析出对象/);
      assert.equal(attached.length, 0);
    } finally { h.close(); }
  }
});

test('real Fabric SVG whose parsed objects are all mask artifacts fails before attaching any PDF object', async () => {
  const h = harness('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24">'
    + '<path data-object-role="mask-artifact" data-pdf-mask-artifact="true" d="M 0 0 L 20 0 L 20 20 z" /></svg>');
  const attached = [];
  try {
    await assert.rejects(h.loadAiSvgObjects({ getWidth: () => 32, getHeight: () => 24,
      add: object => attached.push(object) }, '/uploads/masks.svg', 'masks.pdf', () => {},
    { requireEditableObjects: true }), /未解析出有效元素/);
    assert.equal(attached.length, 0);
  } finally { h.close(); }
});
