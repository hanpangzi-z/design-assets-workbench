const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const tick = () => new Promise(setImmediate);
const admin = { id: 4, username: 'existing-admin', role: { id: 1, name: 'super_admin', permissions: { upload: true, edit: true, manage_users: true } } };
function evaluate(relative, dependencies = {}, globals = {}) {
  const filename = path.resolve(__dirname, relative);
  const source = fs.readFileSync(filename, 'utf8').replaceAll('import.meta.env', '__testEnv');
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const context = { exports: {}, console, __testEnv: { DEV: true },
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name), ...globals };
  vm.runInNewContext(code, context, { filename });
  return context.exports;
}
function storage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function environment({ dev = true, hostname = 'localhost', disabled = false } = {}) {
  const redirects = [];
  const globals = { __testEnv: { DEV: dev, ...(disabled ? { VITE_LOCAL_DEV_NO_LOGIN: '0' } : {}) },
    window: { location: { hostname, pathname: '/', replace: value => redirects.push(value) }, setTimeout, clearTimeout,
      history: { replaceState() {} } } };
  const helper = evaluate('../src/utils/localDevAuth.ts', {}, globals);
  return { globals, helper, redirects };
}
function unauthorized(message = '未找到启用的本地管理员') {
  const error = new Error(message);
  error.response = { status: 401, data: { message } };
  return error;
}
function storeHarness(responses, options = {}) {
  const env = environment(options);
  if (options.clock) Object.assign(env.globals.window, options.clock);
  const localStorage = storage(options.seed);
  const calls = [];
  const store = evaluate('../src/store/authStore.ts', {
    '@/utils/localDevAuth': env.helper,
    '@/api/auth': { impersonateApi: async () => options.impersonationResult, async getMeApi() {
      calls.push({ token: localStorage.getItem('accessToken') });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response() : response;
    } },
  }, { ...env.globals, localStorage }).default;
  return { ...env, store, calls, localStorage };
}

test('local bootstrap is limited to development loopback and honors the explicit opt-out', () => {
  for (const hostname of ['localhost', '127.0.0.1', '[::1]', '::1']) {
    assert.equal(environment({ hostname }).helper.isLocalDevNoLogin(), true);
    assert.equal(environment({ hostname, dev: false }).helper.isLocalDevNoLogin(), false);
    assert.equal(environment({ hostname, disabled: true }).helper.isLocalDevNoLogin(), false);
  }
  for (const hostname of ['localhost.example.com', '192.168.1.20', 'example.com']) {
    assert.equal(environment({ hostname }).helper.isLocalDevNoLogin(), false);
  }
});

test('tokenless local bootstrap waits for one backend response and keeps the actual user and permissions', async () => {
  let resolve;
  const h = storeHarness([() => new Promise(done => { resolve = done; })]);
  const first = h.store.getState().fetchMe(), duplicate = h.store.getState().fetchMe();
  assert.equal(h.calls.length, 1);
  assert.equal(h.store.getState().isLoading, true);
  assert.equal(h.store.getState().isAuthenticated, false);
  assert.equal(h.store.getState().user, null);
  resolve({ user: admin, impersonator: null }); await Promise.all([first, duplicate]);
  assert.equal(h.store.getState().user, admin);
  assert.equal(h.store.getState().permissions, admin.role.permissions);
  assert.equal(h.store.getState().isAuthenticated, true);
  assert.equal(h.localStorage.getItem('accessToken'), null);
  assert.equal(h.localStorage.getItem('refreshToken'), null);
});

test('local backend failure leaves the user unauthenticated with an immediate working retry', async () => {
  const failure = unauthorized();
  const h = storeHarness([failure, { user: admin, impersonator: null }]);
  await assert.rejects(h.store.getState().fetchMe(), error => error === failure);
  assert.equal(h.store.getState().isAuthenticated, false);
  assert.equal(h.store.getState().user, null);
  assert.match(h.store.getState().localAuthError, /本地用户确认失败.*本地管理员/);
  await h.store.getState().fetchMe({ force: true });
  assert.equal(h.calls.length, 2);
  assert.equal(h.store.getState().localAuthError, null);
  assert.equal(h.store.getState().user, admin);
});

test('local cached user is never trusted before confirmation and an expired JWT retries once without a token', async () => {
  const cached = { ...admin, id: 99 };
  const h = storeHarness([unauthorized('invalid_token'), { user: admin, impersonator: null }], {
    seed: { accessToken: 'expired-jwt', refreshToken: 'expired-refresh',
      'benlai.auth.snapshot': JSON.stringify({ user: cached, impersonator: null }) },
  });
  assert.equal(h.store.getState().user, null);
  assert.equal(h.store.getState().isAuthenticated, false);
  await h.store.getState().fetchMe();
  assert.deepEqual(h.calls, [{ token: 'expired-jwt' }, { token: null }]);
  assert.equal(h.localStorage.getItem('refreshToken'), null);
  assert.equal(h.store.getState().user.id, 4);
});

test('a valid local JWT retains its actual identity and impersonation; failed tokenless retry cannot authenticate', async () => {
  const actual = { ...admin, id: 88, role: { permissions: { upload: false } } };
  const impersonator = { id: 4, displayName: '管理员' };
  const h = storeHarness([{ user: actual, impersonator }], { seed: { accessToken: 'valid-jwt' } });
  await h.store.getState().fetchMe();
  assert.equal(h.store.getState().user, actual);
  assert.equal(h.store.getState().impersonator, impersonator);
  assert.equal(h.localStorage.getItem('accessToken'), 'valid-jwt');
  const broken = storeHarness([unauthorized('expired'), unauthorized()], { seed: { accessToken: 'expired-jwt' } });
  await assert.rejects(broken.store.getState().fetchMe());
  assert.equal(broken.calls.length, 2);
  assert.equal(broken.store.getState().isAuthenticated, false);
  assert.equal(broken.store.getState().user, null);
});

test('production and non-loopback cannot bootstrap without JWT and retain existing token cache behavior', async () => {
  for (const options of [{ dev: false }, { hostname: '192.168.1.20' }, { disabled: true }]) {
    const h = storeHarness([], options);
    await h.store.getState().fetchMe();
    assert.equal(h.calls.length, 0);
    assert.equal(h.store.getState().isAuthenticated, false);
    const cached = storeHarness([], { ...options, seed: { accessToken: 'jwt',
      'benlai.auth.snapshot': JSON.stringify({ user: admin, impersonator: null }) } });
    assert.equal(cached.store.getState().user.id, admin.id);
    assert.equal(cached.store.getState().hydratedFromCache, true);
  }
});

test('a timed-out local request cannot clear a newer JWT or start a late tokenless retry', async () => {
  let rejectOld;
  const timers = new Map();
  let nextId = 0;
  const h = storeHarness([() => new Promise((resolve, reject) => { rejectOld = reject; }),
    { user: admin, impersonator: null }], {
    seed: { accessToken: 'expired-jwt' },
    clock: { setTimeout(callback) { const id = ++nextId; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); } },
  });
  const first = h.store.getState().fetchMe();
  const rejected = assert.rejects(first, /auth_me_timeout/);
  timers.get(1)(); await rejected;
  assert.equal(h.store.getState().isAuthenticated, false);
  assert.match(h.store.getState().localAuthError, /超时/);
  await h.store.getState().fetchMe({ force: true });
  h.localStorage.setItem('accessToken', 'new-valid-jwt');
  rejectOld(unauthorized('late invalid_token')); await tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.localStorage.getItem('accessToken'), 'new-valid-jwt');
  assert.equal(h.store.getState().user, admin);
});

function routerHarness(h) {
  let cursor = 0;
  const slots = [], pendingEffects = [];
  const same = (left, right) => left && right && left.length === right.length && left.every((value, index) => value === right[index]);
  const hooks = {
    useState(initial) {
      const index = cursor++;
      slots[index] ||= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (same(slots[index]?.deps, deps)) return;
      const previous = slots[index]; slots[index] = { deps };
      pendingEffects.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect(); });
    },
    lazy: () => function LazyPage() {}, Suspense: 'suspense',
  };
  const LoginPage = function LoginPage() { throw new Error('Local route mounted the SSO login page'); };
  const modules = {
    react: hooks,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' },
    'react-router-dom': { createBrowserRouter: routes => routes, Navigate: 'navigate', redirect: value => value },
    '@/store/authStore': { __esModule: true, default: selector => selector(h.store.getState()) },
    '@/utils/localDevAuth': h.helper,
    '@/components/Layout/AppLayout': { __esModule: true, default: 'app-layout' }, '@/pages/Login': { __esModule: true, default: LoginPage },
    '@/pages/Editor': { __esModule: true, default: 'editor' }, '@/pages/Admin': { __esModule: true, default: 'admin' },
  };
  const routes = evaluate('../src/router.tsx', modules, { ...h.globals, localStorage: h.localStorage }).default;
  const root = routes.find(route => route.path === '/');
  const render = element => {
    cursor = 0;
    const result = element.type(element.props);
    pendingEffects.splice(0).forEach(effect => effect());
    return result;
  };
  return { routes, LoginPage, root, render };
}
function text(tree) {
  if (typeof tree === 'string') return tree;
  if (!tree || typeof tree !== 'object') return '';
  return [].concat(Array.isArray(tree) ? tree : tree.props?.children || []).flat(Infinity).map(text).join('');
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...[].concat(Array.isArray(tree) ? tree : tree.props?.children || []).flat(Infinity).flatMap(nodes)];
}

test('local AuthGuard shows loading until confirmed, then the home screen; failure has a functioning retry', async () => {
  const h = storeHarness([unauthorized(), { user: admin, impersonator: null }]);
  const r = routerHarness(h);
  let tree = r.render(r.root.element);
  assert.equal(tree.type.name, 'LoadingScreen');
  await tick(); tree = r.render(r.root.element);
  assert.match(text(tree), /本地用户确认失败/);
  const retry = nodes(tree).find(node => node.type === 'button' && text(node) === '重试连接');
  assert.ok(retry); retry.props.onClick();
  tree = r.render(r.root.element);
  assert.equal(tree.type.name, 'LoadingScreen');
  await tick(); tree = r.render(r.root.element);
  assert.equal(tree.props.children.type, 'app-layout');
  assert.equal(h.calls.length, 2);
});

test('local login and callback use confirmed home redirect without mounting SSO; production still mounts LoginPage', async () => {
  const h = storeHarness([{ user: admin, impersonator: null }]);
  const r = routerHarness(h);
  for (const pathname of ['/login', '/login/callback']) {
    const element = r.routes.find(route => route.path === pathname).element;
    assert.notEqual(element.type, r.LoginPage);
    const children = element.props.children;
    assert.equal(children.type, 'navigate');
    assert.equal(children.props.to, '/');
  }
  for (const options of [{ dev: false }, { hostname: 'example.com' }, { disabled: true }]) {
    const production = routerHarness(storeHarness([], options));
    assert.equal(production.routes.find(route => route.path === '/login').element.type, production.LoginPage);
    assert.equal(production.render(production.root.element).props.to, '/login');
  }
});

function interceptorHarness(options = {}) {
  const env = options.auth || environment(options), localStorage = options.auth?.localStorage || storage(options.seed);
  const handlers = {}, refreshCalls = [], retries = [];
  const api = Object.assign(async config => {
    const request = await handlers.request(config);
    retries.push({ ...request, headers: { ...request.headers } });
    return options.retry ? options.retry(request, handlers) : { data: 'retried' };
  }, { interceptors: {
    request: { use: value => { handlers.request = value; } },
    response: { use: (success, error) => { handlers.failure = error; } },
  } });
  evaluate('../src/api/index.ts', {
    axios: { create: () => api, post: async (...args) => { refreshCalls.push(args); throw unauthorized(); } },
    '@/utils/localDevAuth': env.helper,
    '@/store/authStore': { __esModule: true, default: options.auth?.store },
  }, { ...env.globals, localStorage });
  return { ...env, handlers, refreshCalls, retries, localStorage };
}

test('tokenless local 401 reports its error without refresh or SSO redirect', async () => {
  for (const seed of [{}, { accessToken: 'expired', refreshToken: 'old-refresh' }]) {
    const h = interceptorHarness({ seed });
    const error = unauthorized(); error.config = { url: '/files', headers: {} };
    await assert.rejects(h.handlers.failure(error), value => value === error);
    assert.equal(h.refreshCalls.length, 0);
    assert.deepEqual(h.redirects, []);
  }
  for (const options of [{ dev: false }, { hostname: 'example.com' }, { disabled: true }]) {
    const h = interceptorHarness(options);
    const error = unauthorized(); error.config = { url: '/files', headers: {} };
    await assert.rejects(h.handlers.failure(error));
    assert.deepEqual(h.redirects, ['/login']);
  }
});

async function businessError(h, method = 'get', data) {
  const config = await h.handlers.request({ url: '/files/1', method, headers: {}, data });
  const error = unauthorized('expired_token'); error.config = config;
  return error;
}

test('an active local JWT expiry confirms identity and permissions before retrying the same request once', async () => {
  const recoveredUser = { ...admin, role: { permissions: { upload: false, edit: false } } };
  const auth = storeHarness([{ user: admin, impersonator: null }, { user: recoveredUser, impersonator: null }], {
    seed: { accessToken: 'expires-during-use' },
  });
  await auth.store.getState().fetchMe();
  const h = interceptorHarness({ auth, retry(request) {
    assert.equal(auth.store.getState().user, recoveredUser);
    assert.equal(auth.store.getState().permissions, recoveredUser.role.permissions);
    assert.equal(request.headers.Authorization, undefined);
    return { data: 'under-confirmed-user' };
  } });
  const body = { name: 'same-user-write' };
  const result = await h.handlers.failure(await businessError(h, 'put', body));
  assert.equal(result.data, 'under-confirmed-user');
  assert.equal(h.retries.length, 1);
  assert.equal(h.retries[0].data, body);
  assert.equal(h.retries[0]._retry, true);
  assert.equal(auth.calls.length, 2);
  assert.deepEqual(h.redirects, []);
});

test('concurrent local failures share identity recovery and queued writes cannot cross to a different user', async () => {
  let resolveRecovery;
  const oldUser = { ...admin, id: 88 };
  const auth = storeHarness([{ user: oldUser, impersonator: null },
    () => new Promise(resolve => { resolveRecovery = resolve; })], { seed: { accessToken: 'expired' } });
  await auth.store.getState().fetchMe();
  const h = interceptorHarness({ auth });
  const firstError = await businessError(h), secondError = await businessError(h), lateError = await businessError(h);
  const first = h.handlers.failure(firstError); await tick();
  assert.equal(auth.store.getState().user, null);
  assert.equal(auth.store.getState().isAuthenticated, false);
  assert.equal(auth.store.getState().isLoading, true);
  const second = h.handlers.failure(secondError);
  const queuedWrite = h.handlers.request({ url: '/files/1/editor-state', method: 'put', headers: {}, data: { objects: [] } });
  const blockedWrite = assert.rejects(queuedWrite, /用户已切换/);
  assert.equal(h.retries.length, 0);
  resolveRecovery({ user: admin, impersonator: null });
  await Promise.all([first, second, blockedWrite]);
  assert.equal(auth.calls.length, 2);
  assert.equal(h.retries.length, 2);
  assert.equal(auth.store.getState().user.id, admin.id);
  // A late failure from the same old JWT uses the already confirmed identity.
  await h.handlers.failure(lateError);
  assert.equal(auth.calls.length, 2);
  assert.equal(h.retries.length, 3);
  assert.deepEqual(h.redirects, []);
});

test('a failed write from the old user is never automatically replayed as the local administrator', async () => {
  const auth = storeHarness([{ user: { ...admin, id: 88 }, impersonator: null }, { user: admin, impersonator: null }], {
    seed: { accessToken: 'expired' },
  });
  await auth.store.getState().fetchMe();
  const h = interceptorHarness({ auth });
  await assert.rejects(h.handlers.failure(await businessError(h, 'post', { asset: 'old-user-content' })), /用户已切换/);
  assert.equal(auth.store.getState().user, admin);
  assert.equal(h.retries.length, 0);
});

test('an anonymous retry still returning 401 stops after one retry without another identity recovery', async () => {
  const auth = storeHarness([{ user: admin, impersonator: null }, { user: admin, impersonator: null }], {
    seed: { accessToken: 'expired' },
  });
  await auth.store.getState().fetchMe();
  const h = interceptorHarness({ auth, retry(request, handlers) {
    const error = unauthorized('anonymous-disabled'); error.config = request;
    return handlers.failure(error);
  } });
  await assert.rejects(h.handlers.failure(await businessError(h)), /anonymous-disabled/);
  assert.equal(auth.calls.length, 2);
  assert.equal(h.retries.length, 1);
  const next = unauthorized(); next.config = { url: '/files', headers: {} };
  await assert.rejects(h.handlers.failure(next));
  assert.equal(auth.calls.length, 2);
});

test('failed local recovery clears loading and its lock; tokenless failures never loop and a later JWT can recover', async () => {
  const auth = storeHarness([{ user: admin, impersonator: null }, unauthorized(), { user: admin, impersonator: null }], {
    seed: { accessToken: 'expired' },
  });
  await auth.store.getState().fetchMe();
  const h = interceptorHarness({ auth });
  await assert.rejects(h.handlers.failure(await businessError(h)));
  assert.equal(auth.store.getState().isAuthenticated, false);
  assert.equal(auth.store.getState().isLoading, false);
  assert.match(auth.store.getState().localAuthError, /本地用户确认失败/);
  const noToken = unauthorized(); noToken.config = { url: '/files', headers: {} };
  await assert.rejects(h.handlers.failure(noToken));
  assert.equal(auth.calls.length, 2);
  auth.localStorage.setItem('accessToken', 'later-expired-jwt');
  await h.handlers.failure(await businessError(h));
  assert.equal(auth.calls.length, 3);
  assert.equal(auth.store.getState().user, admin);
  assert.equal(h.retries.length, 1);
});

test('reset invalidates an old me request and its result cannot replace the new confirmed identity', async () => {
  let resolveOld;
  const auth = storeHarness([() => new Promise(resolve => { resolveOld = resolve; }), { user: admin, impersonator: null }]);
  const oldRequest = auth.store.getState().fetchMe();
  auth.store.getState().reset();
  await auth.store.getState().fetchMe({ force: true });
  resolveOld({ user: { ...admin, id: 99 }, impersonator: null }); await oldRequest;
  assert.equal(auth.calls.length, 2);
  assert.equal(auth.store.getState().user, admin);
  assert.equal(auth.store.getState().isAuthenticated, true);
});

test('completed recovery cannot replay an old write after a newer valid impersonation session', async () => {
  const impersonated = { ...admin, id: 88 };
  const auth = storeHarness([{ user: admin, impersonator: null }, { user: admin, impersonator: null }], {
    seed: { accessToken: 'expired' }, impersonationResult: { user: impersonated, accessToken: 'new-valid-jwt',
      refreshToken: 'new-valid-refresh', impersonator: { id: admin.id, displayName: '管理员' } },
  });
  await auth.store.getState().fetchMe();
  const h = interceptorHarness({ auth });
  const first = await businessError(h), oldWrite = await businessError(h, 'put', { name: 'old-user-write' });
  await h.handlers.failure(first);
  await auth.store.getState().impersonate(88);
  await assert.rejects(h.handlers.failure(oldWrite), /用户已切换/);
  assert.equal(auth.store.getState().user, impersonated);
  assert.equal(auth.localStorage.getItem('accessToken'), 'new-valid-jwt');
  assert.equal(auth.calls.length, 2);
  assert.equal(h.retries.length, 1);
});

test('a cached recovery cannot replay a write after a newer anonymous session was confirmed', async () => {
  const newAdmin = { ...admin, id: 5 };
  const auth = storeHarness([{ user: admin, impersonator: null }, { user: admin, impersonator: null },
    { user: newAdmin, impersonator: null }], { seed: { accessToken: 'expired' } });
  await auth.store.getState().fetchMe();
  const h = interceptorHarness({ auth });
  const first = await businessError(h), oldWrite = await businessError(h, 'put', { name: 'old-user-write' });
  await h.handlers.failure(first);
  auth.store.getState().reset(); await auth.store.getState().fetchMe({ force: true });
  await assert.rejects(h.handlers.failure(oldWrite), /用户已切换/);
  assert.equal(auth.store.getState().user, newAdmin);
  assert.equal(auth.calls.length, 3);
  assert.equal(h.retries.length, 1);
});
