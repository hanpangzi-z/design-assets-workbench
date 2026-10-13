const test = require('node:test');
const assert = require('node:assert/strict');
const sequelize = require('../dist/config/database').default;
const {
  runIsolatedParser, updateParserFile, getParserLayerTransaction, isIsolatedParser,
} = require('../dist/services/parser/parserExecution');

const tick = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function file(id) {
  const writes = [];
  return {
    id, writes,
    async update(patch) { writes.push(patch); },
    set(patch) { Object.assign(this, patch); },
  };
}
function stubTransactions(t, beforeCommit = async () => {}) {
  const original = sequelize.transaction;
  const events = [];
  let id = 0;
  sequelize.transaction = async operation => {
    const transaction = { id: ++id };
    try {
      const patch = await operation(transaction);
      await beforeCommit();
      events.push({ id: transaction.id, result: 'committed' });
      return patch;
    } catch (error) {
      events.push({ id: transaction.id, result: 'rolled-back' });
      throw error;
    }
  };
  t.after(() => { sequelize.transaction = original; });
  return events;
}

test('ordinary direct parser calls retain file persistence', async () => {
  const source = file(1);
  await updateParserFile(source, { parseStatus: 'parsing' });
  await updateParserFile(source, { parseStatus: 'completed', parseResult: { method: 'direct' } });
  assert.deepEqual(source.writes, [
    { parseStatus: 'parsing' },
    { parseStatus: 'completed', parseResult: { method: 'direct' } },
  ]);
  assert.equal(isIsolatedParser(), false);
  assert.equal(getParserLayerTransaction(), undefined);
});

test('isolated result never writes file fields and is unavailable until layer commit completes', async t => {
  const commit = deferred();
  const events = stubTransactions(t, () => commit.promise);
  const source = file(2);
  let settled = false;
  const result = runIsolatedParser(source.id, async () => {
    assert.equal(isIsolatedParser(), true);
    assert.equal(getParserLayerTransaction().id, 1);
    await updateParserFile(source, { parseStatus: 'parsing' });
    await updateParserFile(source, { width: 40, height: 50, thumbnailPath: 'thumbnails/2.png' });
    await updateParserFile(source, { parseStatus: 'completed', parseResult: { method: 'fixture' } });
  }).then(patch => { settled = true; return patch; });
  await tick();
  assert.equal(settled, false);
  assert.deepEqual(events, []);
  assert.deepEqual(source.writes, []);
  commit.resolve();
  assert.deepEqual(await result, {
    width: 40, height: 50, thumbnailPath: 'thumbnails/2.png',
    parseStatus: 'completed', parseResult: { method: 'fixture' },
  });
  assert.deepEqual(events, [{ id: 1, result: 'committed' }]);
  assert.equal(isIsolatedParser(), false);
});

test('errors after a completed patch and failed parser results both roll back without terminal writes', async t => {
  const events = stubTransactions(t);
  const source = file(3);
  await assert.rejects(runIsolatedParser(source.id, async () => {
    await updateParserFile(source, { parseStatus: 'completed', parseResult: { method: 'fixture' } });
    throw new Error('layer insertion failed');
  }), /layer insertion failed/);
  await assert.rejects(runIsolatedParser(source.id, async () => {
    await updateParserFile(source, { parseStatus: 'failed', parseResult: { error: 'bad input' } });
  }), /bad input/);
  await assert.rejects(runIsolatedParser(source.id, async () => {}), /did not produce a completed result/);
  assert.deepEqual(source.writes, []);
  assert.equal(events.filter(event => event.result === 'rolled-back').length, 3);
  assert.equal(isIsolatedParser(), false);
});

test('concurrent attempts keep transactions and final patches separate and reject cross-file updates', async t => {
  stubTransactions(t);
  const firstReady = deferred();
  const secondDone = deferred();
  const one = file(4);
  const two = file(5);
  const first = runIsolatedParser(one.id, async () => {
    const transaction = getParserLayerTransaction();
    firstReady.resolve();
    await secondDone.promise;
    assert.equal(getParserLayerTransaction(), transaction);
    await updateParserFile(one, { parseStatus: 'completed', parseResult: { file: one.id } });
  });
  await firstReady.promise;
  const second = runIsolatedParser(two.id, async () => {
    assert.equal(getParserLayerTransaction().id, 2);
    await updateParserFile(two, { parseStatus: 'completed', parseResult: { file: two.id } });
    secondDone.resolve();
  });
  assert.equal((await first).parseResult.file, one.id);
  assert.equal((await second).parseResult.file, two.id);
  await assert.rejects(runIsolatedParser(one.id, async () => {
    await updateParserFile(two, { parseStatus: 'completed', parseResult: {} });
  }), /another file/);
  assert.deepEqual(one.writes, []);
  assert.deepEqual(two.writes, []);
});
