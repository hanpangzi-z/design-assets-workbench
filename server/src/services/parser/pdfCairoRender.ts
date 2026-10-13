import fs from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { normalizePdfCairoSvg, type PdfCairoSvgOptions } from './pdfCairoSvg';

export interface PdfCairoRenderResult {
  svgElementCount: number;
  svgRasterImageCount: number;
  svgVisualDiffRatio: number;
  svgFidelityMethod: 'cairo-source';
  svgSourceVisualDiffRatio: number;
  sourceImageOnly?: true;
}

/** The preview comparison is a cross-renderer diagnostic for Cairo exports.
 * Cairo source fidelity compares the original PDF drawing export with its
 * editor-compatible normalization, under the stricter 0.5% source gate.
 * Other SVG extraction methods retain the existing preview-based 5% gate.
 */
export function pdfSvgNeedsVisualBacking(page: {
  svgVisualReliable?: boolean; svgVisualDiffRatio?: number;
  svgFidelityMethod?: string; svgSourceVisualDiffRatio?: number;
  svgElementCount?: number; sourceImageOnly?: boolean;
}): boolean {
  if (page.svgVisualReliable === false) return true;
  if (page.svgFidelityMethod === 'cairo-source') {
    return !(typeof page.svgSourceVisualDiffRatio === 'number'
      && Number.isFinite(page.svgSourceVisualDiffRatio)
      && page.svgSourceVisualDiffRatio >= 0 && page.svgSourceVisualDiffRatio <= 0.005
      && typeof page.svgVisualDiffRatio === 'number' && Number.isFinite(page.svgVisualDiffRatio)
      && page.svgVisualDiffRatio >= 0 && page.svgVisualDiffRatio <= 1
      && typeof page.svgElementCount === 'number' && Number.isInteger(page.svgElementCount) && page.svgElementCount >= (page.sourceImageOnly === true ? 1 : 2));
  }
  return typeof page.svgVisualDiffRatio === 'number'
    && (!Number.isFinite(page.svgVisualDiffRatio) || page.svgVisualDiffRatio > 0.05);
}

function cairoBinary(): string {
  const explicit = process.env.PDFTOCAIRO_PATH;
  if (explicit) return explicit;
  const ppm = process.env.PDFTOPPM_PATH || process.env.POPPLER_PDFTOPPM_PATH;
  if (ppm && path.isAbsolute(ppm)) return path.join(path.dirname(ppm), process.platform === 'win32' ? 'pdftocairo.exe' : 'pdftocairo');
  if (process.platform === 'win32' && process.env.USERPROFILE) {
    return path.join(process.env.USERPROFILE, '.cache', 'codex-runtimes', 'codex-primary-runtime',
      'dependencies', 'native', 'poppler', 'Library', 'bin', 'pdftocairo.exe');
  }
  return 'pdftocairo';
}

export async function renderPdfCairoEditable(input: {
  filePath: string; outSvgPath: string; previewPath: string;
  width: number; height: number; pageNumber: number; artifactUrlPrefix: string;
  sourceCrop?: PdfCairoSvgOptions['sourceCrop'];
  allowSingleSourceImage?: boolean;
}): Promise<PdfCairoRenderResult> {
  const { width, height, pageNumber } = input;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || width * height > 32_000_000 || !Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new Error('Invalid Cairo PDF page bounds');
  }
  const rawPath = input.outSvgPath + '.cairo-' + randomUUID() + '.svg';
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(cairoBinary(), ['-svg', '-f', String(pageNumber), '-l', String(pageNumber),
        input.filePath, rawPath], { timeout: 15_000, killSignal: 'SIGKILL', windowsHide: true },
      (error) => error ? reject(error) : resolve());
    });
    const stat = await fs.stat(rawPath);
    if (stat.size > 50_000_000) throw new Error('Cairo PDF SVG exceeds the extraction limit');
    const result = await normalizePdfCairoSvg(await fs.readFile(rawPath, 'utf8'), {
      width, height, outputDirectory: path.dirname(input.outSvgPath),
      artifactUrlPrefix: input.artifactUrlPrefix, pageNumber, sourceCrop: input.sourceCrop, allowSingleSourceImage: input.allowSingleSourceImage,
    });
    if (result.elementCount < (result.sourceImageOnly ? 1 : 2)) throw new Error('Cairo PDF did not recover independently editable elements');
    const sharp = require('sharp');
    // Raster effects use local artifact files only while validating. Published SVG
    // retains upload URLs so the same independent elements survive editor saves.
    const localSvg = result.svgText.replace(/\b(href|xlink:href)=(["'])(.*?)\2/g,
      (attribute: string, name: string, quote: string, href: string) => {
        if (!href.startsWith(input.artifactUrlPrefix + '/')) return attribute;
        const filename = href.slice(input.artifactUrlPrefix.length + 1);
        if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
          throw new Error('Unexpected Cairo PDF artifact path');
        }
        const data = readFileSync(path.join(path.dirname(input.outSvgPath), filename));
        return `${name}=${quote}data:image/png;base64,${data.toString('base64')}${quote}`;
      });
    const [reference, rendered] = await Promise.all([
      sharp(input.previewPath).resize(width, height, { fit: 'fill' }).flatten({ background: '#fff' }).ensureAlpha().raw().toBuffer(),
      sharp(Buffer.from(localSvg), { unlimited: true, limitInputPixels: 32_000_000 }).resize(width, height, { fit: 'fill' }).flatten({ background: '#fff' }).ensureAlpha().raw().toBuffer(),
    ]);
    let different = 0;
    for (let i = 0; i < reference.length; i += 4) {
      if (Math.abs(reference[i] - rendered[i]) + Math.abs(reference[i + 1] - rendered[i + 1])
        + Math.abs(reference[i + 2] - rendered[i + 2]) > 24) different++;
    }
    const ratio = different / (width * height);
    if (!Number.isFinite(ratio)) throw new Error('Invalid Cairo PDF preview comparison');
    // pdftocairo exports the original PDF drawing graph directly. Different
    // raster backends sample fine textures and antialiased edges differently;
    // the preview ratio must stay truthful, but cannot determine whether the
    // normalized source graph retained its objects. The normalizer validates
    // reference/paint support and compositing against that original graph.
    if (!Number.isFinite(result.visualDiffRatioToOriginal)
      || result.visualDiffRatioToOriginal > 0.005) throw new Error('Cairo PDF normalization differs from its source drawing');
    await fs.writeFile(input.outSvgPath, result.svgText, 'utf8');
    return { svgElementCount: result.elementCount, svgRasterImageCount: result.rasterImageCount,
      svgVisualDiffRatio: ratio, svgFidelityMethod: 'cairo-source',
      svgSourceVisualDiffRatio: result.visualDiffRatioToOriginal, ...(result.sourceImageOnly ? { sourceImageOnly: true as const } : {}) };
  } finally {
    await fs.rm(rawPath, { force: true }).catch(() => undefined);
  }
}
