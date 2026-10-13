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
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const filename = path.resolve(__dirname, `../src/editor/${name}.ts`);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = { exports: {}, console, Uint8ClampedArray, require: (id) => id === 'fabric' ? fabric : id.startsWith('./') ? load(id.slice(2)) : id === '../psdImportState' ? load('psdImportState') : require(id) };
  vm.runInNewContext(code, context, { filename });
  modules.set(name, context.exports); return context.exports;
}
const state = load('psdImportState');
const document = load('engine/fabricDocument');
const renderer = load('psdSceneRenderer');
const options = { createCanvas: napi.createCanvas, loadImage: napi.loadImage };
function layer(key, extra = {}) {
  return { id: key, layerName: key, fileId: 1, parentLayerId: null, layerType: 'image', visible: true, opacity: 1, blendMode: 'normal', sortOrder: 0, x: 0, y: 0, width: 2, height: 2, properties: { psdSourceKey: key }, ...extra };
}
function rect(key, fill) {
  const object = new fabric.Rect({ left: 0, top: 0, width: 2, height: 2, strokeWidth: 0, fill, objectCaching: false });
  object._psdSourceKey = key; object._psdOwnVisible = true; object._layerId = key; return object;
}
function canvas(width = 2, height = 2) {
  const value = new fabric.StaticCanvas(null, { width, height, enableRetinaScaling: false, renderOnAddRemove: false, backgroundColor: '' });
  value.discardActiveObject = () => value;
  value.getActiveObject = () => undefined;
  return value;
}
function pixel(value) { return Array.from(value.toCanvasElement().getContext('2d').getImageData(0, 0, 1, 1).data); }
function close(value) { value.__psdSceneSession?.dispose(); value.dispose(); }
function renderPanel(value, selectedKey) {
  let hook = 0;
  const React = { createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) { const index = hook++; return [index === 2 ? selectedKey : initial, () => {}]; }, useEffect() {} };
  const store = Object.assign(() => ({ canvas: value, selectedObjectIds: [], hoveredObjectId: null, setHoveredObjectId() {} }), { getState: () => ({ setSelectedObjects() {} }) });
  const filename = path.resolve(__dirname, '../src/editor/LayerPanel.tsx');
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
  const context = { exports: {}, require: (id) => ({ react: { ...React, default: React }, fabric, 'lucide-react': {}, '@/store/editorStore': { default: store }, './history': { HISTORY_RESTORED_EVENT: 'history-restored' }, './psdImportState': state })[id] || require(id) };
  vm.runInNewContext(code, context, { filename });
  return context.exports.default({ layers: value.__psdScene.layers, fileType: 'psd' });
}
function find(root, predicate) {
  if (!root || typeof root !== 'object') return undefined;
  if (predicate(root)) return root;
  const children = Array.isArray(root) ? root : root.props?.children || [];
  for (const child of children.flat(Infinity)) { const found = find(child, predicate); if (found) return found; }
}
function control(value, key, aria) {
  const result = find(renderPanel(value, key), (node) => node.props?.['aria-label'] === aria);
  assert.ok(result, `Control ${aria} must exist`); return result.props;
}
function button(value, key, label) {
  const result = find(renderPanel(value, key), (node) => node.type === 'button' && node.props?.children?.includes(label));
  assert.ok(result, `Button ${label} must exist`); return result.props;
}
async function restore(value, snapshot) {
  await document.loadPersistedEditorStateIntoFabricCanvas(value, snapshot);
  await renderer.restorePsdScene(value, options);
}

test('actual group opacity handler updates pixels and independent history snapshots survive undo, redo and reload', async () => {
  const value = canvas(); value.add(rect('red', 'red'));
  await renderer.installPsdScene(value, [layer('group', { layerType: 'group', children: [layer('red')] })], options);
  const history = [document.serializeFabricCanvasToFabricJson(value)];
  value.on('object:modified', () => history.push(document.serializeFabricCanvasToFabricJson(value)));
  control(value, 'group', 'PSD 组或调整层不透明度').onChange({ target: { value: '25' } });
  assert.equal(pixel(value)[3], 64);
  assert.equal(history.length, 2);
  assert.equal(history[0].__psdScene.layers[0].opacity, 1, 'Later edits must not mutate the initial snapshot');
  assert.equal(history[1].__psdScene.layers[0].opacity, 0.25);
  await restore(value, history[0]); assert.equal(pixel(value)[3], 255);
  await restore(value, history[1]); assert.equal(pixel(value)[3], 64);
  const reopened = canvas(); await restore(reopened, JSON.parse(JSON.stringify(history[1])));
  assert.deepEqual(pixel(reopened), pixel(value)); close(value); close(reopened);
});

test('actual group reorder and delete handlers change tree and pixels; undo restores the removed descendants', async () => {
  const value = canvas(); value.add(rect('red', 'red'), rect('blue', 'blue'));
  await renderer.installPsdScene(value, [layer('group', { layerType: 'group', children: [layer('red')] }), layer('blue', { sortOrder: 1 })], options);
  const initial = document.serializeFabricCanvasToFabricJson(value);
  assert.deepEqual(pixel(value), [0, 0, 255, 255]);
  button(value, 'group', '上移').onClick(); assert.deepEqual(pixel(value), [255, 0, 0, 255]);
  const reordered = document.serializeFabricCanvasToFabricJson(value);
  button(value, 'group', '删除').onClick(); assert.deepEqual(pixel(value), [0, 0, 255, 255]);
  assert.equal(value.getObjects().length, 1); assert.equal(value.__psdScene.layers.length, 1);
  const deleted = document.serializeFabricCanvasToFabricJson(value);
  await restore(value, reordered); assert.deepEqual(pixel(value), [255, 0, 0, 255]); assert.equal(value.getObjects().length, 2);
  await restore(value, initial); assert.deepEqual(pixel(value), [0, 0, 255, 255]);
  await restore(value, deleted); assert.equal(value.getObjects().length, 1); close(value);
});

test('actual adjustment parameter handler updates backdrop, saves psdAdjustment and restores history', async () => {
  const value = canvas(); value.add(rect('red', '#804020'));
  await renderer.installPsdScene(value, [layer('red'), layer('adjust', { layerType: 'adjustment', sortOrder: 1, properties: { psdSourceKey: 'adjust', psdAdjustment: { type: 'brightness/contrast', brightness: 0, contrast: 0 } } })], options);
  const initial = document.serializeFabricCanvasToFabricJson(value);
  control(value, 'adjust', 'PSD 调整 亮度').onChange({ target: { value: '50' } });
  const modified = pixel(value); assert.ok(modified[0] > 128 && modified[1] > 64); assert.equal(modified[3], 255);
  const saved = document.serializeFabricCanvasToFabricJson(value);
  assert.equal(saved.__psdScene.layers[1].properties.psdAdjustment.brightness, 50);
  await restore(value, initial); assert.deepEqual(pixel(value), [128, 64, 32, 255]);
  await restore(value, saved); assert.deepEqual(pixel(value), modified);
  button(value, 'adjust', '删除').onClick(); assert.deepEqual(pixel(value), [128, 64, 32, 255]); close(value);
});

test('native user stroke replaces the original PSD stroke once and its override survives save and restore', async () => {
  const value = canvas(8, 4), source = rect('source', 'red'); source.set({ left: 3, top: 1 }); value.add(source);
  const effects = { stroke: [{ size: 1, color: { r: 0, g: 255, b: 0 }, position: 'outside', enabled: true }] };
  await renderer.installPsdScene(value, [layer('source', { properties: { psdSourceKey: 'source', effects } })], options);
  const colors = () => {
    const image = value.toCanvasElement(); return Array.from(image.getContext('2d').getImageData(0, 0, 8, 4).data);
  };
  const containsGreen = (rgba) => rgba.some((_, i) => i % 4 === 0 && rgba[i] === 0 && rgba[i + 1] > 250 && rgba[i + 2] === 0 && rgba[i + 3] > 0);
  assert.equal(containsGreen(colors()), true);
  state.markPsdNativeEffectOverride(source, 'stroke'); source.set({ stroke: 'blue', strokeWidth: 2 });
  value.fire('object:modified', { target: source });
  const edited = colors(); assert.equal(containsGreen(edited), false, 'PSD stroke must not be applied over the new native stroke');
  assert.ok(edited.some((_, i) => i % 4 === 0 && edited[i + 2] > 250 && edited[i] === 0));
  const saved = document.serializeFabricCanvasToFabricJson(value);
  assert.equal(saved.__psdScene.layers[0].properties.effects.stroke[0].color.g, 255);
  await restore(value, saved); assert.deepEqual(colors(), edited); close(value);
});

test('PSD to blank route reset restores native rendering and saves no stale scene metadata', async () => {
  const value = canvas(); value.add(rect('source', 'red'));
  await renderer.installPsdScene(value, [layer('source')], options);
  assert.deepEqual(pixel(value), [255, 0, 0, 255]);
  state.resetPsdCanvasScene(value); value.clear();
  value.add(new fabric.Rect({ left: 0, top: 0, width: 2, height: 2, fill: 'blue', strokeWidth: 0 }));
  assert.deepEqual(pixel(value), [0, 0, 255, 255]);
  const saved = document.serializeFabricCanvasToFabricJson(value);
  assert.equal(saved.__psdScene, undefined); assert.equal(saved.__psdVisibilityOverrides, undefined);
  assert.equal(value.__psdSceneSession, undefined); close(value);
});
