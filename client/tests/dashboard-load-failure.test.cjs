const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const tick = () => new Promise(setImmediate);
const file = { id: 301, name: '已保存模板', fileType: 'psd', width: 20, height: 20, parseStatus: 'completed' };
const list = (files = [file]) => ({ list: files, pagination: { total: files.length, page: 1, pageSize: 40 } });
function evaluate(relative, dependencies, globals = {}) {
  const filename = path.resolve(__dirname, relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const context = { exports: {}, require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name), console, ...globals };
  vm.runInNewContext(code, context, { filename });
  return context.exports;
}
function storeHarness(responses) {
  const calls = [];
  const store = evaluate('../src/store/fileStore.ts', {
    '@/api/files': { async getFiles(params) {
      calls.push(params);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(params) : response || list([]);
    } },
  }).default;
  return { store, calls };
}
function dashboardHarness(store, libraryResponses, { my = false } = {}) {
  let cursor = 0;
  const slots = [], pendingEffects = [], libraryCalls = [], local = new Map();
  const same = (left, right) => left && right && left.length === right.length && left.every((value, index) => value === right[index]);
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, update => { slots[index].value = typeof update === 'function' ? update(slots[index].value) : update; }];
    },
    useRef(initial) { const index = cursor++; slots[index] ||= { current: initial }; return slots[index]; },
    useMemo(factory, deps) { const index = cursor++; if (!same(slots[index]?.deps, deps)) slots[index] = { value: factory(), deps }; return slots[index].value; },
    useCallback(value, deps) { return hooks.useMemo(() => value, deps); },
    useEffect(effect, deps) {
      const index = cursor++;
      if (same(slots[index]?.deps, deps)) return;
      const previous = slots[index]; slots[index] = { deps };
      pendingEffects.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect(); });
    },
  };
  const categoryStore = { dimensionCategories: {}, fetchAll: async () => {} };
  const Empty = Object.assign(() => {}, { PRESENTED_IMAGE_SIMPLE: 'empty-image' });
  const component = evaluate('../src/pages/Dashboard/index.tsx', {
    react: hooks,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' },
    'react-router-dom': { useNavigate: () => () => {}, useLocation: () => ({ pathname: my ? '/my' : '/' }), useOutletContext: () => ({ openCreate() {} }) },
    antd: { Empty, Dropdown() {}, Modal() {}, Spin() {}, message: {} },
    'lucide-react': {},
    '@/store/authStore': { default: selector => selector({ user: { id: 7 }, permissions: {} }) },
    '@/store/categoryStore': { default: () => categoryStore },
    '@/store/fileStore': { default: () => store.getState() },
    '@/components/FileCard/Thumb': { default() {} },
    '@/components/ResourceWaterfall': { default: 'resource-waterfall-stub', ResourceCardInfo() {} },
    '@/hooks/useResourceLoadMore': { useResourceLoadMore() {} },
    '@/api/libraries': { async getLibraries(options) {
      libraryCalls.push(options);
      const response = libraryResponses.shift();
      if (response instanceof Error) throw response;
      return response || [{ id: 1, name: '本来资源库' }];
    } },
    '@/hooks/useAutoRefreshPendingParses': { useAutoRefreshPendingParses() {} },
    '@/utils/librarySort': { sortLibrariesByPin: value => value },
    '@/utils/assetPreview': { getAssetPreviewPath: () => undefined },
    '@/api/files': {},
  }, {
    localStorage: { getItem: key => local.get(key) || null, setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key) },
    window: { setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, removeEventListener() {} },
  }).default;
  const render = () => { cursor = 0; const tree = component(); pendingEffects.splice(0).forEach(effect => effect()); return tree; };
  return { render, libraryCalls, async settle() { for (let i = 0; i < 3; i++) { render(); await tick(); } return render(); } };
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  const children = tree.type === 'resource-waterfall-stub'
    ? tree.props.files.map(file => tree.props.renderItem(file, { width: 240, previewHeight: 180 }))
    : Array.isArray(tree) ? tree : tree.props?.children;
  return [tree, ...[].concat(children || []).flat(Infinity).flatMap(nodes)];
}
function text(tree) {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (!tree || typeof tree !== 'object') return '';
  return (tree.props?.description || '') + [].concat(Array.isArray(tree) ? tree : tree.props?.children || []).flat(Infinity).map(text).join('');
}
function button(tree, label) { const result = nodes(tree).find(node => node.type === 'button' && text(node) === label); assert.ok(result, label); return result.props; }

test('file API failure is explicit, keeps an unsuccessful first load distinct from an empty result, and retries recover', async () => {
  const h = storeHarness([new Error('backend unavailable'), list()]);
  await h.store.getState().fetchFiles();
  assert.equal(h.store.getState().hasLoaded, false);
  assert.match(h.store.getState().loadError, /加载失败/);
  await h.store.getState().fetchFiles();
  assert.equal(h.store.getState().hasLoaded, true);
  assert.equal(h.store.getState().loadError, null);
  assert.equal(h.store.getState().files[0].id, file.id);
});

test('refresh and load-more failures preserve the last loaded files, total and pagination', async () => {
  const h = storeHarness([list(), new Error('refresh failed'), new Error('page failed')]);
  await h.store.getState().fetchFiles();
  const before = h.store.getState();
  await h.store.getState().fetchFiles({ page: 1 });
  await h.store.getState().fetchFiles({ page: 2 }, { append: true });
  const after = h.store.getState();
  assert.deepEqual(after.files, before.files);
  assert.equal(after.total, before.total);
  assert.equal(after.page, before.page);
  assert.equal(after.hasLoaded, true);
  assert.match(after.loadError, /加载失败/);
});

test('a stale failed request cannot replace a newer successful filter result with an error', async () => {
  let reject;
  const h = storeHarness([() => new Promise((_, fail) => { reject = fail; }), list()]);
  const first = h.store.getState().fetchFiles();
  h.store.getState().setFilters({ libraryId: 2 }); await tick();
  reject(new Error('old request failed')); await first;
  assert.equal(h.store.getState().loadError, null);
  assert.equal(h.store.getState().files[0].id, file.id);
});

test('Dashboard library outage shows failure and retry instead of zero totals or empty-template claims', async () => {
  const data = storeHarness([list()]);
  const h = dashboardHarness(data.store, [new Error('offline'), [{ id: 1, name: '本来资源库' }]]);
  let tree = await h.settle();
  assert.match(text(tree), /资源库加载失败/);
  assert.doesNotMatch(text(tree), /全部 \(0\)|暂无模板|当前资源库还没有分类/);
  await button(tree, '重试加载').onClick();
  tree = await h.settle();
  assert.equal(h.libraryCalls[1].force, true);
  assert.match(text(tree), /本来资源库/);
  assert.ok(nodes(tree).some(node => node.props?.file?.id === file.id));
  assert.doesNotMatch(text(tree), /加载失败/);
});

test('Dashboard failed library refresh retains the selected library and loaded templates', async () => {
  const data = storeHarness([list(), list()]);
  const h = dashboardHarness(data.store, [[{ id: 1, name: '本来资源库' }], new Error('offline'), [{ id: 1, name: '本来资源库' }]]);
  let tree = await h.settle();
  button(tree, '本来资源库').onClick(); tree = h.render();
  button(tree, '刷新资源库').onClick(); tree = await h.settle();
  assert.match(text(tree), /资源库加载失败/);
  assert.match(text(tree), /已保留上次加载的内容/);
  assert.ok(nodes(tree).some(node => node.props?.file?.id === file.id));
  assert.ok(nodes(tree).some(node => node.type === 'button' && text(node).startsWith('本来资源库')));
  button(tree, '重试加载').onClick(); tree = await h.settle();
  assert.doesNotMatch(text(tree), /加载失败/);
});

test('Dashboard file outage has an actionable retry and renders real successful emptiness only after recovery', async () => {
  const data = storeHarness([new Error('offline'), list([])]);
  const h = dashboardHarness(data.store, [[{ id: 1, name: '本来资源库' }]]);
  let tree = await h.settle();
  assert.match(text(tree), /模板列表加载失败/);
  assert.doesNotMatch(text(tree), /全部 \(0\)|暂无模板/);
  button(tree, '重试加载').onClick(); tree = await h.settle();
  assert.match(text(tree), /全部 \(0\)|暂无模板/);
  assert.doesNotMatch(text(tree), /加载失败/);
});

test('Dashboard pagination outage keeps existing templates and stops automatic continuation until retry', async () => {
  const data = storeHarness([{ ...list(), pagination: { total: 2, page: 1, pageSize: 1 } }, new Error('page unavailable')]);
  data.store.setState({ pageSize: 1 });
  const h = dashboardHarness(data.store, [[{ id: 1, name: '本来资源库' }]]);
  let tree = await h.settle();
  button(tree, '继续加载').onClick(); tree = await h.settle();
  assert.equal(data.calls.length, 2);
  assert.match(text(tree), /模板列表加载失败/);
  assert.ok(nodes(tree).some(node => node.props?.file?.id === file.id));
  assert.equal(nodes(tree).some(node => node.type === 'button' && text(node) === '继续加载'), false);
  assert.ok(button(tree, '重试加载'));
});
