const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const napi = require('@napi-rs/canvas');

const canvasModulePath = require.resolve('canvas');
require.cache[canvasModulePath] = { id: canvasModulePath, filename: canvasModulePath, loaded: true, exports: napi };
const fabric = require('fabric/node');
const { implForWrapper } = require('jsdom/lib/jsdom/living/generated/utils');
const reviveImage = fabric.FabricImage.fromObject.bind(fabric.FabricImage);
fabric.FabricImage.fromObject = async (serialized, options) => {
  const image = await reviveImage(serialized, options);
  // jsdom's node-canvas adapter does not finish NAPI PNG pixels at its image-load
  // event. Decode the identical serialized bytes at this image boundary before
  // exercising the real Fabric/history/scene code.
  const decoded = await napi.loadImage(serialized.src);
  image.setElement(decoded, { width: serialized.width, height: serialized.height });
  return image;
};
function surface(width, height) {
  const image = napi.createCanvas(width, height), context = image.getContext('2d'), drawImage = context.drawImage.bind(context);
  // JSON restore produces jsdom HTMLImageElement wrappers around the same native
  // Image decoder. Only this test canvas boundary needs to unwrap that element.
  context.drawImage = (source, ...args) => { const impl = implForWrapper(source); return drawImage(impl?._image || impl?._canvas || source, ...args); };
  return image;
}
const options = { createCanvas: surface, loadImage: napi.loadImage };
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const filename = path.resolve(__dirname, `../src/editor/${name}.ts`);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = { exports: {}, console, Uint8ClampedArray, window: { setTimeout: (callback) => callback() },
    require(id) {
      if (id === 'fabric') return fabric;
      if (id === '@/editor/engine/fabricDocument') return load('engine/fabricDocument');
      if (id === '@/editor/psdSceneRenderer') { const renderer = load('psdSceneRenderer'); return { ...renderer, restorePsdScene: (canvas) => renderer.restorePsdScene(canvas, options) }; }
      if (id.startsWith('./')) return load(id.slice(2));
      if (id === '../psdImportState') return load('psdImportState');
      return require(id);
    },
  };
  vm.runInNewContext(code, context, { filename }); modules.set(name, context.exports); return context.exports;
}
const renderer = load('psdSceneRenderer');
const document = load('engine/fabricDocument');
const history = load('history');
function layer(key, extra = {}) {
  return { id: key, fileId: 1, layerName: key, parentLayerId: null, layerType: 'image', sortOrder: 0, visible: true, opacity: 1, blendMode: 'normal', x: 0, y: 0, width: 2, height: 2, properties: { psdSourceKey: key }, ...extra };
}
function canvas(width, height) {
  const value = new fabric.StaticCanvas(null, { width, height, enableRetinaScaling: false, renderOnAddRemove: false, backgroundColor: '' });
  value.discardActiveObject = () => value; return value;
}
function clip(width, height) {
  const object = new fabric.Rect({ left: 0, top: 0, width, height, strokeWidth: 0, fill: 'red', objectCaching: false });
  object._psdSourceKey = 'clip'; object._psdClipBaseKey = 'base'; object._psdOwnVisible = true; return object;
}
function pixels(value) {
  const image = value.toCanvasElement(); return Array.from(image.getContext('2d').getImageData(0, 0, image.width, image.height).data);
}
function alpha(values) { return values.filter((_, index) => index % 4 === 3); }
function standaloneAlpha(object, width, height) {
  const image = napi.createCanvas(width, height); object.render(image.getContext('2d'));
  return alpha(Array.from(image.getContext('2d').getImageData(0, 0, width, height).data));
}
function close(value) { value.__psdSceneSession?.dispose(); value.dispose(); }
const sceneLayers = () => [layer('base'), layer('clip', { sortOrder: 1, properties: { psdSourceKey: 'clip', psdClipBaseKey: 'base' } })];

test('scaling a soft clipping base updates clipped alpha and preserves pixels through save, reopen and actual history restore', async () => {
  const bitmap = napi.createCanvas(2, 1), image = bitmap.getContext('2d').createImageData(2, 1);
  image.data.set([0, 0, 0, 255, 0, 0, 0, 64]); bitmap.getContext('2d').putImageData(image, 0, 0);
  const base = new fabric.FabricImage(bitmap, { left: 0, top: 0, objectCaching: false }); base._psdSourceKey = 'base'; base._psdOwnVisible = true;
  const value = canvas(6, 2); value.add(base, clip(6, 2));
  await renderer.installPsdScene(value, sceneLayers(), options);
  const initial = document.serializeFabricCanvasToFabricJson(value), before = pixels(value);
  base.set({ scaleX: 2, scaleY: 2, left: 1 }); value.fire('object:modified', { target: base });
  const edited = pixels(value); assert.deepEqual(alpha(edited), standaloneAlpha(base, 6, 2)); assert.notDeepEqual(edited, before);
  const saved = document.serializeFabricCanvasToFabricJson(value);
  await history.restoreHistorySnapshot(value, initial); assert.deepEqual(pixels(value), before);
  await history.restoreHistorySnapshot(value, saved); assert.deepEqual(pixels(value), edited);
  const reopened = canvas(6, 2); await history.restoreHistorySnapshot(reopened, JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(pixels(reopened), edited); assert.equal(reopened.getObjects()[1]._psdClipBaseKey, 'base'); close(value); close(reopened);
});

test('native text edits recalculate clipping coverage from the changed glyphs and line layout', async () => {
  const base = new fabric.IText('I', { left: 1, top: 1, fontSize: 18, fill: 'black', strokeWidth: 0, objectCaching: false });
  base._psdSourceKey = 'base'; base._psdOwnVisible = true;
  const value = canvas(64, 48); value.add(base, clip(64, 48));
  await renderer.installPsdScene(value, [layer('base', { layerType: 'text' }), sceneLayers()[1]], options);
  const initial = pixels(value);
  base.set({ text: 'WW\nWW', lineHeight: 1.5 }); base.initDimensions(); value.fire('text:changed', { target: base });
  const edited = pixels(value); assert.deepEqual(alpha(edited), standaloneAlpha(base, 64, 48));
  assert.ok(alpha(edited).filter(Boolean).length > alpha(initial).filter(Boolean).length);
  const saved = document.serializeFabricCanvasToFabricJson(value);
  await history.restoreHistorySnapshot(value, saved); assert.deepEqual(pixels(value), edited); close(value);
});

test('reordering a clipped layer away from its base exposes a diagnostic and saves the changed pixels', async () => {
  const base = new fabric.Rect({ left: 0, top: 0, width: 2, height: 2, fill: 'black', strokeWidth: 0 }); base._psdSourceKey = 'base';
  const spacer = new fabric.Rect({ left: 2, top: 0, width: 2, height: 2, fill: 'blue', strokeWidth: 0 }); spacer._psdSourceKey = 'spacer';
  const clipped = clip(4, 2), value = canvas(4, 2); value.add(base, clipped, spacer);
  const session = await renderer.installPsdScene(value, [...sceneLayers(), layer('spacer', { sortOrder: 2 })], options);
  const initial = document.serializeFabricCanvasToFabricJson(value), before = pixels(value);
  value.moveObjectTo(clipped, 2); value.fire('object:modified', { target: clipped });
  const edited = pixels(value); assert.notDeepEqual(edited, before);
  assert.ok(session.getDiagnostics().some((item) => item.layerKey === 'clip' && item.code === 'clipping-detached'));
  const saved = document.serializeFabricCanvasToFabricJson(value);
  await history.restoreHistorySnapshot(value, initial); assert.deepEqual(pixels(value), before);
  await history.restoreHistorySnapshot(value, saved); assert.deepEqual(pixels(value), edited); close(value);
});

test('deleting a clipping base reports the orphaned relationship and actual undo restores base and clipped pixels', async () => {
  const base = new fabric.Rect({ left: 0, top: 0, width: 2, height: 2, fill: 'black', strokeWidth: 0 }); base._psdSourceKey = 'base';
  const value = canvas(4, 2); value.add(base, clip(4, 2));
  const session = await renderer.installPsdScene(value, sceneLayers(), options);
  const initial = document.serializeFabricCanvasToFabricJson(value), before = pixels(value);
  value.remove(base); pixels(value);
  assert.ok(session.getDiagnostics().some((item) => item.layerKey === 'clip' && /clipping.*(missing|detached|orphan)/.test(item.code)), 'Deleting the base must expose the broken clip relationship');
  const deleted = document.serializeFabricCanvasToFabricJson(value);
  await history.restoreHistorySnapshot(value, initial); assert.deepEqual(pixels(value), before); assert.equal(value.getObjects().length, 2);
  await history.restoreHistorySnapshot(value, deleted); assert.equal(value.getObjects().length, 1); close(value);
});

test('automatic original preview can be explicitly switched to editable composition and false persists across history/reopen', async () => {
  const original = napi.createCanvas(2, 2); original.getContext('2d').fillStyle = 'green'; original.getContext('2d').fillRect(0, 0, 2, 2);
  const value = canvas(2, 2); value.add(clip(2, 2)); value.getObjects()[0]._psdClipBaseKey = undefined;
  const sourceOptions = { ...options, compositeImagePath: 'original', loadImage: async () => original };
  const session = await renderer.installPsdScene(value, [layer('clip', { properties: { psdSourceKey: 'clip', effects: { bevel: { enabled: true } } } })], sourceOptions);
  pixels(value); assert.equal(session.getSourcePreview(), true);
  session.setSourcePreview(!session.getSourcePreview()); assert.equal(session.getSourcePreview(), false); assert.equal(pixels(value)[0], 255);
  const saved = document.serializeFabricCanvasToFabricJson(value); assert.equal(saved.__psdScene.sourcePreview, false);
  const reopened = canvas(2, 2); await document.loadPersistedEditorStateIntoFabricCanvas(reopened, saved); const restored = await renderer.restorePsdScene(reopened, sourceOptions);
  assert.equal(restored.getSourcePreview(), false); assert.equal(pixels(reopened)[0], 255);
  assert.equal(reopened.__psdScene.sourceEdited, false, 'Switching the comparison view alone must not mark source content edited'); close(value); close(reopened);
});
