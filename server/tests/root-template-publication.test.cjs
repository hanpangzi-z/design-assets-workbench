const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const controllerPath = path.resolve(__dirname, '../src/controllers/fileController.ts');
const executable = ts.transpileModule(fs.readFileSync(controllerPath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;

function harness(publishedStatus) {
  const sourceBeforePublication = { id: 71, fileType: 'psd', isDeleted: false, isPersonalCopy: false,
    name: 'fixture', parseStatus: 'completed', width: 2, height: 2,
    parseResult: { psdParserVersion: 9, compositePath: 'parsed/71/old/composite.png' } };
  const sourceAfterPublication = { ...sourceBeforePublication, parseStatus: publishedStatus, width: 3,
    parseResult: publishedStatus === 'completed'
      ? { psdParserVersion: 9, compositePath: 'parsed/71/new/composite.png' }
      : { psdParserVersion: 9, error: 'publication failed' } };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const events = [], copiedLayers = [], jobs = [];
  let createdCopy;
  class AppError extends Error {
    constructor(message, statusCode) { super(message); this.statusCode = statusCode; }
  }
  const models = {
    sequelize: { transaction: async operation => operation(transaction) },
    DesignFile: {
      count: async () => 0,
      async findByPk(id, options) {
        if (id !== 71) return createdCopy;
        if (!options?.lock) return { ...sourceBeforePublication };
        assert.equal(options.transaction, transaction);
        assert.equal(options.lock, transaction.LOCK.UPDATE);
        events.push('locked-source');
        return sourceAfterPublication;
      },
      async create(values, options) {
        assert.equal(options.transaction, transaction);
        assert.deepEqual(events, ['locked-source']);
        createdCopy = { ...values, id: 72 };
        events.push('created-copy');
        return createdCopy;
      },
    },
    ParsedLayer: {
      async findAll(options) {
        assert.equal(options.transaction, transaction);
        assert.equal(options.where.fileId, 71);
        return [{ id: 701, parentLayerId: null, layerName: 'source', layerType: 'image',
          sortOrder: 0, imagePath: 'parsed/71/new/layer.png' }];
      },
      async create(values, options) {
        assert.equal(options.transaction, transaction);
        copiedLayers.push(values);
        return { ...values, id: 702 };
      },
    },
    FileTag: { findAll: async () => [] }, FileCategory: { findAll: async () => [] },
    User: {}, Category: {}, Library: {}, Tag: {}, FileVersion: {},
  };
  const stubs = {
    '../models': models,
    '../middleware/errorHandler': { AppError },
    '../services/parser/parserVersions': { PSD_PARSER_VERSION: 9, PDF_PARSER_VERSION: 77, AI_PARSER_VERSION: 52 },
    '../services/parser/parseOrchestrator': { enqueueParse: async (...args) => jobs.push(args) },
  };
  const module = new Module(controllerPath);
  module.filename = controllerPath;
  module.paths = Module._nodeModulePaths(path.dirname(controllerPath));
  const originalRequire = module.require.bind(module);
  module.require = name => Object.hasOwn(stubs, name) ? stubs[name] : name.startsWith('../') ? {} : originalRequire(name);
  module._compile(executable, controllerPath);
  return {
    copiedLayers, jobs,
    get createdCopy() { return createdCopy; },
    async invoke() {
      let response, error;
      await module.exports.useTemplate({ params: { id: '71' }, user: { id: 7 } },
        { status() { return this; }, json(value) { response = value; } }, value => { error = value; });
      return { response, error };
    },
  };
}

test('use-template reads one published generation after locking the source before copy creation', async () => {
  const h = harness('completed');
  const { response, error } = await h.invoke();
  assert.equal(error, undefined);
  assert.equal(response.code, 201);
  assert.equal(h.createdCopy.parseResult.compositePath, 'parsed/71/new/composite.png');
  assert.equal(h.createdCopy.width, 3);
  assert.equal(h.copiedLayers[0].imagePath, 'parsed/71/new/layer.png');
  assert.deepEqual(h.jobs, []);
});

test('use-template does not create a copy when the source becomes failed before its lock is acquired', async () => {
  const h = harness('failed');
  const { error } = await h.invoke();
  assert.equal(error?.statusCode, 409);
  assert.equal(h.createdCopy, undefined);
  assert.deepEqual(h.copiedLayers, []);
  assert.deepEqual(h.jobs, []);
});
