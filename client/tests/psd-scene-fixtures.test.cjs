const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const ts = require('typescript');
const napi = require('@napi-rs/canvas');
const canvasModulePath = require.resolve('canvas');
require.cache[canvasModulePath] = { id: canvasModulePath, filename: canvasModulePath, loaded: true, exports: napi };
const fabric = require('fabric/node');
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const filename = path.resolve(__dirname, `../src/editor/${name}.ts`);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  // Use the process realm, as production bundling does, rather than measuring
  // millions of VM-context global lookups as part of the compositor's latency.
  const result = new Module(filename, module); result.filename = filename;
  result.require = (id) => id === 'fabric' ? fabric : id.startsWith('./') ? load(id.slice(2)) : require(id);
  result._compile(code, filename);
  modules.set(name, result.exports); return result.exports;
}
const { installPsdScene, getPsdSourceKey } = load('psdSceneRenderer');
const { createPsdSimpleShape } = load('psdSimpleShape');
const manifestPath = process.env.PSD_SCENE_MANIFEST;
const manifest = manifestPath && JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const reports = [];
function tree(flat) {
  const nodes = new Map(flat.map((layer) => [layer.id, { ...layer, children: [] }])), roots = [];
  for (const layer of nodes.values()) (nodes.get(layer.parentLayerId)?.children || roots).push(layer);
  for (const node of nodes.values()) node.children.sort((a, b) => a.sortOrder - b.sortOrder);
  return roots.sort((a, b) => a.sortOrder - b.sortOrder);
}
function difference(actual, expected) {
  let total = 0, peak = 0, changed = 0;
  for (let i = 0; i < actual.length; i += 4) {
    let pixelPeak = 0;
    for (let c = 0; c < 4; c++) { const delta = Math.abs(actual[i + c] - expected[i + c]); total += delta; peak = Math.max(peak, delta); pixelPeak = Math.max(pixelPeak, delta); }
    if (pixelPeak > 16) changed++;
  }
  return { rgbaMAE: total / actual.length, peakChannelError: peak, pixelsOver16Percent: changed * 100 / (actual.length / 4) };
}
function exported(canvas) { const result = canvas.toCanvasElement(); return { canvas: result, data: result.getContext('2d').getImageData(0, 0, result.width, result.height).data }; }
function png(canvas) { const copy = napi.createCanvas(canvas.width, canvas.height), context = copy.getContext('2d'), image = context.createImageData(canvas.width, canvas.height); image.data.set(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data); context.putImageData(image, 0, 0); return copy.toBuffer('image/png'); }
test('real PSD fixtures preserve the initial source preview and quantify editable composition', { skip: !manifest }, async (t) => {
  const directory = path.join(manifest.storageBase, 'scene-pixels'); fs.mkdirSync(directory, { recursive: true });
  for (const sample of manifest.samples) await t.test(sample.sourceFilename, async () => {
    const parsed = JSON.parse(fs.readFileSync(sample.manifestPath, 'utf8'));
    const layers = tree(parsed.layers), width = parsed.width, height = parsed.height;
    const canvas = new fabric.StaticCanvas(null, { width, height, enableRetinaScaling: false, renderOnAddRemove: false, backgroundColor: '' });
    let nativePrimitives = 0;
    for (const layer of parsed.layers.filter((layer) => layer.imagePath)) {
      let object = createPsdSimpleShape(layer);
      if (object) nativePrimitives++;
      else {
        const image = await napi.loadImage(path.join(manifest.storageBase, layer.imagePath));
        object = new fabric.FabricImage(image, { left: layer.x, top: layer.y, scaleX: layer.width / image.width, scaleY: layer.height / image.height, opacity: layer.opacity, visible: layer.visible !== false, objectCaching: false });
      }
      object._psdSourceKey = getPsdSourceKey(layer); object._psdOwnVisible = layer.visible !== false; object._psdClipBaseKey = layer.properties?.psdClipBaseKey; canvas.add(object);
    }
    const source = napi.createCanvas(width, height); source.getContext('2d').drawImage(await napi.loadImage(path.join(manifest.storageBase, parsed.parseResult.compositePath)), 0, 0);
    const expected = source.getContext('2d').getImageData(0, 0, width, height).data;
    let allocations = 0;
    const options = { width, height, compositeImagePath: parsed.parseResult.compositePath, externalDiagnostics: parsed.parseResult.diagnostics, createCanvas: (...args) => { allocations++; return napi.createCanvas(...args); }, loadImage: napi.loadImage, resolveAssetUrl: (asset) => path.join(manifest.storageBase, asset) };
    const start = performance.now(); let session = await installPsdScene(canvas, layers, options);
    const initial = exported(canvas), initialDifference = difference(initial.data, expected);
    const initialMs = performance.now() - start;
    session.setSourcePreview(true); const preview = exported(canvas), previewDifference = difference(preview.data, expected);
    assert.equal(previewDifference.rgbaMAE, 0, 'Explicit source preview must export the same pixels as the embedded source composite');
    session.dispose(); const editStart = performance.now(); session = await installPsdScene(canvas, layers, { ...options, sourceEdited: true });
    const editable = exported(canvas), editableDifference = difference(editable.data, expected);
    const editableMs = performance.now() - editStart, cachedStart = performance.now(), cachedAllocations = allocations; exported(canvas); const cachedExportMs = performance.now() - cachedStart;
    assert.equal(allocations, cachedAllocations, 'Repeated native-size export must reuse the composition instead of creating new scene intermediates');
    assert.ok(!session.getDiagnostics().some((diagnostic) => diagnostic.code === 'scene-render-failed'), 'Actual source composition must complete without a hidden runtime error');
    const diagnostics = session.getDiagnostics();
    if (diagnostics.some(({ code }) => /approx|fallback|unsupported/.test(code))) assert.equal(initialDifference.rgbaMAE, 0, 'Known fidelity limits must choose the complete initial source composite');
    const name = sample.sourceFilename.replace(/\.psd$/i, '');
    fs.writeFileSync(path.join(directory, `${name}-editable.png`), png(editable.canvas));
    fs.writeFileSync(path.join(directory, `${name}-initial.png`), png(initial.canvas));
    const report = { sourceFilename: sample.sourceFilename, width, height, nativePrimitives, initial: initialDifference, sourcePreview: previewDifference, editable: editableDifference, initialMs: Math.round(initialMs), editableMs: Math.round(editableMs), cachedExportMs: Math.round(cachedExportMs), elapsedMs: Math.round(performance.now() - start), diagnostics };
    reports.push(report); console.log(JSON.stringify(report));
    session.dispose(); await canvas.dispose();
  });
  fs.writeFileSync(path.join(directory, 'metrics.json'), JSON.stringify(reports, null, 2));
});
