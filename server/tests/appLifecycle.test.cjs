const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const appSource = fs.readFileSync(path.join(__dirname, '../src/app.ts'), 'utf8');
const appCode = ts.transpileModule(appSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

async function flush() {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
}

async function boot({ env = {}, files = [], queueShutdown = async () => {}, closeHttp = true,
  existsSync = () => true, beforeLock = () => {} } = {}) {
  const inOperator = Symbol('in');
  const state = { queued: [], queries: [], imported: [], exits: [], timers: [], httpClosed: 0, forcedHttpClose: 0, dbClosed: 0, queueClosed: 0, merges: 0 };
  const signals = {};
  const httpServer = {
    on() {},
    close(callback) { state.httpClosed += 1; if (closeHttp) callback(); },
    closeAllConnections() { state.forcedHttpClose += 1; },
  };
  const app = {
    disable() {}, use() {}, get() {},
    listen(...args) {
      state.listen = args.slice(0, -1);
      setImmediate(args.at(-1));
      return httpServer;
    },
  };
  const express = () => app;
  express.json = express.urlencoded = express.static = () => () => {};
  const sequelize = {
    authenticate: async () => {}, sync: async () => {},
    transaction: async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }),
    close: async () => { state.dbClosed += 1; },
    getQueryInterface: () => ({ showAllTables: async () => [] }),
  };
  const models = {
    sequelize,
    DesignFile: {
      findByPk: async (id) => { beforeLock(id); return files.find((file) => file.id === id); },
      findAll: async (options) => {
        state.queries.push(options);
        return files.filter((file) => Object.entries(options.where).every(([key, value]) => {
          if (Array.isArray(value)) return value.includes(file[key]);
          if (value && typeof value === 'object' && value[inOperator]) return value[inOperator].includes(file[key]);
          return file[key] === value;
        })).map((file) => ({ ...file }));
      },
    },
    Role: { findOne: async () => null, create: async () => {} },
    Library: {}, Category: {}, User: {},
  };
  const modules = {
    dotenv: { config() {} }, path, fs: { existsSync, mkdirSync: () => { throw new Error('Unexpected filesystem mutation'); } },
    express, cors: () => () => {}, compression: () => () => {}, 'pino-http': () => () => {},
    sequelize: { DataTypes: {}, Op: { in: inOperator }, QueryTypes: {} },
    './models': models,
    './middleware/errorHandler': { errorHandler() {} },
    './constants/roles': { BUILT_IN_ROLES: [] },
    './config/storage': { STORAGE: { base: '/candidate/uploads' } },
    './services/parser/parseOrchestrator': {
      enqueueParse: async (id) => { state.queued.push(id); },
      shutdownParseQueue: async () => { state.queueClosed += 1; await queueShutdown(); },
    },
    './services/parser/parserVersions': { AI_PARSER_VERSION: 52, PDF_PARSER_VERSION: 77, PSD_PARSER_VERSION: 9 },
    './services/parser/resolveParserFilePath': { resolveParserFilePath: (filePath) => filePath },
    './controllers/transferController': { recoverReadyMerges: async () => { state.merges += 1; } },
    './utils/logger': { logger: { info() {}, warn() {}, error() {}, fatal() {} } },
    './utils/superAdmin': { getSuperAdminIdentifiers: () => [], getSuperAdminUserWhere: () => ({}) },
  };
  vm.runInNewContext(appCode, {
    exports: {}, __dirname: path.join(__dirname, '../src'),
    require(name) {
      state.imported.push(name);
      if (name.startsWith('./routes/')) return () => {};
      if (!(name in modules)) throw new Error(`Unexpected application import: ${name}`);
      return modules[name];
    },
    process: { env, on: (signal, callback) => { signals[signal] = callback; }, exit: (code) => { state.exits.push(code); } },
    setTimeout(callback, ms) { const timer = { callback, ms, cleared: false }; state.timers.push(timer); return timer; },
    clearTimeout(timer) { timer.cleared = true; },
  }, { filename: 'app.js' });
  await flush();
  return { state, signals };
}

test('candidate binds loopback and disables all startup task recovery without importing heavy parsers', async () => {
  const { state } = await boot({ env: {
    HOST: '127.0.0.1', PORT: '3098', DISABLE_BOOTSTRAP_PARSE: '1', DISABLE_BOOTSTRAP_STALE_PARSE: '1',
    ENABLE_BOOTSTRAP_STALE_PARSE: '1', DISABLE_BOOTSTRAP_TRANSFER_RECOVERY: '1',
  } });
  assert.deepEqual(state.listen, [3098, '127.0.0.1']);
  assert.equal(state.queries.length, 0);
  assert.equal(state.merges, 0);
  assert.equal(state.imported.some((name) => /\/(?:ai|pdf|psd)Parser$/.test(name)), false);
});

test('startup recovers active files and completed stale sources, excluding deleted and failed source records', async () => {
  const file = (id, parseStatus, extra = {}) => ({ id, parseStatus, fileType: 'pdf', filePath: `/candidate/uploads/${id}.pdf`, isDeleted: false, ...extra });
  const { state } = await boot({ env: { ENABLE_BOOTSTRAP_STALE_PARSE: '1' }, files: [
    file(11, 'pending'), file(12, 'parsing'), file(13, 'pending', { isDeleted: true }),
    file(14, 'completed'), file(15, 'completed', { sourceFileId: 16 }), file(16, 'failed'),
    file(17, 'completed', { isDeleted: true }), file(18, 'failed'),
  ] });
  assert.deepEqual(state.listen, [3088]);
  assert.deepEqual(state.queued, [11, 12, 14]);
  assert.equal(state.merges, 1);
  assert.equal(state.queries.every((query) => query.where.isDeleted === false), true);
  assert.equal(state.queries.slice(1).every((query) => query.where.parseStatus === 'completed'), true);
});

test('missing sources during startup retain each prior published generation and editor state', async () => {
  const makeFile = (id, fileType, parseStatus, parseResult) => ({ id, fileType, parseStatus, parseResult,
    filePath: `/candidate/uploads/${id}.${fileType}`, isDeleted: false, editorState: { saved: id },
    async update(patch) { Object.assign(this, patch); } });
  const files = [
    makeFile(31, 'psd', 'pending', { psdParserVersion: 8, compositeImagePath: 'parsed/31/old/composite.png' }),
    makeFile(32, 'pdf', 'completed', { pdfParserVersion: 76, pages: [{ imagePath: 'parsed/32/old/page.png' }] }),
    makeFile(33, 'ai', 'parsing', { aiParserVersion: 51, error: 'prior failure', hasRetainedResult: true,
      artifactDirectory: 'parsed/33/old' }),
    makeFile(34, 'psd', 'pending', null),
  ];
  const { state } = await boot({ env: { ENABLE_BOOTSTRAP_STALE_PARSE: '1' }, files,
    existsSync: (filename) => !files.some((file) => file.filePath === filename) });
  assert.deepEqual(state.queued, []);
  for (const file of files) {
    assert.equal(file.parseStatus, 'failed');
    assert.deepEqual(file.editorState, { saved: file.id });
    assert.match(file.parseResult.error, /Source file missing/);
  }
  assert.equal(files[0].parseResult.psdParserVersion, 8);
  assert.equal(files[0].parseResult.compositeImagePath, 'parsed/31/old/composite.png');
  assert.equal(files[0].parseResult.lastParseAttempt.psdParserVersion, 9);
  assert.equal(files[1].parseResult.pages[0].imagePath, 'parsed/32/old/page.png');
  assert.equal(files[1].parseResult.lastParseAttempt.pdfParserVersion, 77);
  assert.equal(files[2].parseResult.artifactDirectory, 'parsed/33/old');
  assert.equal(files[2].parseResult.lastParseAttempt.aiParserVersion, 52);
  assert.equal(files.slice(0, 3).every((file) => file.parseResult.hasRetainedResult === true), true);
  assert.equal(files[3].parseResult.hasRetainedResult, undefined);
  assert.equal(files[3].parseResult.psdParserVersion, 9);
});

test('startup missing-source scan rechecks publication and source restoration under its lock', async () => {
  const makeFile = (id) => ({ id, fileType: 'psd', parseStatus: 'pending', isDeleted: false,
    filePath: `/candidate/uploads/${id}.psd`, parseResult: { compositeImagePath: `old-${id}.png` },
    async update() { throw new Error('must not overwrite concurrent restoration'); } });
  const files = [makeFile(41), makeFile(42)];
  const restored = new Set();
  await boot({ files, existsSync: (filename) => !files.some((file) => file.filePath === filename)
    || restored.has(filename), beforeLock: (id) => {
      if (id === 41) { files[0].parseStatus = 'completed'; files[0].parseResult = { compositeImagePath: 'new.png' }; }
      else restored.add(files[1].filePath);
    } });
  assert.equal(files[0].parseResult.compositeImagePath, 'new.png');
  assert.equal(files[1].parseStatus, 'pending');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} closes HTTP, parser queue and database exactly once`, async () => {
    const { state, signals } = await boot({ env: { DISABLE_BOOTSTRAP_PARSE: '1' } });
    signals[signal]();
    signals[signal]();
    await flush();
    assert.equal(state.httpClosed, 1);
    assert.equal(state.queueClosed, 1);
    assert.equal(state.dbClosed, 1);
    assert.deepEqual(state.exits, [0]);
    assert.equal(state.timers[0].ms, 5000);
    assert.equal(state.timers[0].cleared, true);
  });
}

test('parser queue cleanup failure still closes the database and reports failure', async () => {
  const { state, signals } = await boot({ queueShutdown: async () => { throw new Error('worker cleanup failed'); } });
  signals.SIGTERM();
  await flush();
  assert.equal(state.httpClosed, 1);
  assert.equal(state.dbClosed, 1);
  assert.deepEqual(state.exits, [1]);
});

test('stuck cleanup reaches the five second deadline and force closes HTTP', async () => {
  const { state, signals } = await boot({ queueShutdown: () => new Promise(() => {}), closeHttp: false });
  signals.SIGTERM();
  await flush();
  assert.equal(state.exits.length, 0);
  assert.equal(state.timers[0].ms, 5000);
  state.timers[0].callback();
  assert.equal(state.forcedHttpClose, 1);
  assert.deepEqual(state.exits, [1]);
});
