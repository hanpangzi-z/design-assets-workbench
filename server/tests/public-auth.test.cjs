const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const crypto = require('node:crypto');

function loadController(env) {
  class AppError extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode; } }
  const source = fs.readFileSync(path.join(__dirname, '../src/controllers/authController.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const loaded = { exports: {} };
  vm.runInNewContext(code + '\nmodule.exports.verifyForTest = verifyDesignOpsSsoToken; module.exports.fetchForTest = fetchBenlaiLoginUserInfo;', {
    module: loaded, exports: loaded.exports, process: { env }, Buffer, Date,
    require(name) {
      if (name === 'crypto') return crypto;
      if (name === '../middleware/errorHandler') return { AppError };
      if (name === '../utils/env') return { requireEnv: () => 'test-only' };
      if (name === '../models') return {};
      if (name === '../utils/logger') return { logger: {} };
      if (name === '../utils/superAdmin') return {};
      if (name === 'jsonwebtoken' || name === 'bcryptjs') return {};
      throw new Error(`Unexpected module: ${name}`);
    },
  });
  return loaded.exports;
}

test('public defaults do not advertise an enterprise endpoint', () => {
  let body;
  loadController({}).authHubConfig({}, { json(value) { body = value; } });
  assert.equal(body.data.configured, false);
  assert.equal(body.data.loginUrl, '');
});

test('handoff tokens are rejected when the deployer has not set a secret', () => {
  assert.throws(() => loadController({}).verifyForTest('a.b.c'), error => error.statusCode === 503);
});

test('enterprise login fails before any network call when unconfigured', async () => {
  await assert.rejects(loadController({}).fetchForTest('fixture-cookie'), error => error.statusCode === 503);
});

test('explicit handoff configuration validates a signed token and rejects a tampered token', () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const controller = loadController({ DESIGN_LIBRARY_SSO_SECRET: secret });
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: 'designops-platform', aud: 'benlai-design-library', sub: 'fixture-user', exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
  const input = `${header}.${payload}`;
  const signature = crypto.createHmac('sha256', secret).update(input).digest('base64url');
  assert.equal(controller.verifyForTest(`${input}.${signature}`).sub, 'fixture-user');
  assert.throws(() => controller.verifyForTest(`${input}.invalid`), error => error.statusCode === 401);
});

async function runSetup(env, existing = false) {
  const state = { created: [], closed: 0, errors: [], exitCode: 0 };
  const source = fs.readFileSync(path.join(__dirname, '../src/scripts/createAdmin.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const processStub = { env, exitCode: 0 };
  vm.runInNewContext(code, { exports: {}, __dirname, process: processStub, Buffer,
    console: { log() {}, error(message) { state.errors.push(message); } },
    require(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === 'path') return path;
      if (name === 'bcryptjs') return { async hash(value, rounds) { assert.equal(rounds, 12); return 'fixture-hash'; } };
      if (name === '../models') return {
        sequelize: { async authenticate() {}, async close() { state.closed++; } },
        Role: { async findOne() { return { id: 1 }; } },
        User: { async findOne() { return existing ? { id: 1 } : null; }, async create(value) { state.created.push(value); } },
      };
      throw new Error(`Unexpected module: ${name}`);
    },
  });
  await new Promise(setImmediate);
  state.exitCode = processStub.exitCode;
  return state;
}

test('administrator setup has no default credentials', async () => {
  const result = await runSetup({});
  assert.equal(result.exitCode, 1);
  assert.equal(result.created.length, 0);
  assert.equal(result.closed, 1);
});

test('administrator setup does not overwrite an existing username', async () => {
  const result = await runSetup({ INITIAL_ADMIN_USERNAME: 'fixture-admin', INITIAL_ADMIN_PASSWORD: crypto.randomBytes(16).toString('hex') }, true);
  assert.equal(result.exitCode, 1);
  assert.equal(result.created.length, 0);
});

test('administrator setup hashes explicit credentials and closes the connection', async () => {
  const result = await runSetup({ INITIAL_ADMIN_USERNAME: 'fixture-admin', INITIAL_ADMIN_PASSWORD: crypto.randomBytes(16).toString('hex') });
  assert.equal(result.exitCode, 0);
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].passwordHash, 'fixture-hash');
  assert.equal(result.created[0].roleId, 1);
  assert.equal(result.closed, 1);
});

test('public database seed never queries or removes historical production users', async () => {
  let userQueries = 0;
  const source = fs.readFileSync(path.join(__dirname, '../src/scripts/dbSeed.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  vm.runInNewContext(code, { exports: {}, __dirname, process: { exit() {} },
    require(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === 'path') return path;
      if (name === 'sequelize') return { Op: {} };
      if (name === '../constants/roles') return { BUILT_IN_ROLES: [] };
      if (name === '../constants/users') return { LEGACY_SEED_USERNAMES: [] };
      if (name === '../utils/logger') return { logger: { info() {}, fatal(error) { throw error; } } };
      if (name === '../utils/uniqueIndexes') return { async cleanupDuplicateUniqueIndexes() {} };
      if (name === '../models') return {
        sequelize: { async authenticate() {}, async sync() {} },
        User: { async findAll() { userQueries++; throw new Error('Do not query historical users'); } },
        Role: {}, Category: {}, DesignFile: {}, FileVersion: {},
        Library: { async findOne() { return {}; } },
      };
      throw new Error(`Unexpected module: ${name}`);
    },
  });
  await new Promise(setImmediate);
  assert.equal(userQueries, 0);
});
