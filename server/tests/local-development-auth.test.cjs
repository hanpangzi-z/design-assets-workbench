const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const ts = require('typescript');

const testSecret = 'isolated-local-development-auth-test-secret';
const development = { NODE_ENV: 'development', LOCAL_DEV_NO_LOGIN: '1' };

function loadMiddleware(name, stubs = {}) {
  const filename = path.resolve(__dirname, `../src/middleware/${name}.ts`);
  const executable = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = name => Object.hasOwn(stubs, name) ? stubs[name] : originalRequire(name);
  loaded._compile(executable, filename);
  return loaded.exports;
}

const localGuard = loadMiddleware('localDevelopmentAuth');

async function withEnvironment(values, action) {
  const previous = { NODE_ENV: process.env.NODE_ENV, LOCAL_DEV_NO_LOGIN: process.env.LOCAL_DEV_NO_LOGIN };
  for (const key of Object.keys(previous)) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try { return await action(); }
  finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function account(id, username, roleName = 'admin', permissions = { 'file.view': true }, isActive = true) {
  const role = { name: roleName, permissions };
  return { id, username, isActive, get: key => key === 'role' ? role : undefined,
    toSafeJSON: () => ({ id, username, isActive, role }) };
}

function harness(users = [account(4, 'local-admin', 'super_admin')]) {
  const state = { users, queries: [], tokenLookups: [], verifies: [], writes: 0, databaseError: null };
  class Role {}
  class AppError extends Error {
    constructor(message, statusCode) { super(message); this.statusCode = statusCode; }
  }
  const forbiddenWrite = () => { state.writes++; throw new Error('authentication must not write accounts'); };
  const User = {
    async findOne(options) {
      state.queries.push(options);
      if (state.databaseError) throw state.databaseError;
      assert.equal(options.where.isActive, true);
      assert.equal(options.include[0].model, Role);
      assert.equal(options.include[0].as, 'role');
      assert.equal(options.include[0].required, true);
      assert.deepEqual(options.include[0].where.name, ['super_admin', 'admin']);
      let candidates = state.users.filter(user => user.isActive
        && (!options.where.username || user.username === options.where.username)
        && options.include[0].where.name.includes(user.get('role')?.name));
      if (options.order) {
        assert.deepEqual(options.order, [['id', 'ASC']]);
        candidates = candidates.slice().sort((a, b) => a.id - b.id);
      }
      return candidates[0] || null;
    },
    async findByPk(id, options) {
      state.tokenLookups.push({ id, options });
      return state.users.find(user => user.id === id) || null;
    },
    create: forbiddenWrite, update: forbiddenWrite, destroy: forbiddenWrite,
  };
  const middleware = loadMiddleware('auth', {
    '../models': { User, Role },
    './errorHandler': { AppError },
    './localDevelopmentAuth': localGuard,
    '../utils/env': { requireEnv: key => { assert.equal(key, 'JWT_SECRET'); return testSecret; } },
    jsonwebtoken: { verify: (...args) => { state.verifies.push(args[0]); return jwt.verify(...args); } },
  });
  const rbac = loadMiddleware('rbac', {
    './errorHandler': { AppError },
    '../utils/logger': { logger: { warn() {} } },
  });
  return { state, middleware, rbac };
}

function request(overrides = {}) {
  return { path: '/me', query: {}, ...overrides,
    headers: { host: 'localhost:3088', ...overrides.headers },
    socket: { remoteAddress: '127.0.0.1', ...overrides.socket } };
}

async function authenticate(h, overrides) {
  const req = request(overrides);
  let nextCalls = 0;
  const error = await new Promise(resolve => {
    h.middleware.authMiddleware(req, {}, err => { nextCalls++; resolve(err); });
  });
  assert.equal(nextCalls, 1);
  assert.equal(h.state.writes, 0);
  return { req, error };
}

test('local development auth accepts only explicit development and opt-in configuration', async () => {
  for (const values of [
    { NODE_ENV: 'production', LOCAL_DEV_NO_LOGIN: '1' },
    { NODE_ENV: 'test', LOCAL_DEV_NO_LOGIN: '1' },
    { NODE_ENV: undefined, LOCAL_DEV_NO_LOGIN: '1' },
    { NODE_ENV: 'development', LOCAL_DEV_NO_LOGIN: undefined },
    { NODE_ENV: 'development', LOCAL_DEV_NO_LOGIN: 'true' },
    { NODE_ENV: 'development', LOCAL_DEV_NO_LOGIN: '0' },
  ]) {
    await withEnvironment(values, async () => {
      const h = harness();
      const { error, req } = await authenticate(h);
      assert.equal(error.statusCode, 401);
      assert.equal(req.user, undefined);
      assert.deepEqual(h.state.queries, []);
    });
  }
});

test('local sockets and strict IPv4, IPv6 or localhost authorities support browser and origin-free requests', async () => {
  await withEnvironment(development, async () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      for (const host of ['localhost', 'LOCALHOST:3088', '127.0.0.1:3088', '[::1]:3088']) {
        for (const origin of [undefined, 'http://localhost:3089', 'http://127.0.0.1:3089', 'https://[::1]:3089']) {
          const h = harness();
          const { error, req } = await authenticate(h, { headers: { host, origin }, socket: { remoteAddress: address } });
          assert.equal(error, undefined, `${address} / ${host} / ${origin}`);
          assert.equal(req.user.id, 4);
          assert.deepEqual(h.state.verifies, []);
        }
      }
    }
  });
});

test('forwarded headers and req.ip cannot turn a non-loopback connection into local auth', async () => {
  await withEnvironment(development, async () => {
    for (const address of ['192.168.1.5', '10.0.0.1', '::ffff:192.168.1.5', undefined]) {
      const h = harness();
      const { error } = await authenticate(h, { ip: '127.0.0.1', socket: { remoteAddress: address },
        headers: { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'localhost', 'forwarded': 'for=127.0.0.1;host=localhost' } });
      assert.equal(error.statusCode, 401);
      assert.deepEqual(h.state.queries, []);
    }
  });
});

test('host rejects external names, credentials, URL syntax, malformed ports and canonicalization tricks', async () => {
  await withEnvironment(development, async () => {
    for (const host of [undefined, '', 'localhost.evil', 'evil@localhost', 'user:pass@localhost',
      'localhost/path', 'localhost?x=1', 'localhost#x', 'localhost,evil', 'localhost:bad', 'localhost:0',
      'localhost:65536', ' localhost', 'localhost ', 'localhost\n', ['localhost'], '127.1', '0x7f000001',
      'localhost.', '127.0.0.2', '[::1]evil', '[::1]:65536', '[::ffff:127.0.0.1]']) {
      const h = harness();
      const { error } = await authenticate(h, { headers: { host, 'x-forwarded-host': 'localhost' } });
      assert.equal(error?.statusCode, 401, JSON.stringify(host));
      assert.deepEqual(h.state.queries, []);
    }
  });
});

test('origin rejects null, external origins, userinfo, other protocols, paths and forged loopback formats', async () => {
  await withEnvironment(development, async () => {
    for (const origin of ['null', '', 'http://localhost.evil', 'http://evil@localhost', 'http://user:pass@localhost',
      'https://example.com', 'ftp://localhost', 'file://localhost', 'http://localhost/path',
      'http://localhost?x=1', 'http://localhost#x', 'http://localhost,http://evil', 'http://localhost:65536',
      'http://127.1', 'http://0x7f000001', 'http://localhost.', ' http://localhost', 'http://localhost\n',
      ['http://localhost'], 'http://[::1]evil']) {
      const h = harness();
      const { error } = await authenticate(h, { headers: { origin } });
      assert.equal(error?.statusCode, 401, JSON.stringify(origin));
      assert.deepEqual(h.state.queries, []);
    }
  });
});

test('an existing active username admin is preferred without changing its actual role or permissions', async () => {
  await withEnvironment(development, async () => {
    const preferred = account(10, 'admin', 'admin', { 'file.view': true, 'user.manage': false });
    const h = harness([account(4, 'root', 'super_admin'), preferred]);
    const { req, error } = await authenticate(h);
    assert.equal(error, undefined);
    assert.equal(req.user, preferred);
    assert.equal(req.userPermissions, preferred.get('role').permissions);
    assert.equal(h.state.queries.length, 1);
    assert.equal(h.state.queries[0].where.username, 'admin');
    let denial;
    h.rbac.rbacMiddleware('user.manage')(req, {}, error => { denial = error; });
    assert.equal(denial.statusCode, 403);
  });
});

test('disabled username admin is skipped and the lowest id active administrator is selected', async () => {
  await withEnvironment(development, async () => {
    const h = harness([account(1, 'admin', 'admin', {}, false), account(5, 'other-root', 'super_admin'),
      account(2, 'editor', 'editor'), account(4, 'local-root', 'super_admin'), account(8, 'local-admin', 'admin')]);
    const { req, error } = await authenticate(h);
    assert.equal(error, undefined);
    assert.equal(req.user.id, 4);
    assert.equal(h.state.users[0].isActive, false);
    assert.equal(h.state.queries.length, 2);
    assert.deepEqual(h.state.queries[1].order, [['id', 'ASC']]);
    let denial;
    h.rbac.rbacMiddleware('user.manage')(req, {}, error => { denial = error; });
    assert.equal(denial, undefined);
  });
});

test('the username admin alone does not grant admin privileges', async () => {
  await withEnvironment(development, async () => {
    const h = harness([account(1, 'admin', 'editor'), account(4, 'local-root', 'super_admin')]);
    const { req, error } = await authenticate(h);
    assert.equal(error, undefined);
    assert.equal(req.user.id, 4);
  });
});

test('role permissions and deactivation are read again on every local request', async () => {
  await withEnvironment(development, async () => {
    const h = harness([account(4, 'admin', 'admin', { 'file.view': true })]);
    const first = await authenticate(h);
    assert.equal(first.req.userPermissions['file.view'], true);
    h.state.users = [account(4, 'admin', 'admin', { 'file.view': false })];
    const second = await authenticate(h);
    assert.equal(second.req.userPermissions['file.view'], false);
    h.state.users = [account(4, 'admin', 'admin', {}, false)];
    const third = await authenticate(h);
    assert.equal(third.error.statusCode, 401);
    assert.equal(third.req.user, undefined);
    assert.equal(h.state.queries.length, 4);
  });
});

test('no available administrator fails with 401 and never creates an account', async () => {
  await withEnvironment(development, async () => {
    const h = harness([account(1, 'admin', 'super_admin', {}, false), account(2, 'viewer', 'viewer')]);
    const { error, req } = await authenticate(h);
    assert.equal(error.statusCode, 401);
    assert.match(error.message, /没有可用的启用管理员/);
    assert.equal(req.user, undefined);
    assert.equal(h.state.writes, 0);
  });
});

test('database lookup failure is passed to the error handler without inventing an identity', async () => {
  await withEnvironment(development, async () => {
    const h = harness();
    h.state.databaseError = new Error('isolated database offline');
    const { error, req } = await authenticate(h);
    assert.equal(error, h.state.databaseError);
    assert.equal(req.user, undefined);
    assert.equal(req.userPermissions, undefined);
    assert.equal(h.state.queries.length, 1);
  });
});

test('a valid JWT preserves its user and impersonator even when local no-login is enabled', async () => {
  await withEnvironment(development, async () => {
    const tokenUser = account(7, 'editor', 'editor', { 'file.edit': true });
    const h = harness([account(4, 'local-root', 'super_admin'), tokenUser]);
    const token = jwt.sign({ userId: 7, impersonatorId: 9 }, testSecret);
    const { req, error } = await authenticate(h, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(error, undefined);
    assert.equal(req.user, tokenUser);
    assert.equal(req.impersonatorId, 9);
    assert.deepEqual(req.userPermissions, { 'file.edit': true });
    assert.deepEqual(h.state.queries, []);
    assert.equal(h.state.tokenLookups[0].id, 7);
  });
});

test('invalid and expired tokens fail instead of falling back to a local administrator', async () => {
  await withEnvironment(development, async () => {
    for (const token of ['invalid', jwt.sign({ userId: 4, exp: 1 }, testSecret)]) {
      const h = harness();
      const { req, error } = await authenticate(h, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(error.statusCode, 401);
      assert.equal(req.user, undefined);
      assert.deepEqual(h.state.queries, []);
    }
  });
});

test('malformed authorization and download credentials never switch into the anonymous local identity', async () => {
  await withEnvironment(development, async () => {
    for (const authorization of ['', 'Bearer ', 'Basic abc', 'bearer validjwt', 'Bearer']) {
      const h = harness();
      const { req, error } = await authenticate(h, { headers: { authorization } });
      assert.equal(error.statusCode, 401, JSON.stringify(authorization));
      assert.equal(req.user, undefined);
      assert.deepEqual(h.state.queries, []);
    }
    for (const downloadToken of ['', ['token'], { token: 'invalid' }, null]) {
      const h = harness();
      const { req, error } = await authenticate(h, { path: '/123/download', query: { downloadToken } });
      assert.equal(error.statusCode, 401, JSON.stringify(downloadToken));
      assert.equal(req.user, undefined);
      assert.deepEqual(h.state.queries, []);
    }
  });
});

test('disabled JWT users retain their existing rejection and download-token requests keep JWT auth', async () => {
  await withEnvironment(development, async () => {
    const h = harness([account(7, 'disabled', 'editor', {}, false), account(4, 'local-root', 'super_admin')]);
    const disabledToken = jwt.sign({ userId: 7 }, testSecret);
    const denied = await authenticate(h, { headers: { authorization: `Bearer ${disabledToken}` } });
    assert.equal(denied.error.statusCode, 401);
    assert.deepEqual(h.state.queries, []);
    const downloadToken = jwt.sign({ userId: 4 }, testSecret);
    const allowed = await authenticate(h, { path: '/123/download', query: { downloadToken } });
    assert.equal(allowed.error, undefined);
    assert.equal(allowed.req.user.id, 4);
    assert.deepEqual(h.state.queries, []);
    assert.deepEqual(h.state.verifies, [disabledToken, downloadToken]);
  });
});

test('production still accepts only a valid JWT regardless of the local development flag', async () => {
  await withEnvironment({ NODE_ENV: 'production', LOCAL_DEV_NO_LOGIN: '1' }, async () => {
    const h = harness();
    const token = jwt.sign({ userId: 4 }, testSecret);
    const { req, error } = await authenticate(h, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(error, undefined);
    assert.equal(req.user.id, 4);
    assert.deepEqual(h.state.queries, []);
  });
});
