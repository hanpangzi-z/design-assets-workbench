const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../src/services/fileIngestService.ts');
const executable = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;

function harness({ failChild = false, orphan = false } = {}) {
  const original = { id: 71, fileType: 'psd', filePath: '/fixture/source.psb', isDeleted: false,
    parseStatus: 'completed', width: 2, height: 2,
    parseResult: { compositePath: 'parsed/71/old/composite.png' } };
  const published = { ...original, width: 3, thumbnailPath: 'parsed/71/new/thumb.png',
    parseResult: { compositePath: 'parsed/71/new/composite.png', artifactDirectory: 'parsed/71/new' } };
  const state = { files: [], layers: [], jobs: [], locks: 0 };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  class AppError extends Error {
    constructor(message, statusCode) { super(message); this.statusCode = statusCode; }
  }
  const database = {
    async transaction(operation) {
      const files = structuredClone(state.files), layers = structuredClone(state.layers);
      try { return await operation(transaction); }
      catch (error) { state.files = files; state.layers = layers; throw error; }
    },
  };
  const models = {
    DesignFile: {
      async findByPk(id, options) {
        if (id !== 71) return state.files.find(file => file.id === id);
        assert.equal(options.transaction, transaction);
        assert.equal(options.lock, transaction.LOCK.UPDATE);
        state.locks++;
        return published;
      },
      async create(values, options) {
        assert.equal(options.transaction, transaction);
        assert.equal(state.locks, 1);
        const file = { ...values, id: 72 };
        state.files.push(file);
        return file;
      },
    },
    ParsedLayer: {
      async findAll(options) {
        assert.equal(options.transaction, transaction);
        assert.equal(options.where.fileId, 71);
        return [{ id: 701, parentLayerId: null, layerType: 'group' },
          { id: 702, parentLayerId: orphan ? 999 : 701, layerType: 'image',
            imagePath: 'parsed/71/new/layer.png', properties: { psdMask: { imagePath: 'parsed/71/new/mask.png' } } }];
      },
      async create(values, options) {
        assert.equal(options.transaction, transaction);
        if (failChild && values.layerType === 'image') throw new Error('child insert failed');
        const layer = { ...values, id: 800 + state.layers.length };
        state.layers.push(layer);
        return layer;
      },
    },
    Category: { findAll: async () => [] },
    FileTag: {}, FileCategory: {}, Tag: {}, Library: {}, User: {},
  };
  const stubs = {
    fs: { existsSync: () => true },
    '../config/database': database,
    '../models': models,
    '../middleware/errorHandler': { AppError },
    './parser/parseOrchestrator': { enqueueParse: async (...args) => state.jobs.push(args) },
  };
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = name => Object.hasOwn(stubs, name) ? stubs[name]
    : name.startsWith('.') ? {} : originalRequire(name);
  loaded._compile(executable, filename);
  return { state, api: loaded.exports, clone: () => loaded.exports.cloneDesignFileObject({
    sourceFile: original, originalName: 'fixture.PSB', userId: 7, libraryId: null, storageScope: 'my',
  }) };
}

test('instant PSB clone copies one locked generation of metadata, pixels, masks and hierarchy', async () => {
  const h = harness();
  const copy = await h.clone();
  assert.equal(copy.fileType, 'psd');
  assert.equal(copy.originalFilename, 'fixture.PSB');
  assert.equal(copy.width, 3);
  assert.equal(copy.parseResult.compositePath, 'parsed/71/new/composite.png');
  assert.equal(copy.thumbnailPath, 'parsed/71/new/thumb.png');
  const group = h.state.layers.find(layer => layer.layerType === 'group');
  const child = h.state.layers.find(layer => layer.layerType === 'image');
  assert.equal(child.parentLayerId, group.id);
  assert.equal(child.imagePath, 'parsed/71/new/layer.png');
  assert.equal(child.properties.psdMask.imagePath, 'parsed/71/new/mask.png');
  assert.deepEqual(h.state.jobs, []);
});

test('instant clone rolls back its file and already inserted parent when child publication fails', async () => {
  const h = harness({ failChild: true });
  await assert.rejects(h.clone(), /child insert failed/);
  assert.deepEqual(h.state.files, []);
  assert.deepEqual(h.state.layers, []);
  assert.deepEqual(h.state.jobs, []);
});

test('instant clone rejects an orphan tree without committing a partial personal file', async () => {
  const h = harness({ orphan: true });
  await assert.rejects(h.clone(), error => error.statusCode === 409);
  assert.deepEqual(h.state.files, []);
  assert.deepEqual(h.state.layers, []);
});

test('PSB file-type alias routes case-insensitive large documents to the PSD parser', () => {
  const { api } = harness();
  assert.equal(api.getFileType('large.psb'), 'psd');
  assert.equal(api.getFileType('large.PSB'), 'psd');
  assert.equal(api.getFileType('small.psd'), 'psd');
  assert.equal(api.getFileType('ordinary.png'), 'png');
});
