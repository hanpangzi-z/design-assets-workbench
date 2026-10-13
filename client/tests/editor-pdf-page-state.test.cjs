const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const fabric = require('fabric');
const { createCanvas } = require('@napi-rs/canvas');

// Exercise the real saved-state selection, stale-import rejection and user
// recovery helpers. Fabric object enlivening is real; the canvas/DOM boundary
// only records layer order, avoiding a React mount or live server.
const editorPath = path.resolve(__dirname, '../src/pages/Editor/index.tsx');
const source = ts.createSourceFile(editorPath, fs.readFileSync(editorPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['normalizeEditorState', 'hasEditorStateOwnerMismatch', 'getEditorStateForDocumentPage',
  'shouldUseSavedEditorState', 'isCompleteCurrentPdfEditorState', 'isCompatibleLegacyPdfEditorState',
  'hasReliableLegacyEditablePdfMetadata', 'hasPdfEditableMetadata', 'createPersistableCanvasState', 'getParsedDocumentPages', 'getParsedDocumentPage',
  'isPdfAuxiliaryImageRole', 'readSerializedObjectProperty', 'readSerializedPdfAuxiliaryRole',
  'isSerializedPdfAuxiliaryPreviewObject', 'isPdfRasterVisualRecord', 'applySerializedNonInteractiveVisualObject',
  'sanitizePersistedPdfRasterVisualObjects', 'sanitizePersistedObjectArray', 'sanitizePersistedRecord',
  'readSerializedSvgObjectRole', 'normalizeSvgObjectRole', 'isInteractiveSvgObjectRole', 'isSkippedSvgObjectRole',
  'isImportedVectorType', 'collectSerializedCanvasObjects', 'savedStateUsesStaleImportedTextPreviewMode',
  'savedStateUsesImportedTextPreviewMode', 'savedStateHasOcrImportedTextObject',
  'savedStateHasInteractivePdfRasterVisualObject', 'savedStateHasPdfAuxiliaryPreviewObject',
  'savedStateLooksLikeLegacyImportedSvgFragments', 'savedStateHasUnpairedSvgDecorationMembers',
  'savedStateHasPdfImportedTextObject', 'getExpectedPdfExportableRasterCount',
  'filterParsedLayersForPage', 'countPdfLayerTreeExportableRasters', 'countSavedStatePdfExportableImageObjects',
  'getExpectedSvgInteractiveVectorCount', 'savedStateHasSvgInteractiveVectorObject', 'savedStateHasPdfEditableObject',
  'extractRecoverableUserObjectsFromRejectedImportedState', 'isRecoverableUserSerializedObject',
  'serializedRecordHasImportedPdfAiMarkers', 'cloneSerializedRecord', 'sanitizeRecoveredUserSerializedRecord',
  'appendRecoveredImportedStateUserObjects', 'normalizeRecoveredUserCanvasObject',
  'restoreSavedEditablePdfLayerState', 'mergePdfPageCompositeUnderlayLayerState', 'isPdfPageCompositeUnderlayObject',
  'isPdfRasterVisualObject', 'removePreviewLayers', 'isPreviewLayer', 'isTextMetadataLayer',
  'foldSvgVectorAtomPanelLayers', 'isSvgVectorAtomLayer', 'hasTrustedSavedPdfContent',
  'shouldReviewEmptySavedPdfState', 'createConfirmedEmptyPdfState', 'getEditablePdfPageSvgPath'];
const constants = ['CURRENT_PDF_PARSER_VERSION', 'CURRENT_AI_PARSER_VERSION', 'IMPORTED_SVG_ROLE_MODEL_VERSION',
  'IMPORTED_TEXT_PREVIEW_MODE_VERSION', 'SVG_DECORATION_GROUP_ROLE', 'SVG_VECTOR_ATOM_ROLE', 'SVG_VECTOR_SUMMARY_ROLE',
  'SVG_VECTOR_ATOM_FOLD_THRESHOLD', 'SVG_VECTOR_SUMMARY_LAYER_ID'];
function declaration(name) {
  const found = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(found, `Real implementation ${name} must exist`);
  return found.getText(source);
}
const constantText = constants.map(name => {
  let declaration;
  for (const node of source.statements) {
    if (ts.isVariableStatement(node)) declaration ||= node.declarationList.declarations.find(entry => entry.name.getText(source) === name);
  }
  assert.ok(declaration, name);
  return `const ${declaration.getText(source)};`;
}).join('\n');
const registration = source.statements.find(node => ts.isExpressionStatement(node)
  && node.expression.getText(source).startsWith('fabricObjectClass.customProperties ='));
vm.runInNewContext(ts.transpileModule(registration.getText(source), {}).outputText,
  { fabricObjectClass: fabric.FabricObject, PSD_SOURCE_CUSTOM_PROPERTIES: [], Array, Set });
const js = ts.transpileModule([constantText, ...names.map(declaration),
  `module.exports = { ${names.join(',')}, CURRENT_PDF_PARSER_VERSION, IMPORTED_SVG_ROLE_MODEL_VERSION };`,
].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
let autosaveEffect;
let finishInitialCanvasLoad;
function findAutosaveEffect(node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect'
    && node.arguments[0]?.getText(source).includes("'autosave snapshot'")) autosaveEffect = node.arguments[0];
  ts.forEachChild(node, findAutosaveEffect);
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'finishInitialCanvasLoad') finishInitialCanvasLoad = node.initializer;
}
findAutosaveEffect(source);
assert.ok(autosaveEffect, 'The actual Editor autosave effect must exist');
const autosaveJs = ts.transpileModule(`(${autosaveEffect.getText(source)})()`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const finishLoadJs = ts.transpileModule(`(${finishInitialCanvasLoad.getText(source)})()`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function harness({ failRecovery = false } = {}) {
  let disposed = false;
  let removed = false;
  class DetachedCanvas {
    async loadFromJSON(state) {
      if (failRecovery) throw new Error('Cannot load existing user image');
      this.objects = await fabric.util.enlivenObjects(state.objects);
    }
    getObjects() { return this.objects; }
    remove(object) { this.objects.splice(this.objects.indexOf(object), 1); }
    dispose() { disposed = true; }
  }
  const context = { module: { exports: {} }, parserVersions: require(path.resolve(__dirname, '../../shared/parserVersions.json')), isPsdFileType: value => value === 'psd', console: { log() {}, warn() {}, info() {} },
    parsePositiveInt: (value, fallback) => Number(value) > 0 ? Number(value) : fallback,
    EDITOR_STATE_OWNER_VERSION: 1,
    validateCanvasStateBeforePersist: () => ({ valid: true }),
    serializeFabricCanvasToFabricJson: canvas => ({ objects: canvas.getObjects().map(object => object.toObject()) }),
    canvasHasImportedTextPreviewHitAreas: () => false,
    document: { createElement: () => ({ remove() { removed = true; } }) },
    fabric: { StaticCanvas: DetachedCanvas }, restoreTransparentHitTesting: () => {} };
  vm.runInNewContext(js, context);
  return { ...context.module.exports, get disposed() { return disposed; }, get removed() { return removed; },
    startAutosave(bindings) { Object.assign(context, bindings); return vm.runInNewContext(autosaveJs, context); },
    finishLoad(bindings) { Object.assign(context, bindings); return vm.runInNewContext(finishLoadJs, context); } };
}
function pageState(page, objects, overrides = {}) {
  return { __editorStateOwnerVersion: 1, __fileId: 7002, __sourceFileId: 7001, __pageNumber: page,
    __pdfParserVersion: 77, objects, ...overrides };
}
function file(overrides = {}) {
  return { id: 7002, sourceFileId: 7001, isPersonalCopy: true, fileType: 'pdf', parseStatus: 'completed',
    parseResult: { pdfParserVersion: 79, textLayersAreMetadata: true,
      rasterImageLayerCount: 3, editableVectorCount: 20, pages: [
        { page: 1, previewOnly: false, svgPath: 'parsed/example/page-1.svg', rasterImageLayerCount: 1, editableVectorCount: 20 },
        { page: 2, previewOnly: false, svgPath: 'parsed/example/page-2.svg', rasterImageLayerCount: 2, editableVectorCount: 0 },
      ] }, ...overrides };
}
function background(page) {
  return { type: 'Image', _layerId: -1000000010, _pdfPreviewOnlyBackground: true,
    _pdfPreviewOnlyPage: page, _pdfPreviewOnlyPath: `parsed/example/page-${page}.png`, selectable: false, evented: false };
}

test('upgrade selects each owned preview-era page even when both current pages are editable SVG', () => {
  const h = harness();
  const one = pageState(1, [background(1), { type: 'Textbox', text: 'first annotation', _layerId: 'local-first' }]);
  const two = pageState(2, [background(2), { type: 'Textbox', text: 'second annotation', _layerId: 'local-second' }]);
  const saved = file({ editorState: { ...two, __pageStates: { '1': one, '2': two } } });
  assert.equal(h.getEditorStateForDocumentPage(saved, 1).objects[1].text, 'first annotation');
  assert.equal(h.getEditorStateForDocumentPage(saved, 2).objects[1].text, 'second annotation');
  assert.equal(h.getEditorStateForDocumentPage(file({ editorState: two }), 1), null);
  for (const extra of [{ __fileId: 22 }, { __sourceFileId: 33 }, { __pageNumber: 2 }, { __editorStateOwnerVersion: Infinity }]) {
    assert.equal(h.getEditorStateForDocumentPage(file({ editorState: { ...two,
      __pageStates: { '1': { ...one, ...extra }, '2': two } } }), 1), null);
  }
});

test('old background and source imports are rejected while local text, image and groups survive recovery', () => {
  const h = harness();
  const objects = [background(1), { type: 'Path', _layerId: -6, _svgObjectRole: 'editable-vector' },
    { type: 'Textbox', _layerId: 52, _layerType: 'text', text: 'old source' },
    { type: 'Textbox', _layerId: 'local-text', _layerType: 'text', text: 'my text' },
    { type: 'Image', _layerId: 'local-image', src: 'data:image/png;base64,existing', left: 15 },
    { type: 'Group', _layerId: 'group-user', objects: [{ type: 'Rect', _layerId: 'local-shape', fill: 'red' }] }];
  const state = pageState(1, objects);
  const before = JSON.stringify(state);
  assert.equal(h.shouldUseSavedEditorState(file(), state, [], 1), false);
  // Even a snapshot mislabeled as the new version must never restore the old page PNG over new objects.
  assert.equal(h.shouldUseSavedEditorState(file(), { ...state, __pdfParserVersion: 78 }, [], 1), false);
  const recovered = h.extractRecoverableUserObjectsFromRejectedImportedState(file(), state);
  assert.deepEqual(Array.from(recovered, object => object._layerId), ['local-text', 'local-image', 'group-user']);
  assert.equal(recovered[0].text, 'my text');
  assert.equal(recovered[1].left, 15);
  assert.equal(JSON.stringify(state), before, 'Recovery must not alter the persisted original state');
});

test('recovered real Fabric user shape is layered above the newly parsed source and remains selectable', async () => {
  const h = harness();
  const user = new fabric.Rect({ left: 23, top: 11, width: 10, height: 6, fill: '#12aa44' });
  user._layerId = 'local-my-shape';
  const old = pageState(1, [background(1), user.toObject()]);
  const recovered = h.extractRecoverableUserObjectsFromRejectedImportedState(file(), old);
  const parsed = new fabric.Rect({ width: 32, height: 24, fill: 'white' });
  const objects = [parsed];
  const canvas = { getWidth: () => 32, getHeight: () => 24, add: object => objects.push(object) };
  assert.equal(await h.appendRecoveredImportedStateUserObjects(canvas, recovered), 1);
  assert.equal(objects[0], parsed);
  assert.equal(objects[1]._layerId, 'local-my-shape');
  assert.equal(objects[1].left, 23);
  assert.equal(objects[1].fill, '#12aa44');
  assert.equal(objects[1].selectable, true);
  assert.equal(objects[1].evented, true);
  assert.equal(h.disposed, true);
  assert.equal(h.removed, true);
});

test('a valid new SVG page preserves source edits and local text without counts from another page', () => {
  const h = harness();
  const one = pageState(1, [
    { type: 'Path', _layerId: -7, _svgObjectRole: 'editable-vector', left: 55 },
    { type: 'Group', _layerId: -8, _svgObjectRole: 'editable-vector', objects: [
      { type: 'Image', _layerId: -9, _svgObjectRole: 'editable-raster', src: 'fixture', selectable: true },
    ] },
    { type: 'Textbox', _layerId: 'local-added-text', _layerType: 'text', text: 'keep my addition' },
  ], { __pdfParserVersion: 79, __pdfSceneCompleteVersion: 2, __importedSvgRoleModelVersion: h.IMPORTED_SVG_ROLE_MODEL_VERSION });
  assert.equal(h.shouldUseSavedEditorState(file(), one, [], 1), true);
  const two = pageState(2, [
    { type: 'Image', _layerId: -21, _svgObjectRole: 'editable-raster', src: 'fixture', selectable: true },
    { type: 'Image', _layerId: -22, _svgObjectRole: 'editable-raster', src: 'fixture', selectable: true },
  ], { __pdfParserVersion: 79, __pdfSceneCompleteVersion: 2, __importedSvgRoleModelVersion: h.IMPORTED_SVG_ROLE_MODEL_VERSION });
  assert.equal(h.shouldUseSavedEditorState(file(), two, [], 2), true);
  assert.equal(h.shouldUseSavedEditorState(file(), { ...one, __pdfParserVersion: 77 }, [], 1), true);
});

test('user content recovery failure rejects loading instead of making an incomplete canvas autosavable', async () => {
  const h = harness({ failRecovery: true });
  const canvas = { getWidth: () => 32, getHeight: () => 24, add() { throw new Error('Do not attach partially loaded content'); } };
  await assert.rejects(h.appendRecoveredImportedStateUserObjects(canvas,
    [{ type: 'Image', _layerId: 'local-existing-image', src: 'invalid-image' }]), /Cannot load existing user image/);
  assert.equal(h.disposed, true);
  assert.equal(h.removed, true);
});

test('a fully loaded current owned PDF persists moved source objects, deletions and intentionally empty pages', () => {
  const h = harness();
  const shape = new fabric.Rect({ left: 23, top: 11, width: 10, height: 6, fill: '#12aa44' });
  shape._layerId = -31;
  shape._svgObjectRole = 'editable-vector';
  const objects = [shape];
  const canvas = { __benlaiPdfParserVersion: 78, __benlaiPdfSceneLoadedVersion: 78, __benlaiPdfSceneCompleteVersion: 2,
    __benlaiImportedSvgRoleModelVersion: h.IMPORTED_SVG_ROLE_MODEL_VERSION,
    __benlaiCanvasOwner: { fileId: 7002, sourceFileId: 7001, pageNumber: 1 }, getObjects: () => objects };
  // The old page had a source raster image which the user has deliberately deleted.
  const moved = h.createPersistableCanvasState(canvas, 'test complete PDF save');
  assert.equal(moved.__pdfSceneCompleteVersion, 2);
  assert.equal(moved.objects[0].left, 23);
  assert.equal(h.shouldUseSavedEditorState(file(), moved, [], 1), true);
  assert.equal(h.shouldUseSavedEditorState(file(), { ...moved, __pdfSceneCompleteVersion: undefined }, [], 1), false,
    'Older snapshots must still satisfy completeness protection');
  objects.splice(0);
  const empty = h.createPersistableCanvasState(canvas, 'test intentional delete all');
  assert.equal(empty.objects.length, 0);
  assert.equal(h.shouldUseSavedEditorState(file(), empty, [], 1), true);
  for (const extra of [{ __pdfParserVersion: 76 }, { __fileId: 8 }, { __sourceFileId: 9 },
    { __pageNumber: 2 }, { __editorStateOwnerVersion: undefined }, { __editorStateOwnerVersion: Infinity }]) {
    assert.equal(h.shouldUseSavedEditorState(file(), { ...empty, ...extra }, [], 1), false);
  }
});

test('a current PDF cannot serialize before scene load completes or after a failed recovery', () => {
  const h = harness();
  const canvas = { __benlaiPdfParserVersion: 78,
    __benlaiImportedSvgRoleModelVersion: h.IMPORTED_SVG_ROLE_MODEL_VERSION,
    __benlaiCanvasOwner: { fileId: 7002, sourceFileId: 7001, pageNumber: 2 }, getObjects: () => [] };
  assert.equal(h.createPersistableCanvasState(canvas, 'unfinished or failed PDF save'), null);
  canvas.__benlaiPdfSceneLoadedVersion = 77;
  assert.equal(h.createPersistableCanvasState(canvas, 'stale previous-page load'), null);
  canvas.__benlaiPdfSceneLoadedVersion = 78;
  canvas.__benlaiPdfSceneCompleteVersion = 2;
  assert.equal(h.createPersistableCanvasState(canvas, 'completed PDF save').__pageNumber, 2);
});

test('real autosave effect saves editable second-page edits and never reads a later page into the old snapshot', () => {
  const h = harness();
  const callbacks = new Map();
  const timers = new Map();
  let timerId = 0;
  const saves = [];
  const shape = new fabric.Rect({ left: 23, width: 10, height: 6 });
  shape._layerId = -31;
  shape._svgObjectRole = 'editable-vector';
  const canvas = { __benlaiPdfParserVersion: 78, __benlaiPdfSceneLoadedVersion: 78, __benlaiPdfSceneCompleteVersion: 2,
    __benlaiImportedSvgRoleModelVersion: h.IMPORTED_SVG_ROLE_MODEL_VERSION,
    __benlaiCanvasOwner: { fileId: 7002, sourceFileId: 7001, pageNumber: 2, generation: 5 },
    getObjects: () => [shape], on: (event, callback) => callbacks.set(event, callback), off: event => callbacks.delete(event) };
  const generation = { current: 5 };
  const cleanup = h.startAutosave({ canvas, fileData: file(), contentLoaded: true, routePageNumber: 2,
    canvasGenerationRef: generation,
    saveEditorState: async (id, state) => { saves.push({ id, state }); },
    window: { setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id) } });
  assert.ok(callbacks.has('object:modified'), 'Editable multi-page SVG must install the actual autosave handlers');
  callbacks.get('object:modified')();
  assert.equal(timers.size, 1);
  // The old page snapshot is already frozen. A late event must neither replace
  // it with the new page nor send the new page through the old effect owner.
  canvas.__benlaiCanvasOwner = { fileId: 7002, sourceFileId: 7001, pageNumber: 1, generation: 6 };
  generation.current = 6;
  shape.set({ left: 99 });
  callbacks.get('object:modified')();
  assert.equal(timers.size, 1);
  cleanup();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].id, 7002);
  assert.equal(saves[0].state.__pageNumber, 2);
  assert.equal(saves[0].state.__sourceFileId, 7001);
  assert.equal(saves[0].state.__pdfSceneCompleteVersion, 2);
  assert.equal(saves[0].state.objects[0].left, 23);
  assert.equal(timers.size, 0);
});

test('owned editable PDF77 source paths/images keep real moves, recolors and deletes after an explicit parse78 upgrade', () => {
  const h = harness();
  const pathObject = new fabric.Path('M 0 0 L 20 0 L 20 20 z', { left: 71, top: 25, fill: '#ab34cd' });
  pathObject._layerId = -11;
  pathObject._svgObjectRole = 'editable-vector';
  const element = createCanvas(8, 8);
  element.classList = { add() {}, remove() {} };
  const imageObject = new fabric.FabricImage(element, { left: 90, top: 15, scaleX: 1.5 });
  imageObject._layerId = -12;
  imageObject._svgObjectRole = 'editable-raster';
  const prior = pageState(1, [pathObject.toObject(), imageObject.toObject()], {
    __importedSvgRoleModelVersion: h.IMPORTED_SVG_ROLE_MODEL_VERSION });
  assert.equal(h.shouldUseSavedEditorState(file(), prior, [], 1), true);
  assert.equal(prior.objects[0].left, 71);
  assert.equal(prior.objects[0].fill, '#ab34cd');
  assert.equal(prior.objects[1].left, 90);
  assert.equal(prior.objects[1].scaleX, 1.5);
  assert.equal(h.shouldUseSavedEditorState(file(), { ...prior, objects: [prior.objects[0]] }, [], 1), true,
    'The source image deleted by the user must not be restored by fresh import');
  assert.equal(h.shouldUseSavedEditorState(file(), { ...prior, objects: [] }, [], 1), false);
  assert.equal(h.shouldReviewEmptySavedPdfState(file(), { ...prior, objects: [] }, 1), true);
  assert.equal(h.shouldUseSavedEditorState(file(), { ...prior, objects: [background(1), ...prior.objects] }, [], 1), false,
    'A preview-only legacy scene still rebuilds and recovers only user additions');
  const normal77 = { pdfParserVersion: 77, editableSvg: true, previewOnly: false, svgPath: 'parsed/old/editable.svg' };
  assert.equal(h.hasPdfEditableMetadata(normal77), true, 'Opening a reliable legacy SVG must not force a client reparse');
  assert.equal(h.shouldUseSavedEditorState(file({ parseResult: normal77 }), prior, [], 1), true);
  assert.equal(h.hasPdfEditableMetadata({ ...normal77, previewOnly: true }), false);
  assert.equal(h.hasPdfEditableMetadata({ ...normal77, svgVisualReliable: false }), false);
  assert.equal(h.shouldUseSavedEditorState(file(), { ...prior, __pdfParserVersion: 76 }, [], 1), false);
});

function sourceImage(id, options = {}) {
  const element = createCanvas(8, 8);
  element.classList = { add() {}, remove() {} };
  const image = new fabric.FabricImage(element, options);
  image._layerId = id;
  image._layerName = `Source image ${id}`;
  image._svgObjectRole = 'editable-raster';
  return image;
}

test('saved Cairo PDF restores the same 42 panel layers from its 560 real source objects without changing a moved image', () => {
  const h = harness();
  const paths = Array.from({ length: 519 }, (_, index) => {
    const object = new fabric.Path('M 0 0 L 20 0 L 20 20 z', { fill: '#123456' });
    object._layerId = -index - 1;
    object._svgObjectRole = 'editable-vector';
    return object;
  });
  const images = Array.from({ length: 41 }, (_, index) => sourceImage(-520 - index,
    index === 0 ? { left: 319, top: 431, scaleX: 1.5 } : {}));
  const objects = [...paths, ...images];
  const canvas = { getObjects: () => objects, getActiveObject: () => images[0] };
  const apiLayers = [{ id: 21, fileId: 7001, layerType: 'text', properties: { role: 'text-metadata', page: 1 } }];
  assert.equal(h.removePreviewLayers(h.mergePdfPageCompositeUnderlayLayerState(canvas, apiLayers, 7002)).length, 0,
    'A successful metadata-only API response reproduced the former empty layer panel');
  const before = JSON.stringify(objects.map(object => object.toObject()));
  const restored = h.restoreSavedEditablePdfLayerState(canvas, apiLayers, 7002, 1);
  const visibleLayers = h.filterParsedLayersForPage(h.removePreviewLayers(restored), 1);
  const panel = h.foldSvgVectorAtomPanelLayers(visibleLayers);
  assert.equal(visibleLayers.length, 560);
  assert.equal(panel.length, 42);
  assert.equal(panel[0].properties.atomCount, 519);
  const moved = panel.find(layer => layer.id === images[0]._layerId);
  assert.equal(moved.layerName, images[0]._layerName);
  assert.equal(moved.layerType, 'image');
  assert.equal(moved.fileId, 7002);
  assert.equal(moved.x, 319);
  assert.equal(moved.y, 431);
  assert.equal(moved.properties.svgObjectRole, 'editable-raster');
  assert.equal(canvas.getActiveObject(), images[0]);
  assert.equal(images[0].selectable, true);
  assert.equal(JSON.stringify(objects.map(object => object.toObject())), before,
    'Rebuilding panel records must not alter saved objects, source IDs, selection or groups');
});

test('saved PDF panel follows deletions, hidden images and editable groups while excluding preview and visual metadata', () => {
  const h = harness();
  const hidden = sourceImage(-11, { visible: false, selectable: false, evented: false });
  const group = new fabric.Group([new fabric.Rect({ width: 12, height: 8 })]);
  group._layerId = -12;
  group._layerName = 'Source decoration group';
  group._svgObjectRole = 'decoration-vector';
  group._svgDecorationProxy = true;
  const excluded = [
    { _pdfPreviewOnlyBackground: true }, { _pdfVisualBacking: true }, { _pdfMaskArtifact: true },
    { _svgObjectRole: 'text-outline' }, { _svgObjectRole: 'visual-raster' },
    { _svgDecorationMember: true }, { _svgDecorationVisualOnly: true },
  ].map((properties, index) => Object.assign(new fabric.Rect({ width: 10, height: 10 }),
    { _layerId: -20 - index }, properties));
  const local = sourceImage('local-user-image');
  const objects = [hidden, group, ...excluded, local];
  const before = JSON.stringify(objects.map(object => object.toObject()));
  const staleSource = { id: -99, layerType: 'image', properties: { page: 2, role: 'editable-raster' } };
  const metadata = { id: 22, layerType: 'text', properties: { page: 2, role: 'text-metadata' } };
  const restored = h.restoreSavedEditablePdfLayerState({ getObjects: () => objects }, [staleSource, metadata], 7002, 2);
  assert.equal(restored.find(layer => layer.id === -99), undefined, 'Deleted source objects must not survive as panel ghosts');
  const panel = h.foldSvgVectorAtomPanelLayers(h.filterParsedLayersForPage(h.removePreviewLayers(restored), 2));
  assert.deepEqual(Array.from(panel, layer => layer.id), [-11, -12]);
  assert.equal(panel[0].visible, false, 'Hidden source objects must remain available to unhide');
  assert.equal(panel[1].layerType, 'group');
  assert.equal(panel[1].properties.role, 'svg-decoration-group');
  assert.equal(panel[1].layerName, 'Source decoration group');
  assert.equal(h.filterParsedLayersForPage(panel, 1).length, 0, 'Synthetic records must belong to the restored page');
  assert.equal(JSON.stringify(objects.map(object => object.toObject())), before);
});

test('saved PDF composite underlay retains its specialized layer record alongside restored SVG sources', () => {
  const h = harness();
  const underlay = sourceImage(-1000000011, { left: 15, top: 25 });
  Object.assign(underlay, { _pdfPageCompositeRole: 'underlay', _pdfPageRasterUnderlay: true,
    _pdfRasterFallbackEditable: true, _pdfPageCompositeId: 'pdf-page-2' });
  const source = new fabric.Rect({ width: 12, height: 8 });
  Object.assign(source, { _layerId: -11, _svgObjectRole: 'editable-vector' });
  const restored = h.restoreSavedEditablePdfLayerState({ getObjects: () => [underlay, source] }, [], 7002, 2);
  assert.equal(restored.length, 2);
  assert.equal(restored[0].id, underlay._layerId);
  assert.equal(restored[0].properties.rasterPageFallback, true);
  assert.equal(restored[0].properties.textUnderlaySource, true);
  assert.equal(restored[0].properties.page, 2);
  assert.equal(restored[1].id, source._layerId);
});

test('owned legacy empty PDF pages require review while trusted v2 empty pages stay intentionally empty', () => {
  const h = harness();
  for (const version of [77, 78]) {
    const empty = pageState(2, [], { __pdfParserVersion: version,
      __importedSvgRoleModelVersion: h.IMPORTED_SVG_ROLE_MODEL_VERSION, __pdfSceneCompleteVersion: 1 });
    const prior = JSON.stringify(empty);
    assert.equal(h.shouldReviewEmptySavedPdfState(file(), empty, 2), true);
    assert.equal(h.shouldUseSavedEditorState(file(), empty, [], 2), false);
    assert.equal(JSON.stringify(empty), prior, 'Review must retain the original empty snapshot');
    const confirmed = { ...empty, __pdfSceneCompleteVersion: 2 };
    assert.equal(h.shouldReviewEmptySavedPdfState(file(), confirmed, 2), false);
    assert.equal(h.shouldUseSavedEditorState(file(), confirmed, [], 2), true);
    assert.equal(h.shouldUseSavedEditorState(file(), { ...confirmed, __fileId: 999 }, [], 2), false);
  }
});

test('explicit empty-state confirmation applies only to the reviewed file, source, page and current canvas generation', () => {
  const h = harness();
  const prior = pageState(2, [], { __pdfParserVersion: 78, __pdfSceneCompleteVersion: 1,
    __importedSvgRoleModelVersion: h.IMPORTED_SVG_ROLE_MODEL_VERSION });
  const one = pageState(1, [{ type: 'Rect', _layerId: 'local-page-one', fill: 'red' }]);
  const f = file({ editorState: { ...prior, __pageStates: { '1': one, '2': prior } } });
  const original = JSON.stringify(f);
  const canvas = { __benlaiCanvasOwner: { fileId: 7002, sourceFileId: 7001, pageNumber: 2, generation: 5 }, getObjects: () => [] };
  const review = { fileId: 7002, sourceFileId: 7001, pageNumber: 2, generation: 5 };
  for (const extra of [{ fileId: 33 }, { sourceFileId: 44 }, { pageNumber: 1 }, { generation: 4 }]) {
    assert.equal(h.createConfirmedEmptyPdfState(canvas, f, 2, 5, { ...review, ...extra }), null);
  }
  assert.equal(h.createConfirmedEmptyPdfState(canvas, f, 2, 6, review), null);
  const confirmed = h.createConfirmedEmptyPdfState(canvas, f, 2, 5, review);
  assert.equal(confirmed.__pageNumber, 2);
  assert.equal(confirmed.__pdfSceneCompleteVersion, 2);
  assert.equal(confirmed.objects.length, 0);
  assert.equal(h.shouldUseSavedEditorState(f, confirmed, [], 2), true);
  assert.equal(JSON.stringify(f), original, 'Other pages and the original database state are not changed by review');
});

test('v1 and editable PDF77/78 saved source edits survive parser79 without treating intentional image deletion as damage', () => {
  const h = harness();
  const path = new fabric.Path('M 0 0 L 20 0 L 20 20 z', { left: 71, top: 25, fill: '#ab34cd' });
  Object.assign(path, { _layerId: -11, _svgObjectRole: 'editable-vector' });
  const hidden = sourceImage(-12, { left: 90, top: 15, visible: false, selectable: false, evented: false });
  const upgraded = file({ parseResult: { ...file().parseResult, pdfParserVersion: 79 } });
  for (const version of [77, 78]) {
    const state = pageState(1, [path.toObject(), hidden.toObject()], { __pdfParserVersion: version,
      __importedSvgRoleModelVersion: h.IMPORTED_SVG_ROLE_MODEL_VERSION, __pdfSceneCompleteVersion: 1 });
    assert.equal(h.shouldUseSavedEditorState(upgraded, state, [], 1), true);
    assert.equal(h.shouldUseSavedEditorState(upgraded, { ...state, objects: [state.objects[0]] }, [], 1), true);
    assert.equal(h.shouldUseSavedEditorState(upgraded, { ...state, objects: [state.objects[1]] }, [], 1), true);
    assert.equal(state.objects[0].left, 71);
    assert.equal(state.objects[0].fill, '#ab34cd');
    assert.equal(state.objects[1].left, 90);
  }
});

test('an unfinished fresh PDF cannot mint v2 from loadedVersion or a dropped failure placeholder', () => {
  const h = harness();
  const placeholder = { type: 'IText', _layerId: -1000007002, _pdfImportPlaceholder: true, _pdfPreviewFallback: true };
  const canvas = { __benlaiPdfParserVersion: 78, __benlaiPdfSceneLoadedVersion: 78,
    __benlaiImportedSvgRoleModelVersion: h.IMPORTED_SVG_ROLE_MODEL_VERSION,
    __benlaiCanvasOwner: { fileId: 7002, sourceFileId: 7001, pageNumber: 1 },
    getObjects: () => [{ toObject: () => placeholder }] };
  assert.equal(h.createPersistableCanvasState(canvas, 'failed import'), null);
  canvas.__benlaiPdfSceneCompleteVersion = 1;
  assert.equal(h.createPersistableCanvasState(canvas, 'old incomplete placeholder'), null);
  let completed = false;
  let error;
  const contextCanvas = { requestRenderAll() {} };
  h.finishLoad({ canvas: contextCanvas, editorCanvas: contextCanvas, fileData: file(), initialLoadFinished: false,
    previousRenderOnAddRemove: true, isCurrentLoad: () => true, contentLoadingRef: { current: true },
    pdfSceneCompletionVersion: undefined, previewOnlyLoadFailed: false,
    setContentLoaded: () => { completed = true; }, setContentLoading() {}, setPreviewLoadError: value => { error = value; } });
  assert.equal(completed, false, 'The actual finish callback must not report an invalid fresh scene as loaded');
  assert.equal(contextCanvas.__benlaiPdfSceneLoadedVersion, undefined);
  assert.ok(error);
});

test('fresh PDF page path resolution cannot substitute the first SVG for a missing second-page artifact', () => {
  const h = harness();
  const f = file({ parseResult: { pdfParserVersion: 79, svgPath: 'parsed/page-one.svg', pages: [
    { page: 1, svgPath: 'parsed/page-one.svg' }, { page: 2, previewOnly: false },
  ] } });
  assert.equal(h.getEditablePdfPageSvgPath(f, 1), 'parsed/page-one.svg');
  assert.throws(() => h.getEditablePdfPageSvgPath(f, 2), /缺少可编辑 SVG/);
  assert.throws(() => h.getEditablePdfPageSvgPath(f, 3), /缺少可编辑 SVG/);
  assert.throws(() => h.getEditablePdfPageSvgPath(file({ parseResult: { pdfParserVersion: 79 } }), 1), /缺少可编辑 SVG/);
});

test('actual last-object removal upgrades a reviewed legacy scene to trusted empty only for its current page and generation', () => {
  const h = harness();
  const callbacks = new Map();
  const timers = new Map();
  const saves = [];
  let timerId = 0;
  const shape = new fabric.Rect({ left: 21, top: 31, width: 8, height: 8 });
  shape._layerId = -8;
  shape._svgObjectRole = 'editable-vector';
  const objects = [shape];
  const canvas = { __benlaiPdfParserVersion: 79, __benlaiPdfSceneLoadedVersion: 79, __benlaiPdfSceneCompleteVersion: 1,
    __benlaiImportedSvgRoleModelVersion: h.IMPORTED_SVG_ROLE_MODEL_VERSION,
    __benlaiCanvasOwner: { fileId: 7002, sourceFileId: 7001, pageNumber: 2, generation: 5 },
    getObjects: () => objects, on: (event, callback) => callbacks.set(event, callback), off: event => callbacks.delete(event) };
  const generation = { current: 5 };
  const cleanup = h.startAutosave({ canvas, fileData: file(), contentLoaded: true, routePageNumber: 2,
    canvasGenerationRef: generation, saveEditorState: async (id, state) => saves.push({ id, state }),
    window: { setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id) } });
  callbacks.get('object:modified')();
  assert.equal(h.createPersistableCanvasState(canvas, 'old nonempty edit').__pdfSceneCompleteVersion, 1,
    'Loading a nonempty marker 1 scene must not silently certify its entire source import');
  objects.splice(0);
  callbacks.get('object:removed')();
  assert.equal(canvas.__benlaiPdfEmptySceneConfirmed, true);
  cleanup();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].state.__pdfSceneCompleteVersion, 2);
  assert.equal(saves[0].state.__pageNumber, 2);
  assert.equal(saves[0].state.objects.length, 0);
  assert.equal(h.shouldUseSavedEditorState(file(), saves[0].state, [], 2), true);
  assert.equal(h.shouldReviewEmptySavedPdfState(file(), saves[0].state, 2), false);

  for (const ownerChange of [{ fileId: 9002 }, { sourceFileId: 9001 }, { pageNumber: 1 }, { generation: 6 }]) {
    canvas.__benlaiCanvasOwner = { fileId: 7002, sourceFileId: 7001, pageNumber: 2, generation: 5 };
    canvas.__benlaiPdfEmptySceneConfirmed = false;
    const lateCleanup = h.startAutosave({ canvas, fileData: file(), contentLoaded: true, routePageNumber: 2,
      canvasGenerationRef: generation, saveEditorState: async () => assert.fail('A late removal must not save another owner'),
      window: { setTimeout: () => assert.fail('A late removal must not schedule an autosave'), clearTimeout() {} } });
    Object.assign(canvas.__benlaiCanvasOwner, ownerChange);
    callbacks.get('object:removed')();
    assert.equal(canvas.__benlaiPdfEmptySceneConfirmed, false);
    lateCleanup();
  }
});

test('a saved PDF 78 fallback cannot cover new PDF 79 objects on either page and recovery preserves real annotations', () => {
  const h = harness();
  const one = pageState(1, [background(1)], { __pdfParserVersion: 78, __pdfSceneCompleteVersion: 2,
    __importedSvgRoleModelVersion: h.IMPORTED_SVG_ROLE_MODEL_VERSION });
  const two = pageState(2, [background(2), { type: 'Textbox', text: 'second-page edit', _layerId: 'local-note', left: 30, top: 40 }], {
    __pdfParserVersion: 78, __pdfSceneCompleteVersion: 1, __importedSvgRoleModelVersion: h.IMPORTED_SVG_ROLE_MODEL_VERSION });
  const saved = file({ editorState: { ...two, __pageStates: { '1': one, '2': two } } });
  const original = JSON.stringify(saved.editorState);
  const first = h.getEditorStateForDocumentPage(saved, 1);
  const second = h.getEditorStateForDocumentPage(saved, 2);
  assert.equal(h.shouldUseSavedEditorState(saved, first, [], 1), false);
  assert.equal(h.shouldUseSavedEditorState(saved, second, [], 2), false);
  assert.equal(h.shouldReviewEmptySavedPdfState(saved, first, 1), false,
    'A proven old preview background is rebuilt instead of being mistaken for an intentional blank');
  assert.equal(h.extractRecoverableUserObjectsFromRejectedImportedState(saved, first).length, 0);
  const edits = h.extractRecoverableUserObjectsFromRejectedImportedState(saved, second);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].text, 'second-page edit');
  assert.equal(edits[0].left, 30);
  assert.equal(edits[0].top, 40);
  assert.equal(JSON.stringify(saved.editorState), original, 'Inspecting/recovering must not mutate the existing snapshot');
  assert.equal(h.getEditorStateForDocumentPage(file({ editorState: second }), 1), null,
    'The saved second-page background must not be used for the fresh first page');
});

test('the actual Cairo editability notice is limited to the current editable PDF or AI page', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  let notice;
  function findNotice(node) {
    if (ts.isJsxExpression(node) && node.expression?.getText(source).includes('转曲文字和复合效果可移动')) notice = node.expression;
    ts.forEachChild(node, findNotice);
  }
  findNotice(source);
  assert.ok(notice, 'Exercise the actual Editor notice, including its page guards');
  const compiled = ts.transpileModule(`module.exports = function Notice() { return (${notice.getText(source)}); }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
  const h = harness();
  const sourceFile = file({ parseResult: { svgFidelityMethod: 'cairo-source', pages: [
    { page: 1, svgPath: 'parsed/cairo/page-1.svg', svgFidelityMethod: 'cairo-source' },
    { page: 2, svgPath: 'parsed/ordinary/page-2.svg' },
    { page: 3, svgPath: 'parsed/cairo/page-3.svg', svgFidelityMethod: 'cairo-source', previewOnly: true },
    { page: 4, svgPath: '   ', svgFidelityMethod: 'cairo-source' },
  ] } });
  function render(candidate, page, failed = false) {
    const context = { React, Boolean, module: { exports: {} }, fileData: candidate, routePageNumber: page,
      activePanelPage: h.getParsedDocumentPage(candidate, page), parseFailed: failed };
    vm.runInNewContext(compiled, context);
    return renderToStaticMarkup(React.createElement(context.module.exports));
  }
  assert.match(render(sourceFile, 1), /转曲文字和复合效果可移动、缩放，不能直接修改字词；细密纹理可能有少量显示差异。/);
  assert.doesNotMatch(render(sourceFile, 1), /cairo-source/, 'Implementation labels are not product copy');
  for (const page of [2, 3, 4, 99]) {
    assert.equal(render(sourceFile, page), '', `Page ${page} must not inherit another page's Cairo notice`);
  }
  assert.equal(render(sourceFile, 1, true), '');
  assert.match(render({ ...sourceFile, fileType: 'ai' }, 1), /role="status"/);
  const singlePage = file({ parseResult: { svgPath: 'parsed/cairo/page.svg', svgFidelityMethod: 'cairo-source' } });
  assert.match(render(singlePage, 1), /转曲文字/);
  assert.equal(render(singlePage, 2), '', 'A single-page source does not supply a missing second page');
});

test('the actual empty-state review render keeps its Fabric canvas mounted and the confirmation button usable', async () => {
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const Module = require('node:module');
  const nativeCanvas = require('@napi-rs/canvas');
  const originalLoad = Module._load;
  let JSDOM;
  try {
    // Adapt the optional DOM canvas package boundary to the project's existing
    // napi implementation; the React DOM rendering/lifecycle below remains real.
    Module._load = function(request, parent, isMain) {
      return request === 'canvas' ? nativeCanvas : originalLoad.call(this, request, parent, isMain);
    };
    ({ JSDOM } = require('jsdom'));
  } finally { Module._load = originalLoad; }
  const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'EditorPage');
  const renderStart = component.body.statements.findIndex(node => ts.isIfStatement(node) && node.expression.getText(source) === 'loading');
  assert.ok(renderStart >= 0, 'Use the actual Editor render decisions including any early returns');
  const renderStatements = component.body.statements.slice(renderStart);
  const globals = {};
  function identifiers(node) {
    if (ts.isIdentifier(node)) globals[node.text] = /^[A-Z]/.test(node.text) ? () => null : undefined;
    ts.forEachChild(node, identifiers);
  }
  renderStatements.forEach(identifiers);
  let mounts = 0;
  let disposals = 0;
  let confirmations = 0;
  function CanvasBoundary() {
    React.useEffect(() => { mounts++; return () => { disposals++; }; }, []);
    return React.createElement('div', { 'data-testid': 'live-fabric-canvas' });
  }
  Object.assign(globals, { React, Boolean, EditorCanvas: CanvasBoundary, module: { exports: {} },
    isPsdFileType: value => value === 'psd' || value === 'psb',
    loading: false, parseFailed: false, canOpenFailureSavedState: false, previewLoadError: null,
    emptyPdfStateReview: null, parsedLayerCount: null, pendingTemplate: null, missingFonts: null,
    contentLoading: false, activePanel: 'none', fileData: file(), fileName: 'PDF', parseRetrying: false,
    isNewCanvas: false, canvas: {}, engine: null, handleKeepReviewedEmptyPdfState: () => { confirmations++; } });
  const compiled = ts.transpileModule(`module.exports = function renderEditor() {\n${renderStatements.map(node => node.getText(source)).join('\n')}\n}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  vm.runInNewContext(compiled, globals);
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousAct = global.IS_REACT_ACT_ENVIRONMENT;
  global.window = dom.window;
  global.document = dom.window.document;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(dom.window.document.getElementById('root'));
  try {
    await act(async () => { root.render(React.createElement(globals.module.exports)); });
    assert.equal(mounts, 1);
    assert.equal(disposals, 0);
    globals.emptyPdfStateReview = { fileId: 7002, sourceFileId: 7001, pageNumber: 2, generation: 5 };
    globals.previewLoadError = 'Needs explicit empty-state confirmation';
    await act(async () => { root.render(React.createElement(globals.module.exports)); });
    assert.equal(mounts, 1, 'An empty-state dialog must retain the existing canvas instance');
    assert.equal(disposals, 0, 'Early-return error screens would dispose Fabric and make confirmation impossible');
    assert.ok(dom.window.document.querySelector('[data-testid="live-fabric-canvas"]'));
    const dialog = dom.window.document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    const confirm = [...dialog.querySelectorAll('button')].find(button => button.textContent === '继续使用已保存空白');
    assert.ok(confirm && !confirm.disabled);
    await act(async () => { confirm.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    assert.equal(confirmations, 1);
    globals.emptyPdfStateReview = null;
    globals.previewLoadError = null;
    await act(async () => { root.render(React.createElement(globals.module.exports)); });
    assert.equal(disposals, 0);
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    global.window = previousWindow;
    global.document = previousDocument;
    global.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
  assert.equal(disposals, 1, 'The canvas is disposed exactly once when the editor actually closes');
});

test('AI upgrade preserves owned editable source positions and page histories, while rejecting empty failure states', () => {
  const h = harness();
  const candidate = file({ fileType: 'ai', parseResult: { aiParserVersion: 53, pdfParserVersion: 79,
    editableVectorCount: 5, pages: [{ page: 1, svgPath: 'one.svg', editableVectorCount: 5 },
    { page: 2, svgPath: 'two.svg', editableVectorCount: 5 }] } });
  const first = pageState(1, [{ type: 'Path', _layerId: -7, _svgObjectRole: 'editable-vector', left: 89, fill: '#123456' }],
    { __aiParserVersion: 52, __importedSvgRoleModelVersion: h.IMPORTED_SVG_ROLE_MODEL_VERSION });
  const second = pageState(2, [{ type: 'Path', _layerId: -8, _svgObjectRole: 'editable-vector', left: 23 }],
    { __aiParserVersion: 52, __importedSvgRoleModelVersion: h.IMPORTED_SVG_ROLE_MODEL_VERSION });
  const saved = { ...candidate, editorState: { ...second, __pageStates: { '1': first, '2': second } } };
  const before = JSON.stringify(saved.editorState);
  assert.equal(h.getEditorStateForDocumentPage(saved, 1).objects[0].left, 89);
  assert.equal(h.shouldUseSavedEditorState(candidate, first, [], 1), true);
  assert.equal(h.shouldUseSavedEditorState(candidate, { ...first, __sourceFileId: 999 }, [], 1), false);
  assert.equal(h.shouldUseSavedEditorState(candidate, { ...first, objects: [] }, [], 1), false);
  const empty = { ...first, __aiParserVersion: 53, __pdfSceneCompleteVersion: 2, objects: [] };
  assert.equal(h.shouldUseSavedEditorState(candidate, empty, [], 1), true, 'Verified deliberate deletions remain empty');
  assert.equal(JSON.stringify(saved.editorState), before);
});
test('AI resolves each page independently and recognizes faithful preview-only results', () => {
  const h = harness();
  const candidate = file({ fileType: 'ai', parseResult: { aiParserVersion: 53, editableSvg: true,
    pages: [{ page: 1, svgPath: 'one.svg' }, { page: 2, previewOnly: true, previewPath: 'two.png' }] } });
  assert.equal(h.getEditablePdfPageSvgPath(candidate, 1), 'one.svg');
  assert.throws(() => h.getEditablePdfPageSvgPath(candidate, 2), /SVG/);
  assert.equal(h.getParsedDocumentPage(candidate, 2).previewOnly, true);
  const legacy = file({ fileType: 'ai', parseResult: { aiParserVersion: 53, editableSvg: false, previewLayerCount: 1,
    pages: [{ page: 1, previewPath: 'preview.png', previewLayerCount: 1 }] } });
  assert.equal(h.getParsedDocumentPage(legacy, 1).previewOnly, true);
});

test('owned AI52 source images survive removal of every vector and partial manifests cannot substitute pages', () => {
  const h = harness();
  const candidate = file({ fileType: 'ai', parseResult: { aiParserVersion: 53, pdfParserVersion: 79,
    editableVectorCount: 20, pages: [{ page: 1, previewOnly: true, previewPath: 'first.png' }] } });
  const first = pageState(1, [{ type: 'Image', _layerId: -3, _svgObjectRole: 'editable-raster', left: 77, top: 12 }],
    { __aiParserVersion: 52, __importedSvgRoleModelVersion: h.IMPORTED_SVG_ROLE_MODEL_VERSION });
  const second = pageState(2, [{ type: 'Image', _layerId: -4, _svgObjectRole: 'editable-raster', left: 99 }],
    { __aiParserVersion: 52, __importedSvgRoleModelVersion: h.IMPORTED_SVG_ROLE_MODEL_VERSION });
  const saved = { ...candidate, editorState: { ...first, __pageStates: { '1': first, '2': second } } };
  assert.equal(h.getEditorStateForDocumentPage(saved, 2).__pageNumber, 2);
  assert.equal(h.getParsedDocumentPage(saved, 2), null);
  const editable = { ...candidate, parseResult: { ...candidate.parseResult, pages: [{ page: 1, svgPath: 'first.svg' }] } };
  assert.equal(h.shouldUseSavedEditorState(editable, second, [], 2), true);
  const unknownEmpty = { ...second, objects: [] };
  assert.equal(h.shouldReviewEmptySavedPdfState(editable, unknownEmpty, 2), true);
  assert.equal(h.shouldReviewEmptySavedPdfState(editable, { ...unknownEmpty, __importedSvgRoleModelVersion: undefined }, 2), false,
    'Failed legacy placeholders never masquerade as an intentional empty editable scene');
});
