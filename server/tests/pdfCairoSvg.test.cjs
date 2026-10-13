const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const { normalizePdfCairoSvg } = require('../dist/services/parser/pdfCairoSvg');

const namespace = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
const svg = body => `<svg ${namespace} width="100" height="100" viewBox="0 0 100 100">${body}</svg>`;
async function directory(t) {
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'benlai-cairo-svg-'));
  t.after(() => fs.rm(outputDirectory, { recursive: true, force: true }));
  return outputDirectory;
}
function options(outputDirectory) {
  return { width: 100, height: 100, outputDirectory, artifactUrlPrefix: '/uploads/test-cairo', pageNumber: 2 };
}
async function materialize(result, outputDirectory) {
  const files = await fs.readdir(outputDirectory);
  let text = result.svgText;
  for (const file of files) {
    const bytes = await fs.readFile(path.join(outputDirectory, file));
    text = text.split(`/uploads/test-cairo/${file}`).join(`data:image/png;base64,${bytes.toString('base64')}`);
  }
  return text;
}
async function raw(text) { return sharp(Buffer.from(text)).ensureAlpha().raw().toBuffer(); }
function maxDelta(a, b) { return a.reduce((max, value, index) => Math.max(max, Math.abs(value - b[index])), 0); }

test('Cairo glyph use instances preserve real editable vectors and separate run identity', async t => {
  const outputDirectory = await directory(t);
  const source = svg(`<defs><g id="glyph-0-0"><path d="M0 0 L5 0 L5 8 L0 8 Z"/></g></defs>
    <g fill="red"><use xlink:href="#glyph-0-0" x="10" y="10"/><use xlink:href="#glyph-0-0" x="20" y="10"/></g>
    <path fill="blue" d="M50 50 L60 50 L60 60 Z"/>`);
  const result = await normalizePdfCairoSvg(source, options(outputDirectory));
  assert.equal(result.elementCount, 3);
  assert.equal(result.editableVectorCount, 3);
  assert.equal(result.editableRasterCount, 0);
  assert.equal(result.effectRasterCount, 0);
  assert.equal((result.svgText.match(/data-object-role="decoration-vector"/g) || []).length, 2);
  const clusterIds = [...result.svgText.matchAll(/data-pdf-cluster-id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(clusterIds).size, 1);
  assert.equal(maxDelta(await raw(source), await raw(result.svgText)), 0);
  assert.deepEqual(await fs.readdir(outputDirectory), []);
});

test('masked local drawing keeps ancestor opacity, transform and clip without changing the neighboring vector', async t => {
  const outputDirectory = await directory(t);
  const source = svg(`<defs>
    <mask id="m"><rect x="-100" y="-100" width="300" height="300" fill="white" opacity="0.5"/></mask>
    <clipPath id="c"><rect x="0" y="0" width="26" height="22"/></clipPath>
    </defs>
    <g transform="matrix(1.2 .1 -.1 .9 15 12)" opacity="0.6" clip-path="url(#c)">
      <g mask="url(#m)"><rect x="5" y="5" width="30" height="20" fill="red"/></g>
    </g>
    <path fill="blue" d="M70 70 L90 70 L90 90 Z"/>`);
  const result = await normalizePdfCairoSvg(source, options(outputDirectory));
  assert.equal(result.effectRasterCount, 1);
  assert.equal(result.editableRasterCount, 1);
  assert.equal(result.editableVectorCount, 1);
  assert.match(result.svgText, /data-pdf-cairo-effect="true"/);
  const normalized = await materialize(result, outputDirectory);
  const before = await raw(source), after = await raw(normalized);
  // A point inside the local shape has 0.6 * 0.5 alpha, applied exactly once.
  const pixel = (22 * 100 + 25) * 4;
  assert.ok(before[pixel + 3] >= 75 && before[pixel + 3] <= 78);
  assert.ok(Math.abs(before[pixel + 3] - after[pixel + 3]) <= 1);
  let changedPixels = 0;
  for (let i = 0; i < before.length; i += 4) if (before.slice(i, i + 4).some((value, k) => Math.abs(value - after[i + k]) > 3)) changedPixels++;
  // The original ancestor clip is applied once after the local effect is baked.
  assert.ok(changedPixels < 60, `Changed pixels: ${changedPixels}`);
  const blue = (75 * 100 + 80) * 4;
  assert.deepEqual([...after.slice(blue, blue + 4)], [...before.slice(blue, blue + 4)]);
});

async function knockoutFixture(withAlpha = false) {
  let image = sharp({ create: { width: 20, height: 20, channels: withAlpha ? 4 : 3, background: withAlpha ? { r: 255, g: 0, b: 0, alpha: 0.5 } : '#ff0000' } });
  const data = (await image.png().toBuffer()).toString('base64');
  return svg(`<defs>
    <filter id="invert" x="0%" y="0%" width="100%" height="100%"><feColorMatrix values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 -1 1"/></filter>
    <g id="coverage"><rect width="100" height="100" fill="black" opacity="0"/><rect x="30" y="40" width="20" height="20" fill="white"/></g>
    <mask id="source-mask"><use xlink:href="#coverage"/></mask>
    <mask id="destination-mask"><use xlink:href="#coverage" filter="url(#invert)"/></mask>
    <g id="source" mask="url(#source-mask)"><image width="20" height="20" x="30" y="40" xlink:href="data:image/png;base64,${data}"/></g>
    <g id="destination" mask="url(#destination-mask)"><rect width="100" height="100" fill="blue"/></g>
    <filter id="blend" x="0%" y="0%" width="100%" height="100%"><feImage xlink:href="#source" result="s" x="0" y="0" width="100" height="100"/>
    <feImage xlink:href="#destination" result="d" x="0" y="0" width="100" height="100"/>
    <feComposite in="s" in2="d" operator="arithmetic" k1="0" k2="1" k3="1" k4="0"/></filter>
    </defs><g filter="url(#blend)"><rect width="100" height="100"/></g>`);
}

test('recognized opaque knockout blend preserves separate vector background and real masked image', async t => {
  const outputDirectory = await directory(t);
  const source = await knockoutFixture();
  const result = await normalizePdfCairoSvg(source, options(outputDirectory));
  assert.equal(result.normalizedCompositeCount, 1);
  assert.equal(result.editableVectorCount, 1);
  assert.equal(result.editableRasterCount, 1);
  assert.equal(result.effectRasterCount, 1);
  assert.equal(maxDelta(await raw(source), await raw(await materialize(result, outputDirectory))), 0);
});

test('unknown arithmetic blends and transparent knockout sources fail closed', async t => {
  const outputDirectory = await directory(t);
  const opaque = await knockoutFixture();
  await assert.rejects(normalizePdfCairoSvg(opaque.replace('k2="1"', 'k2="0.5"'), options(outputDirectory)), /arithmetic/);
  await assert.rejects(normalizePdfCairoSvg(await knockoutFixture(true), options(outputDirectory)), /contains alpha/);
  await assert.rejects(normalizePdfCairoSvg(opaque.replace('width="100" height="100"/>\n    <feImage', 'width="200" height="100"/>\n    <feImage'), options(outputDirectory)), /bounds/);
  assert.deepEqual(await fs.readdir(outputDirectory), []);
});

test('external paint/image references, cyclic uses and XML entities are rejected before rendering', async t => {
  const outputDirectory = await directory(t);
  const opts = options(outputDirectory);
  for (const reference of ['fill', 'stroke', 'clip-path', 'mask', 'filter']) {
    await assert.rejects(normalizePdfCairoSvg(svg(`<rect ${reference}="url(https://example.invalid/ref)" width="20" height="20"/>`), opts), /paint reference/);
  }
  await assert.rejects(normalizePdfCairoSvg(svg('<image href="file:///etc/passwd"/>'), opts), /external image reference/);
  await assert.rejects(normalizePdfCairoSvg(svg('<defs><g id="a"><use xlink:href="#a"/></g></defs><use xlink:href="#a"/>'), opts), /cyclic/);
  await assert.rejects(normalizePdfCairoSvg('<!DOCTYPE svg [<!ENTITY secret SYSTEM "file:///etc/passwd">]>' + svg('<text>&secret;</text>'), opts), /XML declarations/);
  assert.deepEqual(await fs.readdir(outputDirectory), []);
});

test('failed normalization cleans completed artifacts and never returns a whole page image as editable content', async t => {
  const outputDirectory = await directory(t);
  const source = svg('<defs><mask id="m"><rect width="100" height="100" fill="white"/></mask></defs>'
    + '<g mask="url(#m)"><rect x="10" y="10" width="10" height="10" fill="red"/></g>'
    + '<g mask="url(#m)"><rect width="100" height="100" fill="blue"/></g>');
  await assert.rejects(normalizePdfCairoSvg(source, options(outputDirectory)), /covers the page/);
  assert.deepEqual(await fs.readdir(outputDirectory), []);
});

test('SVG pattern paint fails closed even when Sharp can render the actual pattern correctly', async t => {
  const outputDirectory = await directory(t);
  const source = svg('<defs><pattern id="tiles" width="10" height="10" patternUnits="userSpaceOnUse">'
    + '<rect width="5" height="10" fill="red"/></pattern></defs>'
    + '<rect x="10" y="10" width="40" height="40" fill="url(#tiles)"/>'
    + '<rect x="60" y="60" width="10" height="10" fill="blue"/>');
  const rendered = await raw(source);
  assert.deepEqual([...rendered.slice((20 * 100 + 11) * 4, (20 * 100 + 11) * 4 + 4)], [255, 0, 0, 255]);
  await assert.rejects(normalizePdfCairoSvg(source, options(outputDirectory)), /unsupported by the editor/);
  assert.deepEqual(await fs.readdir(outputDirectory), []);
});

test('knockout source may contain several drawings and a nested opaque filter', async t => {
  const outputDirectory = await directory(t);
  const source = (await knockoutFixture()).replace('<defs>', '<defs><filter id="identity"><feColorMatrix values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0"/></filter>')
    .replace(/<image\b[^>]*\/>/, '<g filter="url(#identity)"><rect x="30" y="40" width="10" height="20" fill="red"/><rect x="40" y="40" width="10" height="20" fill="green"/></g>');
  const result = await normalizePdfCairoSvg(source, options(outputDirectory));
  assert.equal(result.normalizedCompositeCount, 1);
  assert.equal(result.editableVectorCount, 1);
  assert.equal(result.editableRasterCount, 1);
  assert.equal(maxDelta(await raw(source), await raw(await materialize(result, outputDirectory))), 0);
});

test('knockout reconstruction retains finite filter crop outside the source and destination drawings', async t => {
  const outputDirectory = await directory(t);
  const source = (await knockoutFixture())
    .replaceAll('result="s" x="0" y="0" width="100" height="100"', 'result="s" x="20" y="20" width="50" height="50"')
    .replaceAll('result="d" x="0" y="0" width="100" height="100"', 'result="d" x="20" y="20" width="50" height="50"')
    .replace('</defs><g filter="url(#blend)"><rect width="100" height="100"/>', '</defs><g filter="url(#blend)"><rect x="20" y="20" width="50" height="50"/>');
  const result = await normalizePdfCairoSvg(source, options(outputDirectory));
  assert.equal(result.normalizedCompositeCount, 1);
  assert.equal(maxDelta(await raw(source), await raw(await materialize(result, outputDirectory))), 0);
  assert.equal((await raw(await materialize(result, outputDirectory)))[3], 0);
});

test('a page-sized original image may keep its own mask while whole-page combined drawings remain rejected', async t => {
  const outputDirectory = await directory(t);
  const data = (await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ff0000' } }).png().toBuffer()).toString('base64');
  const source = svg('<defs><mask id="m"><rect width="100" height="100" fill="white" opacity="0.5"/></mask>'
    + `<image id="original" width="100" height="100" href="data:image/png;base64,${data}"/></defs>`
    + '<g mask="url(#m)"><use href="#original"/></g><path fill="blue" d="M10 10 L20 10 L20 20 Z"/>');
  const result = await normalizePdfCairoSvg(source, options(outputDirectory));
  assert.equal(result.editableVectorCount, 1);
  assert.equal(result.editableRasterCount, 1);
  assert.equal(maxDelta(await raw(source), await raw(await materialize(result, outputDirectory))), 0);
  await assert.rejects(normalizePdfCairoSvg(source.replace('<use href="#original"/>', '<use href="#original"/><rect x="10" y="10" width="10" height="10"/>'), options(outputDirectory)), /covers the page/);
  const filtered = source.replace('<defs>', '<defs><g id="paint"><rect width="100" height="100" fill="red"/><rect x="10" y="10" width="10" height="10" fill="blue"/></g>'
    + '<filter id="paint-filter" x="0%" y="0%" width="100%" height="100%"><feImage href="#paint" x="0" y="0" width="100" height="100"/></filter>')
    .replace('<g mask="url(#m)">', '<g filter="url(#paint-filter)">');
  assert.equal((await raw(filtered))[(50 * 100 + 50) * 4 + 3], 255);
  await assert.rejects(normalizePdfCairoSvg(filtered, options(outputDirectory)), /covers the page/);
});

test('compositing alpha proof rejects white-on-white transparency and cyclic feImage references', async t => {
  const outputDirectory = await directory(t);
  const white = (await knockoutFixture(true)).replace(/<image\b[^>]*\/>/, '<rect x="30" y="40" width="20" height="20" fill="white" opacity="0.5"/>').replace('fill="blue"', 'fill="white"');
  await assert.rejects(normalizePdfCairoSvg(white, options(outputDirectory)), /contains alpha/);
  const cyclic = svg('<defs><filter id="f"><feImage href="#loop"/></filter><g id="loop" filter="url(#f)"><rect width="20" height="20"/></g></defs><use href="#loop"/>');
  await assert.rejects(normalizePdfCairoSvg(cyclic, options(outputDirectory)), /cyclic.*reference graph/);
});

test('nonopaque group compositing fails closed after direct or referenced drawings are expanded', async t => {
  const outputDirectory = await directory(t);
  const drawings = '<rect width="80" height="80" fill="blue"/><rect x="20" y="20" width="80" height="80" fill="red"/>';
  const source = svg(`<g opacity="0.5">${drawings}</g>`);
  const pixel = (50 * 100 + 50) * 4;
  assert.deepEqual([...(await raw(source)).slice(pixel, pixel+4)], [255,0,0,128]);
  await assert.rejects(normalizePdfCairoSvg(source, options(outputDirectory)), /group opacity/);
  const referenced = svg(`<defs><g id="paint">${drawings}</g></defs><g opacity="0.5"><use href="#paint"/></g>`);
  await assert.rejects(normalizePdfCairoSvg(referenced, options(outputDirectory)), /group opacity/);
  const perPaint = svg('<rect width="80" height="80" fill="blue" fill-opacity="0.5"/><rect x="20" y="20" width="80" height="80" fill="red" fill-opacity="0.5"/>');
  const result = await normalizePdfCairoSvg(perPaint, options(outputDirectory));
  assert.equal(result.editableVectorCount,2);
  assert.equal(result.visualDiffRatioToOriginal,0);
  assert.equal(maxDelta(await raw(perPaint),await raw(result.svgText)),0);
  assert.deepEqual(await fs.readdir(outputDirectory),[]);
});

const unsupportedPaintFixtures = [
  ['repeated gradient spread', '<defs><linearGradient id="g" spreadMethod="repeat"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect width="60" height="60" fill="url(#g)"/><rect x="70" width="20" height="20"/>', /gradient spread/],
  ['reflected gradient spread', '<defs><linearGradient id="g" spreadMethod="reflect"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect width="60" height="60" fill="url(#g)"/><rect x="70" width="20" height="20"/>', /gradient spread/],
  ['object bounding box clip units', '<defs><clipPath id="c" clipPathUnits="objectBoundingBox"><rect width=".5" height=".5"/></clipPath></defs><rect width="60" height="60" fill="red" clip-path="url(#c)"/><rect x="70" width="20" height="20"/>', /clip units/],
  ['hidden visibility', '<rect width="60" height="60" fill="red" visibility="hidden"/><rect x="70" width="20" height="20"/>', /visibility/],
  ['collapsed visibility', '<rect width="60" height="60" fill="red" visibility="collapse"/><rect x="70" width="20" height="20"/>', /visibility/],
  ['inherited gradient fill opacity', '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><g fill-opacity="0.5"><rect width="60" height="60" fill="url(#g)"/></g><rect x="70" width="20" height="20"/>', /paint opacity/],
  ['inherited gradient stroke opacity', '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><g stroke-opacity="0.5"><path d="M10 10L50 50" stroke="url(#g)" stroke-width="10"/></g><rect x="70" width="20" height="20"/>', /paint opacity/],
  ['nonfinite inherited paint opacity', '<g fill-opacity="NaN"><rect width="60" height="60"/></g><rect x="70" width="20" height="20"/>', /paint opacity/],
  ['radial focal radius', '<defs><radialGradient id="g" fr="0.25"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></radialGradient></defs><rect width="60" height="60" fill="url(#g)"/><rect x="70" width="20" height="20"/>', /focal radius/],
];
for (const [label, body, error] of unsupportedPaintFixtures) {
  test(`unsupported consumer paint fails closed: ${label}`, async t => {
    const outputDirectory=await directory(t);
    await assert.rejects(normalizePdfCairoSvg(svg(body),options(outputDirectory)),error);
    assert.deepEqual(await fs.readdir(outputDirectory),[]);
  });
}

test('default supported gradient, user-space clip, visible paint and opaque inheritance remain accepted', async t => {
  const outputDirectory=await directory(t);
  const source=svg('<defs><linearGradient id="g" spreadMethod="pad"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>'
    + '<clipPath id="c" clipPathUnits="userSpaceOnUse"><rect x="10" y="10" width="40" height="40"/></clipPath>'
    + '<radialGradient id="r" fr="0"><stop offset="0" stop-color="white"/><stop offset="1" stop-color="black"/></radialGradient></defs>'
    + '<g fill-opacity="1" stroke-opacity="1" visibility="visible"><rect width="60" height="60" fill="url(#g)" clip-path="url(#c)"/><rect x="70" width="20" height="20" fill="url(#r)"/></g>');
  const result=await normalizePdfCairoSvg(source,options(outputDirectory));
  assert.equal(result.elementCount,2);assert.equal(result.visualDiffRatioToOriginal,0);
  assert.equal(maxDelta(await raw(source),await raw(result.svgText)),0);
});

test('evenodd compound clips fail closed while nonzero clips and neighboring vectors remain supported', async t => {
  const outputDirectory = await directory(t);
  const source = svg('<defs><clipPath id="clip"><path clip-rule="evenodd" d="M10 10H90V90H10Z M30 30H70V70H30Z"/></clipPath></defs>'
    + '<rect width="100" height="100" fill="red" clip-path="url(#clip)"/><rect x="92" y="60" width="5" height="5" fill="blue"/>');
  const center = (50 * 100 + 50) * 4;
  assert.equal((await raw(source))[center+3],0);
  await assert.rejects(normalizePdfCairoSvg(source,options(outputDirectory)),/clip rules/);
  const nonzero = source.replace('clip-rule="evenodd"','clip-rule="nonzero"');
  const result = await normalizePdfCairoSvg(nonzero,options(outputDirectory));
  assert.equal(result.elementCount,2);
  assert.equal(result.visualDiffRatioToOriginal,0);
  assert.deepEqual([...(await raw(result.svgText)).slice(center,center+4)],[255,0,0,255]);
  assert.equal(maxDelta(await raw(nonzero),await raw(result.svgText)),0);
});

test('baked white effects retain their actual alpha instead of only matching a white background', async t => {
  const outputDirectory = await directory(t);
  const source = svg('<defs><mask id="m"><rect width="100" height="100" fill="white" opacity="0.5"/></mask></defs>'
    + '<g mask="url(#m)"><rect x="10" y="10" width="20" height="20" fill="white"/></g>'
    + '<path fill="blue" d="M60 60 L70 60 L70 70 Z"/>');
  const result = await normalizePdfCairoSvg(source,options(outputDirectory));
  const before=await raw(source),after=await raw(await materialize(result,outputDirectory));
  const inside=(20*100+20)*4,outside=(5*100+5)*4;
  assert.equal(before[inside+3],128);assert.equal(after[inside+3],128);
  assert.equal(before[outside+3],0);assert.equal(after[outside+3],0);
  assert.equal(result.visualDiffRatioToOriginal,0);
  assert.equal(maxDelta(before,after),0);
});


test('AI Cairo ArtBox crop preserves object offsets and the canvas boundary', async t => {
  const outputDirectory = await directory(t);
  const source = svg('<rect x="20" y="10" width="20" height="20" fill="red"/><rect x="70" y="70" width="10" height="10" fill="blue"/>');
  const result = await normalizePdfCairoSvg(source, { ...options(outputDirectory), width: 100, height: 100,
    sourceCrop: { left: 10, top: 5, width: 50, height: 50, pageWidth: 100, pageHeight: 100 } });
  const text = await materialize(result, outputDirectory);
  assert.equal(result.elementCount, 2);
  assert.ok(result.visualDiffRatioToOriginal <= .005);
  const { data, info } = await sharp(Buffer.from(text)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel=(x,y)=>Array.from(data.subarray((y*info.width+x)*4,(y*info.width+x)*4+4));
  assert.deepEqual(pixel(25,15),[255,0,0,255]);
  assert.equal(pixel(5,5)[3],0);
  assert.equal(pixel(95,95)[3],0);
  assert.match(text,/clipPathUnits="userSpaceOnUse"/);
  assert.match(text,/clip-path="url\(#ai-artbox-/);
  await assert.rejects(normalizePdfCairoSvg(source,{...options(outputDirectory),sourceCrop:{left:10,top:5,width:50,height:50,pageWidth:120,pageHeight:100}}),/source bounds/);
});


test('AI whose source is one original image stays one editable image, without weakening vector recovery', async t => {
  const outputDirectory=await directory(t);
  const png=await sharp({create:{width:8,height:8,channels:4,background:'red'}}).png().toBuffer();
  const source=svg(`<image width="100" height="100" href="data:image/png;base64,${png.toString('base64')}"/>`);
  await assert.rejects(normalizePdfCairoSvg(source,options(outputDirectory)),/independent faithful objects/);
  const result=await normalizePdfCairoSvg(source,{...options(outputDirectory),allowSingleSourceImage:true});
  assert.equal(result.elementCount,1);assert.equal(result.editableRasterCount,1);assert.equal(result.sourceImageOnly,true);
  assert.match(result.svgText,/data-object-role="editable-raster"/);assert.equal(result.visualDiffRatioToOriginal,0);
  const vectorOnly=svg('<rect width="20" height="20" fill="blue"/>');
  await assert.rejects(normalizePdfCairoSvg(vectorOnly,{...options(outputDirectory),allowSingleSourceImage:true}),/independent faithful objects/);
});
