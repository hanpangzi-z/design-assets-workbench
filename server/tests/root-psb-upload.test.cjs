const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../src/controllers/fileController.ts');
const executable = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;

function harness() {
  const state = { files: [], jobs: [], assistInputs: [], countQueries: [], libraryQueries: [] };
  class AppError extends Error {
    constructor(message, statusCode) { super(message); this.statusCode = statusCode; }
  }
  const unexpectedMutation = () => { throw new Error('Upload test attempted an actual filesystem operation'); };
  const models = {
    DesignFile: {
      async count(options) { state.countQueries.push(options); return 0; },
      async create(values) {
        const file = { ...values, id: 90 + state.files.length };
        state.files.push(file);
        return file;
      },
      async findByPk(id) { return state.files.find(file => file.id === id); },
    },
    Library: {
      async findByPk(id) { state.libraryQueries.push(id); return { id, isDeleted: false }; },
    },
    Category: { findAll: async () => [] },
    User: {}, Tag: {}, FileTag: {}, FileCategory: {}, ParsedLayer: {}, FileVersion: {}, sequelize: {},
  };
  const stubs = {
    fs: { promises: { unlink: unexpectedMutation } },
    '../models': models,
    '../middleware/errorHandler': { AppError },
    '../services/parser/parseOrchestrator': { enqueueParse: async (...args) => state.jobs.push(args) },
    '../services/parser/parserVersions': { PSD_PARSER_VERSION: 9, PDF_PARSER_VERSION: 77, AI_PARSER_VERSION: 52 },
    '../services/fontRegistry': { isFontFileType: () => false },
    '../services/clientUploadPreview': { applyClientUploadPreviewBodyToFile: async () => false },
    '../services/parser/clientParseAssist': {
      normalizeClientParseAssistFromBody(body, options) { state.assistInputs.push(options); return null; },
      materializeClientParseAssistPreview: async () => null,
    },
    '../utils/logger': { logger: { info() {} } },
  };
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = name => Object.hasOwn(stubs, name) ? stubs[name]
    : name.startsWith('../') ? {} : originalRequire(name);
  loaded._compile(executable, filename);
  return { state, async invoke(originalName, personal) {
    let response, error, responseStatus;
    await loaded.exports.upload({
      file: { originalname: originalName, path: '/isolated-upload/large.psb', size: 256 },
      body: personal ? { storageScope: 'my' } : { libraryId: '5' },
      user: { id: 7 }, userPermissions: { upload: !personal },
    }, {
      status(value) { responseStatus = value; return this; },
      json(value) { response = value; },
    }, value => { error = value; });
    return { response, error, responseStatus };
  } };
}

for (const [scope, originalName, personal] of [
  ['library', 'library-large.PsB', false],
  ['personal', 'personal-large.pSB', true],
]) {
  test(`ordinary ${scope} PSB upload preserves its filename and enqueues the PSD parser`, async () => {
    const h = harness();
    const { response, error, responseStatus } = await h.invoke(originalName, personal);
    assert.equal(error, undefined);
    assert.equal(responseStatus, 201);
    assert.equal(response.code, 201);
    assert.equal(h.state.files.length, 1);
    const uploaded = h.state.files[0];
    assert.equal(uploaded.fileType, 'psd');
    assert.equal(uploaded.originalFilename, originalName);
    assert.equal(uploaded.isPersonalCopy, personal);
    assert.equal(uploaded.libraryId, personal ? null : 5);
    assert.equal(uploaded.parseStatus, 'pending');
    assert.deepEqual(h.state.jobs, [[uploaded.id, { clientAssistSnapshot: null, priority: 'interactive' }]]);
    assert.deepEqual(h.state.assistInputs, [{ fileType: 'psd', fileName: originalName }]);
    assert.equal(response.data, uploaded);
    assert.equal(h.state.countQueries.length, personal ? 1 : 0);
    assert.deepEqual(h.state.libraryQueries, personal ? [] : [5]);
  });
}
