const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function loadModule(relativePath, dependencies = {}) {
  const raw = fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');
  const executable = ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = { exports: {}, require: (name) => dependencies[name] || require(name), console };
  vm.runInNewContext(executable, context);
  return context.exports;
}
const state = loadModule('../src/editor/psdImportState.ts');
const editorPath = path.resolve(__dirname, '../src/pages/Editor/index.tsx');
const source = ts.createSourceFile(editorPath, fs.readFileSync(editorPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function editorFunctions(names, boundaries = {}) {
  const declarations = source.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name.text));
  assert.equal(declarations.length, names.length);
  const executable = ts.transpileModule(declarations.map((node) => node.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = { ...state, console, ...boundaries };
  vm.runInNewContext(executable, context);
  return context;
}
function object(properties) {
  return { ...properties, set(values) { Object.assign(this, values); }, setCoords() {} };
}
const layers = [{ id: 1, layerType: 'group', visible: false, opacity: 0.3, properties: { psdSourceKey: 'group' }, children: [
  { id: 2, layerType: 'image', visible: true, opacity: 0.9, properties: { psdSourceKey: 'image' } },
  { id: 3, layerType: 'image', visible: false, properties: { psdSourceKey: 'hidden' } },
] }];

test('showing a hidden parent preserves each child own visibility', () => {
  const visibleChild = object({ _layerId: 2 });
  const hiddenChild = object({ _layerId: 3 });
  const canvas = { getObjects: () => [visibleChild, hiddenChild], __psdVisibilityOverrides: {} };
  state.applyPsdVisibilityState(canvas, layers);
  assert.equal(visibleChild.visible, false);
  assert.equal(visibleChild._psdOwnVisible, true);
  canvas.__psdVisibilityOverrides.group = true;
  state.applyPsdVisibilityState(canvas, layers);
  assert.equal(visibleChild.visible, true);
  assert.equal(hiddenChild.visible, false);
  canvas.__psdVisibilityOverrides.hidden = true;
  state.applyPsdVisibilityState(canvas, layers);
  assert.equal(hiddenChild.visible, true);
});

test('stable PSD keys reconnect visibility after server layer ids change', () => {
  const saved = object({ _layerId: 987, _psdSourceKey: 'hidden' });
  let refreshed = false;
  const canvas = { getObjects: () => [saved], __psdVisibilityOverrides: { group: true, hidden: true },
    __psdSceneSession: { refresh: () => { refreshed = true; } } };
  state.applyPsdVisibilityState(canvas, layers);
  assert.equal(saved._layerId, 3);
  assert.equal(saved.visible, true);
  assert.equal(refreshed, true);
});

test('text conversion retains independent mask, clip key and original transform', () => {
  const preview = { _psdSourceKey: 'text', _psdClipBaseKey: 'image', _psdOwnVisible: true,
    _psdMask: { imagePath: 'mask.png' }, _psdOriginalTransform: [1, 0, 0, 1, 10, 20], _psdOriginalDimensions: [20, 30, -0.5, -0.5] };
  const edited = {};
  state.copyPsdSourceMetadata(preview, edited);
  assert.deepEqual(edited, preview);
});

test('scene text editing excludes legacy layer effects and retains native typography stroke plus user overrides', () => {
  const legacy = { fontFamily: 'Arial', fill: 'red', stroke: 'green', strokeWidth: 8, shadow: { blur: 9 }, effects: { stroke: { size: 8 } },
    psdNativeTextStroke: { stroke: 'black', strokeWidth: 1 } };
  const source = { _psdSceneObject: true };
  const options = state.getPsdEditableSourceTextOptions(source, legacy);
  assert.equal(options.stroke, 'black'); assert.equal(options.strokeWidth, 1);
  assert.equal(options.shadow, undefined); assert.equal(options.effects, undefined);
  state.markPsdNativeEffectOverride(source, 'stroke'); state.markPsdNativeEffectOverride(source, 'dropShadow');
  Object.assign(source, { stroke: 'blue', strokeWidth: 2, shadow: { blur: 4 } });
  const edited = state.getPsdEditableSourceTextOptions(source, legacy);
  assert.equal(edited.stroke, 'blue'); assert.equal(edited.strokeWidth, 2); assert.equal(edited.shadow.blur, 4);
  assert.equal(legacy.stroke, 'green', 'Original PSD layer parameters stay intact');
});

test('PSD to blank reset removes compositor and scene state before the blank canvas can be saved', () => {
  let disposed = 0;
  const canvas = { __psdScene: { layers }, __psdSceneVersion: 1, __psdVisibilityOverrides: { hidden: true },
    __psdSceneSession: { dispose: () => { disposed++; } } };
  state.resetPsdCanvasScene(canvas);
  assert.equal(disposed, 1);
  assert.deepEqual(Object.keys(canvas), []);
});

test('PSD scene and visibility survive JSON save and reload', async () => {
  const fabric = require('fabric');
  const document = loadModule('../src/editor/engine/fabricDocument.ts', { '../psdImportState': state, fabric });
  const scene = { version: 1, width: 3000, height: 2000, layers };
  const canvas = { __psdScene: scene, __psdSceneVersion: 1, __psdVisibilityOverrides: { hidden: true }, toJSON: () => ({ objects: [] }) };
  const saved = document.serializeFabricCanvasToFabricJson(canvas);
  const restored = { loadFromJSON: async () => {}, requestRenderAll() {} };
  await document.loadPersistedEditorStateIntoFabricCanvas(restored, JSON.parse(JSON.stringify(saved)));
  assert.equal(restored.__psdScene.width, 3000);
  assert.equal(restored.__psdScene.layers[0].properties.psdSourceKey, 'group');
  assert.equal(restored.__psdVisibilityOverrides.hidden, true);
  assert.ok(fabric.FabricObject.customProperties.includes('_psdOriginalTransform'));
});

test('raw import includes hidden children and does not bake parent opacity or masks', async () => {
  const created = [];
  const context = editorFunctions(['loadRawPsdLayerObjects'], {
    loadFabricImageFromUrl: async () => object({ width: 10, height: 10 }),
    getLayerImageScale: () => ({ scaleX: 1, scaleY: 1 }),
  });
  const raw = layers[0].children.map((layer, index) => ({ ...layer, sortOrder: index, imagePath: `${index}.png`, x: 0, y: 0 }));
  const count = await context.loadRawPsdLayerObjects({ add: (item) => created.push(item) }, [{ ...layers[0], children: raw }], (p) => p, [], () => {});
  assert.equal(count, 2);
  assert.equal(created[0].opacity, 0.9);
  assert.equal(created[1].visible, false);
  assert.equal(created[0]._psdSceneObject, true);
  assert.equal(created[0].clipPath, undefined);
});

test('raw image late response cannot attach to a switched editor', async () => {
  let current = true;
  const created = [];
  const context = editorFunctions(['loadRawPsdLayerObjects'], {
    loadFabricImageFromUrl: async () => { current = false; return object({ width: 10, height: 10 }); },
    getLayerImageScale: () => ({ scaleX: 1, scaleY: 1 }),
  });
  const count = await context.loadRawPsdLayerObjects({ add: (item) => created.push(item) }, [{ ...layers[0].children[0], imagePath: 'image.png' }], (p) => p, [], () => {}, () => current);
  assert.equal(count, 0);
  assert.equal(created.length, 0);
});

test('raw PSD image uses a stable upload URL and keeps source asset metadata', async () => {
  let loadedUrl;
  let added;
  const context = editorFunctions(['loadRawPsdLayerObjects'], {
    loadFabricImageFromUrl: async (url) => { loadedUrl = url; return object({ width: 10, height: 10, src: url }); },
    getLayerImageScale: () => ({ scaleX: 1, scaleY: 1 }),
  });
  await context.loadRawPsdLayerObjects({ add: (item) => { added = item; } }, [{ ...layers[0].children[0], imagePath: 'parsed/old/source.png' }], (p) => `/uploads/${p}`, [], () => {});
  assert.equal(loadedUrl, '/uploads/parsed/old/source.png');
  assert.equal(added.src, loadedUrl); assert.equal(added._psdImagePath, 'parsed/old/source.png');
});

test('native shape import retains its descriptor geometry instead of raster crop geometry', async () => {
  let added;
  const shape = object({ left: 20, top: 30, width: 40, height: 50, _psdSimpleShape: true });
  const context = editorFunctions(['loadRawPsdLayerObjects'], {
    createPsdSimpleShape: () => shape,
    loadFabricImageFromUrl: () => { throw new Error('Reliable primitive must stay native'); },
    getLayerImageScale: () => { throw new Error('Raster crop must not replace primitive geometry'); },
  });
  const count = await context.loadRawPsdLayerObjects({ add: (item) => { added = item; } }, [{ ...layers[0].children[0], layerType: 'shape', x: 99, y: 99 }], (p) => p, [], () => {});
  assert.equal(count, 1); assert.equal(added.left, 20); assert.equal(added.top, 30);
  assert.equal(added.width, 40); assert.equal(added._psdSimpleShape, true);
});

test('composite fallback fills original document dimensions', async () => {
  let added;
  const diagnostics = [];
  const context = editorFunctions(['loadPsdCompositeFallback'], { loadFabricImageFromUrl: async () => object({ width: 800, height: 400 }) });
  await context.loadPsdCompositeFallback({ add: (item) => { added = item; } }, {
    width: 3200, height: 1600, parseResult: { compositePath: 'composite.png' },
  }, (p) => p, (items) => diagnostics.push(...items));
  assert.equal(added.scaleX, 4);
  assert.equal(added.scaleY, 4);
  assert.equal(added.selectable, false);
  assert.equal(diagnostics[0].code, 'composite-fallback');
});

test('late complete-composite response cannot attach to a switched blank canvas', async () => {
  const context = editorFunctions(['loadPsdCompositeFallback'], { loadFabricImageFromUrl: async () => object({ width: 800, height: 400 }) });
  await context.loadPsdCompositeFallback({ add() { throw new Error('Stale composite must not attach'); } }, {
    width: 3200, height: 1600, parseResult: { compositePath: 'composite.png' },
  }, (p) => p, () => {}, () => false);
});

test('only current raw PSD/PSB enters the scene renderer', () => {
  const context = editorFunctions(['isPsdFileType', 'usesRawPsdScene', 'hasPsdLayerEffectMetadata'], { parserVersions: { psd: 9 } });
  assert.equal(context.usesRawPsdScene({ fileType: 'psb', parseResult: { psdParserVersion: 9, rasterContentMode: 'raw' } }), true);
  assert.equal(context.usesRawPsdScene({ fileType: 'psd', parseResult: { psdParserVersion: 8 } }), false);
  assert.equal(context.hasPsdLayerEffectMetadata({ psdParserVersion: 8 }), false);
});

test('toolbar PSB upload follows the parser upload route and input accepts the extension', async () => {
  const filename = path.resolve(__dirname, '../src/editor/EditorToolbar.tsx');
  const tree = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  let acceptPsb = false;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'handleOpenFile') declaration = node;
    if (ts.isJsxAttribute(node) && node.name.getText(tree) === 'accept' && ts.isStringLiteral(node.initializer)) acceptPsb ||= node.initializer.text.split(',').includes('.psb');
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.ok(declaration); assert.equal(acceptPsb, true);
  const uploaded = [];
  const context = { canvas: {}, engine: null, navigate: (url) => uploaded.push(url),
    FormData: class { append(key, value) { uploaded.push([key, value]); } },
    appendClientUploadPreview: async () => {}, uploadFile: async () => ({ id: 42 }),
    message: { loading: () => () => {}, success() {}, error() { throw new Error('PSB upload must succeed'); }, warning() { throw new Error('PSB must be recognized'); } },
  };
  const code = ts.transpileModule(`const ${declaration.getText(tree)}; globalThis.run = handleOpenFile;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, context);
  await context.run({ target: { files: [{ name: 'large.PSB' }], value: 'large.PSB' } });
  assert.equal(uploaded.at(-1), '/editor/42');
  assert.ok(uploaded.some((item) => Array.isArray(item) && item[0] === 'storageScope' && item[1] === 'my'));
});

test('saved scene bypasses legacy typography and effects repairs', async () => {
  const context = editorFunctions(['normalizeLoadedPsdTextObjects', 'repairPsdManualLineHeightsFromSavedState', 'repairPsdVerticalTextsFromSavedState', 'refitDinTextsFromSavedState']);
  const canvas = { __psdScene: { version: 1 }, getObjects() { throw new Error('legacy repair must not touch a scene source'); } };
  assert.equal(context.normalizeLoadedPsdTextObjects(canvas, 'psd'), undefined);
  assert.equal(context.repairPsdManualLineHeightsFromSavedState(canvas, layers), false);
  assert.equal(await context.repairPsdVerticalTextsFromSavedState(canvas, layers), false);
  assert.equal(await context.refitDinTextsFromSavedState(canvas, layers), undefined);
});
