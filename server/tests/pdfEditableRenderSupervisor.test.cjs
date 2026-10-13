const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { renderPdfEditableIsolated } = require('../dist/services/parser/pdfEditableRenderSupervisor');

const workerPath = path.join(__dirname, 'fixtures/pdf-editable-render-worker.cjs');
async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'benlai-pdf-stage-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, png: path.join(directory, 'page.png'), svg: path.join(directory, 'page.svg') };
}
function render(paths, mode, timeoutMs = 1000) {
  return renderPdfEditableIsolated(mode, paths.png, paths.svg, 1, {}, { workerPath, timeoutMs });
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

test('native rendering that blocks child timers is killed before fallback and does not block its parent', async t => {
  const paths = await setup(t);
  let heartbeats = 0;
  const heartbeat = setInterval(() => heartbeats++, 25);
  t.after(() => clearInterval(heartbeat));
  await assert.rejects(render(paths, 'native-busy'), /timed out/);
  const pid = Number(await fs.readFile(paths.svg + '.pid', 'utf8'));
  assert.equal(alive(pid), false);
  assert.ok(heartbeats > 5, 'The stage supervisor event loop must remain responsive');
  assert.equal((await render(paths, 'success')).svgElementCount, 1);
  assert.equal((await fs.readdir(paths.directory)).some(name => name.includes('.render-')), false);
});

test('a result notification does not bypass the stage exit deadline', async t => {
  const paths = await setup(t);
  await assert.rejects(render(paths, 'result-then-hang'), /timed out/);
  const pid = Number(await fs.readFile(paths.svg + '.pid', 'utf8'));
  assert.equal(alive(pid), false);
});

test('stage errors and malformed results reject rather than producing editable success', async t => {
  const paths = await setup(t);
  await assert.rejects(render(paths, 'error'), /fixture rendering failed/);
  await assert.rejects(render(paths, 'invalid'), /invalid result/);
  assert.equal((await render(paths, 'success')).width, 1600);
});

function smallPdf(cropBox = '') {
  const content = '0.2 0.6 0.3 rg 20 20 150 100 re f\nBT /F1 18 Tf 25 160 Td (Hello trusted preview) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ${cropBox} /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(source)); source += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return source;
}

test('real PDF rendering rejects missing or misaligned trusted previews and keeps the original path usable', async t => {
  const paths = await setup(t);
  const sourcePath = path.join(paths.directory, 'small.pdf');
  await fs.writeFile(sourcePath, smallPdf());
  await assert.rejects(renderPdfEditableIsolated(sourcePath, paths.png, paths.svg, 1,
    { trustedPreviewPath: path.join(paths.directory, 'missing.png') }, { timeoutMs: 10_000 }), /load|file|read|missing/i);
  const { createCanvas } = require('@napi-rs/canvas');
  const invalidPreviewPath = path.join(paths.directory, 'misaligned.png');
  await fs.writeFile(invalidPreviewPath, createCanvas(10, 200).toBuffer('image/png'));
  await assert.rejects(renderPdfEditableIsolated(sourcePath, paths.png, paths.svg, 1,
    { trustedPreviewPath: invalidPreviewPath }, { timeoutMs: 10_000 }), /aspect ratio/);
  const baseline = await renderPdfEditableIsolated(sourcePath, paths.png, paths.svg, 1, {}, { timeoutMs: 10_000 });
  assert.ok(baseline.svgElementCount > 0);
  assert.ok(baseline.textLayers.some(layer => layer.text.includes('Hello trusted')));
  const trustedResult = await renderPdfEditableIsolated(sourcePath, path.join(paths.directory, 'trusted.png'),
    path.join(paths.directory, 'trusted.svg'), 1, { trustedPreviewPath: paths.png }, { timeoutMs: 10_000 });
  assert.equal(trustedResult.svgElementCount, baseline.svgElementCount);
  assert.equal(trustedResult.width, baseline.width);
  assert.ok(trustedResult.textLayers.some(layer => layer.text.includes('Hello trusted')));
  assert.ok(trustedResult.svgVisualDiffRatio < 0.05);
});

test('a same-aspect CropBox uses the same cropped page in Poppler and PDF.js', async t => {
  const paths = await setup(t);
  const binary = process.env.PDFTOPPM_PATH || process.env.POPPLER_PDFTOPPM_PATH || 'pdftoppm';
  try { await promisify(execFile)(binary, ['-v'], { timeout: 5000 }); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('Poppler is unavailable'); throw error; }
  const sourcePath = path.join(paths.directory, 'cropped.pdf');
  await fs.writeFile(sourcePath, smallPdf('/CropBox [50 50 150 150]'));
  const previewPrefix = path.join(paths.directory, 'cropped-preview');
  await promisify(execFile)(binary, ['-f', '1', '-singlefile', '-cropbox', '-png', '-r', '150', sourcePath, previewPrefix], { timeout: 10_000 });
  const previewPath = previewPrefix + '.png';
  const sharp = require('sharp');
  const preview = await sharp(previewPath).metadata();
  assert.ok(preview.width >= 208 && preview.width <= 210, 'Poppler must render the 100-point CropBox, not the 200-point MediaBox');
  const baseline = await renderPdfEditableIsolated(sourcePath, paths.png, paths.svg, 1, {}, { timeoutMs: 10_000 });
  const trustedPng = path.join(paths.directory, 'trusted-crop.png');
  const trusted = await renderPdfEditableIsolated(sourcePath, trustedPng, path.join(paths.directory, 'trusted-crop.svg'), 1,
    { trustedPreviewPath: previewPath }, { timeoutMs: 10_000 });
  assert.equal(trusted.width, 200);
  assert.equal(trusted.height, 200);
  assert.equal(trusted.width, baseline.width);
  const actualPixels = await sharp(trustedPng).raw().toBuffer();
  const expectedPixels = await sharp(paths.png).raw().toBuffer();
  const meanDifference = actualPixels.reduce((sum, value, index) => sum + Math.abs(value - expectedPixels[index]), 0) / actualPixels.length;
  assert.ok(meanDifference < 2, 'The full source image must not be scaled into the smaller CropBox');
});
