const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { ParsedLayer: RealParsedLayer } = require('../dist/models');

const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/services/parser/parseOrchestrator.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const tick = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('Expected queue transition did not occur');
}
const completedPatch = () => ({ parseStatus: 'completed', parseResult: { pdfParserVersion: 77, method: 'fixture' } });
const source = (id = 1) => ({ id, fileType: 'pdf', name: 'fixture', parseStatus: 'failed', parseResult: { error: 'old failure' },
  isDeleted: false, isPersonalCopy: false, editorState: { saved: id } });
const copy = (id, sourceFileId = 1) => ({ ...source(id), sourceFileId, isPersonalCopy: true });

function harness(records, hooks = {}) {
  const state = { workers: [], writes: [], layerWrites: [], removals: [], errors: [] };
  const files = new Map(records.map(record => [record.id, record]));
  const layers = new Map(records.map(record => [record.id, [{ id: record.id * 100, fileId: record.id,
    parentLayerId: null, layerName: 'old layer', sortOrder: 1 }]]));
  let layerId = 1000, attempt = 0;
  async function update(record, patch, via) {
    state.writes.push({ id: record.id, patch, via });
    await hooks.update?.(record, patch, via);
    Object.assign(record, patch);
  }
  for (const record of records) record.update = patch => update(record, patch, 'instance');
  const models = {
    DesignFile: {
      findByPk: async id => files.get(id) || null,
      async findAll({ where }) {
        return records.filter(record => Object.entries(where).every(([key, value]) => record[key] === value));
      },
      async update(patch, { where }) {
        for (const record of records) {
          if (Object.entries(where).every(([key, value]) => record[key] === value)) await update(record, patch, 'static');
        }
      },
    },
    ParsedLayer: {
      async findAll({ where }) {
        if (hooks.layerModels?.has(where.fileId)) return hooks.layerModels.get(where.fileId);
        return (layers.get(where.fileId) || []).map(layer => ({ ...layer, get: () => ({ ...layer }) }));
      },
      async destroy({ where }) {
        state.layerWrites.push({ type: 'destroy', fileId: where.fileId });
        layers.set(where.fileId, []);
      },
      async create(values) {
        const layer = hooks.createLayer ? await hooks.createLayer(values) : { ...values, id: ++layerId };
        state.layerWrites.push({ type: 'create', fileId: values.fileId });
        layers.get(values.fileId).push(layer);
        return layer;
      },
    },
  };
  const modules = {
    'fs/promises': {
      mkdir: async () => {},
      async rm(directory) { state.removals.push(directory); await hooks.remove?.(directory); },
    },
    path,
    crypto: { randomUUID: () => `attempt-${++attempt}` },
    '../../config/database': { transaction: async operation => operation({ LOCK: { UPDATE: 'UPDATE' } }) },
    '../../config/storage': { STORAGE: { base: '/fixture/uploads' } },
    '../../models': models,
    '../../utils/logger': { logger: { info() {}, warn() {}, error: values => state.errors.push(values) } },
    '../uploadThumbnailVariants': { warmUploadThumbnailVariants() {} },
    './parserVersions': { PSD_PARSER_VERSION: 8, AI_PARSER_VERSION: 52, PDF_PARSER_VERSION: 77 },
    './parserExecution': {
      validateParserCandidate: async () => {},
      async publishParserResult(file, patch) {
        const { layers: candidateLayers, ...metadata } = patch;
        await file.update(metadata);
      },
    },
    './parserWorkerSupervisor': {
      startParserWorker(input) {
        const result = deferred();
        const worker = { input, result: result.promise, assists: [], cancellations: [],
          succeed: patch => result.resolve(patch || completedPatch()), fail: result.reject,
          updateAssist(snapshot, allowWait) { this.assists.push({ snapshot, allowWait }); },
          async cancel(reason) { this.cancellations.push(reason); result.reject(new Error(reason)); },
        };
        state.workers.push(worker);
        return worker;
      },
    },
  };
  const api = {};
  vm.runInNewContext(code, {
    exports: api,
    require(name) { if (!(name in modules)) throw new Error(`Unexpected queue import: ${name}`); return modules[name]; },
    process: { env: {} }, setImmediate,
  }, { filename: 'parseOrchestrator.js' });
  return { api, state, files, layers };
}

test('cloning fully associated Sequelize models targets copy SQL fields and preserves the source graph', async t => {
  const sourceModels = [
    RealParsedLayer.build({ id: 101, fileId: 1, file_id: 1, layerName: 'source group', layerType: 'group', parentLayerId: null, parent_layer_id: null, sortOrder: 1 }),
    RealParsedLayer.build({ id: 102, fileId: 1, file_id: 1, layerName: 'source child', layerType: 'image', parentLayerId: 101, parent_layer_id: 101, sortOrder: 2 }),
  ];
  assert.equal(sourceModels[0].get({ plain: true }), sourceModels[0].dataValues,
    'The regression must exercise Sequelize returning its mutable dataValues');
  assert.equal(sourceModels[0].get({ plain: true }).file_id, 1);
  assert.equal(sourceModels[1].get({ plain: true }).parent_layer_id, 101);
  const originalValues = sourceModels.map(model => ({ ...model.dataValues }));
  const queryInterface = RealParsedLayer.sequelize.getQueryInterface();
  const originalInsert = queryInterface.insert;
  t.after(() => { queryInterface.insert = originalInsert; });
  let insertId = 2000;
  let expectedInsert;
  const sqlInserts = [];
  const cloneRequests = [];
  queryInterface.insert = async (instance, table, fields) => {
    // Model.create/save has already applied its real attribute-to-SQL field mapping here.
    sqlInserts.push({ ...fields });
    assert.equal(fields.file_id, expectedInsert.fileId, 'SQL must target the personal copy, not the source alias');
    assert.equal(fields.parent_layer_id, expectedInsert.parentLayerId, 'SQL must reference the newly cloned parent');
    instance.setDataValue('id', ++insertId);
    return [instance, 1];
  };
  const h = harness([source(), copy(2), copy(3)], {
    layerModels: new Map([[1, sourceModels]]),
    async createLayer(values) {
      cloneRequests.push({ ...values });
      expectedInsert = { fileId: values.fileId, parentLayerId: values.parentLayerId };
      return RealParsedLayer.create(values);
    },
  });
  await h.api.enqueueParse(1, { resetSource: true, syncPersonalCopyIds: [2, 3] });
  await waitFor(() => h.state.workers.length === 1);
  h.state.workers[0].succeed();
  await waitFor(() => [2, 3].every(id => ['completed', 'failed'].includes(h.files.get(id).parseStatus)));
  for (const id of [2, 3]) {
    assert.equal(h.files.get(id).parseStatus, 'completed', h.state.errors.map(({ err }) => err?.message).join('; '));
    const rows = h.layers.get(id);
    assert.equal(rows.length, 2);
    const group = rows.find(layer => layer.layerType === 'group');
    const child = rows.find(layer => layer.layerType === 'image');
    assert.equal(group.parentLayerId, null);
    assert.equal(child.parentLayerId, group.id);
    assert.equal(group.fileId, id);
    assert.equal(child.fileId, id);
    assert.notEqual(group.id, 101);
    assert.notEqual(child.id, 102);
  }
  assert.deepEqual(sourceModels.map(model => ({ ...model.dataValues })), originalValues);
  assert.equal(sqlInserts.length, 4);
  assert.ok(sqlInserts.every(fields => fields.file_id === 2 || fields.file_id === 3));
  assert.ok(cloneRequests.every(values => !Object.hasOwn(values, 'file_id') && !Object.hasOwn(values, 'parent_layer_id')));
  assert.equal(h.state.errors.length, 0);
});

test('active duplicate merges assist and new copies without resetting source or existing layers', async () => {
  const h = harness([source(), copy(2), copy(3)]);
  await h.api.enqueueParse(1, { resetSource: true, syncPersonalCopyIds: [2] });
  await waitFor(() => h.state.workers.length === 1);
  const snapshot = { fileType: 'pdf', previewPath: '/fixture/client.png', textLayers: [] };
  await h.api.enqueueParse(1, { resetSource: true, syncPersonalCopyIds: [3], clientAssistSnapshot: snapshot, allowClientAssistWait: true });
  assert.equal(h.state.workers.length, 1);
  assert.equal(h.state.writes.filter(write => write.id === 1 && write.patch.parseStatus === 'pending').length, 1);
  assert.equal(h.files.get(1).parseStatus, 'parsing');
  assert.equal(h.state.layerWrites.length, 0);
  assert.equal(h.state.workers[0].assists.at(-1).snapshot, snapshot);
  h.state.workers[0].succeed();
  await waitFor(() => h.files.get(2).parseStatus === 'completed' && h.files.get(3).parseStatus === 'completed');
  assert.equal(h.layers.get(2)[0].layerName, 'old layer');
  assert.equal(h.layers.get(3)[0].layerName, 'old layer');
  assert.equal(h.files.get(2).editorState.saved, 2);
  assert.equal(h.files.get(3).editorState.saved, 3);
});

test('a retry arriving during result cleanup becomes a new attempt and old finally cannot delete it', async () => {
  const cleanupEntered = deferred(), releaseCleanup = deferred();
  const h = harness([source(), copy(2), copy(3)], {
    async remove(directory) {
      if (directory.endsWith('attempt-1')) { cleanupEntered.resolve(); await releaseCleanup.promise; }
    },
  });
  await h.api.enqueueParse(1, { resetSource: true });
  await waitFor(() => h.state.workers.length === 1);
  h.state.workers[0].succeed();
  await cleanupEntered.promise;
  await h.api.enqueueParse(1, { resetSource: true, syncPersonalCopyIds: [2] });
  assert.equal(h.files.get(2).parseStatus, 'pending');
  releaseCleanup.resolve();
  await waitFor(() => h.state.workers.length === 2);
  await h.api.enqueueParse(1, { resetSource: true, syncPersonalCopyIds: [3] });
  assert.equal(h.state.workers.length, 2);
  assert.equal(h.state.writes.filter(write => write.id === 1 && write.patch.parseStatus === 'pending').length, 2);
  h.state.workers[1].succeed();
  await waitFor(() => h.files.get(2).parseStatus === 'completed' && h.files.get(3).parseStatus === 'completed');
});

test('a copy added while another copy is synchronizing is included before the attempt finishes', async () => {
  const syncEntered = deferred(), releaseSync = deferred();
  const h = harness([source(), copy(2), copy(3)], {
    async update(record, patch) {
      if (record.id === 2 && patch.parseStatus === 'completed') { syncEntered.resolve(); await releaseSync.promise; }
    },
  });
  await h.api.enqueueParse(1, { resetSource: true, syncPersonalCopyIds: [2] });
  await waitFor(() => h.state.workers.length === 1);
  h.state.workers[0].succeed();
  await syncEntered.promise;
  assert.equal(h.api.getParseQueuePhase(1), 'finishing');
  assert.equal(h.files.get(1).parseStatus, 'completed');
  await h.api.enqueueParse(1, { syncPersonalCopyIds: [3], priority: 'interactive' });
  assert.equal(h.state.writes.filter(write => write.id === 3 && write.patch.parseStatus === 'pending').length, 0,
    'Late merges must not overwrite a committed or independently synchronized copy with pending');
  releaseSync.resolve();
  await waitFor(() => h.files.get(2).parseStatus === 'completed' && h.files.get(3).parseStatus === 'completed');
  assert.equal(h.state.workers.length, 1);
  assert.equal(h.files.get(3).parseResult.parseRevision, h.files.get(1).parseResult.parseRevision);
  await waitFor(() => h.api.getParseQueuePhase(1) === null);
});

test('a pending copy preparation prevents terminal commit until preparation settles', async () => {
  const preparationEntered = deferred(), releasePreparation = deferred();
  const h = harness([source(), copy(2)], {
    async update(record, patch, via) {
      if (record.id === 2 && patch.parseStatus === 'pending' && via === 'static') {
        preparationEntered.resolve(); await releasePreparation.promise;
      }
    },
  });
  await h.api.enqueueParse(1, { resetSource: true });
  await waitFor(() => h.state.workers.length === 1);
  const merged = h.api.enqueueParse(1, { syncPersonalCopyIds: [2] });
  await preparationEntered.promise;
  h.state.workers[0].succeed();
  await tick();
  assert.equal(h.files.get(1).parseStatus, 'parsing');
  releasePreparation.resolve();
  await merged;
  await waitFor(() => h.files.get(2).parseStatus === 'completed');
  assert.equal(h.files.get(1).parseStatus, 'completed');
});

test('worker failure persists versioned failure, synchronizes its copy and starts the next queued file', async () => {
  const h = harness([source(), copy(2), source(4)]);
  await h.api.enqueueParse(1, { resetSource: true, syncPersonalCopyIds: [2] });
  await h.api.enqueueParse(4, { resetSource: true });
  await waitFor(() => h.state.workers.length === 1);
  h.state.workers[0].fail(new Error('fixture timeout'));
  await waitFor(() => h.state.workers.length === 2);
  assert.equal(h.files.get(1).parseStatus, 'failed');
  assert.equal(h.files.get(2).parseStatus, 'failed');
  assert.equal(h.files.get(1).parseResult.pdfParserVersion, 77);
  assert.equal(h.files.get(1).parseResult.error, 'fixture timeout');
  assert.equal(h.files.get(2).editorState.saved, 2);
  assert.equal(h.state.workers[1].input.fileId, 4);
  h.state.workers[1].succeed();
  await waitFor(() => h.files.get(4).parseStatus === 'completed');
});

test('shutdown cancels active work, drains both queues with copies and refuses new work', async () => {
  const h = harness([source(), copy(2), source(4), copy(5, 4), source(6), copy(7, 6)]);
  await h.api.enqueueParse(1, { resetSource: true, syncPersonalCopyIds: [2] });
  await h.api.enqueueParse(4, { resetSource: true, syncPersonalCopyIds: [5] });
  await h.api.enqueueParse(6, { resetSource: true, syncPersonalCopyIds: [7], priority: 'interactive' });
  await waitFor(() => h.state.workers.length === 1);
  await h.api.shutdownParseQueue();
  assert.equal(h.state.workers.length, 1);
  assert.equal(h.state.workers[0].cancellations.length, 1);
  for (const id of [1, 2, 4, 5, 6, 7]) {
    assert.equal(h.files.get(id).parseStatus, 'failed');
    assert.equal(h.files.get(id).parseResult.pdfParserVersion, 77);
    assert.match(h.files.get(id).parseResult.error, /服务重启/);
    assert.equal(h.files.get(id).editorState.saved, id);
  }
  for (const id of [1, 4, 6]) assert.equal(h.api.getParseQueuePhase(id), null);
  await assert.rejects(h.api.enqueueParse(1), /正在停止/);
});

test('interactive jobs precede background FIFO; promotion and duplicate requests retain queue order', async () => {
  const h = harness([source(), source(2), source(3), source(4), source(5), source(6), copy(7, 3), copy(8, 3)]);
  await h.api.enqueueParse(1, { resetSource: true });
  await waitFor(() => h.state.workers.length === 1);
  await h.api.enqueueParse(2, { resetSource: true });
  await h.api.enqueueParse(3, { resetSource: true, syncPersonalCopyIds: [7] });
  await h.api.enqueueParse(4, { resetSource: true, priority: 'interactive' });
  await h.api.enqueueParse(5, { resetSource: true, priority: 'interactive' });
  await h.api.enqueueParse(6, { resetSource: true });
  await h.api.enqueueParse(3, { resetSource: true, syncPersonalCopyIds: [7, 8], priority: 'interactive' });
  await h.api.enqueueParse(4, { resetSource: true, priority: 'interactive' });
  await h.api.enqueueParse(3, { resetSource: true, priority: 'background' });
  await h.api.enqueueParse(1, { resetSource: true, priority: 'interactive' });
  assert.equal(h.state.workers.length, 1, 'Opening another file must never preempt the active worker');
  assert.equal(h.state.workers[0].cancellations.length, 0);
  assert.equal(h.api.getParseQueuePhase(1), 'parsing');
  assert.equal(h.api.getParseQueuePhase(3), 'queued');
  for (const id of [1, 3, 4, 7, 8]) {
    assert.equal(h.state.writes.filter(write => write.id === id && write.patch.parseStatus === 'pending').length, 1,
      'Duplicate requests must not reset a source or copy');
  }
  const order = [1, 4, 5, 3, 2, 6];
  for (let index = 0; index < order.length; index++) {
    await waitFor(() => h.state.workers.length === index + 1);
    assert.equal(h.state.workers[index].input.fileId, order[index]);
    h.state.workers[index].succeed();
  }
  await waitFor(() => order.every(id => h.api.getParseQueuePhase(id) === null));
  assert.equal(h.state.workers.length, order.length);
  assert.equal(h.files.get(7).parseResult.parseRevision, h.files.get(3).parseResult.parseRevision);
  assert.equal(h.files.get(8).parseResult.parseRevision, h.files.get(3).parseResult.parseRevision);
});

test('each successful parent commit stamps a new revision and copies inherit it, ignoring worker revisions', async () => {
  const h = harness([source(), copy(2)]);
  let previousRevision;
  for (let attempt = 0; attempt < 2; attempt++) {
    await h.api.enqueueParse(1, { resetSource: true, syncPersonalCopyIds: [2], priority: 'interactive' });
    await waitFor(() => h.state.workers.length === attempt + 1);
    const patch = completedPatch();
    patch.parseResult.parseRevision = 'worker-controlled-old-revision';
    h.state.workers[attempt].succeed(patch);
    await waitFor(() => h.api.getParseQueuePhase(1) === null);
    const committedRevision = h.files.get(1).parseResult.parseRevision;
    assert.ok(committedRevision);
    assert.notEqual(committedRevision, 'worker-controlled-old-revision');
    assert.notEqual(committedRevision, previousRevision);
    assert.equal(h.files.get(2).parseResult.parseRevision, committedRevision);
    assert.equal(h.files.get(2).editorState.saved, 2);
    previousRevision = committedRevision;
  }
});

test('interactive merge during active slot preparation cannot enqueue the same source again', async () => {
  const preparationEntered = deferred(), releasePreparation = deferred();
  const h = harness([source(), source(2)], {
    async update(record, patch, via) {
      if (record.id === 1 && patch.parseStatus === 'pending' && via === 'static') {
        preparationEntered.resolve(); await releasePreparation.promise;
      }
    },
  });
  const initial = h.api.enqueueParse(1, { resetSource: true });
  await preparationEntered.promise;
  await h.api.enqueueParse(2, { resetSource: true, priority: 'interactive' });
  const merged = h.api.enqueueParse(1, { resetSource: true, priority: 'interactive' });
  assert.equal(h.api.getParseQueuePhase(1), 'queued');
  assert.equal(h.state.workers.length, 0);
  releasePreparation.resolve();
  await Promise.all([initial, merged]);
  await waitFor(() => h.state.workers.length === 1);
  assert.equal(h.state.workers[0].input.fileId, 1);
  assert.equal(h.state.writes.filter(write => write.id === 1 && write.patch.parseStatus === 'pending').length, 1);
  h.state.workers[0].succeed();
  await waitFor(() => h.state.workers.length === 2);
  assert.equal(h.state.workers[1].input.fileId, 2);
  h.state.workers[1].succeed();
  await waitFor(() => h.api.getParseQueuePhase(2) === null);
  assert.equal(h.state.workers.length, 2);
});

test('a failed active task releases its slot to interactive work before older background work', async () => {
  const h = harness([source(), source(2), source(3)]);
  await h.api.enqueueParse(1, { resetSource: true });
  await h.api.enqueueParse(2, { resetSource: true });
  await h.api.enqueueParse(3, { resetSource: true, priority: 'interactive' });
  await waitFor(() => h.state.workers.length === 1);
  h.state.workers[0].fail(new Error('fixture crash'));
  await waitFor(() => h.state.workers.length === 2);
  assert.equal(h.files.get(1).parseStatus, 'failed');
  assert.equal(h.files.get(1).parseResult.parseRevision, undefined);
  assert.equal(h.state.workers[1].input.fileId, 3);
  h.state.workers[1].succeed();
  await waitFor(() => h.state.workers.length === 3);
  assert.equal(h.state.workers[2].input.fileId, 2);
  h.state.workers[2].succeed();
  await waitFor(() => h.api.getParseQueuePhase(2) === null);
});

test('a parent publication failure does not persist a new successful revision or destroy saved edits', async () => {
  const h = harness([source(), copy(2)], {
    async update(record, patch) {
      if (record.id === 1 && patch.parseStatus === 'completed') throw new Error('fixture publication failure');
    },
  });
  await h.api.enqueueParse(1, { resetSource: true, syncPersonalCopyIds: [2], priority: 'interactive' });
  await waitFor(() => h.state.workers.length === 1);
  h.state.workers[0].succeed();
  await waitFor(() => h.api.getParseQueuePhase(1) === null);
  for (const id of [1, 2]) {
    assert.equal(h.files.get(id).parseStatus, 'failed');
    assert.equal(h.files.get(id).parseResult.parseRevision, undefined);
    assert.equal(h.files.get(id).editorState.saved, id);
  }
});

test('pending and worker failure retain each source and copy resource revision with saved edits', async () => {
  const h = harness([
    { ...source(), parseStatus: 'completed', parseResult: { pdfParserVersion: 66, parseRevision: 'source-old', svgPath: 'parsed/1/old.svg' } },
    { ...copy(2), parseStatus: 'completed', parseResult: { pdfParserVersion: 65, parseRevision: 'copy-own-old', svgPath: 'parsed/1/copy-old.svg' } },
  ]);
  await h.api.enqueueParse(1, { resetSource: true, syncPersonalCopyIds: [2], priority: 'interactive' });
  await waitFor(() => h.state.workers.length === 1);
  assert.equal(h.files.get(1).parseResult.parseRevision, 'source-old');
  assert.equal(h.files.get(2).parseResult.parseRevision, 'copy-own-old');
  assert.equal(h.state.layerWrites.length, 0);
  h.state.workers[0].fail(new Error('fixture retained timeout'));
  await waitFor(() => h.api.getParseQueuePhase(1) === null);
  for (const [id, revision, version, svgPath] of [[1, 'source-old', 66, 'parsed/1/old.svg'], [2, 'copy-own-old', 65, 'parsed/1/copy-old.svg']]) {
    const record = h.files.get(id);
    assert.equal(record.parseStatus, 'failed');
    assert.equal(record.parseResult.parseRevision, revision);
    assert.equal(record.parseResult.pdfParserVersion, version);
    assert.equal(record.parseResult.svgPath, svgPath);
    assert.equal(record.parseResult.hasRetainedResult, true);
    assert.equal(record.parseResult.lastParseAttempt.pdfParserVersion, 77);
    assert.equal(record.parseResult.lastParseAttempt.parseRevision, undefined);
    assert.match(record.parseResult.error, /retained timeout/);
    assert.equal(record.editorState.saved, id);
    assert.equal(h.layers.get(id)[0].layerName, 'old layer');
  }
  assert.equal(h.state.layerWrites.length, 0);
});

test('shutdown of waiting source and copies retains old result through both queues', async () => {
  const h = harness([source(),
    { ...source(2), parseStatus: 'completed', parseResult: { pdfParserVersion: 66, parseRevision: 'waiting-source-old' } },
    { ...copy(3, 2), parseStatus: 'completed', parseResult: { pdfParserVersion: 65, parseRevision: 'waiting-copy-old' } },
    { ...source(4), parseStatus: 'completed', parseResult: { pdfParserVersion: 66, parseRevision: 'interactive-source-old' } },
    { ...copy(5, 4), parseStatus: 'completed', parseResult: { pdfParserVersion: 65, parseRevision: 'interactive-copy-old' } },
  ]);
  await h.api.enqueueParse(1, { resetSource: true });
  await waitFor(() => h.state.workers.length === 1);
  await h.api.enqueueParse(2, { resetSource: true, syncPersonalCopyIds: [3] });
  await h.api.enqueueParse(4, { resetSource: true, syncPersonalCopyIds: [5], priority: 'interactive' });
  for (const id of [2, 3, 4, 5]) assert.ok(h.files.get(id).parseResult.parseRevision);
  await h.api.shutdownParseQueue();
  for (const [id, revision] of [[2, 'waiting-source-old'], [3, 'waiting-copy-old'], [4, 'interactive-source-old'], [5, 'interactive-copy-old']]) {
    const record = h.files.get(id);
    assert.equal(record.parseStatus, 'failed');
    assert.equal(record.parseResult.parseRevision, revision);
    assert.equal(record.parseResult.hasRetainedResult, true);
    assert.match(record.parseResult.lastParseAttempt.error, /服务重启/);
    assert.equal(record.editorState.saved, id);
  }
  assert.equal(h.state.workers.length, 1);
});
