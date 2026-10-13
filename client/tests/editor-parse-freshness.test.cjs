const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const base = path.resolve(__dirname, '..');
const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const helpers = { exports: {} };
vm.runInNewContext(transpile(fs.readFileSync(path.join(base, 'src/utils/parseFreshness.ts'), 'utf8')), { module: helpers, exports: helpers.exports, URL, Set });
const h = helpers.exports;
const editor = ts.createSourceFile('Editor.tsx', fs.readFileSync(path.join(base, 'src/pages/Editor/index.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
let layersStatements, abortedCleanup;
function visit(node) {
  if (ts.isVariableDeclaration(node)) declarations.set(node.name.getText(editor), node);
  if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(editor) === 'loadedLayers')) {
    const statements = node.parent.statements;
    const index = statements.indexOf(node);
    layersStatements = statements.slice(index, index + 4).map(n => n.getText(editor)).join('\n');
  }
  if (ts.isTryStatement(node) && node.finallyBlock?.getText(editor).includes('initialLoadAborted')) abortedCleanup = node.finallyBlock.getText(editor);
  ts.forEachChild(node, visit);
}
visit(editor);
const initial = name => { const d = declarations.get(name); assert.ok(d, `actual ${name}`); return d.initializer.getText(editor); };
const fresh = (state = 'ready', revision = 'generation-a', resultVersion = 79) => ({ state, revision, requiredVersion: 79, resultVersion });
const file = overrides => ({ id: 6435, sourceFileId: 6408, isPersonalCopy: true, fileType: 'pdf', parseStatus: 'completed',
  updatedAt: 'unrelated-editor-save-time', parseFreshness: fresh(), parseResult: { pdfParserVersion: 79 }, ...overrides });
function compiled(body, context = {}) {
  const module = { exports: {} };
  const globals = { module, exports: module.exports, ...h, URL, Date, console, ...context };
  vm.runInNewContext(transpile(body), globals);
  return { value: module.exports, globals };
}
function openingWait(context) { return compiled(`module.exports = ${initial('waitForParsedFile')};`, {
  isCurrentGeneration: () => true, routePageNumber: 1, setFileData() {}, getParsedDocumentPage: () => null, setCanvasSize() {}, ...context,
}).value; }

test('effective freshness blocks all intermediate states and stops on explicit failure', () => {
  for (const state of ['queued', 'parsing', 'syncing']) assert.equal(h.shouldWaitForParseFreshness(file({ parseFreshness: fresh(state, null, 77) })), true);
  for (const state of ['ready', 'failed']) assert.equal(h.shouldWaitForParseFreshness(file({ parseFreshness: fresh(state) })), false);
  assert.equal(h.shouldWaitForParseFreshness(file({ parseFreshness: undefined, sourceParseStatus: 'parsing' })), true);
  assert.equal(h.shouldWaitForParseFreshness(file({ parseFreshness: undefined, sourceParseStatus: 'failed' })), false);
});

test('actual opening poll waits for a completed copy whose source is finishing and synchronizing', async () => {
  const phases = [file({ parseFreshness: fresh('syncing', null, 77) }), file()];
  const waits = [], reads = [];
  const run = openingWait({ waitForPoll: async delay => { waits.push(delay); return true; }, readFile: async id => { reads.push(id); return phases.shift(); } });
  const completed = await run(file({ parseFreshness: fresh('parsing', null, 77) }));
  assert.equal(completed.parseFreshness.revision, 'generation-a'); assert.equal(reads.length, 2); assert.deepEqual(waits, [2000, 2000]);
  let calls = 0;
  const ready = openingWait({ waitForPoll: async () => { calls++; }, readFile: async () => { calls++; } });
  await ready(completed); assert.equal(calls, 0, 'A successful current result is reused without another forced attempt');
});

test('route cancellation ends the actual opening poll before another file read', async () => {
  let reads = 0;
  const run = openingWait({ waitForPoll: async () => false, readFile: async () => { reads++; } });
  await run(file({ parseFreshness: fresh('queued') })); assert.equal(reads, 0);
});

function loadLayers(bindings) {
  assert.ok(layersStatements);
  return compiled(`module.exports = async () => { ${layersStatements}\nreturn { file, loadedLayers }; };`, {
    file: file(), contentFileId: 6435, pollAbort: { signal: undefined }, isCurrentGeneration: () => true,
    waitForPoll: async () => true, waitForParsedFile: async value => value, setFileData() {}, ...bindings,
  });
}
test('actual layers mismatch rereads metadata and never accepts the temporary empty array', async () => {
  const expected = [], detailCommits = [];
  const run = loadLayers({ api: { get: async (_url, options) => {
    expected.push(options.params.expectedParseRevision);
    return expected.length === 1 ? { data: { data: [], parseFreshness: fresh('ready', 'generation-b') } }
      : { data: { data: [{ id: 10 }], parseFreshness: fresh('ready', 'generation-b') } };
  } }, readFile: async () => file({ parseFreshness: fresh('ready', 'generation-b') }), setFileData: value => detailCommits.push(value) });
  const result = await run.value();
  assert.deepEqual(expected, ['generation-a', 'generation-b']); assert.equal(result.loadedLayers[0].id, 10);
  assert.equal(result.file.parseFreshness.revision, 'generation-b'); assert.equal(detailCommits.length, 2);
});
test('actual layers request failure rejects instead of silently becoming zero layers', async () => {
  const run = loadLayers({ api: { get: async () => { throw new Error('HTTP 500'); } } });
  await assert.rejects(run.value(), /HTTP 500/);
});
test('a successful zero-SQL-layer SVG response is allowed and cancellation prevents committing layers', async () => {
  const zero = loadLayers({ api: { get: async () => ({ data: { data: [], parseFreshness: fresh() } }) } });
  assert.equal((await zero.value()).loadedLayers.length, 0);
  let current = true, commits = 0;
  const stale = loadLayers({ isCurrentGeneration: () => current, setFileData: () => { commits++; },
    api: { get: async () => { current = false; return { data: { data: [{ id: 10 }], parseFreshness: fresh() } }; } } });
  assert.equal(await stale.value(), undefined); assert.equal(commits, 0);
});

function finish(bindings = {}) {
  let current = true, loaded = 0, reloads = 0, error;
  const canvas = { requestRenderAll() {}, __bulkLoading: true, __suspendHistory: true, renderOnAddRemove: false };
  const run = compiled(`const finishInitialCanvasLoad = ${initial('finishInitialCanvasLoad')};
    const finishVerifiedCanvasLoad = ${initial('finishVerifiedCanvasLoad')};
    module.exports = { finish: finishVerifiedCanvasLoad, cleanup: async () => ${abortedCleanup} };`, {
    fileData: file(), initialLoadFinished: false, initialLoadAborted: false, previewOnlyLoadFailed: false,
    pdfSceneCompletionVersion: 2, previousRenderOnAddRemove: true, editorCanvas: canvas, canvas,
    isCurrentLoad: () => current, contentLoadingRef: { current: true },
    setContentLoaded: () => { loaded++; }, setContentLoading() {}, setFailedCanvasUnavailable() {},
    setPreviewLoadError: value => { error = value; }, setParseReloadKey: update => { reloads = update(reloads); },
    createHistorySnapshot: () => ({}), useEditorStore: { getState: () => ({ resetHistory() {}, setDirty() {} }) },
    api: { get: async () => ({ data: { data: { parseFreshness: fresh(), parseStatus: 'completed' } } }) },
    ...bindings,
  });
  return { ...run, canvas, get loaded() { return loaded; }, get reloads() { return reloads; }, get error() { return error; }, cancel() { current = false; } };
}
test('actual final scene commit requires the matching ready revision before enabling autosave', async () => {
  const run = finish(); await run.value.finish(); assert.equal(run.loaded, 1); assert.equal(run.canvas.__benlaiPdfSceneLoadedVersion, 79);
  const changed = finish({ api: { get: async () => ({ data: { data: { parseFreshness: fresh('ready', 'generation-b') } } }) } });
  await changed.value.finish(); await changed.value.cleanup();
  assert.equal(changed.loaded, 0); assert.equal(changed.reloads, 1); assert.equal(changed.canvas.__benlaiPdfSceneLoadedVersion, undefined);
});
test('final status failure blocks saving and stale route cleanup cannot release the next generation', async () => {
  const broken = finish({ api: { get: async () => { throw new Error('HTTP 502'); } } });
  await broken.value.finish(); await broken.value.cleanup(); assert.equal(broken.loaded, 0); assert.match(broken.error, /重新加载/);
  let stale;
  stale = finish({ api: { get: async () => { stale.cancel(); return { data: { data: { parseFreshness: fresh() } } }; } } });
  await stale.value.finish(); await stale.value.cleanup();
  assert.equal(stale.loaded, 0); assert.equal(stale.canvas.__suspendHistory, true); assert.equal(stale.globals.contentLoadingRef.current, true);
});
test('consistent failed-source history can remain visible without forcing another parse', async () => {
  const f = file({ parseStatus: 'failed', parseFreshness: fresh('failed', 'retained-old', 77), sourceParseStatus: 'failed' });
  const run = finish({ fileData: f, api: { get: async () => ({ data: { data: { parseStatus: 'failed', parseFreshness: f.parseFreshness } } }) } });
  await run.value.finish(); assert.equal(run.loaded, 1);
  const d = ['parseFailed', 'parseFailureReason'].map(name => `const ${declarations.get(name).getText(editor)};`).join('\n');
  const banner = compiled(`${d}\nmodule.exports={parseFailed,parseFailureReason};`, { fileData: { ...f, parseStatus: 'completed', sourceParseError: '源文件解析超时' } }).value;
  assert.equal(banner.parseFailed, true); assert.equal(banner.parseFailureReason, '源文件解析超时');
});

test('owned saved scenes refresh generated src recursively without mutating edits, other pages or user sources', () => {
  const origin = 'http://127.0.0.1:18080';
  const sources = ['/uploads/parsed/6408/a.png?v=old&token=x', '/uploads/parsed/6435/b.png?v=old&v=older',
    '/uploads/parsed/9999/foreign.png?v=old', '/uploads/user-images/user.png?v=old', 'data:image/png;base64,x',
    'https://elsewhere.test/uploads/parsed/6408/a.png?v=old'];
  const state = { __fileId: 6435, __sourceFileId: 6408, __pageNumber: 2, objects: [{ type: 'group', left: 123, objects: sources.map(src => ({ type: 'image', src })),
    clipPath: { type: 'image', src: '/uploads/parsed/6408/clip.png?v=old' } }], __pageStates: { 1: { objects: [{ src: sources[0] }] } } };
  const original = JSON.stringify(state), updated = h.refreshOwnedSavedAssetRevisions(state, file(), origin);
  assert.equal(JSON.stringify(state), original); assert.equal(updated.objects[0].left, 123);
  for (const index of [0, 1]) { const url = new URL(updated.objects[0].objects[index].src, origin); assert.equal(url.searchParams.get('v'), 'generation-a'); assert.equal(url.searchParams.getAll('v').length, 1); }
  assert.equal(new URL(updated.objects[0].clipPath.src, origin).searchParams.get('v'), 'generation-a');
  for (const index of [2, 3, 4, 5]) assert.equal(updated.objects[0].objects[index].src, sources[index]);
  assert.equal(updated.__pageStates[1].objects[0].src, sources[0]);
  assert.equal(JSON.stringify(h.refreshOwnedSavedAssetRevisions({ ...state, __fileId: 9999 }, file(), origin)), JSON.stringify({ ...state, __fileId: 9999 }));
  assert.equal(h.getParseAssetRevision(file({ parseFreshness: undefined })), 'unrelated-editor-save-time');
});
test('actual SVG href rewriting replaces existing v while retaining parameters and XML escaping', () => {
  const declaration = editor.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'normalizeUploadSvgHrefs');
  const run = compiled(`${declaration.getText(editor)}\nmodule.exports=normalizeUploadSvgHrefs;`, { window: { location: { origin: 'http://127.0.0.1:18080' } } }).value;
  const svg = '<svg><image href="/uploads/parsed/6408/a.png?v=old&amp;x=one"/><image xlink:href="uploads/parsed/6408/b.png?v=old"/><image href="data:image/png;base64,x"/><image href="https://external.test/a.png?v=old"/><use href="#symbol"/></svg>';
  const updated = run(svg, 'new-revision');
  assert.match(updated, /a\.png\?v=new-revision&amp;x=one/); assert.match(updated, /b\.png\?v=new-revision/);
  assert.ok(!updated.includes('v=old&amp;x=one')); assert.ok(updated.includes('data:image/png;base64,x')); assert.ok(updated.includes('https://external.test/a.png?v=old')); assert.ok(updated.includes('href="#symbol"'));
});

test('the actual PSD group-effect mask reads children through the current revision resolver', async () => {
  const declaration = editor.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'buildPsdGroupEffectOverlay');
  const requested = [];
  const layer = { imagePath: 'parsed/6408/child.png', width: 10, height: 20, x: 0, y: 0 };
  const run = compiled(`${declaration.getText(editor)}\nmodule.exports=buildPsdGroupEffectOverlay;`, {
    document: { createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/png;base64,mask' }) },
    getParsedLayerEffects: () => ({}), getPsdEffect: (_effects, name) => name === 'stroke' ? { size: 1 } : undefined,
    extractCssColor: () => '#fff', toFiniteNumber: Number, buildPsdAlphaShadows: () => [],
    collectPsdGroupImageLayers: () => [layer], unionParsedLayerBounds: () => ({ left: 0, top: 0, width: 10, height: 20 }),
    loadHtmlImage: async url => { requested.push(url); return { naturalWidth: 10, naturalHeight: 20 }; },
    getPsdLayerContentOpacity: () => 1, rasterizeAlphaStyle: async () => { throw new Error('Reached the style-rendering boundary'); },
  }).value;
  assert.equal(await run({ children: [layer] }, assetPath => h.withUploadAssetRevision(`/uploads/${assetPath}`, 'new-generation', 'http://127.0.0.1:18080')), null);
  assert.deepEqual(requested, ['/uploads/parsed/6408/child.png?v=new-generation']);
});
