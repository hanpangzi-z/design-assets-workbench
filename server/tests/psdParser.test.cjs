const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const ag = require('ag-psd');
const { STORAGE } = require('../dist/config/storage');
const { DesignFile, ParsedLayer } = require('../dist/models');
const { runStagedParser } = require('../dist/services/parser/parserExecution');
const { parsePsd } = require('../dist/services/parser/psdParser');

function colored(width, height, color) {
  const canvas = createCanvas(width, height), context = canvas.getContext('2d');
  context.fillStyle = color; context.fillRect(0, 0, width, height); return canvas;
}
function fixture(psb = false) {
  ag.initializeCanvas(createCanvas, (w, h) => createCanvas(w, h).getContext('2d').createImageData(w, h));
  const white = () => colored(1, 1, 'white');
  return ag.writePsdBuffer({ width: 2, height: 2, canvas: colored(2, 2, 'blue'), children: [
    { id: 10, name: 'masked group', mask: { canvas: colored(1, 1, 'rgb(128,128,128)'), defaultColor: 0 }, children: [
      { id: 11, name: 'red', canvas: colored(1, 1, 'red') },
      { id: 12, name: 'blue clipping', clipping: true, canvas: colored(1, 1, 'blue') },
    ] },
    { id: 13, name: 'empty group', children: [] },
    { id: 14, name: 'disabled overlay', canvas: white(), effects: { disabled: true, solidFill: [{ enabled: true, color: { r: 255, g: 0, b: 0 }, opacity: 1 }] } },
    { id: 15, name: 'masked text', canvas: white(), text: { text: 'A', transform: [1, 0, 0, 1, 0, 0], style: { font: { name: 'ArialMT' }, fontSize: 12 } }, mask: { canvas: colored(1, 1, 'black'), userMaskDensity: 0 } },
    { id: 16, name: 'shape', canvas: white(), vectorFill: { type: 'color', color: { r: 255, g: 255, b: 255 } }, vectorMask: { paths: [{ open: false, fillRule: 'even-odd', knots: [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => ({ linked: true, points: [x, y, x, y, x, y] })) }] } },
    { id: 17, name: 'adjustment', adjustment: { type: 'invert' } },
    { id: 18, name: 'smart object', canvas: white(), placedLayer: { id: '6e05254f-fb27-43dc-a666-51aef4b348e6', type: 'raster', transform: [0, 0, 1, 0, 1, 1, 0, 1], width: 1, height: 1 } },
  ] }, { psb });
}
function setup(t, buffer = fixture()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benlai-psd-test-'));
  const originalBase = STORAGE.base;
  STORAGE.base = root;
  const originalFind = DesignFile.findByPk;
  const originalCreate = ParsedLayer.create;
  const originalDestroy = ParsedLayer.destroy;
  const source = path.join(root, 'original.psd'); fs.writeFileSync(source, buffer);
  const file = { id: 123, filePath: source, name: 'test', set(patch) { Object.assign(this, patch); }, update() { throw new Error('live file write attempted'); } };
  DesignFile.findByPk = async () => file;
  ParsedLayer.create = async () => { throw new Error('live layer insert attempted'); };
  ParsedLayer.destroy = async () => { throw new Error('live layer deletion attempted'); };
  t.after(() => {
    DesignFile.findByPk = originalFind; ParsedLayer.create = originalCreate; ParsedLayer.destroy = originalDestroy;
    STORAGE.base = originalBase;
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('benlai-psd-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, artifactDirectory: `parsed/123/${randomUUID()}`, file };
}
async function rgba(root, filename) {
  const image = await loadImage(path.join(root, filename));
  const canvas = createCanvas(image.width, image.height); canvas.getContext('2d').drawImage(image, 0, 0);
  return [...canvas.getContext('2d').getImageData(0, 0, 1, 1).data];
}

test('real PSD decoding stages original child pixels, independent group/text masks and complete source semantics without DB writes', async t => {
  const { root, artifactDirectory } = setup(t);
  const result = await runStagedParser(123, artifactDirectory, () => parsePsd(123));
  const byName = new Map(result.layers.map(layer => [layer.layerName, layer]));
  assert.equal(result.parseResult.rasterContentMode, 'raw');
  assert.equal(result.parseResult.artifactDirectory, artifactDirectory);
  assert.ok(fs.existsSync(path.join(root, result.parseResult.compositePath)));
  assert.ok(fs.existsSync(path.join(root, result.thumbnailPath)));
  assert.deepEqual(await rgba(root, byName.get('red').imagePath), [255, 0, 0, 255]);
  assert.deepEqual(await rgba(root, byName.get('blue clipping').imagePath), [0, 0, 255, 255]);
  assert.equal((await rgba(root, byName.get('masked group').properties.psdMask.imagePath))[3], 128);
  assert.equal(byName.get('blue clipping').properties.psdClipBaseKey, 'id:11');
  assert.equal(byName.get('empty group').layerType, 'group');
  assert.deepEqual(await rgba(root, byName.get('disabled overlay').imagePath), [255, 255, 255, 255]);
  assert.equal(byName.get('disabled overlay').properties.effects, undefined);
  assert.equal(byName.get('disabled overlay').properties.psdEffectsDisabled, true);
  assert.equal((await rgba(root, byName.get('masked text').properties.psdMask.imagePath))[3], 255);
  assert.equal(byName.get('masked text').textContent, 'A');
  assert.equal(byName.get('shape').layerType, 'shape');
  assert.equal(byName.get('shape').properties.psdVectorMask.paths.length, 1);
  assert.equal(byName.get('shape').properties.psdMaskIncludesVectorGeometry, true);
  assert.equal(byName.get('shape').properties.psdUserMask, undefined);
  assert.deepEqual(byName.get('adjustment').properties.psdAdjustment, { type: 'invert' });
  assert.equal(byName.get('smart object').properties.psdPlacedLayer.id, '6e05254f-fb27-43dc-a666-51aef4b348e6');
  assert.equal(result.parseResult.hasErrors, false);
});

test('PSB uses the same staged layer decoder and preserves version 2 in the result', async t => {
  const { artifactDirectory } = setup(t, fixture(true));
  const result = await runStagedParser(123, artifactDirectory, () => parsePsd(123));
  assert.equal(result.parseResult.psdVersion, 2);
  assert.ok(result.layers.some(layer => layer.layerType === 'text'));
});

test('real PSD raw export preserves partial and fully off-canvas content and only trims transparent margins', async t => {
  ag.initializeCanvas(createCanvas, (w, h) => createCanvas(w, h).getContext('2d').createImageData(w, h));
  const transparentMargins = createCanvas(5, 3);
  const marginsContext = transparentMargins.getContext('2d');
  marginsContext.fillStyle = 'green'; marginsContext.fillRect(1, 1, 3, 1);
  const buffer = ag.writePsdBuffer({ width: 2, height: 2, canvas: colored(2, 2, 'white'), children: [
    { id: 21, name: 'partially outside', left: -2, top: 0, canvas: colored(4, 1, 'red') },
    { id: 22, name: 'hidden outside', hidden: true, left: 5, top: -3, canvas: colored(3, 1, 'blue') },
    { id: 23, name: 'alpha trimmed outside', left: -6, top: 5, canvas: transparentMargins },
  ] }, { trimImageData: false });
  const { root, artifactDirectory } = setup(t, buffer);
  const result = await runStagedParser(123, artifactDirectory, () => parsePsd(123));
  const byName = new Map(result.layers.map(layer => [layer.layerName, layer]));
  for (const [name, x, y, width, height, color, visible, trimmed] of [
    ['partially outside', -2, 0, 4, 1, [255, 0, 0, 255], true, false],
    ['hidden outside', 5, -3, 3, 1, [0, 0, 255, 255], false, false],
    ['alpha trimmed outside', -5, 6, 3, 1, [0, 128, 0, 255], true, true],
  ]) {
    const layer = byName.get(name);
    assert.deepEqual([layer.x, layer.y, layer.width, layer.height], [x, y, width, height]);
    assert.equal(layer.visible, visible);
    assert.ok(layer.imagePath.startsWith(artifactDirectory + '/'));
    const image = await loadImage(path.join(root, layer.imagePath));
    assert.deepEqual([image.width, image.height], [width, height]);
    assert.deepEqual(await rgba(root, layer.imagePath), color);
    assert.equal(layer.properties.documentClipped, false);
    assert.equal(layer.properties.alphaTrimmed, trimmed);
    // Moving the exported raw content into the document must reveal it even
    // when its original PSD coordinates were wholly outside the canvas.
    const document = createCanvas(2, 2);
    document.getContext('2d').drawImage(image, 0, 0);
    assert.deepEqual([...document.getContext('2d').getImageData(0, 0, 1, 1).data], color);
  }
  assert.equal(result.parseResult.exportedImageCount, 3);
  assert.equal(result.parseResult.documentClippedRasterCount, 0);
  assert.equal(result.parseResult.hasErrors, false);
});

test('a layer PNG write failure is visible as a per-layer error and actual exported image count', async t => {
  const { artifactDirectory } = setup(t);
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function (filename, ...args) {
    if (path.basename(String(filename)) === 'layer_2.png') throw new Error('fixture disk failure');
    return originalWrite.call(this, filename, ...args);
  };
  t.after(() => { fs.writeFileSync = originalWrite; });
  const result = await runStagedParser(123, artifactDirectory, () => parsePsd(123));
  assert.equal(result.parseResult.hasErrors, true);
  const error = result.parseResult.diagnostics.find(item => item.code === 'layer-image-export-failed');
  assert.equal(error.layerKey, 'id:11');
  assert.match(error.message, /fixture disk failure/);
  assert.equal(result.parseResult.exportedImageCount, result.layers.filter(layer => layer.imagePath).length);
});

test('header budget failure rejects staged parsing without creating output or changing live rows', async t => {
  const { root, artifactDirectory } = setup(t);
  const previous = process.env.PSD_MAX_PIXELS;
  process.env.PSD_MAX_PIXELS = '3';
  t.after(() => { if (previous === undefined) delete process.env.PSD_MAX_PIXELS; else process.env.PSD_MAX_PIXELS = previous; });
  await assert.rejects(runStagedParser(123, artifactDirectory, () => parsePsd(123)), /预算/);
  assert.equal(fs.existsSync(path.join(root, artifactDirectory)), false);
});
