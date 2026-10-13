const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const freshnessModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(
  fs.readFileSync(path.resolve(__dirname, '../src/utils/parseFreshness.ts'), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText, { module: freshnessModule, exports: freshnessModule.exports, URL, Set });

// Exercise the actual polling functions without mounting Fabric/React or contacting an API.
// Extract their AST expressions, compile TypeScript, then provide fake time and API boundaries.
const editorPath = path.resolve(__dirname, '../src/pages/Editor/index.tsx');
const source = ts.createSourceFile(editorPath, fs.readFileSync(editorPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && ['readFile', 'waitForPoll', 'waitForParsedFile'].includes(node.name.text)) {
    functions.set(node.name.text, node.initializer.getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(functions.size, 3, 'The polling implementation must be available for behavioral tests');
const executable = ts.transpileModule(`(() => {
  let pollTimer;
  let cancelPollWait;
  ${[...functions].map(([name, expression]) => `const ${name} = ${expression};`).join('\n')}
  return {
    poll: waitForParsedFile,
    cancel: () => { deactivate(); pollAbort.abort(); window.clearTimeout(pollTimer); cancelPollWait?.(); },
  };
})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function harness(statuses, readOverride) {
  let now = 0;
  let active = true;
  let sequence = 0;
  const timers = new Map();
  const delays = [];
  const updates = [];
  const requests = [];
  const pollAbort = new AbortController();
  const initialFile = { id: 6411, fileType: 'pdf', parseStatus: 'pending' };
  const lifecycle = vm.runInNewContext(executable, {
    shouldWaitForParseFreshness: freshnessModule.exports.shouldWaitForParseFreshness,
    Date: { now: () => now },
    pollAbort,
    routePageNumber: 1,
    isCurrentGeneration: () => active,
    deactivate: () => { active = false; },
    setFileData: (file) => updates.push(file),
    setCanvasSize: () => {},
    getParsedDocumentPage: () => null,
    api: {
      get: async (url, options) => {
        requests.push({ url, signal: options.signal });
        if (readOverride) return readOverride(options.signal);
        assert.ok(statuses.length, 'Polling must stop once the terminal response is received');
        return { data: { data: { ...initialFile, parseStatus: statuses.shift() } } };
      },
    },
    window: {
      setTimeout(callback, delay) {
        delays.push(delay);
        timers.set(++sequence, { callback, delay });
        return sequence;
      },
      clearTimeout: (id) => timers.delete(id),
    },
  });
  async function nextTimer() {
    const entry = timers.entries().next().value;
    assert.ok(entry, 'Expected an active poll timer');
    timers.delete(entry[0]);
    now += entry[1].delay;
    entry[1].callback();
    // Allow the real async API/read/update continuation to schedule its next poll.
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
  return { ...lifecycle, initialFile, nextTimer, delays, updates, requests, timers, pollAbort };
}

test('pending parsing continues past forty seconds and stops only at completed', async () => {
  const h = harness([...Array(29).fill('parsing'), 'completed']);
  const result = h.poll(h.initialFile);
  for (let i = 0; i < 30; i++) await h.nextTimer();
  assert.equal((await result).parseStatus, 'completed');
  assert.equal(h.requests.length, 30);
  assert.ok(h.delays.every((delay) => delay === 2000));
  assert.equal(h.timers.size, 0);
});

test('polling slows after 210 seconds and stops at failed', async () => {
  const h = harness([...Array(105).fill('parsing'), 'failed']);
  const result = h.poll(h.initialFile);
  for (let i = 0; i < 106; i++) await h.nextTimer();
  assert.equal((await result).parseStatus, 'failed');
  assert.deepEqual(h.delays.slice(0, 105), Array(105).fill(2000));
  assert.equal(h.delays[105], 5000);
  assert.equal(h.timers.size, 0);
});

test('switching files cancels a pending timer without another API request', async () => {
  const h = harness(['completed']);
  const result = h.poll(h.initialFile);
  h.cancel();
  assert.equal((await result).parseStatus, 'pending');
  assert.equal(h.timers.size, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.updates.length, 0);
  assert.equal(h.pollAbort.signal.aborted, true);
});

test('a late response after switching files cannot update the new editor', async () => {
  let completeRead;
  const h = harness([], () => new Promise((resolve) => { completeRead = resolve; }));
  const result = h.poll(h.initialFile);
  await h.nextTimer();
  assert.equal(h.requests[0].signal, h.pollAbort.signal);
  h.cancel();
  completeRead({ data: { data: { ...h.initialFile, parseStatus: 'completed' } } });
  await result;
  assert.equal(h.updates.length, 0);
  assert.equal(h.timers.size, 0);
});

test('opening a completed PDF never automatically posts force parse, including old preview copies of failed sources', () => {
  let autoReparse;
  function find(node) {
    if (ts.isIfStatement(node) && node.expression.getText(source).includes("file.parseStatus === 'completed'")
      && node.thenStatement.getText(source).includes('await api.post(`/files/${contentFileId}/parse`')) autoReparse = node.expression;
    ts.forEachChild(node, find);
  }
  find(source);
  assert.ok(autoReparse, 'The actual automatic reparse decision must be tested');
  const compiled = ts.transpileModule(`(${autoReparse.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const shouldPost = file => vm.runInNewContext(compiled, { file,
    isPsdFileType: value => value === 'psd' || value === 'psb', normalizeEditorState: () => null,
    hasPsdLayerEffectMetadata: () => false, hasAiEditableMetadata: () => false });
  for (const pdf of [
    { fileType: 'pdf', parseStatus: 'completed', parseResult: { pdfParserVersion: 76 } },
    { fileType: 'pdf', parseStatus: 'completed', sourceParseStatus: 'failed', autoParseBlocked: true,
      parseResult: { pdfParserVersion: 78, previewOnly: true } },
    { fileType: 'pdf', parseStatus: 'completed', parseResult: { pdfParserVersion: 79, previewOnly: true } },
  ]) assert.equal(shouldPost(pdf), false, 'The source-first GET policy owns automatic PDF reconciliation');
  assert.equal(shouldPost({ fileType: 'psd', parseStatus: 'completed' }), true);
  assert.equal(shouldPost({ fileType: 'ai', parseStatus: 'completed' }), true);
});

test('client parse assist is blocked for failed sources and failed copies while a genuinely queued PDF may continue', () => {
  const names = ['shouldSubmitClientParseAssist', 'hasPdfEditableMetadata', 'hasAiEditableMetadata'];
  const declarations = names.map(name => {
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration, name);
    return declaration.getText(source);
  });
  const executable = ts.transpileModule(`${declarations.join('\n')}\nmodule.exports = shouldSubmitClientParseAssist;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = { module: { exports: {} }, canGenerateClientParseAssist: () => true,
    CURRENT_PDF_PARSER_VERSION: 79, CURRENT_AI_PARSER_VERSION: 52 };
  vm.runInNewContext(executable, context);
  const shouldAssist = context.module.exports;
  assert.equal(shouldAssist({ fileType: 'pdf', parseStatus: 'pending' }), true);
  for (const status of ['pending', 'parsing', 'completed', 'failed']) {
    assert.equal(shouldAssist({ fileType: 'pdf', parseStatus: status, sourceParseStatus: 'failed' }), false);
    assert.equal(shouldAssist({ fileType: 'pdf', parseStatus: status, autoParseBlocked: true }), false);
  }
  assert.equal(shouldAssist({ fileType: 'pdf', parseStatus: 'failed' }), false);
  assert.equal(shouldAssist({ fileType: 'pdf', parseStatus: 'completed', parseResult: { pdfParserVersion: 79,
    previewOnly: true, editableSvg: false } }), false, 'A current valid preview fallback must not reparse forever');
});
