const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const fabric = require('fabric');
const { createCanvas } = require('@napi-rs/canvas');

// Test the actual Editor helpers at their image-load/canvas boundaries. Native
// PNG/Fabric serialization is real; no React mount, network or remote DB.
const editorPath = path.resolve(__dirname, '../src/pages/Editor/index.tsx');
const editor = ts.createSourceFile(editorPath, fs.readFileSync(editorPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const toolbarPath = path.resolve(__dirname, '../src/editor/EditorToolbar.tsx');
const toolbar = ts.createSourceFile(toolbarPath, fs.readFileSync(toolbarPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['normalizeEditorState', 'hasEditorStateOwnerMismatch', 'getEditorStateForDocumentPage', 'cloneSerializedRecord',
  'shouldUseSavedEditorState', 'getParsedDocumentPages', 'getParsedDocumentPage', 'loadPdfPreviewFallbackLayer',
  'resolvePdfPreviewFallbackPath', 'isPdfAuxiliaryImageRole', 'readSerializedObjectProperty',
  'readSerializedPdfAuxiliaryRole', 'isSerializedPdfAuxiliaryPreviewObject', 'isPdfRasterVisualRecord',
  'applySerializedNonInteractiveVisualObject', 'sanitizePersistedPdfRasterVisualObjects',
  'sanitizePersistedObjectArray', 'sanitizePersistedRecord'];
function declaration(source, name) {
  const found = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(found, `Real implementation ${name} must exist`);
  return found.getText(source);
}
const registration = editor.statements.find(node => ts.isExpressionStatement(node)
  && node.expression.getText(editor).startsWith('fabricObjectClass.customProperties ='));
assert.ok(registration);
vm.runInNewContext(ts.transpileModule(registration.getText(editor), {}).outputText,
  { fabricObjectClass: fabric.FabricObject, PSD_SOURCE_CUSTOM_PROPERTIES: [], Array, Set });
const js = ts.transpileModule([
  ...names.map(name => declaration(editor, name)),
  declaration(toolbar, 'isPdfExportAuxiliaryObject'),
  declaration(toolbar, 'filterObjectsForPdfExport'),
  `module.exports = { ${names.join(',')}, isPdfExportAuxiliaryObject, filterObjectsForPdfExport };`,
].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function harness({ failImage = false } = {}) {
  const requests = [];
  const context = {
    module: { exports: {} }, console: { log() {}, warn() {}, info() {} },
    CURRENT_PDF_PARSER_VERSION: 78, CURRENT_AI_PARSER_VERSION: 10, IMPORTED_SVG_ROLE_MODEL_VERSION: 2,
    parsePositiveInt: (value, fallback) => Number(value) > 0 ? Number(value) : fallback,
    readSerializedSvgObjectRole: record => record._svgObjectRole || '',
    isSkippedSvgObjectRole: () => false,
    isImportedVisualBackingObject: object => object._pdfPreviewFallback === true,
    isPdfExportAuxiliaryRole: role => ['page-preview', 'preview-fallback', 'visual-backing'].includes(role),
    readPdfExportObjectRole: object => object._pdfAuxiliaryImageRole,
    isFullPagePdfRasterObject: () => true,
    loadFabricImageFromUrl: async url => {
      requests.push(url);
      if (failImage) throw Error('fixture image missing');
      const element = createCanvas(16, 12);
      element.classList = { add() {}, remove() {} };
      element.getContext('2d').fillStyle = '#13ab34';
      element.getContext('2d').fillRect(0, 0, 16, 12);
      return new fabric.FabricImage(element);
    },
  };
  vm.runInNewContext(js, context);
  return { ...context.module.exports, requests };
}
function file(overrides = {}) {
  return { id: 6411, sourceFileId: 6410, isPersonalCopy: true, fileType: 'pdf', parseStatus: 'completed',
    width: 32, height: 24, parseResult: { pdfParserVersion: 78, pages: [
      { page: 1, width: 32, height: 24, previewPath: 'parsed/6410/pdf_page_1.png', previewOnly: true },
      { page: 2, width: 32, height: 24, previewPath: 'parsed/6410/pdf_page_2.png', previewOnly: true },
    ] }, ...overrides };
}
function state(page, objects) {
  return { __editorStateOwnerVersion: 1, __fileId: 6411, __sourceFileId: 6410, __pageNumber: page,
    __pdfParserVersion: 78, objects };
}
function canvasHarness() {
  const objects = [];
  return { objects, getWidth: () => 32, getHeight: () => 24,
    add: object => objects.push(object), sendObjectToBack: object => { objects.splice(objects.indexOf(object), 1); objects.unshift(object); } };
}

test('previewOnly loads the original active-page PNG as a locked exportable full-page image', async () => {
  const h = harness();
  const canvas = canvasHarness();
  const page = h.getParsedDocumentPage(file(), 2);
  const layer = await h.loadPdfPreviewFallbackLayer(canvas, file(), page, asset => `/uploads/${asset}?v=now`,
    { previewOnly: true, locked: true, placement: 'back' });
  assert.equal(h.requests[0], '/uploads/parsed/6410/pdf_page_2.png?v=now');
  assert.equal(layer.imagePath, page.previewPath);
  const background = canvas.objects[0];
  assert.equal(background.scaleX, 2);
  assert.equal(background.scaleY, 2);
  assert.equal(background.selectable, false);
  assert.equal(background.evented, false);
  assert.equal(background.lockMovementX, true);
  assert.equal(background.excludeFromExport, false);
  assert.equal(background._pdfPreviewOnlyPage, 2);
  assert.equal(background._pdfPreviewOnlyBackground, true);
  assert.equal(layer.properties.locked, true);
  assert.equal(layer.properties.panelOnly, true, 'Layer panel must not offer source-background visibility or selection edits');
});

test('real Fabric PNG serialization preserves the source background and user objects through save cleanup and PDF filtering', async () => {
  const h = harness();
  const canvas = canvasHarness();
  await h.loadPdfPreviewFallbackLayer(canvas, file(), h.getParsedDocumentPage(file(), 1), asset => `/uploads/${asset}`,
    { previewOnly: true, locked: true, placement: 'back' });
  const serialized = canvas.objects[0].toObject();
  assert.equal(serialized._pdfPreviewOnlyBackground, true, 'The real custom property registration must persist the marker');
  assert.ok(serialized.src.startsWith('data:image/png;base64,'));
  const text = { type: 'Textbox', text: 'my annotation', _layerId: 'local-text', selectable: true };
  const userImage = { type: 'Image', src: 'data:image/png;base64,fixture', _layerId: 'local-image', selectable: true };
  const saved = h.sanitizePersistedPdfRasterVisualObjects(state(1, [serialized, text, userImage,
    { type: 'Image', _pdfPreviewFallback: true, _layerId: -1000000010 }]));
  assert.equal(saved.objects.length, 3, 'Only the obsolete auxiliary preview is dropped');
  assert.equal(saved.objects[0].excludeFromExport, false);
  assert.equal(saved.objects[0].lockScalingX, true);
  assert.equal(saved.objects[1].text, 'my annotation');
  assert.equal(h.filterObjectsForPdfExport(saved.objects, { pageWidth: 32, pageHeight: 24 }).length, 3);
  const normalized = h.normalizeEditorState(JSON.stringify(saved));
  assert.equal(normalized.objects[0]._pdfPreviewOnlyPath, 'parsed/6410/pdf_page_1.png');
  assert.equal(h.shouldUseSavedEditorState(file(), normalized, [], 1), true);
});

test('page reopening selects its own saved text/background and rejects foreign owner snapshots', () => {
  const h = harness();
  const one = state(1, [{ type: 'Textbox', text: 'page one' }]);
  const two = state(2, [{ type: 'Textbox', text: 'page two' }]);
  const savedFile = file({ editorState: { ...two, __pageStates: { '1': one, '2': two } } });
  assert.equal(h.getEditorStateForDocumentPage(savedFile, 1).objects[0].text, 'page one');
  assert.equal(h.getEditorStateForDocumentPage(savedFile, 2).objects[0].text, 'page two');
  assert.equal(h.getEditorStateForDocumentPage(file({ editorState: two }), 1), null);
  assert.equal(h.getEditorStateForDocumentPage(file({ editorState: { ...two, __pageStates: { '1': { ...one, __fileId: 42 } } } }), 1), null);
  const failedFile = { ...savedFile, parseStatus: 'failed', parseResult: { error: 'timeout' } };
  assert.equal(h.getEditorStateForDocumentPage(failedFile, 1).objects[0].text, 'page one');
});

test('missing original-page PNG cannot silently fall back to a thumbnail or a different page', async () => {
  const h = harness({ failImage: true });
  assert.equal(await h.loadPdfPreviewFallbackLayer(canvasHarness(), file(), h.getParsedDocumentPage(file(), 1),
    asset => asset, { previewOnly: true, locked: true }), null);
  const missing = { page: 2, previewOnly: true, thumbnailPath: 'thumbnails/old.png' };
  assert.equal(await harness().loadPdfPreviewFallbackLayer(canvasHarness(), file(), missing, asset => asset,
    { previewOnly: true, locked: true }), null);
});
