const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/dev.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

async function start(env = {}, configuredEnv = {}) {
  const launched = [];
  vm.runInNewContext(code, { exports: {}, __dirname: path.join(__dirname, '../src'), process: { env }, require: (name) => {
    if (name === 'dotenv') return { config(options) {
      assert.equal(options.path, path.resolve(__dirname, '../../.env'));
      for (const [key, value] of Object.entries(configuredEnv)) env[key] ??= value;
    } };
    if (name === 'path') return path;
    launched.push({ name, env: { ...env } });
    return {};
  } });
  await new Promise(setImmediate);
  return launched;
}

test('local dev entry enables no-login and loopback before loading the application', async () => {
  assert.deepEqual(await start(), [{ name: './app', env: {
    NODE_ENV: 'development', LOCAL_DEV_NO_LOGIN: '1', HOST: '127.0.0.1',
  } }]);
});

test('root environment file opt-out is loaded before development defaults', async () => {
  const env = { NODE_ENV: 'production', LOCAL_DEV_NO_LOGIN: '0', HOST: '::1' };
  assert.deepEqual(await start({}, env), [{ name: './app', env }]);
  assert.equal((await start({}, { LOCAL_DEV_NO_LOGIN: '0' }))[0].env.LOCAL_DEV_NO_LOGIN, '0');
});

test('dev entry does not enable no-login when the runtime is production', async () => {
  assert.deepEqual(await start({ NODE_ENV: 'production' }), [{ name: './app', env: {
    NODE_ENV: 'production', HOST: '127.0.0.1',
  } }]);
});

test('local dev entry respects explicit no-login opt-out and bind configuration', async () => {
  const env = { NODE_ENV: 'development', LOCAL_DEV_NO_LOGIN: '0', HOST: '::1' };
  assert.deepEqual(await start(env), [{ name: './app', env }]);
});
