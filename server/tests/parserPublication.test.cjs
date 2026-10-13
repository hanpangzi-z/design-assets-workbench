const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { STORAGE } = require('../dist/config/storage');
const sequelize = require('../dist/config/database').default;
const { DesignFile, ParsedLayer } = require('../dist/models');
const {
  runStagedParser, ParserLayerStore, updateParserFile, publishParserResult,
  getParserArtifactDirectory, getParserOutputDirectory, validateParserCandidate,
} = require('../dist/services/parser/parserExecution');

function setup(t) {
  const originals = { transaction: sequelize.transaction, find: DesignFile.findByPk,
    create: ParsedLayer.create, destroy: ParsedLayer.destroy };
  const state = { layers: [{ id: 50, fileId: 7, parentLayerId: null, imagePath: 'parsed/7/old/layer.png' }],
    metadata: { parseStatus: 'completed', parseResult: { compositePath: 'parsed/7/old/composite.png' },
      editorState: { objects: [{ userEdited: true }] } }, sequence: 100, failCreate: false, failPublish: false };
  const file = { id: 7, isDeleted: false, ...state.metadata,
    set(patch) { Object.assign(this, patch); },
    async update(patch) {
      if (state.failPublish) throw new Error('publication failed');
      Object.assign(state.metadata, patch);
    },
  };
  DesignFile.findByPk = async () => file;
  ParsedLayer.destroy = async () => { state.layers = []; return 1; };
  ParsedLayer.create = async values => {
    if (state.failCreate) throw new Error('layer insert failed');
    const layer = { ...values, id: ++state.sequence };
    state.layers.push(layer);
    return layer;
  };
  sequelize.transaction = async operation => {
    const previous = structuredClone({ layers: state.layers, metadata: state.metadata });
    try { return await operation({ LOCK: { UPDATE: 'UPDATE' } }); }
    catch (error) { Object.assign(state, previous); throw error; }
  };
  t.after(() => {
    sequelize.transaction = originals.transaction;
    DesignFile.findByPk = originals.find;
    ParsedLayer.create = originals.create;
    ParsedLayer.destroy = originals.destroy;
  });
  return { file, state };
}

async function candidate(file) {
  return runStagedParser(file.id, 'parsed/7/new-generation', async () => {
    await ParserLayerStore.destroy({ where: { fileId: file.id } });
    const group = await ParserLayerStore.create({ fileId: file.id, layerType: 'group', layerName: 'group' });
    await ParserLayerStore.create({ fileId: file.id, parentLayerId: group.id, layerType: 'image',
      imagePath: 'parsed/7/new-generation/layer.png' });
    await updateParserFile(file, { parseStatus: 'completed',
      parseResult: { compositePath: 'parsed/7/new-generation/composite.png' } });
  });
}

test('candidate parser leaves live rows and metadata untouched and uses a separate output directory', async t => {
  const { file, state } = setup(t);
  const before = structuredClone(state);
  const result = await candidate(file);
  assert.deepEqual(state, before);
  assert.equal(result.layers.length, 2);
  assert.equal(result.layers[1].parentLayerId, result.layers[0].id);
  assert.equal(result.parseResult.artifactDirectory, 'parsed/7/new-generation');
  assert.deepEqual(result.parseResult.diagnostics, []);
  assert.equal(getParserArtifactDirectory(7), undefined);
  assert.match(getParserOutputDirectory(7), /parsed[\\/]7$/);
});

test('publication atomically remaps an out-of-order tree and preserves editor state', async t => {
  const { file, state } = setup(t);
  const result = await candidate(file);
  result.layers.reverse();
  await publishParserResult(file, result);
  const group = state.layers.find(layer => layer.layerType === 'group');
  const child = state.layers.find(layer => layer.layerType === 'image');
  assert.equal(child.parentLayerId, group.id);
  assert.equal(state.metadata.parseResult.compositePath, 'parsed/7/new-generation/composite.png');
  assert.equal(state.metadata.layers, undefined);
  assert.equal(state.metadata.editorState.objects[0].userEdited, true);
});

for (const failure of ['failCreate', 'failPublish']) {
  test(failure + ' rolls back both rows and metadata; old resource pointers remain intact', async t => {
    const { file, state } = setup(t);
    const result = await candidate(file);
    const before = structuredClone({ layers: state.layers, metadata: state.metadata });
    state[failure] = true;
    await assert.rejects(publishParserResult(file, result), /failed/);
    assert.deepEqual(state.layers, before.layers);
    assert.deepEqual(state.metadata, before.metadata);
  });
}

test('invalid, cross-file and cyclic candidate trees cannot replace live rows', async t => {
  const { file, state } = setup(t);
  for (const layers of [
    [{ id: -1, fileId: 8, parentLayerId: null }],
    [{ id: -1, fileId: 7, parentLayerId: -2 }],
    [{ id: -1, fileId: 7, parentLayerId: -2 }, { id: -2, fileId: 7, parentLayerId: -1 }],
  ]) {
    await assert.rejects(publishParserResult(file, { parseStatus: 'completed', parseResult: {}, layers }));
    assert.equal(state.layers[0].id, 50);
  }
  await assert.rejects(runStagedParser(7, 'parsed/7/new', async () => {
    await ParserLayerStore.create({ fileId: 8 });
  }), /another file/);
});

test('candidate errors and incomplete results never invoke live persistence', async t => {
  const { file, state } = setup(t);
  const before = structuredClone(state.metadata);
  await assert.rejects(runStagedParser(7, 'parsed/7/new', async () => {
    await updateParserFile(file, { parseStatus: 'failed', parseResult: { error: 'bad image' } });
  }), /bad image/);
  assert.deepEqual(state.metadata, before);
  assert.equal(state.layers[0].id, 50);
});

test('candidate validation decodes assets, rejects missing or corrupt pixels and confines resources', async t => {
  const relative = `parsed/7/test-${randomUUID()}`;
  const directory = path.resolve(STORAGE.base, relative);
  await fs.mkdir(directory, { recursive: true });
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(STORAGE.base, 'parsed', '7'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const resource = `${relative}/layer.png`;
  await sharp({ create: { width: 2, height: 2, channels: 4, background: 'red' } }).png().toFile(path.join(directory, 'layer.png'));
  const result = { parseStatus: 'completed', parseResult: { artifactDirectory: relative, compositePath: resource },
    thumbnailPath: resource, layers: [{ id: -1, fileId: 7, parentLayerId: null, imagePath: resource }] };
  await validateParserCandidate(7, relative, result);
  await fs.writeFile(path.join(directory, 'layer.png'), 'broken PNG');
  await assert.rejects(validateParserCandidate(7, relative, result), /图片无效/);
  await fs.unlink(path.join(directory, 'layer.png'));
  await assert.rejects(validateParserCandidate(7, relative, result), /ENOENT/);
  await assert.rejects(validateParserCandidate(8, relative, result), /目录/);
  await assert.rejects(validateParserCandidate(7, relative, { ...result, thumbnailPath: 'parsed/7/old/thumb.png' }), /缩略图/);
  await assert.rejects(validateParserCandidate(7, relative, { ...result, thumbnailPath: null,
    parseResult: { artifactDirectory: relative, compositePath: `${relative}/../old/composite.png` }, layers: [] }), /超出/);
});
