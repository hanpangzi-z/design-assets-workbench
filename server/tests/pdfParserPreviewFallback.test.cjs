const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const { createCanvas } = require('@napi-rs/canvas');

const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/services/parser/pdfParser.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

async function harness(t, resultOverrides = {}, cairoResult = null) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'benlai-pdf-preview-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const storage = { base: directory, parsed: path.join(directory, 'parsed'), thumbnails: path.join(directory, 'thumbnails') };
  await fsp.mkdir(storage.thumbnails);
  const canvas = createCanvas(100, 100);
  const context = canvas.getContext('2d');
  context.fillStyle = '#339955';
  context.fillRect(0, 0, 100, 100);
  const preview = canvas.toBuffer('image/png');
  const file = { id: 1, name: 'complex.pdf', filePath: 'originals/complex.pdf',
    async update(patch) { Object.assign(this, patch); } };
  const state = { layers: [], popplerArgs: [], renders: [], cairoCalls: 0, clientPreviewCalls: 0 };
  const modules = {
    fs, path,
    child_process: {
      execFile(command, args, options, done) {
        state.popplerArgs.push(args);
        fs.writeFileSync(args.at(-1) + '.png', preview);
        setImmediate(() => done(null, '', ''));
      },
      exec() { throw new Error('Unexpected Inkscape fallback'); },
    },
    '../../models': {
      DesignFile: { findByPk: async () => file },
      ParsedLayer: { destroy: async () => { state.layers = []; }, bulkCreate: async rows => { state.layers.push(...rows); } },
    },
    '../../config/storage': { STORAGE: storage },
    '../../utils/logger': { logger: { info() {}, warn() {}, error() {} } },
    '../uploadThumbnailVariants': { warmUploadThumbnailVariants() {} },
    './aiParser': {
      getPdfPageInfos: async () => [{}, {}],
      normalizePdfTextLayers: layers => layers,
      readSvgInfo: () => ({ width: 100, height: 100, elementCount: 5 }),
      checkInkscape: async () => false,
    },
    './svgRoles': { countSvgObjectRoleStats: () => ({ editableVectorCount: 5, decorationVectorCount: 0, editableRasterCount: 0, visualOnlyCount: 0 }) },
    './resolveParserFilePath': { resolveParserFilePath: relative => path.join(directory, relative) },
    './parserExecution': {
      ParserLayerStore: { destroy: async () => { state.layers = []; }, bulkCreate: async rows => { state.layers.push(...rows); } },
      getParserArtifactDirectory: () => undefined,
      getParserOutputDirectory: fileId => path.join(storage.parsed, String(fileId)),
      getParserThumbnailPath: fileId => `thumbnails/${fileId}_thumb.png`,
      getParserLayerTransaction: () => undefined, isIsolatedParser: () => true,
      updateParserFile: (source, patch) => source.update(patch),
    },
    './parserVersions': { PDF_PARSER_VERSION: 77 },
    './pdfEditableRenderSupervisor': {
      async renderPdfEditableIsolated(filePath, pngPath, svgPath, pageNumber, options) {
        state.renders.push(options);
        assert.deepEqual(await fsp.readFile(options.trustedPreviewPath), preview);
        await fsp.writeFile(pngPath, preview);
        await fsp.writeFile(svgPath, '<svg><rect data-object-role="editable-vector" width="50" height="50"/></svg>');
        return { width: 100, height: 100, pageNumber, svgElementCount: 5, svgVisualReliable: false,
          svgVisualDiffRatio: 0.4,
          textLayers: [{ text: 'Original source text', x: 10, y: 10, width: 50, height: 20, fontSize: 12, fillColor: '#222222' }],
          ...resultOverrides };
      },
    },
    './pdfCairoRender': {
      pdfSvgNeedsVisualBacking: require('../dist/services/parser/pdfCairoRender').pdfSvgNeedsVisualBacking,
      async renderPdfCairoEditable(input) {
        state.cairoCalls++;
        assert.equal(input.previewPath.endsWith(`pdf_page_${input.pageNumber}.png`), true);
        assert.equal(input.artifactUrlPrefix, '/uploads/parsed/1');
        if (!cairoResult) throw new Error('Alternate converter unavailable');
        await fsp.writeFile(input.outSvgPath, '<svg><rect data-object-role="editable-vector" width="50" height="50"/></svg>');
        return cairoResult;
      },
    },
    './clientParseAssist': {
      resolveClientParseAssistSnapshot: async snapshot => snapshot,
      async writeClientAssistPreviewToPath() { state.clientPreviewCalls++; throw new Error('The server preview should take priority'); },
    },
    sharp: require('sharp'),
  };
  const api = {};
  vm.runInNewContext(code, { exports: api,
    require(name) { if (!(name in modules)) throw new Error('Unexpected parser import: ' + name); return modules[name]; },
    process: { env: { PDFTOPPM_PATH: 'pdftoppm' }, platform: process.platform, on() {} }, setImmediate,
  }, { filename: 'pdfParser.js' });
  await api.parsePdf(1, { clientAssistSnapshot: { fileType: 'pdf', width: 100, height: 100, textLayers: [] } });
  return { file, state, directory, preview };
}

test('complex two-page PDF preserves faithful page images and stores source text only as metadata', async t => {
  const h = await harness(t);
  const result = h.file.parseResult;
  assert.equal(h.file.parseStatus, 'completed');
  assert.equal(result.editableSvg, false);
  assert.equal(result.vectorLayerCount, 0);
  assert.equal(result.previewLayerCount, 2);
  assert.equal(result.layerCount, 2);
  assert.equal(result.previewOnly, true);
  assert.deepEqual(Array.from(result.previewOnlyPages), [1, 2]);
  assert.equal(result.textMetadataLayerCount, 2);
  assert.equal(result.textOnDemandLayerCount, 0);
  assert.equal(result.textLayersAreMetadata, true);
  assert.equal(result.svgPath, undefined);
  assert.match(result.warning, /原有元素暂不能逐个编辑/);
  for (const page of result.pages) {
    assert.equal(page.previewOnly, true);
    assert.equal(page.svgPath, undefined);
    assert.equal(page.layerCount, 1);
    assert.equal(page.previewLayerCount, 1);
    assert.equal(page.vectorLayerCount, 0);
  }
  assert.equal(h.state.layers.filter(layer => layer.layerType === 'image' && layer.properties.role === 'page-preview').length, 2);
  assert.equal(h.state.layers.filter(layer => layer.layerType === 'text' && layer.properties.role === 'text-metadata'
    && layer.properties.editableAs === 'metadata').length, 2);
  assert.equal(h.state.clientPreviewCalls, 0);
  assert.ok(h.state.popplerArgs.every(args => args.includes('-cropbox')));
  assert.ok(h.state.renders.every(options => options.trustedPreviewPath));
  const savedSvg = await fsp.readFile(path.join(h.directory, 'parsed/1/pdf_page_1.svg'), 'utf8');
  assert.equal(savedSvg.includes('raster page fallback'), false);
  assert.deepEqual(await fsp.readFile(path.join(h.directory, 'parsed/1/pdf_page_1.png')), h.preview);
});

test('verified SVG remains editable rather than degrading normal PDF parsing', async t => {
  const h = await harness(t, { svgVisualReliable: true, svgVisualDiffRatio: 0.01 });
  assert.equal(h.file.parseResult.editableSvg, true);
  assert.equal(h.file.parseResult.vectorLayerCount, 10);
  assert.equal(h.file.parseResult.previewOnly, false);
  assert.equal(h.file.parseResult.textOnDemandLayerCount, 2);
  assert.equal(h.file.parseResult.textMetadataLayerCount, 0);
  assert.equal(h.state.cairoCalls, 0);
  assert.ok(h.file.parseResult.pages.every(page => page.svgPath && !page.previewOnly));
  assert.ok(h.state.layers.every(layer => layer.properties.role === 'source-text'));
});

test('verified Cairo drawing source keeps two pages editable with truthful cross-backend preview diagnostics', async t => {
  const h = await harness(t, {}, { svgElementCount: 5, svgRasterImageCount: 0,
    svgVisualDiffRatio: .11, svgFidelityMethod: 'cairo-source', svgSourceVisualDiffRatio: .002 });
  const result = h.file.parseResult;
  assert.equal(result.editableSvg, true);
  assert.equal(result.previewOnly, false);
  assert.equal(result.explicitVisualBacking, false);
  assert.equal(result.svgVisualDiffRatio, .11);
  assert.equal(result.svgFidelityMethod, 'cairo-source');
  assert.equal(result.svgSourceVisualDiffRatio, .002);
  for (const page of result.pages) {
    assert.equal(page.previewOnly, false);
    assert.equal(page.svgVisualDiffRatio, .11);
    assert.equal(page.svgFidelityMethod, 'cairo-source');
    assert.equal(page.svgSourceVisualDiffRatio, .002);
    assert.equal(page.explicitVisualBacking, false);
    assert.ok(page.svgPath);
  }
});

test('an alternate faithful SVG restores independent objects for every complex PDF page without duplicate text', async t => {
  const h = await harness(t, {}, { svgElementCount: 5, svgRasterImageCount: 1, svgVisualDiffRatio: 0.01 });
  assert.equal(h.file.parseResult.editableSvg, true);
  assert.equal(h.file.parseResult.previewOnly, false);
  assert.equal(h.file.parseResult.vectorLayerCount, 10);
  assert.equal(h.file.parseResult.textMetadataLayerCount, 2);
  assert.equal(h.file.parseResult.textOnDemandLayerCount, 0);
  assert.equal(h.state.cairoCalls, 2);
  for (const page of h.file.parseResult.pages) {
    assert.equal(page.previewOnly, false);
    assert.notEqual(page.svgVisualReliable, false);
    assert.equal(page.svgVisualDiffRatio, 0.01);
    assert.ok(page.svgPath);
  }
  assert.ok(h.state.layers.filter(layer => layer.layerType === 'text').every(layer => layer.properties.role === 'text-metadata'));
});

test('an SVG that omits full-page content does not masquerade as an editable vector page', async t => {
  const h = await harness(t, { svgVisualReliable: true, svgOmitsFullPageRaster: true });
  assert.equal(h.file.parseResult.editableSvg, false);
  assert.equal(h.file.parseResult.vectorLayerCount, 0);
  assert.equal(h.file.parseResult.previewOnly, true);
});
