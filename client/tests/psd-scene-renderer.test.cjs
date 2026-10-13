const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const napi = require('@napi-rs/canvas');

// Fabric's jsdom environment uses the same native Canvas API. Inject the available
// native implementation instead of requiring an unbuilt node-canvas binary.
const canvasModulePath = require.resolve('canvas');
require.cache[canvasModulePath] = { id: canvasModulePath, filename: canvasModulePath, loaded: true, exports: napi };
const fabric = require('fabric/node');
fabric.FabricObject.customProperties = [...fabric.FabricObject.customProperties, '_psdSourceKey', '_psdClipBaseKey', '_psdOwnVisible', '_psdOriginalTransform', '_psdOriginalDimensions', '_psdSceneObject'];
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const filename = path.resolve(__dirname, `../src/editor/${name}.ts`);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const result = { exports: {} };
  vm.runInNewContext(code, { exports: result.exports, module: result, require: (id) => id === 'fabric' ? fabric : id.startsWith('./') ? load(id.slice(2)) : require(id), console, Uint8ClampedArray, setTimeout, clearTimeout }, { filename });
  modules.set(name, result.exports); return result.exports;
}
const { installPsdScene, restorePsdScene } = load('psdSceneRenderer');
const pixelHelpers = load('psdScenePixels');
const options = { createCanvas: napi.createCanvas, loadImage: napi.loadImage };
function layer(key, overrides = {}) {
  return { id: Number(key.replace(/\D/g, '')) || 1, fileId: 1, layerType: 'image', parentLayerId: null, sortOrder: 0, visible: true, opacity: 1, blendMode: 'normal', x: 0, y: 0, width: 2, height: 2, properties: { psdSourceKey: key }, ...overrides };
}
function rect(key, fill, overrides = {}) {
  const object = new fabric.Rect({ left: 0, top: 0, width: 2, height: 2, strokeWidth: 0, fill, objectCaching: false, ...overrides });
  object._psdSourceKey = key; object._psdOwnVisible = true; return object;
}
function makeCanvas(width = 2, height = 2) { return new fabric.StaticCanvas(null, { width, height, enableRetinaScaling: false, renderOnAddRemove: false, backgroundColor: '' }); }
function exportedPixels(canvas) {
  const exported = canvas.toCanvasElement();
  return Array.from(exported.getContext('2d').getImageData(0, 0, exported.width, exported.height).data);
}
function close(canvas) { canvas.__psdSceneSession?.dispose(); canvas.dispose(); }

test('normal group opacity applies to overlapping siblings once in the production export hook', async () => {
  const canvas = makeCanvas(); canvas.add(rect('red', 'red'), rect('blue', 'blue'));
  const group = layer('g', { layerType: 'group', opacity: 0.5, children: [layer('red'), layer('blue')] });
  await installPsdScene(canvas, [group], options);
  const rgba = exportedPixels(canvas);
  assert.deepEqual(rgba.slice(0, 4), [0, 0, 255, 128]);
  assert.equal(canvas.getObjects().length, 2, 'Scene rendering must not replace editable source identities');
  assert.equal(canvas.getObjects()[0].opacity, 1);
  close(canvas);
});

test('pass-through group blend sees external backdrop and overall opacity interpolates once', async () => {
  const canvas = makeCanvas();
  canvas.add(new fabric.Rect({ left: 0, top: 0, width: 2, height: 2, strokeWidth: 0, fill: '#00ff00' }), rect('red', '#ff0000'));
  await installPsdScene(canvas, [layer('g', { layerType: 'group', blendMode: 'pass through', opacity: 0.5, children: [layer('red', { blendMode: 'multiply' })] })], options);
  assert.deepEqual(exportedPixels(canvas).slice(0, 4), [0, 128, 0, 255]);
  close(canvas);
});

test('group soft mask does not thicken overlapping children and keeps outside defaultColor', async () => {
  const mask = napi.createCanvas(1, 1), context = mask.getContext('2d');
  context.fillStyle = 'rgba(255,255,255,0.5)'; context.fillRect(0, 0, 1, 1);
  const canvas = makeCanvas(); canvas.add(rect('red', 'red'), rect('blue', 'blue'));
  await installPsdScene(canvas, [layer('g', { layerType: 'group', children: [layer('red'), layer('blue')], properties: { psdSourceKey: 'g', psdMask: { imagePath: 'mask.png', x: 1, y: 0, width: 1, height: 1, defaultColor: 0 } } })], { ...options, loadImage: async () => mask });
  const output = exportedPixels(canvas);
  assert.equal(output[3], 0); assert.equal(output[7], 127); assert.equal(output[11], 0);
  close(canvas);
});

test('clipping stack preserves soft base alpha and dynamically follows base movement and opacity', async () => {
  const bitmap = napi.createCanvas(2, 2), context = bitmap.getContext('2d'), image = context.createImageData(2, 2);
  const alphas = [255, 128, 32, 0];
  alphas.forEach((a, i) => { image.data[i * 4 + 3] = a; }); context.putImageData(image, 0, 0);
  const base = new fabric.FabricImage(bitmap, { left: 0, top: 0, objectCaching: false }); base._psdSourceKey = 'base';
  const clipped = rect('clip', 'red'); clipped._psdClipBaseKey = 'base';
  const canvas = makeCanvas(); canvas.add(base, clipped);
  await installPsdScene(canvas, [layer('base'), layer('clip', { properties: { psdSourceKey: 'clip', psdClipBaseKey: 'base' } })], options);
  let output = exportedPixels(canvas);
  assert.deepEqual([output[3], output[7], output[11], output[15]], alphas);
  assert.ok(output[0] > 250 && output[4] > 250 && output[8] > 240, 'Clipped colors must avoid black premultiplication fringes');
  clipped.set('opacity', 0.5); output = exportedPixels(canvas);
  assert.deepEqual([output[3], output[7], output[11], output[15]], alphas);
  base.set({ left: 1, opacity: 0.5 }); canvas.fire('object:modified', { target: base });
  output = exportedPixels(canvas);
  assert.deepEqual([output[3], output[7], output[11], output[15]], [0, 128, 0, 16]);
  close(canvas);
});

test('source-linked mask transform survives JSON/history restoration', async () => {
  const mask = napi.createCanvas(1, 1); mask.getContext('2d').fillStyle = 'white'; mask.getContext('2d').fillRect(0, 0, 1, 1);
  const canvas = makeCanvas(4, 2), source = rect('source', 'red'); canvas.add(source);
  const sceneLayers = [layer('source', { properties: { psdSourceKey: 'source', psdMask: { imagePath: 'mask.png', x: 0, y: 0, width: 1, height: 1, defaultColor: 0, linked: true } } })];
  const maskOptions = { ...options, loadImage: async () => mask };
  await installPsdScene(canvas, sceneLayers, maskOptions); source.set('left', 1);
  const before = exportedPixels(canvas), saved = JSON.parse(JSON.stringify({ ...canvas.toJSON(), __psdScene: canvas.__psdScene, __psdVisibilityOverrides: canvas.__psdVisibilityOverrides }));
  assert.equal(before[3], 0); assert.equal(before[7], 255);
  const restored = makeCanvas(4, 2); await restored.loadFromJSON(saved);
  restored.__psdScene = saved.__psdScene; restored.__psdVisibilityOverrides = saved.__psdVisibilityOverrides;
  await restorePsdScene(restored, maskOptions);
  assert.deepEqual(exportedPixels(restored), before);
  restored.getObjects()[0].set('left', 2);
  const moved = exportedPixels(restored); assert.equal(moved[7], 0); assert.equal(moved[11], 255);
  assert.equal(restored.getObjects()[0]._psdSourceKey, 'source');
  close(canvas); close(restored);
});

test('hidden group visibility changes do not erase child own visibility', async () => {
  const canvas = makeCanvas(), source = rect('source', 'red'); source.visible = false; source._psdOwnVisible = true; canvas.add(source);
  const session = await installPsdScene(canvas, [layer('g', { layerType: 'group', visible: false, children: [layer('source')] })], options);
  assert.equal(exportedPixels(canvas)[3], 0);
  session.updateLayer('g', { visible: true }); assert.equal(exportedPixels(canvas)[3], 255);
  session.updateLayer('source', { visible: false }); session.updateLayer('g', { visible: false }); session.updateLayer('g', { visible: true });
  assert.equal(exportedPixels(canvas)[3], 0); close(canvas);
});

test('zoom, pan and selection render reuse cached PSD pixels; source property changes invalidate', async () => {
  const canvas = makeCanvas(), source = rect('source', 'red'); let samples = 0; const original = source.render;
  source.render = function(context) { samples++; return original.call(this, context); }; canvas.add(source);
  await installPsdScene(canvas, [layer('source')], options);
  exportedPixels(canvas); const initial = samples;
  canvas.setViewportTransform([2, 0, 0, 2, 1, 1]); exportedPixels(canvas); exportedPixels(canvas);
  assert.equal(samples, initial);
  canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
  source.set('fill', 'blue'); const output = exportedPixels(canvas); assert.ok(samples > initial); assert.equal(output[2], 255);
  close(canvas);
});

test('multiple gradient overlays and strokes are iterated; unsupported effects produce layer diagnostics', async () => {
  const canvas = makeCanvas(6, 2), source = rect('source', 'black', { left: 2 }); canvas.add(source);
  const solid = (r, g, b) => ({ type: 'solid', colorStops: [{ location: 0, midpoint: 0.5, color: { r, g, b } }, { location: 1, midpoint: 0.5, color: { r, g, b } }], opacityStops: [{ location: 0, opacity: 1 }, { location: 1, opacity: 1 }] });
  const effects = { gradientOverlay: [{ enabled: true, gradient: solid(255, 0, 0) }, { enabled: true, opacity: 0.5, gradient: solid(0, 0, 255) }], stroke: [{ enabled: true, size: { value: 1 }, color: { r: 0, g: 255, b: 0 }, position: 'outside' }, { enabled: true, size: { value: 2 }, color: { r: 255, g: 255, b: 0 }, position: 'outside', opacity: 0.5 }], bevel: { enabled: true } };
  const session = await installPsdScene(canvas, [layer('source', { properties: { psdSourceKey: 'source', effects } })], options);
  const output = exportedPixels(canvas); assert.ok(output[3] > 0, 'Second stroke reaches farther than the first');
  assert.ok(output[8] > 100 && output[10] > 100, 'Both overlays affect source colors');
  assert.ok(session.getDiagnostics().some((d) => d.sourceKey === 'source' && d.code === 'effect-bevel'));
  close(canvas);
});

test('adjustment parameters execute on backdrop while alpha remains unchanged', async () => {
  const canvas = makeCanvas(); canvas.add(rect('source', '#804020'));
  await installPsdScene(canvas, [layer('source'), layer('curve', { layerType: 'adjustment', sortOrder: 99, opacity: 0.5, properties: { psdSourceKey: 'curve', adjustment: { type: 'curves', rgb: [{ input: 0, output: 255 }, { input: 255, output: 0 }] } } })], options);
  const output = exportedPixels(canvas); assert.ok(Math.abs(output[0] - 128) <= 1 && Math.abs(output[1] - 128) <= 1 && Math.abs(output[2] - 128) <= 1); assert.equal(output[3], 255);
  const sample = new Uint8ClampedArray([255, 0, 0, 128]);
  assert.deepEqual(Array.from(pixelHelpers.adjustPixels(sample, { type: 'hue/saturation', master: { hue: 120, saturation: 0, lightness: 0 } })), [0, 255, 0, 128]);
  const balance = pixelHelpers.adjustPixels(new Uint8ClampedArray([128, 128, 128, 128]), { type: 'color balance', midtones: { cyanRed: 20, magentaGreen: 0, yellowBlue: 0 } }); assert.ok(balance[0] > 128); assert.equal(balance[3], 128);
  const selective = pixelHelpers.adjustPixels(sample, { type: 'selective color', mode: 'absolute', reds: { c: 50, m: 0, y: 0, k: 0 } }); assert.ok(selective[0] < 255); assert.equal(selective[3], 128);
  close(canvas);
});

test('cloned source identity becomes a separate serializable scene node', async () => {
  const canvas = makeCanvas(4, 2), original = rect('source', 'red'); canvas.add(original);
  await installPsdScene(canvas, [layer('source')], options);
  const duplicate = await original.clone(); duplicate.set('left', 2); canvas.add(duplicate);
  const output = exportedPixels(canvas); assert.equal(output[3], 255); assert.equal(output[11], 255);
  assert.notEqual(duplicate._psdSourceKey, original._psdSourceKey);
  assert.equal(canvas.__psdScene.layers.length, 2);
  canvas.remove(original); assert.equal(exportedPixels(canvas)[11], 255);
  close(canvas);
});

test('unsupported initial styles use complete source composite until source edit; preview mode remains explicit', async () => {
  const preview = napi.createCanvas(2, 2), context = preview.getContext('2d'); context.fillStyle = 'green'; context.fillRect(0, 0, 2, 2);
  const canvas = makeCanvas(), source = rect('source', 'red'); canvas.add(source);
  const session = await installPsdScene(canvas, [layer('source', { properties: { psdSourceKey: 'source', effects: { bevel: { enabled: true } } } })], { ...options, compositeImagePath: 'original.png', loadImage: async () => preview });
  assert.deepEqual(exportedPixels(canvas).slice(0, 4), [0, 128, 0, 255]);
  canvas.setViewportTransform([2, 0, 0, 2, 0, 0]); assert.equal(exportedPixels(canvas)[1], 128);
  canvas.setViewportTransform([1, 0, 0, 1, 0, 0]); source.set('fill', 'blue');
  assert.deepEqual(exportedPixels(canvas).slice(0, 4), [0, 0, 255, 255]);
  assert.ok(session.getDiagnostics().some((d) => d.code === 'edited-fidelity-boundary'));
  session.setSourcePreview(true); assert.equal(exportedPixels(canvas)[1], 128);
  session.setSourcePreview(false); assert.equal(exportedPixels(canvas)[2], 255);
  close(canvas);
});

test('edited scene saved before the next render stays edited after restore', async () => {
  const preview = napi.createCanvas(2, 2); preview.getContext('2d').fillStyle = 'green'; preview.getContext('2d').fillRect(0, 0, 2, 2);
  const canvas = makeCanvas(), source = rect('source', 'red'); canvas.add(source);
  const testOptions = { ...options, compositeImagePath: 'original.png', loadImage: async () => preview };
  await installPsdScene(canvas, [layer('source', { properties: { psdSourceKey: 'source', effects: { bevel: { enabled: true } } } })], testOptions);
  assert.equal(exportedPixels(canvas)[1], 128); source.set('fill', 'blue');
  // The history/save serializer runs synchronously, before RAF can rebuild scene pixels.
  const serialized = canvas.toJSON(), metadata = JSON.parse(JSON.stringify(canvas.__psdScene));
  assert.equal(metadata.sourceEdited, true);
  const restored = makeCanvas(); await restored.loadFromJSON(serialized); restored.__psdScene = metadata;
  await restorePsdScene(restored, testOptions); assert.deepEqual(exportedPixels(restored).slice(0, 4), [0, 0, 255, 255]);
  close(canvas); close(restored);
});

test('clipping preserves the base outer stroke after restoring clipping coverage', async () => {
  const canvas = makeCanvas(6, 2); canvas.add(rect('base', 'black', { left: 2 }), rect('clip', 'red', { left: 2 }));
  const base = layer('base', { properties: { psdSourceKey: 'base', effects: { stroke: [{ size: 1, color: { r: 0, g: 255, b: 0 }, position: 'outside', enabled: true }] } } });
  await installPsdScene(canvas, [base, layer('clip', { properties: { psdSourceKey: 'clip', psdClipBaseKey: 'base' } })], options);
  const output = exportedPixels(canvas); assert.deepEqual(output.slice(4, 8), [0, 255, 0, 255]); assert.deepEqual(output.slice(8, 12), [255, 0, 0, 255]);
  close(canvas);
});

test('group mask stays fixed when only its first child moves, follows a common group move', async () => {
  const coverage = napi.createCanvas(1, 2); coverage.getContext('2d').fillStyle = 'white'; coverage.getContext('2d').fillRect(0, 0, 1, 2);
  const canvas = makeCanvas(4, 2), first = rect('first', 'red'), second = rect('second', 'blue'); canvas.add(first, second);
  await installPsdScene(canvas, [layer('group', { layerType: 'group', children: [layer('first'), layer('second')], properties: { psdSourceKey: 'group', psdMask: { imagePath: 'mask', x: 0, y: 0, width: 1, height: 2, defaultColor: 0, linked: true } } })], { ...options, loadImage: async () => coverage });
  first.set('left', 1); let output = exportedPixels(canvas); assert.equal(output[3], 255); assert.equal(output[7], 0);
  second.set('left', 1); output = exportedPixels(canvas); assert.equal(output[3], 0); assert.equal(output[7], 255);
  close(canvas);
});

test('normal group can be a clipping base using the combined group alpha', async () => {
  const canvas = makeCanvas(4, 2); canvas.add(rect('inside', 'black'), rect('clip', 'red', { width: 4 }));
  await installPsdScene(canvas, [layer('group', { layerType: 'group', opacity: 0.5, children: [layer('inside')] }), layer('clip', { properties: { psdSourceKey: 'clip', psdClipBaseKey: 'group' } })], options);
  const output = exportedPixels(canvas); assert.deepEqual(output.slice(0, 4), [255, 0, 0, 128]); assert.equal(output[11], 0);
  close(canvas);
});

test('Fill Opacity zero still shows color-overlay style; gradient transparency is retained', async () => {
  const canvas = makeCanvas(2, 2); canvas.add(rect('source', 'black'));
  await installPsdScene(canvas, [layer('source', { properties: { psdSourceKey: 'source', fillOpacity: 0, effects: { solidFill: [{ color: { r: 255, g: 0, b: 0 }, opacity: 1, enabled: true }] } } })], options);
  assert.deepEqual(exportedPixels(canvas).slice(0, 4), [255, 0, 0, 255]); close(canvas);
  const gradientCanvas = makeCanvas(2, 2); gradientCanvas.add(rect('source', 'black'));
  const gradient = { type: 'solid', colorStops: [{ location: 0, color: { r: 255, g: 0, b: 0 }, midpoint: 0.5 }, { location: 1, color: { r: 255, g: 0, b: 0 }, midpoint: 0.5 }], opacityStops: [{ location: 0, opacity: 0, midpoint: 0.5 }, { location: 1, opacity: 1, midpoint: 0.5 }] };
  await installPsdScene(gradientCanvas, [layer('source', { properties: { psdSourceKey: 'source', fillOpacity: 0, effects: { gradientOverlay: [{ gradient, angle: 0 }] } } })], options);
  const output = exportedPixels(gradientCanvas); assert.equal(output[3], 0); assert.ok(output[7] >= 127 && output[7] <= 129); close(gradientCanvas);
});

test('PSD gradient angle, scale, offset and reverse share document coordinate conventions', () => {
  const gradient = { type: 'solid', colorStops: [{ location: 0, color: { r: 0, g: 0, b: 0 }, midpoint: 0.5 }, { location: 1, color: { r: 255, g: 255, b: 255 }, midpoint: 0.5 }] };
  const bounds = { x: 0, y: 0, width: 10, height: 10 };
  assert.equal(pixelHelpers.gradientColor({ gradient, angle: 90 }, 5, 0, bounds)[0], 255);
  assert.equal(pixelHelpers.gradientColor({ gradient, angle: 90 }, 5, 10, bounds)[0], 0);
  assert.equal(pixelHelpers.gradientColor({ gradient, angle: 90, reverse: true }, 5, 0, bounds)[0], 0);
  assert.equal(pixelHelpers.gradientColor({ gradient, angle: 0, offset: { x: 0.5, y: 0 } }, 5, 5, bounds)[0], 0);
  assert.equal(pixelHelpers.gradientColor({ gradient, angle: 0, scale: 2 }, 10, 5, bounds)[0], 191.25);
});

test('simple native primitive applies only the independent user mask and remains editable', async () => {
  const { createPsdSimpleShape } = load('psdSimpleShape');
  const input = layer('ellipse', { properties: { psdSourceKey: 'ellipse', vectorFill: { type: 'color', color: { r: 255, g: 0, b: 0 } }, psdMaskIncludesVectorGeometry: true, psdMask: { imagePath: 'geometry', x: 0, y: 0, width: 2, height: 2, defaultColor: 0 }, psdVectorOrigination: { keyDescriptorList: [{ keyOriginType: 5, keyOriginShapeBoundingBox: { left: 0, top: 0, right: 2, bottom: 2 } }] } } });
  const shape = createPsdSimpleShape(input); assert.ok(shape instanceof fabric.Ellipse); shape._psdSourceKey = 'ellipse';
  const canvas = makeCanvas(); canvas.add(shape);
  const geometry = napi.createCanvas(2, 2); // deliberately black/transparent; native shape must not multiply it a second time
  await installPsdScene(canvas, [input], { ...options, loadImage: async () => geometry });
  assert.ok(exportedPixels(canvas)[3] > 0); shape.set('fill', 'blue'); assert.equal(exportedPixels(canvas)[2], 255);
  input.properties.vectorMaskFeather = 1; assert.equal(createPsdSimpleShape(input), null); close(canvas);
});

test('memory budget preserves native-size composite without allocating scene intermediates', async () => {
  const canvas = makeCanvas(), source = rect('source', 'red'); canvas.add(source);
  const preview = napi.createCanvas(2, 2); preview.getContext('2d').fillStyle = 'green'; preview.getContext('2d').fillRect(0, 0, 2, 2);
  let allocations = 0;
  const session = await installPsdScene(canvas, [layer('source')], { ...options, maxWorkingBytes: 1, compositeImagePath: 'preview', loadImage: async () => preview, createCanvas: (w, h) => { allocations++; return napi.createCanvas(w, h); } });
  assert.deepEqual(exportedPixels(canvas).slice(0, 4), [0, 128, 0, 255]); assert.equal(allocations, 0); assert.ok(session.getDiagnostics().some((d) => d.code === 'scene-memory-budget'));
  close(canvas);
});

test('native objects inserted between PSD sources preserve canvas z-order', async () => {
  const canvas = makeCanvas(), red = rect('red', 'red'), green = new fabric.Rect({ width: 2, height: 2, fill: 'green', strokeWidth: 0 }), blue = rect('blue', 'blue');
  canvas.add(red, green, blue);
  await installPsdScene(canvas, [layer('red', { sortOrder: 1 }), layer('blue', { sortOrder: 2 })], options);
  assert.deepEqual(exportedPixels(canvas).slice(0, 4), [0, 0, 255, 255]);
  canvas.moveObjectTo(green, 2); assert.deepEqual(exportedPixels(canvas).slice(0, 4), [0, 128, 0, 255]); close(canvas);
});

test('native objects inserted inside an isolated group participate in its overall opacity', async () => {
  const canvas = makeCanvas(), red = rect('red', 'red'), green = new fabric.Rect({ width: 2, height: 2, fill: 'green', strokeWidth: 0 }), blue = rect('blue', 'blue'); canvas.add(red, green, blue);
  await installPsdScene(canvas, [layer('g', { layerType: 'group', opacity: 0.5, children: [layer('red'), layer('blue')] })], options);
  assert.deepEqual(exportedPixels(canvas).slice(0, 4), [0, 0, 255, 128]); close(canvas);
});

test('interactive ActiveSelection preserves isolated group opacity, native order and shared transforms', async () => {
  const canvas = new fabric.Canvas(null, { width: 4, height: 2, enableRetinaScaling: false, renderOnAddRemove: false, backgroundColor: '' });
  const red = rect('red', 'red'), blue = rect('blue', 'blue'); canvas.add(red, blue);
  const session = await installPsdScene(canvas, [layer('g', { layerType: 'group', opacity: 0.5, children: [layer('red'), layer('blue')] })], options);
  const selection = new fabric.ActiveSelection([red, blue], { canvas }); canvas.setActiveObject(selection);
  const pixels = () => { canvas.renderAll(); return Array.from(canvas.contextContainer.getImageData(0, 0, 4, 2).data); };
  assert.deepEqual(pixels().slice(0, 4), [0, 0, 255, 128]);
  session.updateLayer('g', { opacity: 0 }); assert.equal(pixels()[3], 0, 'Selection must not draw selected sources a second time above the scene');
  session.updateLayer('g', { opacity: 0.5 }); selection.set('left', selection.left + 2); selection.setCoords();
  const moved = pixels(); assert.equal(moved[3], 0); assert.deepEqual(moved.slice(8, 12), [0, 0, 255, 128]);
  assert.deepEqual(exportedPixels(canvas).slice(8, 12), [0, 0, 255, 128], 'Interactive and exported pixels share selection transforms');
  canvas.discardActiveObject(); close(canvas);
});

test('Fabric user grouping keeps PSD source masks, parent opacity and editable child transforms', async () => {
  const canvas = makeCanvas(4, 2), red = rect('red', 'red'), blue = rect('blue', 'blue'); canvas.add(red, blue);
  await installPsdScene(canvas, [layer('g', { layerType: 'group', opacity: 0.5, children: [layer('red'), layer('blue')] })], options);
  assert.equal(exportedPixels(canvas)[3], 128);
  canvas.remove(red, blue); const userGroup = new fabric.Group([red, blue], { objectCaching: false }); canvas.add(userGroup);
  assert.deepEqual(exportedPixels(canvas).slice(0, 4), [0, 0, 255, 128]);
  userGroup.set('left', 2); const moved = exportedPixels(canvas); assert.equal(moved[3], 0); assert.deepEqual(moved.slice(8, 12), [0, 0, 255, 128]);
  blue.set('fill', 'green'); assert.deepEqual(exportedPixels(canvas).slice(8, 12), [0, 128, 0, 128]); close(canvas);
});

test('late async installation cannot replace a newer scene or a superseded route', async () => {
  const canvas = makeCanvas(); canvas.add(rect('source', 'red'));
  let finish; const slowImage = new Promise((resolve) => { finish = resolve; });
  const old = installPsdScene(canvas, [layer('old')], { ...options, compositeImagePath: 'old.png', loadImage: async () => slowImage });
  const latest = await installPsdScene(canvas, [layer('source')], options);
  finish(napi.createCanvas(2, 2)); await assert.rejects(old, { name: 'AbortError' });
  assert.equal(canvas.__psdSceneSession, latest); assert.deepEqual(exportedPixels(canvas).slice(0, 4), [255, 0, 0, 255]); close(canvas);
  const routeCanvas = makeCanvas(); routeCanvas.add(rect('source', 'red')); const originalRender = routeCanvas._renderObjects;
  await assert.rejects(installPsdScene(routeCanvas, [layer('source')], { ...options, isCurrent: () => false }), { name: 'AbortError' });
  assert.equal(routeCanvas._renderObjects, originalRender); assert.equal(routeCanvas.__psdScene, undefined); close(routeCanvas);
});

test('known fidelity limits display the pristine source without computing editable intermediates', async () => {
  const canvas = makeCanvas(); canvas.add(rect('source', 'red')); const preview = napi.createCanvas(2, 2); preview.getContext('2d').fillRect(0, 0, 2, 2);
  let allocated = 0;
  const session = await installPsdScene(canvas, [layer('source', { properties: { psdSourceKey: 'source', effects: { stroke: [{ enabled: true, size: 1 }] } } })], { ...options, compositeImagePath: 'source', loadImage: async () => preview, createCanvas: (...args) => { allocated++; return napi.createCanvas(...args); } });
  exportedPixels(canvas); assert.equal(allocated, 0, 'Fidelity preflight must not run an unused full-scene composition');
  canvas.getObjects()[0].set('fill', 'blue'); exportedPixels(canvas); assert.ok(allocated > 0); assert.equal(canvas.__psdScene.sourceEdited, true); close(canvas);
});

test('linked text masks stay anchored when text width or line height changes', async () => {
  const canvas = makeCanvas(120, 40), source = new fabric.IText('I', { left: 0, top: 0, fontSize: 30, fill: 'red', strokeWidth: 0, objectCaching: false }); source._psdSourceKey = 'text'; canvas.add(source);
  const white = napi.createCanvas(1, 40); white.getContext('2d').fillStyle = 'white'; white.getContext('2d').fillRect(0, 0, 1, 40);
  await installPsdScene(canvas, [layer('text', { properties: { psdSourceKey: 'text', psdMask: { imagePath: 'mask', x: 5, y: 0, width: 1, height: 40, defaultColor: 0 } } })], { ...options, loadImage: async () => white });
  source.set('text', 'IIIIIIII'); source.set('lineHeight', 2);
  const output = exportedPixels(canvas);
  const coveredColumns = new Set(); for (let i = 3; i < output.length; i += 4) if (output[i]) coveredColumns.add(((i - 3) / 4) % 120);
  assert.ok(coveredColumns.size > 0); assert.deepEqual([...coveredColumns], [5]); close(canvas);
});

test('source comparison catches an unexpected initial mismatch and editable preview override restores', async () => {
  const canvas = makeCanvas(); canvas.add(rect('source', 'red')); const preview = napi.createCanvas(2, 2); preview.getContext('2d').fillStyle = 'blue'; preview.getContext('2d').fillRect(0, 0, 2, 2);
  let session = await installPsdScene(canvas, [layer('source')], { ...options, compositeImagePath: 'source', loadImage: async () => preview });
  assert.deepEqual(exportedPixels(canvas).slice(0, 4), [0, 0, 255, 255]); assert.ok(session.getDiagnostics().some((d) => d.code === 'source-composite-fallback')); assert.equal(session.getSourcePreview(), true);
  session.setSourcePreview(false); assert.deepEqual(exportedPixels(canvas).slice(0, 4), [255, 0, 0, 255]); assert.equal(session.getSourcePreview(), false);
  const metadata = JSON.parse(JSON.stringify(canvas.__psdScene)); session.dispose(); canvas.__psdScene = metadata;
  session = await restorePsdScene(canvas, { ...options, loadImage: async () => preview });
  assert.equal(canvas.__psdScene.sourcePreview, false); assert.deepEqual(exportedPixels(canvas).slice(0, 4), [255, 0, 0, 255]); close(canvas);
});

test('unaligned gradient overlay uses document bounds instead of source alpha bounds', async () => {
  const canvas = makeCanvas(10, 2); canvas.add(rect('source', 'black'));
  const gradient = { type: 'solid', colorStops: [{ location: 0, color: { r: 0, g: 0, b: 0 } }, { location: 1, color: { r: 255, g: 255, b: 255 } }] };
  await installPsdScene(canvas, [layer('source', { properties: { psdSourceKey: 'source', effects: { gradientOverlay: [{ align: false, gradient, angle: 0, scale: 1 }] } } })], options);
  const gray = exportedPixels(canvas)[4]; assert.ok(gray >= 25 && gray <= 26); close(canvas);
});
