const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { createCanvas } = require('@napi-rs/canvas');

const assets = fs.mkdtempSync(path.join(os.tmpdir(), 'benlai-controller-health-'));
test.after(() => fs.rmSync(assets, { recursive: true, force: true }));
fs.writeFileSync(path.join(assets, 'editable.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 0 L10 10Z"/></svg>');
fs.writeFileSync(path.join(assets, 'preview.png'), createCanvas(2, 2).toBuffer('image/png'));
const versionPath = path.resolve(__dirname, '../src/services/parser/parserVersions.ts');
const versionModule = new Module(versionPath, module);
versionModule.filename = versionPath;
versionModule.paths = Module._nodeModulePaths(path.dirname(versionPath));
versionModule._compile(ts.transpileModule(fs.readFileSync(versionPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, versionPath);
const PDF_VERSION = versionModule.exports.PDF_PARSER_VERSION;
const freshnessPath = path.resolve(__dirname, '../src/services/parser/parseFreshness.ts');
const freshnessModule = new Module(freshnessPath, module);
freshnessModule.filename = freshnessPath;
freshnessModule.paths = Module._nodeModulePaths(path.dirname(freshnessPath));
freshnessModule._compile(ts.transpileModule(fs.readFileSync(freshnessPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, freshnessPath);
const editableResult = (extra = {}) => ({ pdfParserVersion: PDF_VERSION, editableSvg: true,
  svgPath: 'editable.svg', textLayersAreMetadata: true, ...extra });

// Load the real controller with an in-memory database and queue boundary.
// No app bootstrap, environment file, parser, or external database is imported.
const controllerPath = path.resolve(__dirname, '../src/controllers/fileController.ts');
const controllerJs = ts.transpileModule(fs.readFileSync(controllerPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

function harness(files, { allowRefresh = false, beforeSourceLock, layerRows, queueUpdates = false, storageBase = assets, queuePhase = null } = {}) {
  const records = new Map(files.map((file) => [file.id, file]));
  const jobs = [];
  const updates = [];
  const lockOrder = [];
  const layerQueries = [];
  let createdCopies = 0;
  let layerReads = 0;
  let refreshes = 0;
  let clonedLayers = 0;
  let copyLocks = 0;
  let sourceLocks = 0;
  let lastClonedLayer;
  let transactionTail = Promise.resolve();
  for (const file of files) {
    file.update = async (changes) => {
      updates.push({ id: file.id, changes });
      Object.assign(file, changes);
      return file;
    };
    file.reload = async () => file;
    file.toJSON = () => {
      const { update, reload, toJSON, ...data } = file;
      return data;
    };
  }
  class AppError extends Error {
    constructor(message, statusCode) { super(message); this.statusCode = statusCode; }
  }
  const models = {
    sequelize: {
      transaction: async (callback) => {
        const transaction = { LOCK: { UPDATE: 'UPDATE' } };
        const current = transactionTail.then(() => callback(transaction));
        transactionTail = current.catch(() => undefined);
        return current;
      },
    },
    DesignFile: {
      findByPk: async (id, options) => {
        const record = records.get(id);
        if (!record) return null;
        if (options?.lock) {
          lockOrder.push(id);
          assert.equal(options.lock, 'UPDATE');
          assert.ok(options.transaction);
          if (id === 6411) copyLocks += 1;
          else { sourceLocks += 1; await beforeSourceLock?.(record); }
          return record;
        }
        if (!allowRefresh || ![6410, 6411].includes(id)) return record;
        const snapshot = { ...record };
        snapshot.reload = async () => Object.assign(snapshot, record);
        return snapshot;
      },
      count: async () => 0,
      create: async () => { createdCopies += 1; throw new Error('Unexpected copy creation'); },
    },
    ParsedLayer: {
      findOne: async (options) => layerRows?.has(options.where.fileId)
        ? layerRows.get(options.where.fileId).length ? { id: 1 } : null
        : options.where.fileId === 6410 || records.get(options.where.fileId)?.parseStatus === 'completed' ? { id: 1 } : null,
      findAll: async (options) => { layerReads += 1;
        layerQueries.push(options);
        if (layerRows?.has(options.where.fileId)) return layerRows.get(options.where.fileId).map(row => ({ ...row, toJSON() { return { ...row }; } }));
        return [{ id: 1, fileId: 6411, parentLayerId: null,
        imagePath: records.get(6410)?.parseResult?.compositePath?.replace('composite.png', 'layer.png'),
        layerType: 'image', toJSON() { return { id: this.id, fileId: this.fileId, layerType: this.layerType }; } }]; },
      destroy: async (options) => {
        if (!allowRefresh) throw new Error('Controller must not delete parser layers');
        assert.ok(options.transaction, 'Snapshot refresh must be atomic');
        assert.ok(copyLocks, 'Snapshot refresh must lock the copy first');
        refreshes += 1;
        clonedLayers = 0;
      },
      create: async (values, options) => {
        assert.ok(options.transaction);
        lastClonedLayer = { ...values };
        return { id: ++clonedLayers };
      },
    },
    User: {}, Library: {}, Category: {}, Tag: {}, FileTag: {}, FileCategory: {},
  };
  const stubs = {
    '../models': models,
    '../middleware/errorHandler': { AppError },
    '../config/storage': { STORAGE: { base: storageBase } },
    '../services/parser/parseOrchestrator': { enqueueParse: async (id, options) => {
      jobs.push({ id, options });
      if (queueUpdates) {
        if (options?.resetSource) records.get(id).parseStatus = 'pending';
        for (const copyId of options?.syncPersonalCopyIds || []) records.get(copyId).parseStatus = 'pending';
      }
    }, getParseQueuePhase: id => typeof queuePhase === 'function' ? queuePhase(id) : queuePhase },
    '../services/parser/parseFreshness': freshnessModule.exports,
    '../services/parser/parserVersions': versionModule.exports,
  };
  const controllerModule = new Module(controllerPath, module);
  controllerModule.filename = controllerPath;
  controllerModule.paths = Module._nodeModulePaths(path.dirname(controllerPath));
  const originalRequire = controllerModule.require.bind(controllerModule);
  controllerModule.require = (request) => Object.hasOwn(stubs, request)
    ? stubs[request]
    : request.startsWith('../') ? {} : originalRequire(request);
  controllerModule._compile(controllerJs, controllerPath);
  const invoke = async (method, id, body, query = {}) => {
    let response;
    let error;
    const res = { status() { return this; }, json(body) { response = body; return this; } };
    await controllerModule.exports[method]({ params: { id: String(id) }, user: { id: 7 }, body, query }, res, (err) => { error = err; });
    return { response, error };
  };
  return { invoke, jobs, updates, lockOrder, layerQueries, get createdCopies() { return createdCopies; }, get layerReads() { return layerReads; },
    get refreshes() { return refreshes; }, get clonedLayers() { return clonedLayers; }, get copyLocks() { return copyLocks; },
    get sourceLocks() { return sourceLocks; }, get lastClonedLayer() { return lastClonedLayer; } };
}

function source(overrides = {}) {
  return { id: 6410, fileType: 'pdf', parseStatus: 'failed', parseResult: { error: 'render timed out' }, isPersonalCopy: false, isDeleted: false, ...overrides };
}

function copy(overrides = {}) {
  return { id: 6411, fileType: 'pdf', sourceFileId: 6410, parseStatus: 'pending', isPersonalCopy: true, uploadedBy: 7, editorState: { objects: [{ type: 'textbox', text: 'saved work' }] }, ...overrides };
}

test('failed source with missing parser version cannot create a copy or queue an implicit retry', async () => {
  const h = harness([source()]);
  const { error } = await h.invoke('useTemplate', 6410);
  assert.equal(error?.statusCode, 409);
  assert.equal(h.createdCopies, 0);
  assert.deepEqual(h.jobs, []);
  assert.deepEqual(h.updates, []);
});

test('reading a failed standalone personal file cannot retry it as stale', async () => {
  const file = copy({ sourceFileId: null, parseStatus: 'failed', parseResult: { error: 'old failure' } });
  const h = harness([file]);
  const { response, error } = await h.invoke('getById', 6411);
  assert.equal(error, undefined);
  assert.equal(response.data.parseStatus, 'failed');
  assert.deepEqual(h.jobs, []);
  assert.deepEqual(h.updates, []);
});

for (const status of ['pending', 'parsing']) {
  test(`reading legacy ${status} copy closes it as failed and preserves saved work`, async () => {
    const original = source();
    const personal = copy({ parseStatus: status });
    const savedState = structuredClone(personal.editorState);
    const h = harness([original, personal]);
    const { response, error } = await h.invoke('getById', 6411);
    assert.equal(error, undefined);
    assert.equal(response.data.parseStatus, 'failed');
    assert.equal(response.data.parseResult.error, original.parseResult.error);
    assert.deepEqual(personal.editorState, savedState);
    assert.deepEqual(h.jobs, []);
    assert.deepEqual(h.updates.map((update) => Object.keys(update.changes).sort()), [['parseResult', 'parseStatus']]);
    const layers = await h.invoke('getLayers', 6411);
    assert.deepEqual(layers.response.data, []);
    assert.equal(h.layerReads, 0);
  });
}

test('failed reparse keeps retained pointers and saved work without exposing ready layers', async () => {
  const original = source({ parseResult: { error: 'timeout', hasRetainedResult: true,
    compositePath: 'parsed/6410/source-old/composite.png' } });
  const personal = copy({ parseStatus: 'parsing', parseResult: { pdfParserVersion: 76,
    compositePath: 'parsed/6411/copy-old/composite.png' } });
  const h = harness([original, personal]);
  assert.equal((await h.invoke('getById', 6411)).error, undefined);
  assert.equal(personal.parseResult.hasRetainedResult, true);
  assert.equal(personal.parseResult.compositePath, 'parsed/6411/copy-old/composite.png');
  const { response, error } = await h.invoke('getLayers', 6411);
  assert.equal(error, undefined);
  assert.equal(response.data.length, 0);
  assert.equal(response.parseFreshness.state, 'failed');
  assert.equal(h.layerReads, 0);
});

function pageState(page, text, extra = {}) {
  return { __editorStateOwnerVersion: 1, __fileId: 6411, __sourceFileId: 6410, __pageNumber: page,
    objects: [{ type: 'textbox', text }], ...extra };
}
function previewCopy(overrides = {}) {
  return copy({ parseStatus: 'completed', parseResult: { pdfParserVersion: 78,
    pages: [{ page: 1, previewOnly: true }, { page: 2, previewOnly: true }] }, ...overrides });
}

test('concurrent preview page saves lock the file and preserve both pages and latest legacy root', async () => {
  const personal = previewCopy({ editorState: null });
  const h = harness([personal]);
  const results = await Promise.all([h.invoke('saveEditorState', 6411, { editorState: pageState(1, 'page one') }),
    h.invoke('saveEditorState', 6411, { editorState: pageState(2, 'page two') })]);
  assert.ok(results.every(({ error, response }) => !error && response.code === 200));
  assert.equal(h.copyLocks, 2);
  assert.equal(personal.editorState.__pageNumber, 2);
  assert.equal(personal.editorState.__pageStates['1'].objects[0].text, 'page one');
  assert.equal(personal.editorState.__pageStates['2'].objects[0].text, 'page two');
  assert.equal(personal.editorState.__pageStates['1'].__pageStates, undefined);
});

test('preview page merge imports valid legacy root and ignores the client supplied page map', async () => {
  const personal = previewCopy({ editorState: pageState(1, 'legacy page one') });
  const h = harness([personal]);
  const { error } = await h.invoke('saveEditorState', 6411, { editorState: JSON.stringify(pageState(2, 'current page two',
    { __pageStates: { '1': pageState(1, 'forged overwrite'), '99': pageState(99, 'injected') } })) });
  assert.equal(error, undefined);
  assert.equal(personal.editorState.__pageStates['1'].objects[0].text, 'legacy page one');
  assert.deepEqual(Object.keys(personal.editorState.__pageStates).sort(), ['1', '2']);
});

test('preview page save rejects foreign owners, absent ownership and pages outside the document', async () => {
  for (const invalid of [pageState(1, 'bad', { __fileId: 9 }), pageState(2, 'bad', { __sourceFileId: 99 }),
    pageState(3, 'bad'), { objects: [] }]) {
    const personal = previewCopy();
    const previous = structuredClone(personal.editorState);
    const h = harness([personal]);
    const { error } = await h.invoke('saveEditorState', 6411, { editorState: invalid });
    assert.equal(error?.statusCode, 409);
    assert.deepEqual(personal.editorState, previous);
    assert.deepEqual(h.updates, []);
  }
});

test('mixed multipage saving preserves both SVG and preview pages using their original page indexes', async () => {
  const personal = previewCopy({ parseResult: { pages: [{ previewOnly: false }, { previewOnly: true }] }, editorState: null });
  const h = harness([personal]);
  assert.equal((await h.invoke('saveEditorState', 6411, { editorState: pageState(2, 'preview second') })).error, undefined);
  assert.equal((await h.invoke('saveEditorState', 6411, { editorState: pageState(1, 'svg first') })).error, undefined);
  assert.equal(personal.editorState.__pageStates['2'].objects[0].text, 'preview second');
});

test('single-page and existing SVG saved state retain their legacy representation', async () => {
  const raw = JSON.stringify(pageState(1, 'legacy'));
  const personal = copy({ parseResult: { pages: [{ page: 1 }] } });
  const h = harness([personal]);
  assert.equal((await h.invoke('saveEditorState', 6411, { editorState: raw })).error, undefined);
  assert.equal(personal.editorState, raw);
});

test('saving existing work before a failed multipage retry retains other owned page snapshots', async () => {
  const one = pageState(1, 'page one');
  const two = pageState(2, 'page two');
  const personal = previewCopy({ parseStatus: 'failed', parseResult: { error: 'timeout' },
    editorState: { ...two, __pageStates: { '1': one, '2': two } } });
  const h = harness([personal]);
  const { error } = await h.invoke('saveEditorState', 6411, { editorState: pageState(1, 'page one before retry') });
  assert.equal(error, undefined);
  assert.equal(personal.editorState.__pageStates['2'].objects[0].text, 'page two');
  assert.equal(personal.editorState.__pageStates['1'].objects[0].text, 'page one before retry');
});

test('partial PDF manifests preserve all previously owned pages in every parser status', async () => {
  for (const parseStatus of ['pending', 'parsing', 'failed', 'completed']) {
    const one = pageState(1, 'kept first');
    const two = pageState(2, 'kept second');
    const personal = previewCopy({ parseStatus, parseResult: { pdfParserVersion: PDF_VERSION, pageCount: 2, pages: [{ page: 1 }] },
      editorState: { ...two, __pageStates: { '1': one, '2': two } } });
    const h = harness([personal]);
    assert.equal((await h.invoke('saveEditorState', 6411, { editorState: pageState(1, 'updated first', {
      __pageStates: { '2': pageState(2, 'forged second'), '99': pageState(99, 'injected') } }) })).error, undefined);
    assert.equal(personal.editorState.__pageStates['1'].objects[0].text, 'updated first');
    assert.deepEqual(personal.editorState.__pageStates['2'], two);
    assert.deepEqual(Object.keys(personal.editorState.__pageStates).sort(), ['1', '2']);
    assert.equal((await h.invoke('saveEditorState', 6411, { editorState: pageState(2, 'updated second') })).error, undefined);
    assert.equal(personal.editorState.__pageStates['1'].objects[0].text, 'updated first');
    assert.equal(personal.editorState.__pageStates['2'].objects[0].text, 'updated second');
  }
});

test('a partial manifest combines newly known pages with an owned legacy root or page map', async () => {
  for (const editorState of [pageState(2, 'legacy second'), { ...pageState(1, 'legacy first'), __pageStates: { '1': pageState(1, 'legacy first') } }]) {
    const manifestPage = editorState.__pageNumber === 2 ? 1 : 2;
    const personal = previewCopy({ parseStatus: 'pending', parseResult: { pageCount: 2, pages: [{ page: manifestPage }] }, editorState });
    const h = harness([personal]);
    assert.equal((await h.invoke('saveEditorState', 6411, { editorState: pageState(manifestPage, 'new manifest page') })).error, undefined);
    assert.deepEqual(Object.keys(personal.editorState.__pageStates).sort(), ['1', '2']);
    assert.equal(personal.editorState.__pageStates[String(editorState.__pageNumber)].objects[0].text, editorState.objects[0].text);
  }
});

test('a completed shortened manifest keeps trusted history without admitting foreign or unknown pages', async () => {
  const one = pageState(1, 'kept first');
  const two = pageState(2, 'kept second');
  const personal = previewCopy({ parseResult: { pageCount: 1, pages: [{ page: 1 }] },
    editorState: { ...two, __pageStates: { '1': one, '2': two, '3': pageState(3, 'foreign', { __sourceFileId: 99 }),
      '4': pageState(4, 'foreign', { __fileId: 99 }) } } });
  const h = harness([personal]);
  assert.equal((await h.invoke('saveEditorState', 6411, { editorState: pageState(1, 'updated first') })).error, undefined);
  assert.deepEqual(personal.editorState.__pageStates['2'], two);
  assert.deepEqual(Object.keys(personal.editorState.__pageStates).sort(), ['1', '2']);
  const before = structuredClone(personal.editorState);
  for (const invalid of [pageState(3, 'not known'), pageState(4, 'not known'), pageState(Number.MAX_SAFE_INTEGER + 1, 'unsafe'),
    pageState(2, 'wrong source', { __sourceFileId: 99 }), pageState(2, 'wrong file', { __fileId: 99 })]) {
    assert.equal((await h.invoke('saveEditorState', 6411, { editorState: invalid })).error?.statusCode, 409);
    assert.deepEqual(personal.editorState, before);
  }
});

test('a completed historical copy reports source failure and preserves its saved work', async () => {
  const personal = copy({ parseStatus: 'completed', parseResult: { pdfParserVersion: 78 } });
  const h = harness([source(), personal]);
  const { response, error } = await h.invoke('getById', 6411);
  assert.equal(error, undefined);
  assert.equal(response.data.parseStatus, 'failed');
  assert.equal(response.data.parseFreshness.state, 'failed');
  assert.equal(personal.parseStatus, 'completed');
  assert.deepEqual(h.updates, []);
  assert.deepEqual(h.jobs, []);
});

test('explicit retry delegates all destructive resets to the queue and keeps the copy state', async () => {
  const original = source();
  const personal = copy({ parseStatus: 'failed' });
  const savedState = structuredClone(personal.editorState);
  const h = harness([original, personal]);
  const { response, error } = await h.invoke('triggerParse', 6411);
  assert.equal(error, undefined);
  assert.equal(response.code, 200);
  assert.deepEqual(h.updates, []);
  assert.deepEqual(personal.editorState, savedState);
  assert.equal(h.jobs.length, 1);
  assert.equal(h.jobs[0].id, 6410);
  assert.equal(h.jobs[0].options.resetSource, true);
  assert.equal(h.jobs[0].options.preserveEditorState, false);
  assert.deepEqual(h.jobs[0].options.syncPersonalCopyIds, [6411]);
});

test('repeated active-source reads merge through queue without clearing layers or state', async () => {
  const h = harness([source({ parseStatus: 'parsing' }), copy()]);
  await Promise.all([h.invoke('getById', 6411), h.invoke('getById', 6411)]);
  assert.equal(h.jobs.length, 2);
  assert.ok(h.jobs.every(({ id, options }) => id === 6410 && options.resetSource === false));
  assert.ok(h.jobs.every(({ options }) => options.syncPersonalCopyIds[0] === 6411));
  assert.deepEqual(h.updates, []);
});

test('stale completed source still upgrades lazily without controller resets', async () => {
  const h = harness([source({ parseStatus: 'completed', parseResult: { pdfParserVersion: 1 } }), copy()]);
  const { error } = await h.invoke('getById', 6411);
  assert.equal(error, undefined);
  assert.equal(h.jobs.length, 1);
  assert.equal(h.jobs[0].options.resetSource, true);
  assert.deepEqual(h.updates, []);
});

test('explicit standalone-copy retry preserves its editor state in queue options', async () => {
  const h = harness([copy({ sourceFileId: null, parseStatus: 'failed' })]);
  const { error } = await h.invoke('triggerParse', 6411);
  assert.equal(error, undefined);
  assert.equal(h.jobs[0].id, 6411);
  assert.equal(h.jobs[0].options.resetSource, true);
  assert.equal(h.jobs[0].options.preserveEditorState, true);
  assert.deepEqual(h.updates, []);
});

test('concurrent reads serialize finished-source copy refresh and recheck the locked copy', async () => {
  const personal = copy();
  const savedState = structuredClone(personal.editorState);
  const h = harness([source({ parseStatus: 'completed', parseResult: editableResult() }), personal], { allowRefresh: true });
  const results = await Promise.all([h.invoke('getById', 6411), h.invoke('getById', 6411)]);
  assert.ok(results.every(({ response, error }) => !error && response.data.parseStatus === 'completed'));
  assert.equal(h.copyLocks, 4);
  assert.equal(h.refreshes, 1);
  assert.equal(h.clonedLayers, 1);
  assert.deepEqual(personal.editorState, savedState);
  assert.deepEqual(h.jobs, []);
});

test('a concurrently published source cannot mix new copied layers with old result metadata', async () => {
  const original = source({ parseStatus: 'completed', parseResult: editableResult({
    compositePath: 'parsed/6410/old/composite.png' }) });
  const personal = copy();
  let published = false;
  const h = harness([original, personal], { allowRefresh: true, beforeSourceLock: async (record) => {
    if (!published) {
      record.parseResult = editableResult({ compositePath: 'parsed/6410/new/composite.png' });
      published = true;
    }
  } });
  const { response, error } = await h.invoke('getById', 6411);
  assert.equal(error, undefined);
  assert.equal(response.data.parseResult.compositePath, 'parsed/6410/new/composite.png');
  assert.equal(h.lastClonedLayer.imagePath, 'parsed/6410/new/layer.png');
  assert.equal(h.sourceLocks, 2);
});

for (const status of ['pending', 'parsing']) {
  test(`${status} file cannot expose unfinished parsed layers`, async () => {
    const h = harness([source({ parseStatus: status })]);
    const { response, error } = await h.invoke('getLayers', 6410);
    assert.equal(error, undefined);
    assert.deepEqual(response.data, []);
    assert.equal(h.layerReads, 0);
  });
}


test('upgraded editable PDF concurrently saves both pages and retains existing preview-era user work', async () => {
  const beforeOne = pageState(1, 'existing first', { __pdfParserVersion: 77 });
  const beforeTwo = pageState(2, 'existing second', { __pdfParserVersion: 77 });
  const personal = previewCopy({ parseResult: { pdfParserVersion: 78,
    pages: [{ page: 1, previewOnly: false }, { page: 2, previewOnly: false }] },
    editorState: { ...beforeTwo, __pageStates: { '1': beforeOne, '2': beforeTwo } } });
  const h = harness([personal]);
  assert.equal((await h.invoke('saveEditorState', 6411, { editorState: pageState(1, 'updated first', {
    __pdfParserVersion: 78, __pageStates: { '2': pageState(2, 'forged second') } }) })).error, undefined);
  assert.equal(personal.editorState.__pageStates['2'].objects[0].text, 'existing second');
  const results = await Promise.all([
    h.invoke('saveEditorState', 6411, { editorState: pageState(1, 'latest first', { __pdfParserVersion: 78 }) }),
    h.invoke('saveEditorState', 6411, { editorState: pageState(2, 'latest second', { __pdfParserVersion: 78 }) }),
  ]);
  assert.ok(results.every(({ error }) => !error));
  assert.equal(personal.editorState.__pageStates['1'].objects[0].text, 'latest first');
  assert.equal(personal.editorState.__pageStates['2'].objects[0].text, 'latest second');
});


test('editable multi-page saves reject foreign source/file/page identity and preserve the existing map', async () => {
  for (const invalid of [pageState(1, 'bad', { __fileId: 9 }), pageState(2, 'bad', { __sourceFileId: 99 }),
    pageState(3, 'bad'), pageState(1, 'bad', { __pageNumber: 1.5 }), { objects: [] }]) {
    const one = pageState(1, 'keep first');
    const two = pageState(2, 'keep second');
    const personal = previewCopy({ parseResult: { pdfParserVersion: 78, pages: [{ page: 1 }, { page: 2 }] },
      editorState: { ...two, __pageStates: { '1': one, '2': two } } });
    const previous = structuredClone(personal.editorState);
    const h = harness([personal]);
    assert.equal((await h.invoke('saveEditorState', 6411, { editorState: invalid })).error?.statusCode, 409);
    assert.deepEqual(personal.editorState, previous);
  }
});


test('old reliable editable PDF77 upgrades its source once while preserving saved edits', async () => {
  const metadata = { parseStatus: 'completed', parseResult: { pdfParserVersion: 77, editableSvg: true,
    previewOnly: false, svgPath: 'parsed/source/page.svg' }, width: 100, height: 200 };
  const personal = copy({ ...metadata, editorState: pageState(1, 'preserved addition', { __pdfParserVersion: 77,
    __importedSvgRoleModelVersion: 39, objects: [{ type: 'Path', _layerId: -5, _svgObjectRole: 'editable-vector', left: 80, fill: '#123456' }] }) });
  const before = structuredClone(personal.editorState);
  const h = harness([source(metadata), personal], { allowRefresh: true,
    layerRows: new Map([[6410, [{ id: 1, fileId: 6410 }]], [6411, [{ id: 2, fileId: 6411 }]]]) });
  assert.equal((await h.invoke('getById', 6411)).error, undefined);
  assert.equal(h.jobs.length, 1);
  assert.equal(h.jobs[0].id, 6410);
  assert.equal(h.jobs[0].options.resetSource, true);
  assert.deepEqual(h.updates, []);
  assert.deepEqual(personal.editorState, before);
});


test('PDF77 preview or unreliable SVG still upgrades to the current parser', async () => {
  for (const parseResult of [
    { pdfParserVersion: 77, editableSvg: false, previewOnly: true },
    { pdfParserVersion: 77, editableSvg: true, previewOnly: false, svgPath: 'parsed/source/page.svg', svgVisualReliable: false },
    { pdfParserVersion: 77, editableSvg: true, previewOnly: false, pages: [
      { page: 1, svgPath: 'parsed/source/page-1.svg' }, { page: 2, previewOnly: true } ] },
  ]) {
    const h = harness([source({ parseStatus: 'completed', parseResult }), copy()]);
    assert.equal((await h.invoke('getById', 6411)).error, undefined);
    assert.equal(h.jobs.length, 1);
    assert.equal(h.jobs[0].options.resetSource, true);
  }
});

test('current metadata-only PDF with a real SVG remains usable with zero SQL layers', async () => {
  const original = source({ parseStatus: 'completed', parseResult: editableResult(), editorState: { objects: [{ type: 'textbox', text: 'kept' }] } });
  const before = structuredClone(original.editorState);
  const h = harness([original], { layerRows: new Map([[6410, []]]) });
  for (const method of ['getById', 'getParseStatus', 'getLayers']) {
    const result = await h.invoke(method, 6410);
    assert.equal(result.error, undefined);
  }
  assert.deepEqual(h.jobs, []);
  assert.deepEqual(h.updates, []);
  assert.deepEqual(original.editorState, before);
});

test('current preview fallback and mixed SVG/preview pages do not implicitly retry', async () => {
  for (const parseResult of [
    { pdfParserVersion: PDF_VERSION, previewOnly: true, editableSvg: false, previewPath: 'preview.png' },
    { pdfParserVersion: PDF_VERSION, pageCount: 2, editableSvg: true, pages: [
      { page: 1, previewOnly: false, svgPath: 'editable.svg' }, { page: 2, previewOnly: true, previewPath: 'preview.png' },
    ] },
  ]) {
    const h = harness([source({ parseStatus: 'completed', parseResult })]);
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const method of ['getById', 'getParseStatus', 'getLayers']) assert.equal((await h.invoke(method, 6410)).error, undefined);
    }
    assert.deepEqual(h.jobs, []);
    assert.deepEqual(h.updates, []);
  }
});

test('old preview upgrades once and the newly published current preview is stable', async () => {
  const original = source({ parseStatus: 'completed', parseResult: {
    pdfParserVersion: PDF_VERSION - 1, previewOnly: true, previewPath: 'preview.png' } });
  const h = harness([original], { queueUpdates: true });
  assert.equal((await h.invoke('getParseStatus', 6410)).response.data.parseStatus, 'pending');
  assert.equal(h.jobs.length, 1);
  // Model a completed worker publication; subsequent reads must not repeat that attempt.
  original.parseStatus = 'completed';
  original.parseResult.pdfParserVersion = PDF_VERSION;
  for (const method of ['getById', 'getParseStatus', 'getLayers']) assert.equal((await h.invoke(method, 6410)).error, undefined);
  assert.equal(h.jobs.length, 1);
});

test('malformed, empty, definitions-only, cyclic and missing SVG assets trigger source repair', async () => {
  const invalid = {
    'empty.svg': '',
    'malformed.svg': '<svg><path d="M0 0L1 1"></svg>',
    'definitions.svg': '<svg><defs><path id="p" d="M0 0L1 1"/></defs></svg>',
    'cycle.svg': '<svg><defs><use id="p" href="#p"/></defs><use href="#p"/></svg>',
    'masked.svg': '<svg><path data-object-role="mask-artifact" d="M0 0L1 1"/></svg>',
    'external-image.svg': '<svg><image width="10" height="10" href="https://example.invalid/x.png"/></svg>',
    'missing-image.svg': '<svg><image width="10" height="10" href="absent.png"/></svg>',
    'bad-path.svg': '<svg><path d="bad1"/></svg>',
    'unfinished-path.svg': '<svg><path d="M0 0 L1"/></svg>',
    'bad-line.svg': '<svg><line x1="bad" x2="bad"/></svg>',
    'bad-points.svg': '<svg><polygon points="bad1 bad2 bad3 bad4"/></svg>',
  };
  for (const [filename, xml] of Object.entries(invalid)) fs.writeFileSync(path.join(assets, filename), xml);
  for (const svgPath of [...Object.keys(invalid), 'absent.svg']) {
    const h = harness([source({ parseStatus: 'completed', parseResult: editableResult({ svgPath }) }), copy()], { queueUpdates: true });
    const before = structuredClone((await h.invoke('getParseStatus', 6411)).response.data);
    assert.equal(before.parseStatus, 'pending', svgPath);
    assert.equal(h.jobs.length, 1, svgPath);
    assert.equal(h.jobs[0].id, 6410, svgPath);
    assert.deepEqual(h.jobs[0].options.syncPersonalCopyIds, [6411]);
    assert.deepEqual(h.updates, []);
  }
});

test('actual SVG use references and local raster objects are accepted without reparsing', async () => {
  fs.writeFileSync(path.join(assets, 'references.svg'), '<svg><defs><symbol id="p"><path d="M0 0L10 10"/></symbol></defs><use href="#p"/><image width="2" height="2" href="preview.png"/></svg>');
  const h = harness([source({ parseStatus: 'completed', parseResult: editableResult({ svgPath: 'references.svg' }) })]);
  assert.equal((await h.invoke('getById', 6410)).error, undefined);
  assert.deepEqual(h.jobs, []);
});

test('preview validation fully decodes PNG and detects replacement after a healthy read', async () => {
  const filename = path.join(assets, 'replace.png');
  fs.copyFileSync(path.join(assets, 'preview.png'), filename);
  const original = source({ parseStatus: 'completed', parseResult: {
    pdfParserVersion: PDF_VERSION, previewOnly: true, previewPath: 'replace.png' } });
  const h = harness([original]);
  assert.equal((await h.invoke('getById', 6410)).error, undefined);
  assert.equal(h.jobs.length, 0);
  fs.writeFileSync(filename, Buffer.from('broken image'));
  assert.equal((await h.invoke('getById', 6410)).error, undefined);
  assert.equal(h.jobs.length, 1);
});

test('resource paths cannot escape upload root through traversal or directory symlinks', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'benlai-controller-outside-'));
  try {
    fs.copyFileSync(path.join(assets, 'editable.svg'), path.join(outside, 'outside.svg'));
    fs.symlinkSync(outside, path.join(assets, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const svgPath of [path.join(outside, 'outside.svg'), path.relative(assets, path.join(outside, 'outside.svg')), 'outside-link/outside.svg', '%2e%2e/' + path.basename(outside) + '/outside.svg']) {
      const h = harness([source({ parseStatus: 'completed', parseResult: editableResult({ svgPath }) })]);
      assert.equal((await h.invoke('getById', 6410)).error, undefined);
      assert.equal(h.jobs.length, 1, svgPath);
    }
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});

test('detail, status and layers repair a stale personal copy through the same source', async () => {
  for (const method of ['getById', 'getParseStatus', 'getLayers']) {
    const personal = copy({ editorState: { __pageStates: { '2': { objects: [{ type: 'text', text: 'saved second page' }] } } } });
    const before = structuredClone(personal.editorState);
    const h = harness([source({ parseStatus: 'completed', parseResult: { pdfParserVersion: 77 } }), personal], { queueUpdates: true });
    assert.equal((await h.invoke(method, 6411)).error, undefined);
    assert.equal(h.jobs.length, 1);
    assert.equal(h.jobs[0].id, 6410);
    assert.deepEqual(h.jobs[0].options.syncPersonalCopyIds, [6411]);
    assert.equal(personal.parseStatus, 'pending');
    assert.deepEqual(personal.editorState, before);
    assert.deepEqual(h.updates, []);
  }
});

test('status and layers synchronize a completed source snapshot without starting a worker', async () => {
  for (const method of ['getParseStatus', 'getLayers']) {
    const personal = copy({ parseStatus: 'completed', parseResult: { pdfParserVersion: 77 } });
    const before = structuredClone(personal.editorState);
    const h = harness([source({ parseStatus: 'completed', parseResult: editableResult() }), personal], { allowRefresh: true });
    assert.equal((await h.invoke(method, 6411)).error, undefined);
    assert.equal(personal.parseResult.pdfParserVersion, PDF_VERSION);
    assert.equal(h.refreshes, 1);
    assert.equal(h.clonedLayers, 1);
    assert.deepEqual(h.jobs, []);
    assert.deepEqual(personal.editorState, before);
  }
});

test('failed sources and failed copies cannot be automatically retried by any GET entry', async () => {
  for (const method of ['getById', 'getParseStatus', 'getLayers']) {
    for (const status of ['completed', 'failed']) {
      const personal = copy({ parseStatus: status, parseResult: { pdfParserVersion: 76, hasRetainedResult: true } });
      const before = structuredClone(personal.editorState);
      const h = harness([source(), personal]);
      const result = await h.invoke(method, 6411);
      assert.equal(result.error, undefined);
      if (method !== 'getLayers') {
        assert.equal(result.response.data.sourceParseStatus, 'failed');
        assert.equal(result.response.data.autoParseBlocked, true);
      }
      assert.deepEqual(h.jobs, []);
      assert.deepEqual(h.updates, []);
      assert.deepEqual(personal.editorState, before);
    }
    const h = harness([source({ parseStatus: 'completed', parseResult: editableResult() }), copy({ parseStatus: 'failed' })]);
    assert.equal((await h.invoke(method, 6411)).error, undefined);
    assert.deepEqual(h.jobs, []);
    assert.deepEqual(h.updates, []);
  }
});

test('a pending copy with a soft-deleted source recovers through its own material', async () => {
  for (const method of ['getById', 'getParseStatus', 'getLayers']) {
    const personal = copy({ parseStatus: 'pending', filePath: 'originals/kept.pdf' });
    const before = structuredClone(personal.editorState);
    const h = harness([source({ isDeleted: true }), personal]);
    assert.equal((await h.invoke(method, 6411)).error, undefined);
    assert.equal(h.jobs.length, 1);
    assert.equal(h.jobs[0].id, 6411);
    assert.equal(h.jobs[0].options.preserveEditorState, true);
    assert.equal(personal.sourceFileId, 6410);
    assert.equal(personal.filePath, 'originals/kept.pdf');
    assert.deepEqual(personal.editorState, before);
    assert.deepEqual(h.updates, []);
  }
});

test('finishing late join reports syncing consistently without late database pending writes', async () => {
  const original = source({ parseStatus: 'parsing', parseResult: editableResult({ pdfParserVersion: 77, parseRevision: 'before' }) });
  const personal = copy({ parseStatus: 'completed', parseResult: editableResult({ pdfParserVersion: 77, parseRevision: 'before' }) });
  const saved = structuredClone(personal.editorState);
  const h = harness([original, personal], { queuePhase: 'finishing', allowRefresh: true });
  for (const method of ['getById', 'getParseStatus', 'getLayers']) {
    const result = await h.invoke(method, 6411);
    assert.equal(result.error, undefined);
    const freshness = method === 'getLayers' ? result.response.parseFreshness : result.response.data.parseFreshness;
    assert.equal(freshness.state, 'syncing');
    assert.equal(freshness.revision, 'before');
    if (method === 'getLayers') assert.deepEqual(result.response.data, []);
    else assert.equal(result.response.data.parseStatus, 'pending');
  }
  assert.equal(personal.parseStatus, 'completed');
  assert.deepEqual(h.updates, []);
  assert.deepEqual(personal.editorState, saved);
  assert.equal(h.layerReads, 0);
  assert.ok(h.jobs.every(job => job.id === 6410 && job.options.priority === 'interactive'));
  original.parseStatus = 'completed';
  original.parseResult = editableResult({ parseRevision: 'after' });
  const ready = await h.invoke('getById', 6411);
  assert.equal(ready.response.data.parseFreshness.state, 'ready');
  assert.equal(ready.response.data.parseFreshness.revision, 'after');
  assert.equal(ready.response.data.parseStatus, 'completed');
  assert.deepEqual(personal.editorState, saved);
});

test('layers verify revision after locking source then copy and use a current locking layer read', async () => {
  const original = source({ parseStatus: 'completed', parseResult: editableResult({ parseRevision: 'generation-one' }) });
  const personal = copy({ parseStatus: 'completed', parseResult: editableResult({ parseRevision: 'generation-one' }) });
  let publishOnLock = true;
  const h = harness([original, personal], { allowRefresh: true, beforeSourceLock: async record => {
    if (publishOnLock) {
      record.parseResult = editableResult({ parseRevision: 'generation-two' });
      publishOnLock = false;
    }
  } });
  const stale = await h.invoke('getLayers', 6411, undefined, { expectedParseRevision: 'generation-one' });
  assert.equal(stale.error, undefined);
  assert.equal(stale.response.parseFreshness.state, 'syncing');
  assert.deepEqual(stale.response.data, []);
  assert.deepEqual(h.lockOrder, [6410, 6411]);
  assert.equal(h.layerReads, 0);
  const fresh = await h.invoke('getById', 6411);
  assert.equal(fresh.response.data.parseFreshness.state, 'ready');
  assert.equal(fresh.response.data.parseFreshness.revision, 'generation-two');
  const mismatch = await h.invoke('getLayers', 6411, undefined, { expectedParseRevision: 'generation-one' });
  assert.equal(mismatch.response.parseFreshness.state, 'ready');
  assert.equal(mismatch.response.parseFreshness.revision, 'generation-two');
  assert.deepEqual(mismatch.response.data, []);
  const matched = await h.invoke('getLayers', 6411, undefined, { expectedParseRevision: 'generation-two' });
  assert.equal(matched.error, undefined);
  assert.equal(matched.response.data.length, 1);
  assert.deepEqual(h.lockOrder.slice(-2), [6410, 6411]);
  assert.equal(h.layerQueries.at(-1).lock, 'UPDATE');
  assert.ok(h.layerQueries.at(-1).transaction);
});

test('ready metadata-only SVG with no SQL objects reports readiness independently of an empty layer array', async () => {
  const original = source({ parseStatus: 'completed', parseResult: editableResult({ parseRevision: 'svg-only' }) });
  const h = harness([original], { layerRows: new Map([[6410, []]]) });
  const response = (await h.invoke('getLayers', 6410, undefined, { expectedParseRevision: 'svg-only' })).response;
  assert.equal(response.parseFreshness.state, 'ready');
  assert.deepEqual(response.data, []);
  assert.deepEqual(h.jobs, []);
});

test('old AI opens interactively while non-parser formats omit the freshness contract', async () => {
  const aiVersion = versionModule.exports.AI_PARSER_VERSION;
  const ai = source({ fileType: 'ai', parseStatus: 'completed', parseResult: { aiParserVersion: aiVersion - 1 } });
  const h = harness([ai], { queueUpdates: true, queuePhase: 'queued' });
  const status = (await h.invoke('getParseStatus', 6410)).response.data;
  assert.equal(status.parseFreshness.state, 'queued');
  assert.equal(status.parseFreshness.requiredVersion, aiVersion);
  assert.equal(h.jobs[0].options.priority, 'interactive');
  const image = source({ fileType: 'png', parseStatus: 'completed', parseResult: null });
  const plain = harness([image]);
  const detail = (await plain.invoke('getById', 6410)).response.data;
  assert.equal(detail.parseStatus, 'completed');
  assert.equal(detail.parseFreshness, undefined);
  assert.deepEqual(plain.jobs, []);
});

test('opening an already queued current source promotes its existing attempt before the pending write', async () => {
  const original = source({ parseStatus: 'completed', parseResult: editableResult({ parseRevision: 'preceding' }) });
  const personal = copy({ parseStatus: 'completed', parseResult: editableResult({ parseRevision: 'preceding' }) });
  const h = harness([original, personal], { queuePhase: 'queued' });
  const detail = (await h.invoke('getById', 6411)).response.data;
  assert.equal(detail.parseFreshness.state, 'queued');
  assert.equal(detail.parseStatus, 'pending');
  assert.equal(h.jobs[0].id, 6410);
  assert.equal(h.jobs[0].options.priority, 'interactive');
  assert.deepEqual(h.updates, []);
});

test('current AI checks SVG and preview resources instead of accepting a version alone', async () => {
  const aiParserVersion = versionModule.exports.AI_PARSER_VERSION;
  for (const result of [
    { aiParserVersion, svgPath: 'missing.svg', editableSvg: true },
    { aiParserVersion, editableSvg: false, previewLayerCount: 1, previewPath: 'missing.png' },
    { aiParserVersion, svgPath: 'empty-ai.svg', editableSvg: true },
  ]) {
    fs.writeFileSync(path.join(assets, 'empty-ai.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const original = source({ fileType: 'ai', parseStatus: 'completed', parseResult: result });
    const h = harness([original], { queueUpdates: true, queuePhase: 'queued' });
    const detail = (await h.invoke('getById', 6410)).response.data;
    assert.equal(detail.parseFreshness.state, 'queued');
    assert.equal(h.jobs.length, 1);
    assert.equal(h.jobs[0].options.priority, 'interactive');
  }
  for (const result of [
    { aiParserVersion, svgPath: 'editable.svg', editableSvg: true },
    { aiParserVersion, editableSvg: false, previewLayerCount: 1, previewPath: 'preview.png' },
  ]) {
    const original = source({ fileType: 'ai', parseStatus: 'completed', parseResult: result });
    const h = harness([original]);
    assert.equal((await h.invoke('getById', 6410)).response.data.parseFreshness.state, 'ready');
    assert.deepEqual(h.jobs, []);
  }
});
test('AI page saves retain other owned pages and reject foreign page maps', async () => {
  const beforeOne = pageState(1, 'keep first', { __aiParserVersion: 52 });
  const beforeTwo = pageState(2, 'keep second', { __aiParserVersion: 52 });
  const personal = previewCopy({ fileType: 'ai', parseResult: { aiParserVersion: versionModule.exports.AI_PARSER_VERSION,
    pages: [{ page: 1 }, { page: 2 }] }, editorState: { ...beforeTwo, __pageStates: { '1': beforeOne, '2': beforeTwo } } });
  const h = harness([personal]);
  const response = await h.invoke('saveEditorState', 6411, { editorState: pageState(1, 'changed first', {
    __aiParserVersion: 53, __pageStates: { '2': pageState(2, 'forged') } }) });
  assert.equal(response.error, undefined);
  assert.equal(personal.editorState.__pageStates['2'].objects[0].text, 'keep second');
  assert.equal(personal.editorState.__pageStates['1'].objects[0].text, 'changed first');
  assert.equal((await h.invoke('saveEditorState', 6411, { editorState: pageState(3, 'foreign') })).error.statusCode, 409);
});
