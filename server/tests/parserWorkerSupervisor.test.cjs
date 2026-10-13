const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { startParserWorker } = require('../dist/services/parser/parserWorkerSupervisor');
const workerPath = path.join(__dirname, 'fixtures', 'parser-worker.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'benlai-worker-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function run(dir, fileId, overrides = {}) {
  return startParserWorker({ fileId, resultPath: path.join(dir, 'result.json'), allowClientAssistWait: false, ...overrides }, { timeoutMs: 1000, workerPath });
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
test('successful child returns only after exit and next worker can start', async t => {
  const dir = await setup(t);
  const worker = run(dir, 1);
  const patch = await worker.result;
  assert.equal(patch.parseStatus, 'completed');
  assert.equal(alive(worker.pid), false);
  assert.equal((await run(dir, 1).result).parseStatus, 'completed');
});
test('synchronous busy child cannot block parent HTTP, timeout kills descendants and later work succeeds', async t => {
  const dir = await setup(t);
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const worker = run(dir, 2);
  const failure = assert.rejects(worker.result, /超时/);
  for (let i = 0; i < 5; i++) {
    await delay(50);
    const start = Date.now();
    const response = await fetch('http://127.0.0.1:' + server.address().port);
    assert.equal(response.status, 200);
    assert.ok(Date.now() - start < 2000);
  }
  await failure;
  const childPid = Number(await fs.readFile(path.join(dir, 'descendant.pid'), 'utf8'));
  await delay(100);
  assert.equal(alive(worker.pid), false);
  assert.equal(alive(childPid), false);
  assert.equal((await run(dir, 1).result).parseStatus, 'completed');
});
for (const [fileId, expression] of [[3, /fixture throw/], [4, /没有返回结果/], [5, /异常退出/], [7, /无效结果/]]) {
  test('failure mode ' + fileId + ' never becomes completed', async t => {
    const dir = await setup(t);
    await assert.rejects(run(dir, fileId).result, expression);
    assert.equal((await run(dir, 1).result).parseStatus, 'completed');
  });
}
test('latest assist is delivered without preview data and cancellation ignores an early result', async t => {
  const dir = await setup(t);
  const snapshot = { version: 1, source: 'browser-pdfjs-worker', fileType: 'pdf', width: 10, height: 10, pageCount: 1, textItemCount: 0, imageOpCount: 0, pathOpCount: 0, hasFullPageImage: false, textLayers: [], previewDataUrl: 'data:image/png;base64,AAA' };
  const worker = run(dir, 6, { clientAssistSnapshot: snapshot });
  worker.updateAssist({ ...snapshot, textItemCount: 1 }, true);
  worker.updateAssist({ ...snapshot, textItemCount: 2 }, true);
  const patch = await worker.result;
  assert.equal(patch.parseResult.assist.textItemCount, 2);
  assert.equal(patch.parseResult.assist.previewDataUrl, undefined);
  assert.equal(patch.parseResult.previewRemoved, true);
  const cancelled = run(dir, 6);
  const rejection = assert.rejects(cancelled.result, /requested cancellation/);
  await cancelled.cancel('requested cancellation');
  await rejection;
  await cancelled.cancel('double cancellation');
});
test('optional assist after a result cannot turn graceful IPC shutdown into failure', async t => {
  const dir = await setup(t);
  const worker = run(dir, 8);
  while (true) {
    try { await fs.access(path.join(dir, 'result-sent')); break; } catch { await delay(5); }
  }
  for (let i = 0; i < 20; i++) worker.updateAssist(null, true);
  assert.equal((await worker.result).parseStatus, 'completed');
});
