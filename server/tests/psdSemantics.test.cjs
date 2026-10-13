const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanvas } = require('@napi-rs/canvas');
const {
  inspectPsdHeader, checkPsdDecodedBudget, checkPsdSourceSize, classifyPsdLayer, psdSourceKey,
  createPsdSourceKeyResolver, psdClippingBaseKeys, serializePsdEffects,
  firstPsdEffects, createPsdMaskRenderer, releasePsdLayerPixels,
  canRestorePsdVectorContent, renderPsdVectorContent,
} = require('../dist/services/parser/psdSemantics');

function canvas(width, height, color) {
  const result = createCanvas(width, height);
  const context = result.getContext('2d');
  context.fillStyle = color; context.fillRect(0, 0, width, height);
  return result;
}
function pixel(surface, x = 0, y = 0) { return [...surface.getContext('2d').getImageData(x, y, 1, 1).data]; }
function header(version, width, height) {
  const buffer = Buffer.alloc(26); buffer.write('8BPS'); buffer.writeUInt16BE(version, 4);
  buffer.writeUInt32BE(height, 14); buffer.writeUInt32BE(width, 18); buffer.writeUInt16BE(8, 22);
  return buffer;
}
function rectangle(left, top, right, bottom, operation) {
  return { open: false, fillRule: 'even-odd', operation, knots: [[left, top], [right, top], [right, bottom], [left, bottom]].map(([x, y]) => ({ linked: true, points: [x, y, x, y, x, y] })) };
}

test('PSD/PSB headers and aggregate decoder budget reject oversized or invalid canvases before decoding', () => {
  assert.deepEqual(inspectPsdHeader(header(2, 40_000, 1)), { version: 2, width: 40_000, height: 1, bitsPerChannel: 8 });
  assert.throws(() => inspectPsdHeader(header(1, 40_000, 1)), /无效/);
  assert.throws(() => inspectPsdHeader(header(2, 10, 10), 99), /预算/);
  assert.throws(() => inspectPsdHeader(Buffer.alloc(5)), /文件头/);
  assert.throws(() => checkPsdDecodedBudget({ width: 10, height: 10, children: [{ left: 0, top: 0, right: 10, bottom: 10 }] }, 2_000), /预算/);
  assert.throws(() => checkPsdDecodedBudget({ width: 1, height: 1, children: [{ left: 4, right: 2 }] }), /边界/);
  assert.throws(() => checkPsdSourceSize(101, 100), /预算/);
  assert.equal(checkPsdDecodedBudget({ width: 10, height: 10, bitsPerChannel: 16 }), 2_400);
  assert.equal(checkPsdDecodedBudget({ width: 10, height: 10, bitsPerChannel: 32 }), 4_000);
  assert.throws(() => checkPsdDecodedBudget({ width: 1, height: 1, children: [{}, {}] }, 10_000, 100, 1), /数量/);
  assert.throws(() => checkPsdDecodedBudget({ width: 1, height: 1, children: [{ children: [{}] }] }, 10_000, 100, 100, 1), /嵌套/);
});

test('empty groups, adjustments and masked photos retain correct semantic types and stable clipping parents', () => {
  assert.equal(classifyPsdLayer({ children: [] }), 'group');
  assert.equal(classifyPsdLayer({ adjustment: { type: 'curves' } }), 'adjustment');
  assert.equal(classifyPsdLayer({ vectorFill: { type: 'color', color: { r: 1, g: 2, b: 3 } } }), 'shape');
  assert.equal(classifyPsdLayer({ vectorMask: { paths: [] }, placedLayer: { id: 'x' } }), 'image');
  assert.equal(classifyPsdLayer({ vectorOrigination: { keyDescriptorList: [] } }), 'image');
  assert.equal(psdSourceKey({ id: NaN }, [1, 2]), 'path:1.2');
  const layers = [{ id: 5 }, { id: 6, clipping: true }, { children: [{ id: 5 }] }, { clipping: true }];
  const keyOf = createPsdSourceKeyResolver(layers);
  assert.equal(keyOf(layers[0], [0]), 'path:0');
  assert.equal(keyOf(layers[2].children[0], [2, 0]), 'path:2.0');
  assert.deepEqual(psdClippingBaseKeys(layers, [], keyOf), [undefined, 'path:0', undefined, 'path:2']);
  assert.deepEqual(psdClippingBaseKeys([{ clipping: true }], []), [undefined]);
});

test('disabled master FX suppresses everything; all enabled effects and complete gradient descriptors survive', () => {
  assert.deepEqual(serializePsdEffects({ disabled: true, solidFill: [{ enabled: true, color: { r: 255, g: 0, b: 0 } }] }), {});
  const gradient = { type: 'solid', name: 'test', colorStops: [{ location: 0, midpoint: 0.4, color: { r: 255, g: 0, b: 0 } }], opacityStops: [{ location: 1, midpoint: 0.6, opacity: 0.5 }] };
  const result = serializePsdEffects({ scale: 0.5, stroke: [{ enabled: false }, { enabled: true, size: { units: 'Pixels', value: 2 } }, { enabled: true, size: { units: 'Pixels', value: 3 } }], gradientOverlay: [{ gradient, reverse: true, scale: 50, offset: { x: 4, y: 8 } }] });
  assert.deepEqual(result.stroke.map(item => item.size), [2, 3]);
  assert.deepEqual(result.gradientOverlay[0].gradient, gradient);
  assert.deepEqual(result.gradientOverlay[0].offset, { x: 4, y: 8 });
  assert.equal(firstPsdEffects(result).stroke.size, 2);
});

test('ordinary mask density, relative coordinates, disabled masks and raw imageData produce alpha resources', async () => {
  const render = createPsdMaskRenderer();
  const owner = { left: 20, top: 30, mask: { canvas: canvas(1, 1, 'black'), left: 2, top: 3, defaultColor: 0, positionRelativeToLayer: true, userMaskDensity: 0 } };
  const result = await render(owner, { width: 50, height: 50 });
  assert.deepEqual([result.x, result.y, result.defaultColor], [22, 33, 255]);
  assert.equal(pixel(result.canvas)[3], 255);
  owner.mask.userMaskDensity = 0.5;
  assert.equal(pixel((await render(owner, { width: 50, height: 50 })).canvas)[3], 128);
  owner.mask.disabled = true;
  assert.equal(await render(owner, { width: 50, height: 50 }), null);
  const dataMask = await render({ mask: { imageData: { width: 1, height: 1, data: new Uint8Array([128, 128, 128, 255]) }, defaultColor: 255 } }, { width: 1, height: 1 });
  assert.equal(pixel(dataMask.canvas)[3], 128);
});

test('mask feather extends its alpha rectangle and fades a hard edge without mutating content', async () => {
  const hard = canvas(9, 5, 'black');
  const context = hard.getContext('2d'); context.fillStyle = 'white'; context.fillRect(4, 0, 5, 5);
  const render = createPsdMaskRenderer();
  const result = await render({ mask: { canvas: hard, left: 10, top: 10, defaultColor: 0, userMaskFeather: 1 } }, { width: 40, height: 40 });
  assert.deepEqual([result.x, result.y, result.width, result.height], [7, 7, 15, 11]);
  const alpha = pixel(result.canvas, 6, 5)[3];
  assert.ok(alpha > 0 && alpha < 128, `feather edge alpha ${alpha}`);
  assert.deepEqual(pixel(hard, 3, 2), [0, 0, 0, 255]);
});

test('cached vector bitmap is applied once; real mask replaces a possibly combined cache', async () => {
  const render = createPsdMaskRenderer();
  const owner = { mask: { canvas: canvas(2, 2, 'rgb(128,128,128)'), fromVectorData: true }, vectorMask: { paths: [rectangle(0, 0, 2, 2)] } };
  const cached = await render(owner, { width: 2, height: 2 });
  assert.equal(pixel(cached.canvas)[3], 128);
  assert.equal(await render(owner, { width: 2, height: 2 }), cached);
  owner.realMask = { canvas: canvas(2, 2, 'rgb(128,128,128)') };
  const combined = await render(owner, { width: 2, height: 2 });
  assert.equal(pixel(combined.canvas)[3], 128);
  render.release(owner);
  releasePsdLayerPixels(owner);
  assert.equal(owner.mask.canvas, undefined);
  assert.equal(owner.realMask.canvas, undefined);
});

test('vector subtract operations and retained raster geometry avoid duplicate masking', async () => {
  const render = createPsdMaskRenderer();
  const layer = { vectorMask: { paths: [rectangle(0, 0, 4, 4, 'combine'), rectangle(1, 1, 3, 3, 'subtract')] } };
  const result = await render(layer, { width: 4, height: 4 });
  assert.equal(pixel(result.canvas, 0, 0)[3], 255);
  assert.equal(pixel(result.canvas, 1, 1)[3], 0);
  assert.equal(await render(layer, { width: 4, height: 4 }, { skipVectorMask: true }), null);
});

test('solid vector gradient restores unmasked fill colors and opacity without hard outline alpha', () => {
  const layer = { left: 0, top: 0, right: 4, bottom: 1, vectorFill: { type: 'solid', name: 'r-b', style: 'linear', angle: 0, colorStops: [{ location: 0, midpoint: 0.5, color: { r: 255, g: 0, b: 0 } }, { location: 1, midpoint: 0.5, color: { r: 0, g: 0, b: 255 } }], opacityStops: [{ location: 0, midpoint: 0.5, opacity: 1 }, { location: 1, midpoint: 0.5, opacity: 0.5 }] } };
  assert.equal(canRestorePsdVectorContent(layer), true);
  const fill = renderPsdVectorContent(layer, { x: 0, y: 0, width: 4, height: 1 }, { width: 4, height: 1 });
  assert.deepEqual(pixel(fill, 0), [223, 0, 32, 239]);
  assert.deepEqual(pixel(fill, 3), [32, 0, 223, 143]);
  assert.equal(canRestorePsdVectorContent({ ...layer, vectorStroke: { strokeEnabled: true } }), false);
});
