const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../src/services/parser/parseFreshness.ts');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const { deriveParseFreshness, effectiveParseStatus, parseResultRevision } = loaded.exports;
const record = (revision, version = 79, status = 'completed') => ({ parseStatus: status,
  parseResult: { pdfParserVersion: version, parseRevision: revision } });
const input = extra => ({ file: record('a'), source: record('a'), versionKey: 'pdfParserVersion',
  requiredVersion: 79, canonicalHealthy: true, ownHealthy: true, queuePhase: null, ...extra });

test('ready is local to the opened copy even while the parent is finishing other copies', () => {
  const result = deriveParseFreshness(input({ queuePhase: 'finishing' }));
  assert.deepEqual(result, { state: 'ready', requiredVersion: 79, resultVersion: 79, revision: 'a' });
  assert.equal(effectiveParseStatus(result), 'completed');
});

test('same version is insufficient when a copy still belongs to the preceding revision', () => {
  const result = deriveParseFreshness(input({ file: record('old') }));
  assert.equal(result.state, 'syncing');
  assert.equal(result.revision, 'old');
  assert.equal(effectiveParseStatus(result), 'pending');
});

test('late joining a finishing source cannot advertise its old completed copy as ready', () => {
  const result = deriveParseFreshness(input({ file: record('old', 77), source: record('old', 77, 'parsing'),
    canonicalHealthy: false, queuePhase: 'finishing' }));
  assert.equal(result.state, 'syncing');
  assert.equal(result.resultVersion, 77);
  assert.equal(effectiveParseStatus(result), 'pending');
});

test('queue phase disambiguates recovery of stale database parsing status', () => {
  const result = deriveParseFreshness(input({ source: record('old', 77, 'parsing'), queuePhase: 'queued' }));
  assert.equal(result.state, 'queued');
});

test('an attempt claimed before its pending write cannot expose the preceding completed generation', () => {
  for (const queuePhase of ['queued', 'parsing']) {
    assert.equal(deriveParseFreshness(input({ queuePhase })).state, queuePhase);
  }
});

test('failed source or failed copy always remains terminal despite a retained current revision', () => {
  for (const extra of [{ file: record('a', 79, 'failed') }, { source: record('a', 79, 'failed') }]) {
    const result = deriveParseFreshness(input(extra));
    assert.equal(result.state, 'failed');
    assert.equal(effectiveParseStatus(result), 'failed');
  }
});

test('current metadata and equal revision cannot bypass unhealthy canonical or own resources', () => {
  assert.equal(deriveParseFreshness(input({ canonicalHealthy: false })).state, 'queued');
  assert.equal(deriveParseFreshness(input({ ownHealthy: false })).state, 'syncing');
});

test('legacy revision hashes all metadata stably without relying on model updatedAt', () => {
  const a = { pdfParserVersion: 79, pages: [{ page: 1, svgPath: 'old.svg', width: 100 }], previewOnly: false };
  const b = { previewOnly: false, pages: [{ width: 100, svgPath: 'old.svg', page: 1 }], pdfParserVersion: 79 };
  assert.equal(parseResultRevision(a), parseResultRevision(b));
  assert.notEqual(parseResultRevision(a), parseResultRevision({ ...a, pages: [{ ...a.pages[0], svgPath: 'new.svg' }] }));
  assert.equal(parseResultRevision(null), null);
  const file = { parseStatus: 'completed', parseResult: a, updatedAt: 'earlier' };
  const source = { parseStatus: 'completed', parseResult: b, updatedAt: 'later' };
  assert.equal(deriveParseFreshness(input({ file, source })).state, 'ready');
});

test('a newly versioned parent cannot make an old-version copy ready even with matching identity', () => {
  assert.equal(deriveParseFreshness(input({ file: record('a', 78) })).state, 'syncing');
});
