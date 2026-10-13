import { execFile, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DesignFile } from '../../models';
import { STORAGE } from '../../config/storage';
import { logger } from '../../utils/logger';
import { warmUploadThumbnailVariants } from '../uploadThumbnailVariants';
import { resolveParserFilePath } from './resolveParserFilePath';
import { ParserLayerStore as ParsedLayer, getParserLayerTransaction, isIsolatedParser, updateParserFile,
  getParserArtifactDirectory, getParserOutputDirectory, getParserThumbnailPath } from './parserExecution';
import { AI_PARSER_VERSION } from './parserVersions';
import { renderPdfCairoEditable } from './pdfCairoRender';
export { AI_PARSER_VERSION } from './parserVersions';
import {
  resolveClientParseAssistSnapshot,
  writeClientAssistPreviewToPath,
  type ClientParseAssistSnapshot,
} from './clientParseAssist';
import {
  countSvgObjectRoleStats,
  isHiddenSvgObjectRole,
  type SvgObjectRole,
  type SvgRoleStats,
} from './svgRoles';

const ENABLE_AI_INKSCAPE_PARSE = ['1', 'true', 'yes'].includes(String(process.env.ENABLE_AI_INKSCAPE_PARSE || '').toLowerCase());
const INKSCAPE_CHECK_TIMEOUT_MS = 10_000;
const INKSCAPE_CONVERSION_TIMEOUT_MS = 15_000;
const PDFJS_OPERATOR_SVG_TIMEOUT_MS = 45_000;
const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];

let inkscapeAvailable: boolean | null = null;
const activeInkscapeProcs = new Set<ChildProcess>();

type Matrix = [number, number, number, number, number, number];

export interface PdfTextLayer {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fillColor: string;
  fontName?: string;
  source?: 'pdfjs' | 'svg-glyph' | 'client-assist' | 'encoded-repair';
  confidence?: number;
  textPathGlyphIds?: string[];
  textPathBounds?: SvgBounds;
  writingMode?: 'horizontal-tb' | 'vertical-rl';
  textMatrix?: number[];
  rotation?: number;
}

export interface PdfTextGlyphPath {
  id: string;
  text: string;
  bounds: SvgBounds;
  textRunId?: string;
  glyphIndex?: number;
  writingMode?: 'horizontal-tb' | 'vertical-rl';
  textMatrix?: number[];
  rotation?: number;
}

export interface PdfEditableRenderResult {
  width: number;
  height: number;
  textLayers: PdfTextLayer[];
  svgElementCount: number;
  svgRasterImageCount?: number;
  textGlyphCount?: number;
  textPathCount?: number;
  textMissingGlyphCount?: number;
  textPathGlyphs?: PdfTextGlyphPath[];
  pageNumber: number;
  svgWarning?: string;
  svgVisualDiffRatio?: number;
  svgVisualReliable?: boolean;
  svgFidelityMethod?: 'cairo-source';
  svgSourceVisualDiffRatio?: number;
  sourceImageOnly?: true;
  svgOmitsFullPageRaster?: boolean;
  redundantClipPathCount?: number;
  textlessPngPath?: string;
}

export interface PdfEditableRenderOptions {
  allowSvgFallback?: boolean;
  operatorSvgTimeoutMs?: number;
  pageBox?: 'default' | 'artBox';
  trustedPreviewPath?: string;
}

interface PdfRenderPageBox {
  width: number;
  height: number;
  cropLeft: number;
  cropTop: number;
  initialCtm: Matrix;
  source: 'default' | 'ArtBox';
}

interface PdfImageData {
  width: number;
  height: number;
  kind?: number;
  data?: Uint8ClampedArray | Uint8Array;
}

interface SvgRasterImage {
  href: string;
  pngBuffer?: Buffer;
  x: number;
  y: number;
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  nonWhiteRatio: number;
  sparseMask: boolean;
  transform?: Matrix;
  clipApplied?: boolean;
  visibleBounds?: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  };
}

interface SvgState {
  ctm: Matrix;
  fillColor: string;
  strokeColor: string;
  fillUsesPattern?: boolean;
  strokeUsesPattern?: boolean;
  lineWidth: number;
  currentPath: string;
  clipBounds?: SvgBounds | null;
  clipPath?: SvgClipPath | null;
  text: SvgTextState;
}

interface SvgTextState {
  fontName: string | null;
  font: any | null;
  fontSize: number;
  fontDirection: number;
  fontMatrix: Matrix;
  textMatrix: Matrix;
  textMatrixScale: number;
  x: number;
  y: number;
  lineX: number;
  lineY: number;
  leading: number;
  charSpacing: number;
  wordSpacing: number;
  textHScale: number;
  textRise: number;
  textRenderingMode: number;
}

interface SvgBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface SvgClipPath {
  pathData: string;
  matrix: Matrix;
  bounds: SvgBounds;
  source?: 'path' | 'text' | 'fill';
}

interface SourceCanvasSnapshot {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

interface SvgRgbColor {
  r: number;
  g: number;
  b: number;
}

interface PdfOperatorSvgResult {
  elementCount: number;
  rasterImageCount: number;
  omittedFullPageRaster: boolean;
  textGlyphCount: number;
  textPathCount: number;
  textMissingGlyphCount: number;
  textPathGlyphs: PdfTextGlyphPath[];
  redundantClipPathCount: number;
}

interface SvgRasterElementInfo {
  index: number;
  element: string;
  href: string;
  filePath: string | null;
  bounds: SvgBounds;
}

interface SvgPathElementInfo {
  index: number;
  element: string;
  pathData: string;
  fill: string;
  stroke: string;
  transform: Matrix;
  bounds: SvgBounds;
  commandCount: number;
  hasCurve: boolean;
}

interface SvgRasterArtifactStats {
  maskLike: boolean;
  contentLike: boolean;
  visiblePixels: number;
  monochromeRatio: number;
  saturatedRatio: number;
  darkRatio: number;
  lightRatio: number;
  midRatio: number;
  darkComponentDensity: number;
  transitionRatio: number;
}

interface SvgRasterRoleClassification {
  role: SvgObjectRole;
  artifactReason?: string;
}

interface DecorationRasterCleanTarget {
  raster: SvgRasterElementInfo;
  paths: SvgPathElementInfo[];
  clusterBounds: SvgBounds;
  clusterId?: string;
}

interface DecorationRasterCleanResult {
  element: string;
  visualElement?: string;
}

interface DecorationVectorCluster {
  id: string;
  bounds: SvgBounds;
  count: number;
}

function ensureTrailingSeparator(value: string): string {
  return value.endsWith(path.sep) || value.endsWith('/') ? value : `${value}${path.sep}`;
}

function getPdfjsAssetDir(dirname: 'cmaps' | 'standard_fonts'): string | undefined {
  try {
    return ensureTrailingSeparator(path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), dirname));
  } catch {
    return undefined;
  }
}

export function getPdfjsDocumentOptions(data: Uint8Array, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const cMapUrl = getPdfjsAssetDir('cmaps');
  const standardFontDataUrl = getPdfjsAssetDir('standard_fonts');
  return {
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: 0,
    ...(cMapUrl ? { cMapUrl, cMapPacked: true } : {}),
    ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
    ...overrides,
  };
}

function createInkscapeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.DISPLAY;
  return env;
}

function execInkscape(args: string[], timeout = INKSCAPE_CONVERSION_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile('inkscape', args, {
      timeout,
      killSignal: 'SIGKILL',
      env: createInkscapeEnv(),
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      activeInkscapeProcs.delete(child);
      if (err) reject(err);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    activeInkscapeProcs.add(child);
  });
}

function killActiveInkscape() {
  for (const proc of activeInkscapeProcs) {
    try { proc.kill('SIGKILL'); } catch {}
  }
  activeInkscapeProcs.clear();
}

process.on('SIGINT', killActiveInkscape);
process.on('SIGTERM', killActiveInkscape);
process.on('exit', killActiveInkscape);

export async function checkInkscape(): Promise<boolean> {
  if (inkscapeAvailable !== null) return inkscapeAvailable;
  try {
    // 清掉 DISPLAY 避免 inkscape 试图连 X server；加 timeout 防探测命令卡死
    await execInkscape(['--version'], INKSCAPE_CHECK_TIMEOUT_MS);
    inkscapeAvailable = true;
  } catch {
    inkscapeAvailable = false;
  }
  return inkscapeAvailable;
}

export interface SvgInfo {
  width: number;
  height: number;
  elementCount: number;
}

export interface PdfPageInfo {
  pageNumber: number;
  width: number;
  height: number;
  view?: number[];
}

export function readSvgInfo(svgPath: string, fallbackWidth = 1080, fallbackHeight = 1080): SvgInfo {
  const svg = fs.readFileSync(svgPath, 'utf8');
  const viewBoxMatch = /\bviewBox=["']\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*["']/i.exec(svg);
  const widthAttr = /\bwidth=["']([^"']+)["']/i.exec(svg)?.[1];
  const heightAttr = /\bheight=["']([^"']+)["']/i.exec(svg)?.[1];
  const viewBoxWidth = viewBoxMatch ? parseFloat(viewBoxMatch[3]) : undefined;
  const viewBoxHeight = viewBoxMatch ? parseFloat(viewBoxMatch[4]) : undefined;
  const width = Math.round(viewBoxWidth || parseSvgLength(widthAttr) || fallbackWidth);
  const height = Math.round(viewBoxHeight || parseSvgLength(heightAttr) || fallbackHeight);
  return {
    width: Math.max(1, width),
    height: Math.max(1, height),
    elementCount: countSvgRenderableElements(svg),
  };
}

export async function getPdfPageInfos(filePath: string): Promise<PdfPageInfo[]> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjsLib.getDocument(getPdfjsDocumentOptions(data)).promise;
  const pages: PdfPageInfo[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    pages.push({
      pageNumber,
      width: viewport.width,
      height: viewport.height,
      view: Array.from(page.view).map(Number),
    });
  }
  await doc.destroy();
  return pages;
}

function countSvgRenderableElements(svg: string): number {
  let count = 0;
  const tagPattern = /<(path|rect|circle|ellipse|line|polyline|polygon|text|image)\b[^>]*>/gi;
  for (const match of svg.matchAll(tagPattern)) {
    const tag = match[0] || '';
    if (/\bdisplay=["']none["']/i.test(tag)) continue;
    const role = readSvgElementAttr(tag, 'data-object-role');
    if (role === 'mask-artifact' || role === 'raster-reconstruction-strip' || role === 'visual-raster' || role === 'preview-fallback') {
      continue;
    }
    count++;
  }
  return count;
}

function parseSvgLength(value?: string): number | undefined {
  if (!value) return undefined;
  const match = /^\s*([\d.]+)\s*(px|pt|mm|cm|in)?\s*$/i.exec(value);
  if (!match) return undefined;
  const raw = Number(match[1]);
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  const unit = (match[2] || 'px').toLowerCase();
  if (unit === 'pt') return raw * (96 / 72);
  if (unit === 'mm') return raw * (96 / 25.4);
  if (unit === 'cm') return raw * (96 / 2.54);
  if (unit === 'in') return raw * 96;
  return raw;
}

export async function renderWithPdfjs(
  filePath: string,
  outPngPath: string,
  outSvgPath: string,
  pageNumber = 1,
  options: PdfEditableRenderOptions = {}
): Promise<PdfEditableRenderResult> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const canvasLib = await import('@napi-rs/canvas');

  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjsLib.getDocument(getPdfjsDocumentOptions(data)).promise;
  try {
    const page = await doc.getPage(pageNumber);

    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 1600 / baseViewport.width);
    const viewport = page.getViewport({ scale });
    const fullWidth = Math.floor(viewport.width);
    const fullHeight = Math.floor(viewport.height);
    const pageBox = resolvePdfRenderPageBox(filePath, page as any, pageNumber, scale, fullWidth, fullHeight, options.pageBox || 'default');
    const width = pageBox.width;
    const height = pageBox.height;

    const opList = await page.getOperatorList();
    const textColors = collectTextColors(pdfjsLib.OPS as Record<string, number>, opList);

    const textContent = await (page as any).getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
    let textColorIndex = 0;
    const textLayers = normalizePdfTextLayers(cropPdfTextLayersToPageBox((textContent.items as any[])
      .filter((item) => typeof item.str === 'string' && item.str.trim())
      .map((item) => {
        const tx = (pdfjsLib as any).Util.transform(viewport.transform, item.transform);
        const fontSize = Math.max(Math.abs(tx[3]) || Math.abs(item.height * scale) || 12, 1);
        const fillColor = textColors[textColorIndex++] || '#141413';
        const writingMode = item.dir === 'ttb' ? 'vertical-rl' : 'horizontal-tb';
        const itemWidth = Math.max(Math.round((item.width || 0) * scale), 1);
        const itemHeight = Math.max(Math.round((item.height || 0) * scale), 1);
        const width = writingMode === 'vertical-rl'
          ? Math.max(Math.round(fontSize * 1.15), itemWidth)
          : Math.max(itemWidth, Math.round(fontSize * item.str.length * 0.5), 1);
        const height = writingMode === 'vertical-rl'
          ? Math.max(itemHeight, Math.round(fontSize * item.str.length * 1.05), 1)
          : Math.max(Math.round(fontSize), 1);
        const y = writingMode === 'vertical-rl'
          ? Math.round(tx[5])
          : Math.round(tx[5] - height);
        return {
          text: item.str,
          x: Math.round(tx[4]),
          y,
          width,
          height,
          fontSize: Math.round(fontSize),
          fillColor,
          fontName: item.fontName,
          writingMode,
          textMatrix: Array.isArray(tx) ? tx.map((value: unknown) => Number(value) || 0) : undefined,
          rotation: matrixRotationDegrees(tx),
        };
      }), pageBox));

    const fullCanvas = canvasLib.createCanvas(fullWidth, fullHeight);
    const fullCtx = fullCanvas.getContext('2d');

    if (options.trustedPreviewPath) {
      const preview = await canvasLib.loadImage(await fs.promises.readFile(options.trustedPreviewPath));
      if (!preview.width || !preview.height) throw new Error('Trusted PDF preview has no image dimensions');
      const aspectDifference = Math.abs(preview.width / preview.height - fullWidth / fullHeight) / (fullWidth / fullHeight);
      if (aspectDifference > 0.01) throw new Error('Trusted PDF preview does not match the PDF page aspect ratio');
      fullCtx.fillStyle = '#ffffff';
      fullCtx.fillRect(0, 0, fullWidth, fullHeight);
      fullCtx.drawImage(preview, 0, 0, fullWidth, fullHeight);
    } else {
      await page.render({
        canvasContext: fullCtx as any,
        viewport,
      }).promise;
    }

    const canvas = cropRenderedPdfCanvas(fullCanvas, canvasLib.createCanvas, pageBox);
    const ctx = canvas.getContext('2d');
    let coloredTextLayers = applySampledPdfTextColors(textLayers, ctx, width, height);

    fs.writeFileSync(outPngPath, canvas.toBuffer('image/png'));

    let svgElementCount = 0;
    let svgWarning: string | undefined;
    let svgVisualDiffRatio: number | undefined;
    let svgVisualReliable = true;
    let svgOmitsFullPageRaster = false;
    let svgRasterImageCount = 0;
    let textGlyphCount = 0;
    let textPathCount = 0;
    let textMissingGlyphCount = 0;
    let textPathGlyphs: PdfTextGlyphPath[] = [];
    let redundantClipPathCount = 0;
    try {
      const operatorSvg = await writePdfOperatorSvg({
        page: page as any,
        ops: pdfjsLib.OPS as Record<string, number>,
        opList,
        width,
        height,
        scale,
        initialCtm: pageBox.initialCtm,
        outSvgPath,
        createCanvas: canvasLib.createCanvas,
        ImageDataCtor: canvasLib.ImageData,
        sourceCanvasContext: ctx as any,
        extractedTextLayers: coloredTextLayers,
        timeoutMs: options.operatorSvgTimeoutMs,
      });
      svgElementCount = operatorSvg.elementCount;
      svgRasterImageCount = operatorSvg.rasterImageCount;
      textGlyphCount = operatorSvg.textGlyphCount;
      textPathCount = operatorSvg.textPathCount;
      textMissingGlyphCount = operatorSvg.textMissingGlyphCount;
      textPathGlyphs = operatorSvg.textPathGlyphs;
      redundantClipPathCount = operatorSvg.redundantClipPathCount;
      coloredTextLayers = attachTextPathGlyphsToTextLayers(coloredTextLayers, textPathGlyphs);
      svgOmitsFullPageRaster = operatorSvg.omittedFullPageRaster;
      if (svgElementCount > 0 && fs.existsSync(outSvgPath)) {
        try {
          const sharp = require('sharp');
          const svgForDiff = materializeSvgUploadHrefsForSharp(outSvgPath);
          const svgRaw = await sharp(Buffer.from(svgForDiff))
            .resize(width, height, { fit: 'fill' })
            .flatten({ background: '#ffffff' })
            .ensureAlpha()
            .raw()
            .toBuffer();
          const sourceRaw = ctx.getImageData(0, 0, width, height).data;
          svgVisualDiffRatio = compareRenderedRgbaDiffRatio(sourceRaw, svgRaw, width, height);
          svgVisualReliable = svgVisualDiffRatio <= 0.05;
          if (!svgVisualReliable) {
            svgWarning = `AI editable SVG visually differs from rendered preview (${(svgVisualDiffRatio * 100).toFixed(1)}%).`;
            logger.warn({
              scope: 'ai',
              pageNumber,
            svgVisualDiffRatio,
            svgElementCount,
            }, 'AI: SVG visual diff too high; keeping editable SVG with warning');
          }
        } catch (err) {
          if (options.trustedPreviewPath) {
            svgVisualReliable = false;
            svgWarning = 'PDF editable SVG visual fidelity could not be verified.';
          }
          logger.warn({ scope: 'ai', err, pageNumber }, 'AI: SVG visual diff check failed');
        }
      }
    } catch (err) {
      if (!options.allowSvgFallback) throw err;
      if (options.trustedPreviewPath) svgVisualReliable = false;
      svgWarning = (err as Error)?.message || 'PDF operator SVG extraction failed';
      cleanupPdfOperatorSvgArtifacts(outSvgPath);
      logger.warn({ scope: 'ai', err, pageNumber }, 'AI: SVG operator extraction failed, using preview fallback');
    }

    return {
      width,
      height,
      textLayers: coloredTextLayers,
      svgElementCount,
      svgRasterImageCount,
      textGlyphCount,
      textPathCount,
      textMissingGlyphCount,
      textPathGlyphs,
      pageNumber,
      svgWarning,
      svgVisualDiffRatio,
      svgVisualReliable,
      svgOmitsFullPageRaster,
      redundantClipPathCount,
    };
  } finally {
    await doc.destroy();
  }
}

function resolvePdfRenderPageBox(
  filePath: string,
  page: any,
  pageNumber: number,
  scale: number,
  fullWidth: number,
  fullHeight: number,
  pageBoxMode: 'default' | 'artBox'
): PdfRenderPageBox {
  const view = normalizePdfPageView(page?.view, fullWidth / scale, fullHeight / scale);
  const fallback = createPdfRenderPageBox(view, scale, fullWidth, fullHeight, 0, 0, fullWidth, fullHeight, 'default');
  if (pageBoxMode !== 'artBox') return fallback;

  const artBox = extractPdfPageBox(filePath, pageNumber, 'ArtBox');
  if (!artBox) return fallback;

  const x0 = Math.max(view[0], Math.min(artBox[0], artBox[2]));
  const y0 = Math.max(view[1], Math.min(artBox[1], artBox[3]));
  const x1 = Math.min(view[2], Math.max(artBox[0], artBox[2]));
  const y1 = Math.min(view[3], Math.max(artBox[1], artBox[3]));
  if (x1 - x0 <= 1 || y1 - y0 <= 1) return fallback;

  const viewArea = Math.max(1, (view[2] - view[0]) * (view[3] - view[1]));
  const boxArea = Math.max(1, (x1 - x0) * (y1 - y0));
  if (boxArea / viewArea < 0.05) return fallback;

  const cropLeft = clampInt(Math.round((x0 - view[0]) * scale), 0, Math.max(0, fullWidth - 1));
  const cropTop = clampInt(Math.round((view[3] - y1) * scale), 0, Math.max(0, fullHeight - 1));
  const cropWidth = clampInt(Math.round((x1 - x0) * scale), 1, Math.max(1, fullWidth - cropLeft));
  const cropHeight = clampInt(Math.round((y1 - y0) * scale), 1, Math.max(1, fullHeight - cropTop));

  return createPdfRenderPageBox(view, scale, fullWidth, fullHeight, cropLeft, cropTop, cropWidth, cropHeight, 'ArtBox');
}

function createPdfRenderPageBox(
  view: [number, number, number, number],
  scale: number,
  fullWidth: number,
  fullHeight: number,
  cropLeft: number,
  cropTop: number,
  width: number,
  height: number,
  source: 'default' | 'ArtBox'
): PdfRenderPageBox {
  return {
    width,
    height,
    cropLeft,
    cropTop,
    source,
    initialCtm: [
      scale,
      0,
      0,
      -scale,
      -view[0] * scale - cropLeft,
      view[3] * scale - cropTop,
    ],
  };
}

function normalizePdfPageView(value: unknown, fallbackWidth: number, fallbackHeight: number): [number, number, number, number] {
  const nums = Array.isArray(value) ? value.map(Number).filter((item) => Number.isFinite(item)) : [];
  if (nums.length >= 4 && nums[2] > nums[0] && nums[3] > nums[1]) {
    return [nums[0], nums[1], nums[2], nums[3]];
  }
  return [0, 0, fallbackWidth, fallbackHeight];
}

function extractPdfPageBox(filePath: string, pageNumber: number, boxName: 'ArtBox'): [number, number, number, number] | null {
  try {
    const content = fs.readFileSync(filePath, 'latin1');
    const regex = new RegExp(`/${boxName}\\s*\\[([^\\]]+)\\]`, 'gi');
    const boxes: Array<[number, number, number, number]> = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content))) {
      const nums = (match[1].match(/[+-]?(?:\d+\.\d+|\d+|\.\d+)/g) || []).map(Number);
      if (nums.length >= 4 && nums.slice(0, 4).every((item) => Number.isFinite(item))) {
        boxes.push([nums[0], nums[1], nums[2], nums[3]]);
      }
    }
    return boxes[Math.max(0, pageNumber - 1)] || boxes[0] || null;
  } catch {
    return null;
  }
}

function cropRenderedPdfCanvas(
  sourceCanvas: any,
  createCanvas: (width: number, height: number) => any,
  pageBox: PdfRenderPageBox
): any {
  if (pageBox.source === 'default') return sourceCanvas;
  const canvas = createCanvas(pageBox.width, pageBox.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(
    sourceCanvas,
    pageBox.cropLeft,
    pageBox.cropTop,
    pageBox.width,
    pageBox.height,
    0,
    0,
    pageBox.width,
    pageBox.height
  );
  return canvas;
}

function cropPdfTextLayersToPageBox(layers: PdfTextLayer[], pageBox: PdfRenderPageBox): PdfTextLayer[] {
  if (pageBox.source === 'default') return layers;
  return layers
    .map((layer) => ({
      ...layer,
      x: layer.x - pageBox.cropLeft,
      y: layer.y - pageBox.cropTop,
      textMatrix: Array.isArray(layer.textMatrix) && layer.textMatrix.length >= 6
        ? [
            Number(layer.textMatrix[0]) || 0,
            Number(layer.textMatrix[1]) || 0,
            Number(layer.textMatrix[2]) || 0,
            Number(layer.textMatrix[3]) || 0,
            (Number(layer.textMatrix[4]) || 0) - pageBox.cropLeft,
            (Number(layer.textMatrix[5]) || 0) - pageBox.cropTop,
          ]
        : layer.textMatrix,
    }))
    .filter((layer) =>
      layer.x + layer.width > 0
      && layer.y + layer.height > 0
      && layer.x < pageBox.width
      && layer.y < pageBox.height
    );
}

function matrixRotationDegrees(matrix: unknown): number {
  if (!Array.isArray(matrix) || matrix.length < 2) return 0;
  const a = Number(matrix[0]) || 0;
  const b = Number(matrix[1]) || 0;
  const angle = Math.atan2(b, a) * 180 / Math.PI;
  return Number.isFinite(angle) ? angle : 0;
}

function compareRenderedRgbaDiffRatio(
  source: Uint8ClampedArray | Uint8Array,
  rendered: Buffer,
  width: number,
  height: number
): number {
  const totalPixels = width * height;
  let diffPixels = 0;
  for (let i = 0; i < totalPixels; i++) {
    const offset = i * 4;
    const delta =
      Math.abs((source[offset] ?? 0) - (rendered[offset] ?? 0))
      + Math.abs((source[offset + 1] ?? 0) - (rendered[offset + 1] ?? 0))
      + Math.abs((source[offset + 2] ?? 0) - (rendered[offset + 2] ?? 0))
      + Math.abs((source[offset + 3] ?? 255) - (rendered[offset + 3] ?? 255));
    if (delta > 24) diffPixels++;
  }
  return diffPixels / Math.max(1, totalPixels);
}

function materializeSvgUploadHrefsForSharp(svgPath: string): string {
  const svg = fs.readFileSync(svgPath, 'utf8');
  return svg.replace(
    /((?:href|xlink:href)=["'])\/uploads\/([^"']+)(["'])/g,
    (_match, prefix: string, relativeUploadPath: string, suffix: string) => {
      const filePath = path.join(STORAGE.base, relativeUploadPath.replace(/[\\/]+/g, path.sep));
      if (!fs.existsSync(filePath)) return `${prefix}/uploads/${relativeUploadPath}${suffix}`;
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
      const dataUri = `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
      return `${prefix}${dataUri}${suffix}`;
    }
  );
}

export function normalizePdfTextLayers(layers: PdfTextLayer[]): PdfTextLayer[] {
  const deduped: PdfTextLayer[] = [];
  const seen = new Set<string>();

  for (const layer of layers) {
    const normalizedLayer = normalizeExtractedPdfTextLayer(layer);
    if (!normalizedLayer) continue;
    const key = [
      Math.round(normalizedLayer.x),
      Math.round(normalizedLayer.y),
      Math.round(normalizedLayer.width),
      Math.round(normalizedLayer.height),
      Math.round(normalizedLayer.fontSize),
      normalizedLayer.fillColor,
      normalizedLayer.fontName || '',
      normalizedLayer.text,
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(normalizedLayer);
  }

  const merged: PdfTextLayer[] = [];
  let current: PdfTextLayer | null = null;

  for (const layer of deduped) {
    if (current && shouldMergePdfTextLayer(current, layer)) {
      current = mergePdfTextLayer(current, layer);
      continue;
    }
    if (current) merged.push(current);
    current = { ...layer };
  }

  if (current) merged.push(current);
  return merged;
}

function normalizeExtractedPdfTextLayer(layer: PdfTextLayer): PdfTextLayer | null {
  const normalized = normalizeExtractedPdfText(layer.text);
  if (!normalized) return null;
  return {
    ...layer,
    text: normalized.text,
    source: normalized.source || layer.source || 'pdfjs',
    confidence: layer.confidence ?? normalized.confidence,
  };
}

function normalizeExtractedPdfText(value: unknown): { text: string; confidence: number; source?: PdfTextLayer['source'] } | null {
  const raw = String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return null;

  const repaired = repairUtf8Mojibake(raw);
  if (repaired && isTrustedExtractedPdfText(repaired)) {
    return { text: repaired, confidence: 0.72, source: 'encoded-repair' };
  }

  const text = raw.normalize('NFKC');
  if (!isTrustedExtractedPdfText(text)) return null;
  return { text, confidence: 0.95 };
}

function repairUtf8Mojibake(text: string): string | null {
  if (!/[\u00C0-\u00FF]/.test(text)) return null;
  if ([...text].some((char) => char.charCodeAt(0) > 255)) return null;
  try {
    const repaired = Buffer.from(text, 'latin1').toString('utf8')
      .replace(/\u0000/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!repaired || repaired === text || repaired.includes('\uFFFD')) return null;
    return repaired;
  } catch {
    return null;
  }
}

function isTrustedExtractedPdfText(text: string): boolean {
  if (!text) return false;
  if (/[\uFFFD\uE000-\uF8FF]/.test(text)) return false;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return false;

  const chars = [...text];
  const cjkCount = chars.filter((char) => /[\u3400-\u9FFF\uF900-\uFAFF]/.test(char)).length;
  const asciiWordCount = chars.filter((char) => /[A-Za-z0-9]/.test(char)).length;
  const punctuationCount = chars.filter((char) => /[\s.,:;!?'"()\[\]{}<>/@#%&*+=_\-|\\，。、“”‘’；：？！《》（）【】￥·]/.test(char)).length;
  const latinExtendedCount = chars.filter((char) => /[\u00C0-\u024F]/.test(char)).length;
  const trustedRatio = (cjkCount + asciiWordCount + punctuationCount) / Math.max(1, chars.length);

  if (cjkCount === 0 && latinExtendedCount >= Math.max(2, chars.length * 0.25)) return false;
  if (trustedRatio < 0.76) return false;
  return true;
}

export function attachTextPathGlyphsToTextLayers(
  layers: PdfTextLayer[],
  glyphs: PdfTextGlyphPath[]
): PdfTextLayer[] {
  if (layers.length === 0 || glyphs.length === 0) {
    return layers.map((layer) => ({ ...layer, textPathGlyphIds: [], textPathBounds: undefined }));
  }
  const usedGlyphIds = new Set<string>();
  return layers.map((layer) => {
    const layerBounds = textLayerToBounds(layer);
    const padded = padBounds(layerBounds, Math.max(3, layer.fontSize * 0.35), Math.max(2, layer.fontSize * 0.35));
    const sequenceMatched = findSequentialTextGlyphMatch(layer, glyphs, padded, usedGlyphIds);
    const matched = (sequenceMatched || glyphs
      .filter((glyph) => glyph.bounds && glyphMatchesTextLayer(glyph.bounds, padded))
      .filter((glyph) => !usedGlyphIds.has(glyph.id))
      .sort((left, right) => {
        const rowTolerance = Math.max(2, layer.fontSize * 0.35);
        if (Math.abs(left.bounds.top - right.bounds.top) > rowTolerance) return left.bounds.top - right.bounds.top;
        return left.bounds.left - right.bounds.left;
      }));
    matched.forEach((glyph) => usedGlyphIds.add(glyph.id));
    const bounds = unionSvgBounds(matched.map((glyph) => glyph.bounds));
    return {
      ...layer,
      textPathGlyphIds: matched.map((glyph) => glyph.id),
      textPathBounds: bounds || undefined,
    };
  });
}

function findSequentialTextGlyphMatch(
  layer: PdfTextLayer,
  glyphs: PdfTextGlyphPath[],
  paddedBounds: SvgBounds,
  usedGlyphIds: Set<string>
): PdfTextGlyphPath[] | null {
  const target = normalizeGlyphMatchText(layer.text);
  if (!target) return null;
  const writingMode = layer.writingMode || 'horizontal-tb';

  for (let start = 0; start < glyphs.length; start++) {
    const first = glyphs[start];
    if (!first || usedGlyphIds.has(first.id)) continue;
    if ((first.writingMode || 'horizontal-tb') !== writingMode) continue;

    const candidate: PdfTextGlyphPath[] = [];
    let text = '';
    for (let index = start; index < glyphs.length; index++) {
      const glyph = glyphs[index];
      if (!glyph || usedGlyphIds.has(glyph.id)) break;
      if ((glyph.writingMode || 'horizontal-tb') !== writingMode) break;
      const glyphText = normalizeGlyphMatchText(glyph.text);
      if (!glyphText) continue;
      candidate.push(glyph);
      text += glyphText;
      if (!target.startsWith(text)) break;
      if (text === target) {
        const bounds = unionSvgBounds(candidate.map((item) => item.bounds));
        if (bounds && boundsOverlapEnough(bounds, paddedBounds)) return candidate;
        break;
      }
    }
  }

  return null;
}

function normalizeGlyphMatchText(value: unknown): string {
  return String(value || '').replace(/\s+/g, '');
}

function boundsOverlapEnough(left: SvgBounds, right: SvgBounds): boolean {
  const x1 = Math.max(left.left, right.left);
  const y1 = Math.max(left.top, right.top);
  const x2 = Math.min(left.right, right.right);
  const y2 = Math.min(left.bottom, right.bottom);
  if (x2 <= x1 || y2 <= y1) return false;
  const intersection = (x2 - x1) * (y2 - y1);
  const leftArea = Math.max(1, left.width * left.height);
  return intersection / leftArea >= 0.1;
}

function textLayerToBounds(layer: PdfTextLayer): SvgBounds {
  const left = Number(layer.x) || 0;
  const top = Number(layer.y) || 0;
  const width = Math.max(0, Number(layer.width) || 0);
  const height = Math.max(0, Number(layer.height) || 0);
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
}

function padBounds(bounds: SvgBounds, padX: number, padY: number): SvgBounds {
  return {
    left: bounds.left - padX,
    top: bounds.top - padY,
    right: bounds.right + padX,
    bottom: bounds.bottom + padY,
    width: bounds.width + padX * 2,
    height: bounds.height + padY * 2,
  };
}

function glyphMatchesTextLayer(glyphBounds: SvgBounds, layerBounds: SvgBounds): boolean {
  const centerX = glyphBounds.left + glyphBounds.width / 2;
  const centerY = glyphBounds.top + glyphBounds.height / 2;
  if (
    centerX >= layerBounds.left
    && centerX <= layerBounds.right
    && centerY >= layerBounds.top
    && centerY <= layerBounds.bottom
  ) {
    return true;
  }
  const left = Math.max(glyphBounds.left, layerBounds.left);
  const top = Math.max(glyphBounds.top, layerBounds.top);
  const right = Math.min(glyphBounds.right, layerBounds.right);
  const bottom = Math.min(glyphBounds.bottom, layerBounds.bottom);
  if (right <= left || bottom <= top) return false;
  const glyphArea = Math.max(1, Math.max(0, glyphBounds.width) * Math.max(0, glyphBounds.height));
  return ((right - left) * (bottom - top)) / glyphArea >= 0.15;
}

function unionSvgBounds(boundsList: SvgBounds[]): SvgBounds | null {
  if (boundsList.length === 0) return null;
  const left = Math.min(...boundsList.map((bounds) => bounds.left));
  const top = Math.min(...boundsList.map((bounds) => bounds.top));
  const right = Math.max(...boundsList.map((bounds) => bounds.right));
  const bottom = Math.max(...boundsList.map((bounds) => bounds.bottom));
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function shouldMergePdfTextLayer(left: PdfTextLayer, right: PdfTextLayer): boolean {
  if (!samePdfTextStyle(left, right)) return false;

  const fontSize = Math.max(left.fontSize || 0, right.fontSize || 0, 1);
  const lineTolerance = Math.max(2, fontSize * 0.25);
  if (Math.abs(left.y - right.y) > lineTolerance) return false;

  if (right.x < left.x - 0.5) return false;

  const leftRight = left.x + left.width;
  const gap = right.x - leftRight;
  const maxGap = Math.max(8, Math.min(24, fontSize * 0.9));
  if (gap > maxGap) return false;

  const overlap = -gap;
  const maxOverlap = Math.max(left.width, right.width) * 0.8;
  return overlap <= maxOverlap;
}

function samePdfTextStyle(left: PdfTextLayer, right: PdfTextLayer): boolean {
  if ((left.fontName || '') !== (right.fontName || '')) return false;
  if ((left.fillColor || '') !== (right.fillColor || '')) return false;
  if ((left.writingMode || 'horizontal-tb') !== (right.writingMode || 'horizontal-tb')) return false;
  return Math.abs((left.fontSize || 0) - (right.fontSize || 0)) <= Math.max(1, Math.max(left.fontSize, right.fontSize) * 0.08);
}

function mergePdfTextLayer(left: PdfTextLayer, right: PdfTextLayer): PdfTextLayer {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const rightEdge = Math.max(left.x + left.width, right.x + right.width);
  const bottom = Math.max(left.y + left.height, right.y + right.height);
  const leftWeight = Math.max(1, left.text.length);
  const rightWeight = Math.max(1, right.text.length);
  const fontSize = ((left.fontSize * leftWeight) + (right.fontSize * rightWeight)) / (leftWeight + rightWeight);

  return {
    text: `${left.text}${textJoiner(left, right)}${right.text}`,
    x,
    y,
    width: rightEdge - x,
    height: bottom - y,
    fontSize,
    fillColor: left.fillColor || right.fillColor || '#141413',
    fontName: left.fontName || right.fontName,
    source: left.source || right.source,
    confidence: left.confidence ?? right.confidence,
    writingMode: left.writingMode || right.writingMode,
    textMatrix: left.textMatrix || right.textMatrix,
    rotation: left.rotation ?? right.rotation,
  };
}

function textJoiner(left: PdfTextLayer, right: PdfTextLayer): string {
  if (/\s$/.test(left.text) || /^\s/.test(right.text)) return '';

  const gap = right.x - (left.x + left.width);
  if (gap < Math.max(4, Math.min(left.fontSize, right.fontSize) * 0.25)) return '';

  const leftChar = left.text.slice(-1);
  const rightChar = right.text.charAt(0);
  if (/^[A-Za-z0-9]$/.test(leftChar) && /^[A-Za-z0-9]$/.test(rightChar)) return ' ';
  return '';
}

function applySampledPdfTextColors(
  layers: PdfTextLayer[],
  ctx: { getImageData?: (x: number, y: number, width: number, height: number) => { data: Uint8ClampedArray | Uint8Array } },
  pageWidth: number,
  pageHeight: number
): PdfTextLayer[] {
  if (typeof ctx.getImageData !== 'function') return layers;
  const imageReader = ctx as { getImageData: (x: number, y: number, width: number, height: number) => { data: Uint8ClampedArray | Uint8Array } };
  return layers.map((layer) => ({
    ...layer,
    fillColor: samplePdfTextColor(layer, imageReader, pageWidth, pageHeight) || layer.fillColor || '#141413',
  }));
}

function samplePdfTextColor(
  layer: PdfTextLayer,
  ctx: { getImageData: (x: number, y: number, width: number, height: number) => { data: Uint8ClampedArray | Uint8Array } },
  pageWidth: number,
  pageHeight: number
): string | null {
  const pad = Math.max(2, Math.round(layer.fontSize * 0.25));
  const x0 = clampInt(Math.floor(layer.x - pad), 0, pageWidth - 1);
  const y0 = clampInt(Math.floor(layer.y - pad), 0, pageHeight - 1);
  const x1 = clampInt(Math.ceil(layer.x + layer.width + pad), x0 + 1, pageWidth);
  const y1 = clampInt(Math.ceil(layer.y + layer.height + pad), y0 + 1, pageHeight);
  const cropWidth = x1 - x0;
  const cropHeight = y1 - y0;
  if (cropWidth <= 1 || cropHeight <= 1) return null;

  let imageData: { data: Uint8ClampedArray | Uint8Array };
  try {
    imageData = ctx.getImageData(x0, y0, cropWidth, cropHeight);
  } catch {
    return null;
  }

  const pixels = imageData.data;
  const border = Math.max(1, Math.min(pad, Math.floor(Math.min(cropWidth, cropHeight) / 3)));
  const background = dominantColor(pixels, cropWidth, cropHeight, (x, y) =>
    x < border || y < border || x >= cropWidth - border || y >= cropHeight - border
  ) || dominantColor(pixels, cropWidth, cropHeight);
  if (!background) return null;

  const candidates = new Map<string, { count: number; r: number; g: number; b: number; distance: number }>();
  let candidateCount = 0;
  const minDistance = 42;

  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      const idx = (y * cropWidth + x) * 4;
      const alpha = pixels[idx + 3] ?? 255;
      if (alpha <= 8) continue;
      const r = pixels[idx] ?? 0;
      const g = pixels[idx + 1] ?? 0;
      const b = pixels[idx + 2] ?? 0;
      const distance = colorDistance({ r, g, b }, background);
      if (distance < minDistance) continue;
      const key = `${r >> 4},${g >> 4},${b >> 4}`;
      const bucket = candidates.get(key) || { count: 0, r: 0, g: 0, b: 0, distance: 0 };
      bucket.count++;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.distance += distance;
      candidates.set(key, bucket);
      candidateCount++;
    }
  }

  const best = pickContrastingTextColorBucket(candidates);
  if (candidateCount < Math.max(3, Math.round(layer.text.length * 0.6)) || !best) return null;
  return rgbToHex(
    clampColorChannel(best.r / best.count),
    clampColorChannel(best.g / best.count),
    clampColorChannel(best.b / best.count)
  );
}

function pickContrastingTextColorBucket(
  candidates: Map<string, { count: number; r: number; g: number; b: number; distance: number }>
): { count: number; r: number; g: number; b: number; distance: number } | null {
  let best: { count: number; r: number; g: number; b: number; distance: number } | null = null;
  for (const candidate of candidates.values()) {
    if (candidate.count < 3) continue;
    if (!best) {
      best = candidate;
      continue;
    }
    const avgDistance = candidate.distance / Math.max(1, candidate.count);
    const bestAvgDistance = best.distance / Math.max(1, best.count);
    const score = candidate.count * avgDistance * avgDistance;
    const bestScore = best.count * bestAvgDistance * bestAvgDistance;
    if (score > bestScore) best = candidate;
  }
  return best;
}

function samplePdfShadingFillColor(
  ctx: { getImageData?: (x: number, y: number, width: number, height: number) => { data: Uint8ClampedArray | Uint8Array } } | undefined,
  bounds: SvgBounds,
  pageWidth: number,
  pageHeight: number,
  preferDominant = false
): string | null {
  if (typeof ctx?.getImageData !== 'function') return null;
  const pad = Math.max(2, Math.min(10, Math.round(Math.max(bounds.width, bounds.height) * 0.04)));
  const x0 = clampInt(Math.floor(bounds.left - pad), 0, pageWidth - 1);
  const y0 = clampInt(Math.floor(bounds.top - pad), 0, pageHeight - 1);
  const x1 = clampInt(Math.ceil(bounds.right + pad), x0 + 1, pageWidth);
  const y1 = clampInt(Math.ceil(bounds.bottom + pad), y0 + 1, pageHeight);
  const cropWidth = x1 - x0;
  const cropHeight = y1 - y0;
  if (cropWidth <= 1 || cropHeight <= 1) return null;

  let imageData: { data: Uint8ClampedArray | Uint8Array };
  try {
    imageData = ctx.getImageData(x0, y0, cropWidth, cropHeight);
  } catch {
    return null;
  }

  const pixels = imageData.data;
  const border = Math.max(1, Math.min(pad, Math.floor(Math.min(cropWidth, cropHeight) / 3)));
  const background = dominantColor(pixels, cropWidth, cropHeight, (x, y) =>
    x < border || y < border || x >= cropWidth - border || y >= cropHeight - border
  ) || dominantColor(pixels, cropWidth, cropHeight);
  if (!background) return null;

  if (preferDominant) {
    const dominant = dominantColor(pixels, cropWidth, cropHeight) || background;
    return rgbToHex(
      clampColorChannel(dominant.r),
      clampColorChannel(dominant.g),
      clampColorChannel(dominant.b)
    );
  }

  const contrastCandidates = new Map<string, { count: number; r: number; g: number; b: number; distance: number }>();
  const allCandidates = new Map<string, { count: number; r: number; g: number; b: number; distance: number }>();
  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      const idx = (y * cropWidth + x) * 4;
      const alpha = pixels[idx + 3] ?? 255;
      if (alpha <= 8) continue;
      const r = pixels[idx] ?? 0;
      const g = pixels[idx + 1] ?? 0;
      const b = pixels[idx + 2] ?? 0;
      const distance = colorDistance({ r, g, b }, background);
      const key = `${r >> 3},${g >> 3},${b >> 3}`;
      const all = allCandidates.get(key) || { count: 0, r: 0, g: 0, b: 0, distance: 0 };
      all.count++;
      all.r += r;
      all.g += g;
      all.b += b;
      all.distance += distance;
      allCandidates.set(key, all);
      if (distance < 28) continue;
      const contrast = contrastCandidates.get(key) || { count: 0, r: 0, g: 0, b: 0, distance: 0 };
      contrast.count++;
      contrast.r += r;
      contrast.g += g;
      contrast.b += b;
      contrast.distance += distance;
      contrastCandidates.set(key, contrast);
    }
  }

  const candidates = contrastCandidates.size > 0 ? contrastCandidates : allCandidates;
  let best: { count: number; r: number; g: number; b: number; distance: number } | null = null;
  for (const candidate of candidates.values()) {
    if (!best) {
      best = candidate;
      continue;
    }
    const score = candidate.count * Math.max(1, candidate.distance / Math.max(1, candidate.count));
    const bestScore = best.count * Math.max(1, best.distance / Math.max(1, best.count));
    if (score > bestScore) best = candidate;
  }
  if (!best || best.count <= 0) return null;
  return rgbToHex(
    clampColorChannel(best.r / best.count),
    clampColorChannel(best.g / best.count),
    clampColorChannel(best.b / best.count)
  );
}

async function createPreviewTextureFillImage(
  clipPath: SvgClipPath,
  snapshot: SourceCanvasSnapshot | null,
  pageWidth: number,
  pageHeight: number
): Promise<SvgRasterImage | null> {
  if (!snapshot?.data || !clipPath.pathData) return null;
  const pageBounds = boundsFromEdges(0, 0, pageWidth, pageHeight);
  const clipped = intersectBounds(pageBounds, clipPath.bounds);
  if (!clipped || clipped.width <= 1 || clipped.height <= 1) return null;

  const pageArea = Math.max(1, pageWidth * pageHeight);
  const areaRatio = Math.max(0, clipped.width) * Math.max(0, clipped.height) / pageArea;
  if (areaRatio > 0.22 || isNearFullPageBounds(clipped, pageWidth, pageHeight)) return null;

  const x0 = clampInt(Math.floor(clipped.left), 0, pageWidth - 1);
  const y0 = clampInt(Math.floor(clipped.top), 0, pageHeight - 1);
  const x1 = clampInt(Math.ceil(clipped.right), x0 + 1, pageWidth);
  const y1 = clampInt(Math.ceil(clipped.bottom), y0 + 1, pageHeight);
  const cropWidth = x1 - x0;
  const cropHeight = y1 - y0;
  if (cropWidth <= 1 || cropHeight <= 1 || cropWidth * cropHeight > 1_500_000) return null;

  const mask = await renderRasterClipMask(clipPath, boundsFromEdges(x0, y0, x1, y1), cropWidth, cropHeight);
  if (!mask) return null;

  const rgba = Buffer.alloc(cropWidth * cropHeight * 4);
  const buckets = new Map<string, number>();
  let visiblePixels = 0;
  let dominantBucketCount = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumSqR = 0;
  let sumSqG = 0;
  let sumSqB = 0;

  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      const targetOffset = (y * cropWidth + x) * 4;
      const sourceOffset = ((y0 + y) * snapshot.width + (x0 + x)) * 4;
      const maskAlpha = mask[y * cropWidth + x] ?? 0;
      if (maskAlpha <= 0 || sourceOffset + 3 >= snapshot.data.length) {
        rgba[targetOffset + 3] = 0;
        continue;
      }
      const sourceAlpha = snapshot.data[sourceOffset + 3] ?? 255;
      const alpha = Math.round((sourceAlpha * maskAlpha) / 255);
      if (alpha <= 8) {
        rgba[targetOffset + 3] = 0;
        continue;
      }

      const r = snapshot.data[sourceOffset] ?? 0;
      const g = snapshot.data[sourceOffset + 1] ?? 0;
      const b = snapshot.data[sourceOffset + 2] ?? 0;
      rgba[targetOffset] = r;
      rgba[targetOffset + 1] = g;
      rgba[targetOffset + 2] = b;
      rgba[targetOffset + 3] = alpha;

      visiblePixels++;
      sumR += r;
      sumG += g;
      sumB += b;
      sumSqR += r * r;
      sumSqG += g * g;
      sumSqB += b * b;
      const bucketKey = `${r >> 4},${g >> 4},${b >> 4}`;
      const bucketCount = (buckets.get(bucketKey) || 0) + 1;
      buckets.set(bucketKey, bucketCount);
      if (bucketCount > dominantBucketCount) dominantBucketCount = bucketCount;
    }
  }

  if (visiblePixels < 24) return null;
  const meanR = sumR / visiblePixels;
  const meanG = sumG / visiblePixels;
  const meanB = sumB / visiblePixels;
  const variance = Math.max(0, (sumSqR / visiblePixels) - meanR * meanR)
    + Math.max(0, (sumSqG / visiblePixels) - meanG * meanG)
    + Math.max(0, (sumSqB / visiblePixels) - meanB * meanB);
  const colorSpread = Math.sqrt(variance / 3);
  const dominantRatio = dominantBucketCount / Math.max(1, visiblePixels);
  const bucketCount = buckets.size;
  const textureLike = bucketCount >= 10
    || colorSpread >= 16
    || (clipPath.source === 'text' && bucketCount >= 5 && dominantRatio < 0.97);
  if (!textureLike || dominantRatio > 0.985) return null;

  const sharp = require('sharp');
  const pngBuffer = await sharp(rgba, {
    raw: { width: cropWidth, height: cropHeight, channels: 4 },
  }).png().toBuffer();

  return {
    href: `data:image/png;base64,${pngBuffer.toString('base64')}`,
    pngBuffer,
    x: 0,
    y: 0,
    width: cropWidth,
    height: cropHeight,
    pixelWidth: cropWidth,
    pixelHeight: cropHeight,
    nonWhiteRatio: visiblePixels / Math.max(1, cropWidth * cropHeight),
    sparseMask: false,
    clipApplied: true,
    transform: [1, 0, 0, 1, x0, y0],
    visibleBounds: boundsFromEdges(x0, y0, x1, y1),
  };
}

function dominantColor(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  include?: (x: number, y: number) => boolean
): { r: number; g: number; b: number } | null {
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (include && !include(x, y)) continue;
      const idx = (y * width + x) * 4;
      const alpha = pixels[idx + 3] ?? 255;
      if (alpha <= 8) continue;
      const r = pixels[idx] ?? 0;
      const g = pixels[idx + 1] ?? 0;
      const b = pixels[idx + 2] ?? 0;
      const key = `${r >> 4},${g >> 4},${b >> 4}`;
      const bucket = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
      bucket.count++;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      buckets.set(key, bucket);
    }
  }

  let best: { count: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket;
  }
  if (!best || best.count <= 0) return null;
  return {
    r: best.r / best.count,
    g: best.g / best.count,
    b: best.b / best.count,
  };
}

function colorDistance(left: { r: number; g: number; b: number }, right: { r: number; g: number; b: number }): number {
  const dr = left.r - right.r;
  const dg = left.g - right.g;
  const db = left.b - right.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clampColorChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function isLikelyExtractedTextShading(bounds: SvgBounds, textLayers: PdfTextLayer[]): boolean {
  const centerX = bounds.left + bounds.width / 2;
  const centerY = bounds.top + bounds.height / 2;
  for (const layer of textLayers) {
    const pad = Math.max(6, Math.round((layer.fontSize || layer.height || 12) * 0.75));
    const left = layer.x - pad;
    const top = layer.y - pad;
    const right = layer.x + layer.width + pad;
    const bottom = layer.y + layer.height + pad;
    const centerInside = centerX >= left && centerX <= right && centerY >= top && centerY <= bottom;
    if (centerInside) return true;

    const overlapLeft = Math.max(bounds.left, left);
    const overlapTop = Math.max(bounds.top, top);
    const overlapRight = Math.min(bounds.right, right);
    const overlapBottom = Math.min(bounds.bottom, bottom);
    const overlapArea = Math.max(0, overlapRight - overlapLeft) * Math.max(0, overlapBottom - overlapTop);
    const boundsArea = Math.max(1, bounds.width * bounds.height);
    if (overlapArea / boundsArea > 0.65) return true;
  }
  return false;
}

function isLikelyLargeRectangularShading(pathData: string, bounds: SvgBounds, pageWidth: number, pageHeight: number): boolean {
  if (isLikelyFullPageShading(bounds, pageWidth, pageHeight)) return false;
  const pageArea = Math.max(1, pageWidth * pageHeight);
  const areaRatio = (bounds.width * bounds.height) / pageArea;
  if (areaRatio < 0.025) return false;
  const hasCurves = /\bC\b/i.test(pathData);
  if (hasCurves) return false;
  const moveCount = (pathData.match(/\bM\b/gi) || []).length;
  const lineCount = (pathData.match(/\bL\b/gi) || []).length;
  const closeCount = (pathData.match(/\bZ\b/gi) || []).length;
  return moveCount <= 2 && lineCount <= 8 && closeCount >= 1;
}

function isLikelyFullPageShading(bounds: SvgBounds, pageWidth: number, pageHeight: number): boolean {
  return bounds.left <= pageWidth * 0.02
    && bounds.top <= pageHeight * 0.02
    && bounds.right >= pageWidth * 0.98
    && bounds.bottom >= pageHeight * 0.98
    && (bounds.width * bounds.height) / Math.max(1, pageWidth * pageHeight) >= 0.9;
}

function isLikelyBroadShadingShape(pathData: string, bounds: SvgBounds, pageWidth: number, pageHeight: number): boolean {
  const pageArea = Math.max(1, pageWidth * pageHeight);
  const areaRatio = (bounds.width * bounds.height) / pageArea;
  if (areaRatio < 0.04) return false;
  const moveCount = (pathData.match(/\bM\b/gi) || []).length;
  const curveCount = (pathData.match(/\bC\b/gi) || []).length;
  const commandCount = (pathData.match(/\b[MLCZ]\b/gi) || []).length;
  return moveCount <= 4 && curveCount <= 12 && commandCount <= 40;
}

async function writePdfOperatorSvg({
  page,
  ops,
  opList,
  width,
  height,
  scale,
  initialCtm,
  outSvgPath,
  createCanvas,
  ImageDataCtor,
  sourceCanvasContext,
  extractedTextLayers,
  timeoutMs,
}: {
  page: any;
  ops: Record<string, number>;
  opList: { fnArray: number[]; argsArray: any[] };
  width: number;
  height: number;
  scale: number;
  initialCtm?: Matrix;
  outSvgPath: string;
  createCanvas: (width: number, height: number) => any;
  ImageDataCtor: new (data: Uint8ClampedArray, width: number, height: number) => any;
  sourceCanvasContext?: {
    getImageData?: (x: number, y: number, width: number, height: number) => { data: Uint8ClampedArray | Uint8Array };
  };
  extractedTextLayers?: PdfTextLayer[];
  timeoutMs?: number;
}): Promise<PdfOperatorSvgResult> {
  const startedAt = Date.now();
  const state: SvgState = {
    ctm: initialCtm ? [...initialCtm] : [scale, 0, 0, -scale, 0, height],
    fillColor: '#000000',
    strokeColor: '#000000',
    fillUsesPattern: false,
    strokeUsesPattern: false,
    lineWidth: 1,
    currentPath: '',
    clipBounds: null,
    clipPath: null,
    text: createDefaultSvgTextState(),
  };
  const stack: SvgState[] = [];
  const elements: string[] = [];
  let vectorElementCount = 0;
  let rasterAssetCounter = 0;
  const rasterAssetRunId = `${Date.now().toString(36)}-${process.pid}`;
  let sourceSnapshot: SourceCanvasSnapshot | null | undefined;
  let lastHiddenFillBounds: SvgBounds | null = null;
  let omittedFullPageRaster = false;
  let textGlyphCount = 0;
  let textPathCount = 0;
  let textMissingGlyphCount = 0;
  let textGlyphPathCounter = 0;
  const textPathGlyphs: PdfTextGlyphPath[] = [];
  const clipPathDefs: string[] = [];
  const clipPathIds = new Map<string, string>();
  const clipPathsById = new Map<string, SvgClipPath>();
  let clipPathCounter = 0;

  const getSourceSnapshot = (): SourceCanvasSnapshot | null => {
    if (sourceSnapshot !== undefined) return sourceSnapshot;
    sourceSnapshot = null;
    try {
      const imageData = sourceCanvasContext?.getImageData?.(0, 0, width, height);
      if (imageData?.data) {
        sourceSnapshot = { width, height, data: imageData.data };
      }
    } catch {
      sourceSnapshot = null;
    }
    return sourceSnapshot;
  };

  const materializeRasterImage = (raster: SvgRasterImage): SvgRasterImage => {
    if (!raster.pngBuffer) return raster;
    const basename = path.basename(outSvgPath, path.extname(outSvgPath));
    const filename = `${basename}_raster_${rasterAssetRunId}_${++rasterAssetCounter}.png`;
    const assetPath = path.join(path.dirname(outSvgPath), filename);
    fs.writeFileSync(assetPath, raster.pngBuffer);
    const uploadHref = `/uploads/${path.relative(STORAGE.base, assetPath).replace(/\\/g, '/')}`;
    return {
      ...raster,
      href: uploadHref,
      pngBuffer: undefined,
    };
  };

  const appendRasterImage = async (raster: SvgRasterImage) => {
    const isFullPageRaster = isRasterPaintedAsFullPage(state.ctm, width, height);
    const visibleRaster = isFullPageRaster && raster.sparseMask
      ? await cropSparseRasterToVisibleBounds(raster, state, width, height)
      : raster;
    if (!visibleRaster) return;
    const alphaRestoredRaster = await restoreRasterAlphaFromPreview(
      visibleRaster,
      state,
      getSourceSnapshot()
    );
    const preparedRaster = await cropRasterToClipBounds(alphaRestoredRaster, state);
    if (!preparedRaster) return;
    elements.push(svgImageElement(
      state,
      materializeRasterImage(preparedRaster),
      preparedRaster.clipApplied ? null : getCurrentClipPathId()
    ));
  };

  const appendTextureFillImage = async (clipPath: SvgClipPath): Promise<boolean> => {
    const texture = await createPreviewTextureFillImage(clipPath, getSourceSnapshot(), width, height);
    if (!texture) return false;
    elements.push(svgTextureFillImageElement(materializeRasterImage(texture)));
    return true;
  };

  const appendCurrentPathTextureFillImage = async (): Promise<boolean> => {
    const bounds = transformedPathBounds(state.currentPath, state.ctm);
    if (!bounds) return false;
    return appendTextureFillImage({
      pathData: state.currentPath,
      matrix: [...state.ctm],
      bounds,
      source: 'fill',
    });
  };

  const getCurrentClipPathId = (): string | null => getClipPathId(state.clipPath);

  const getClipPathId = (clipPath?: SvgClipPath | null): string | null => {
    if (!clipPath?.pathData) return null;
    if (isNearFullPageBounds(clipPath.bounds, width, height)) return null;

    const key = `${clipPath.source || 'path'}|${clipPath.matrix.map(formatNum).join(',')}|${clipPath.pathData}`;
    const existing = clipPathIds.get(key);
    if (existing) return existing;

    const id = `pdfClip${++clipPathCounter}`;
    clipPathIds.set(key, id);
    clipPathsById.set(id, {
      ...clipPath,
      matrix: [...clipPath.matrix],
      bounds: { ...clipPath.bounds },
    });
    clipPathDefs.push(
      `<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${escapeXml(clipPath.pathData)}"${matrixAttr(clipPath.matrix)} /></clipPath>`
    );
    return id;
  };

  const ensureWithinTimeBudget = () => {
    if (!timeoutMs) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`pdfjs operator SVG timed out after ${timeoutMs}ms`);
    }
  };

  for (let i = 0; i < opList.fnArray.length; i++) {
    ensureWithinTimeBudget();
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];

    if (fn === ops.save) {
      stack.push(cloneState(state));
      continue;
    }
    if (fn === ops.restore) {
      const restored = stack.pop();
      if (restored) Object.assign(state, restored);
      continue;
    }
    if (fn === ops.transform) {
      state.ctm = multiplyMatrix(state.ctm, toMatrix(args));
      continue;
    }
    if (fn === ops.setLineWidth) {
      state.lineWidth = Number(args?.[0] ?? 1) || 1;
      continue;
    }
    if (fn === ops.setFillRGBColor) {
      state.fillColor = rgbColor(args);
      state.fillUsesPattern = false;
      continue;
    }
    if (fn === ops.setStrokeRGBColor) {
      state.strokeColor = rgbColor(args);
      state.strokeUsesPattern = false;
      continue;
    }
    if (fn === ops.setFillGray) {
      state.fillColor = grayColor(args);
      state.fillUsesPattern = false;
      continue;
    }
    if (fn === ops.setStrokeGray) {
      state.strokeColor = grayColor(args);
      state.strokeUsesPattern = false;
      continue;
    }
    if (fn === ops.setFillCMYKColor) {
      state.fillColor = cmykColor(args);
      state.fillUsesPattern = false;
      continue;
    }
    if (fn === ops.setStrokeCMYKColor) {
      state.strokeColor = cmykColor(args);
      state.strokeUsesPattern = false;
      continue;
    }
    if (fn === ops.setFillColor || fn === ops.setFillColorN) {
      state.fillUsesPattern = isPdfPatternColorArgs(args);
      if (!state.fillUsesPattern) {
        state.fillColor = genericColor(args, state.fillColor);
      }
      continue;
    }
    if (fn === ops.setStrokeColor || fn === ops.setStrokeColorN) {
      state.strokeUsesPattern = isPdfPatternColorArgs(args);
      if (!state.strokeUsesPattern) {
        state.strokeColor = genericColor(args, state.strokeColor);
      }
      continue;
    }
    if (fn === ops.setGState) {
      applyGraphicState(state, args);
      continue;
    }
    if (fn === ops.beginText) {
      state.text.x = 0;
      state.text.y = 0;
      state.text.lineX = 0;
      state.text.lineY = 0;
      state.text.textMatrix = [...IDENTITY_MATRIX];
      state.text.textMatrixScale = 1;
      continue;
    }
    if (fn === ops.endText) {
      state.text.x = 0;
      state.text.y = 0;
      state.text.lineX = 0;
      state.text.lineY = 0;
      continue;
    }
    if (fn === ops.setCharSpacing) {
      state.text.charSpacing = Number(args?.[0] ?? 0) || 0;
      continue;
    }
    if (fn === ops.setWordSpacing) {
      state.text.wordSpacing = Number(args?.[0] ?? 0) || 0;
      continue;
    }
    if (fn === ops.setHScale) {
      const hScale = Number(args?.[0] ?? 100);
      state.text.textHScale = Number.isFinite(hScale) ? hScale / 100 : 1;
      continue;
    }
    if (fn === ops.setLeading) {
      state.text.leading = Number(args?.[0] ?? 0) || 0;
      continue;
    }
    if (fn === ops.setFont) {
      applySvgTextFont(state.text, page, args);
      continue;
    }
    if (fn === ops.setTextRenderingMode) {
      state.text.textRenderingMode = Number(args?.[0] ?? 0) || 0;
      continue;
    }
    if (fn === ops.setTextRise) {
      state.text.textRise = Number(args?.[0] ?? 0) || 0;
      continue;
    }
    if (fn === ops.moveText) {
      moveSvgText(state.text, Number(args?.[0] ?? 0) || 0, Number(args?.[1] ?? 0) || 0);
      continue;
    }
    if (fn === ops.setLeadingMoveText) {
      state.text.leading = -(Number(args?.[1] ?? 0) || 0);
      moveSvgText(state.text, Number(args?.[0] ?? 0) || 0, Number(args?.[1] ?? 0) || 0);
      continue;
    }
    if (fn === ops.setTextMatrix) {
      state.text.textMatrix = toMatrix(args);
      state.text.textMatrixScale = Math.hypot(state.text.textMatrix[0], state.text.textMatrix[1]) || 1;
      state.text.x = 0;
      state.text.y = 0;
      state.text.lineX = 0;
      state.text.lineY = 0;
      continue;
    }
    if (fn === ops.nextLine) {
      moveSvgText(state.text, 0, state.text.leading);
      continue;
    }
    if (
      fn === ops.showText
      || fn === ops.showSpacedText
      || fn === ops.nextLineShowText
      || fn === ops.nextLineSetSpacingShowText
    ) {
      if (fn === ops.nextLineSetSpacingShowText) {
        state.text.wordSpacing = Number(args?.[0] ?? 0) || 0;
        state.text.charSpacing = Number(args?.[1] ?? 0) || 0;
      }
      if (fn === ops.nextLineShowText || fn === ops.nextLineSetSpacingShowText) {
        moveSvgText(state.text, 0, state.text.leading);
      }
      const glyphArg = fn === ops.nextLineSetSpacingShowText ? args?.[2] : args?.[0];
      const glyphs = Array.isArray(glyphArg) ? glyphArg : [];
      const textResult = appendPdfTextGlyphPaths(state, glyphs, page, () => `p${page?._pageIndex !== undefined ? Number(page._pageIndex) + 1 : 1}-g${++textGlyphPathCounter}`);
      elements.push(...textResult.elements);
      textPathGlyphs.push(...textResult.glyphPaths);
      vectorElementCount += textResult.elements.length;
      textGlyphCount += textResult.glyphCount;
      textPathCount += textResult.pathCount;
      textMissingGlyphCount += textResult.missingGlyphCount;
      if (textResult.clipPathData && textResult.clipBounds) {
        state.clipBounds = intersectBounds(state.clipBounds, textResult.clipBounds);
        state.clipPath = {
          pathData: textResult.clipPathData,
          matrix: [...IDENTITY_MATRIX],
          bounds: textResult.clipBounds,
          source: 'text',
        };
      }
      continue;
    }
    if (fn === ops.constructPath) {
      state.currentPath = pathFromConstructPath(ops, args);
      continue;
    }
    if (fn === ops.clip || fn === ops.eoClip) {
      const clipBounds = transformedPathBounds(state.currentPath, state.ctm);
      if (clipBounds) {
        state.clipBounds = intersectBounds(state.clipBounds, clipBounds);
        state.clipPath = {
          pathData: state.currentPath,
          matrix: [...state.ctm],
          bounds: clipBounds,
          source: 'path',
        };
      }
      continue;
    }
    if (fn === ops.shadingFill) {
      if (
        state.clipPath?.pathData
        && (state.clipPath.source === 'text' || !isLikelyExtractedTextShading(state.clipPath.bounds, extractedTextLayers || []))
        && !isLikelyLargeRectangularShading(state.clipPath.pathData, state.clipPath.bounds, width, height)
      ) {
        if (await appendTextureFillImage(state.clipPath)) {
          vectorElementCount++;
          ensureWithinTimeBudget();
          continue;
        }
        const fill = samplePdfShadingFillColor(
          sourceCanvasContext,
          state.clipPath.bounds,
          width,
          height,
          isLikelyBroadShadingShape(state.clipPath.pathData, state.clipPath.bounds, width, height)
        )
          || state.fillColor
          || '#000000';
        elements.push(svgPathElement({
          ...state,
          currentPath: state.clipPath.pathData,
          ctm: [...state.clipPath.matrix],
        }, {
          fill,
          stroke: 'none',
          fillRule: 'nonzero',
        }, getCurrentClipPathId()));
        vectorElementCount++;
      }
      continue;
    }
    if (fn === ops.fill || fn === ops.eoFill || fn === ops.fillStroke || fn === ops.eoFillStroke) {
      if (state.currentPath) {
        const pathOptions = {
          fill: state.fillColor,
          stroke: fn === ops.fillStroke || fn === ops.eoFillStroke ? state.strokeColor : 'none',
          fillRule: fn === ops.eoFill || fn === ops.eoFillStroke ? 'evenodd' : 'nonzero',
        } as const;
        const hiddenCheck = shouldSkipHiddenPdfPath(state, pathOptions, getSourceSnapshot());
        if (hiddenCheck.skip) {
          lastHiddenFillBounds = hiddenCheck.bounds;
        } else {
          const wroteTextureFill = state.fillUsesPattern
            && pathOptions.fill !== 'none'
            && await appendCurrentPathTextureFillImage();
          if (wroteTextureFill && pathOptions.stroke !== 'none') {
            elements.push(svgPathElement(state, {
              fill: 'none',
              stroke: pathOptions.stroke,
              fillRule: pathOptions.fillRule,
            }, getCurrentClipPathId()));
            vectorElementCount++;
          } else if (!wroteTextureFill) {
            elements.push(svgPathElement(state, pathOptions, getCurrentClipPathId()));
          }
          vectorElementCount++;
          lastHiddenFillBounds = null;
        }
      }
      state.currentPath = '';
      continue;
    }
    if (fn === ops.stroke || fn === ops.closeStroke) {
      if (state.currentPath) {
        const bounds = transformedPathBounds(state.currentPath, state.ctm);
        if (bounds && shouldSkipHiddenFollowerStroke(bounds, lastHiddenFillBounds)) {
          lastHiddenFillBounds = null;
          state.currentPath = '';
          continue;
        }
        elements.push(svgPathElement(state, {
          fill: 'none',
          stroke: state.strokeColor,
          fillRule: 'nonzero',
        }, getCurrentClipPathId()));
        vectorElementCount++;
        lastHiddenFillBounds = null;
      }
      state.currentPath = '';
      continue;
    }
    if (fn === ops.endPath) {
      state.currentPath = '';
      continue;
    }
    if (fn === ops.paintImageXObject) {
      if (isRasterPaintedAsFullPage(state.ctm, width, height)) {
        omittedFullPageRaster = true;
        continue;
      }
      const imageId = args?.[0];
      const image = imageId ? await getPageObject(page, imageId) : null;
      if (image?.data && image.width && image.height) {
        const raster = imageToSvgRasterImage(image, createCanvas, ImageDataCtor);
        if (raster) {
          await appendRasterImage(raster);
          ensureWithinTimeBudget();
        }
      }
      continue;
    }
    if (fn === ops.paintInlineImageXObject && args?.[0]?.data) {
      if (isRasterPaintedAsFullPage(state.ctm, width, height)) {
        omittedFullPageRaster = true;
        continue;
      }
      const raster = imageToSvgRasterImage(args[0], createCanvas, ImageDataCtor);
      if (raster) {
        await appendRasterImage(raster);
        ensureWithinTimeBudget();
      }
    }
  }

  const cleanedElements = await removeDuplicatePdfRasterMaskArtifacts(elements, outSvgPath, width, height);
  const roleAnnotated = await annotatePdfOperatorSvgObjectRoles(cleanedElements, width, height);
  const textureAugmented = await addDecorationTextureOverlaysForClippedClusters(
    roleAnnotated.elements,
    outSvgPath,
    width,
    height,
    getSourceSnapshot()
  );
  const defs = clipPathDefs.length > 0
    ? [`<defs>`, ...clipPathDefs, `</defs>`]
    : [];
  const decorCleanedElements = await cleanDecorationOverprintedRasters(
    textureAugmented,
    defs,
    outSvgPath,
    width,
    height,
    getSourceSnapshot()
  );
  const clipSimplified = removeRedundantRectangularPathClips(decorCleanedElements, clipPathsById);
  const finalElements = clipSimplified.elements;
  const rasterImageCount = finalElements.filter((element) =>
    /<image\b/i.test(element) && /\bdata-pdf-raster=["']true["']/i.test(element)
  ).length;
  const renderableVectorElementCount = finalElements.filter((element) =>
    (
      /<path\b/i.test(element)
      || (/<image\b/i.test(element) && /\bdata-object-role=["'](?:decoration-texture-fill|decoration-effect-raster)["']/i.test(element))
    )
    && !/\bdisplay=["']none["']/i.test(element)
    && !/\bdata-object-role=["'](?:mask-artifact|raster-reconstruction-strip)["']/i.test(element)
  ).length;
  const svg = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    ...defs,
    ...finalElements,
    `</svg>`,
  ].join('\n');

  fs.writeFileSync(outSvgPath, svg, 'utf8');
  return {
    elementCount: renderableVectorElementCount,
    rasterImageCount,
    omittedFullPageRaster,
    textGlyphCount,
    textPathCount,
    textMissingGlyphCount,
    textPathGlyphs,
    redundantClipPathCount: clipSimplified.removedCount,
  };
}

function removeRedundantRectangularPathClips(
  elements: string[],
  clipPathsById: Map<string, SvgClipPath>
): { elements: string[]; removedCount: number } {
  let removedCount = 0;
  const simplified = elements.map((element, index) => {
    if (!/<path\b/i.test(element)) return element;
    const role = readSvgElementAttr(element, 'data-object-role');
    if (!role || !['editable-vector', 'decoration-vector', 'text-outline'].includes(role)) return element;

    const clipAttr = readSvgElementAttr(element, 'clip-path');
    const clipId = /^url\(\s*#([^\s)]+)\s*\)$/i.exec(clipAttr || '')?.[1];
    if (!clipId) return element;
    const clipPath = clipPathsById.get(clipId);
    if (!clipPath) return element;

    const clipBounds = getSimpleAxisAlignedRectangleBounds(clipPath.pathData, clipPath.matrix);
    if (!clipBounds) return element;
    const pathInfo = parseSvgPathElementInfo(element, index);
    if (!pathInfo) return element;

    const stroke = pathInfo.stroke.trim().toLowerCase();
    const strokeWidth = stroke && stroke !== 'none'
      ? Math.max(0, Number(readSvgElementAttr(element, 'stroke-width')) || 0)
      : 0;
    const strokeScale = Math.max(
      Math.hypot(pathInfo.transform[0], pathInfo.transform[1]),
      Math.hypot(pathInfo.transform[2], pathInfo.transform[3]),
      1
    );
    const inset = 1 + strokeWidth * strokeScale * 0.5;
    if (
      pathInfo.bounds.left < clipBounds.left + inset
      || pathInfo.bounds.top < clipBounds.top + inset
      || pathInfo.bounds.right > clipBounds.right - inset
      || pathInfo.bounds.bottom > clipBounds.bottom - inset
    ) {
      return element;
    }

    removedCount++;
    return removeSvgElementAttr(element, 'clip-path');
  });
  return { elements: simplified, removedCount };
}

function getSimpleAxisAlignedRectangleBounds(pathData: string, matrix: Matrix): SvgBounds | null {
  if (!pathData || /[ACHQSTV]/i.test(pathData)) return null;
  const tokens = pathData.match(/[MLZmlz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  if (tokens.length === 0) return null;

  const points: Array<{ x: number; y: number }> = [];
  let current = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  let command = '';
  let moveCount = 0;
  let closeCount = 0;
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[MLZ]$/i.test(token)) {
      command = token;
      index++;
      if (command.toUpperCase() === 'Z') {
        closeCount++;
        current = { ...start };
        command = '';
      }
      continue;
    }
    if (!command || command.toUpperCase() === 'Z' || index + 1 >= tokens.length) return null;
    const rawX = Number(tokens[index]);
    const rawY = Number(tokens[index + 1]);
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return null;
    const relative = command === command.toLowerCase();
    const point = {
      x: relative ? current.x + rawX : rawX,
      y: relative ? current.y + rawY : rawY,
    };
    if (command.toUpperCase() === 'M') {
      moveCount++;
      if (moveCount > 1) return null;
      start = { ...point };
      command = relative ? 'l' : 'L';
    }
    points.push(point);
    current = point;
    index += 2;
  }

  if (moveCount !== 1 || closeCount !== 1) return null;
  if (points.length === 5 && areSvgPointsClose(points[0], points[4])) points.pop();
  if (points.length !== 4) return null;

  const transformed = points.map((point) => transformPoint(matrix, point.x, point.y));
  for (let pointIndex = 0; pointIndex < transformed.length; pointIndex++) {
    const currentPoint = transformed[pointIndex];
    const nextPoint = transformed[(pointIndex + 1) % transformed.length];
    if (
      Math.abs(currentPoint.x - nextPoint.x) > 0.01
      && Math.abs(currentPoint.y - nextPoint.y) > 0.01
    ) {
      return null;
    }
  }
  const xs = dedupeSvgCoordinates(transformed.map((point) => point.x));
  const ys = dedupeSvgCoordinates(transformed.map((point) => point.y));
  if (xs.length !== 2 || ys.length !== 2) return null;
  return boundsFromEdges(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

function areSvgPointsClose(
  left: { x: number; y: number },
  right: { x: number; y: number }
): boolean {
  return Math.abs(left.x - right.x) <= 0.01 && Math.abs(left.y - right.y) <= 0.01;
}

function dedupeSvgCoordinates(values: number[]): number[] {
  return values.reduce<number[]>((result, value) => {
    if (!result.some((existing) => Math.abs(existing - value) <= 0.01)) result.push(value);
    return result;
  }, []);
}

async function annotatePdfOperatorSvgObjectRoles(
  elements: string[],
  pageWidth: number,
  pageHeight: number
): Promise<{ elements: string[]; renderableVectorElementCount: number }> {
  const rasterInfos = elements
    .map((element, index) => parseSvgRasterElementInfo(element, index))
    .filter((info): info is SvgRasterElementInfo => Boolean(info));
  const rasterArtifactStats = new Map<number, SvgRasterArtifactStats>();
  await Promise.all(rasterInfos.map(async (info) => {
    if (!info.filePath) return;
    const stats = await analyzeSvgRasterArtifact(info.filePath);
    if (stats) rasterArtifactStats.set(info.index, stats);
  }));
  const pathInfos = new Map<number, SvgPathElementInfo>();
  elements.forEach((element, index) => {
    const pathInfo = parseSvgPathElementInfo(element, index);
    if (pathInfo) pathInfos.set(index, pathInfo);
  });
  const decorationClusters = buildDecorationVectorClusters(
    Array.from(pathInfos.values()),
    rasterInfos,
    pageWidth,
    pageHeight
  );

  let renderableVectorElementCount = 0;
  const annotated = elements.map((element, index) => {
    const rasterInfo = parseSvgRasterElementInfo(element, index);
    if (rasterInfo) {
      const classification = classifySvgRasterImageRole(
        rasterInfo,
        rasterInfos,
        Array.from(pathInfos.values()),
        decorationClusters,
        pageWidth,
        pageHeight,
        rasterArtifactStats
      );
      const role = classification.role;
      const clustered = role === 'decoration-effect-raster'
        ? withSvgDecorationClusterId(element, findDecorationClusterForRaster(rasterInfo, decorationClusters)?.id)
        : element;
      const reasoned = classification.artifactReason
        ? setSvgElementAttr(clustered, 'data-pdf-artifact-reason', classification.artifactReason)
        : clustered;
      return withSvgObjectRole(reasoned, role, role === 'mask-artifact');
    }

    if (!/<path\b/i.test(element)) return element;

    let role: SvgObjectRole = 'editable-vector';
    const pathInfo = pathInfos.get(index) || null;
    if (/\bdata-pdf-mask-artifact=["']true["']/i.test(element)) {
      role = 'mask-artifact';
    } else if (/\bdata-pdf-text-path=["']true["']/i.test(element)) {
      role = 'text-outline';
    } else if (pathInfo && isRasterMaskArtifactPath(pathInfo, rasterInfos, pageWidth, pageHeight)) {
      role = 'mask-artifact';
    } else if (pathInfo && isRasterReconstructionStripPath(pathInfo, rasterInfos, pageWidth, pageHeight)) {
      role = findDecorationClusterForPath(pathInfo, decorationClusters)
        ? 'decoration-gradient-strip'
        : 'raster-reconstruction-strip';
    } else if (pathInfo && findDecorationClusterForPath(pathInfo, decorationClusters)) {
      role = 'decoration-vector';
    } else if (pathInfo && isDecorationVectorPath(pathInfo, rasterInfos)) {
      role = 'decoration-vector';
    }

    const hidden = isHiddenSvgObjectRole(role);

    if (!hidden) {
      renderableVectorElementCount++;
    }

    const roleElement = hidden ? removeSvgElementAttr(element, 'clip-path') : element;
    const clustered = pathInfo
      ? withSvgDecorationClusterId(roleElement, findDecorationClusterForPath(pathInfo, decorationClusters)?.id)
      : roleElement;
    return withSvgObjectRole(clustered, role, hidden);
  });

  return { elements: annotated, renderableVectorElementCount };
}

async function addDecorationTextureOverlaysForClippedClusters(
  elements: string[],
  outSvgPath: string,
  pageWidth: number,
  pageHeight: number,
  snapshot: SourceCanvasSnapshot | null
): Promise<string[]> {
  if (!snapshot?.data) return elements;
  const rasterInfos = elements
    .map((element, index) => parseSvgRasterElementInfo(element, index))
    .filter((info): info is SvgRasterElementInfo => Boolean(info))
    .filter((info) => readSvgElementAttr(info.element, 'data-object-role') === 'editable-raster');
  if (rasterInfos.length === 0) return elements;

  const pathInfos = elements
    .map((element, index) => parseSvgPathElementInfo(element, index))
    .filter((info): info is SvgPathElementInfo => Boolean(info));
  const clusters = new Map<string, SvgPathElementInfo[]>();
  for (const pathInfo of pathInfos) {
    const role = readSvgElementAttr(pathInfo.element, 'data-object-role');
    if (role !== 'decoration-gradient-strip' && role !== 'decoration-vector') continue;
    const clusterId = readSvgElementAttr(pathInfo.element, 'data-pdf-cluster-id');
    if (!clusterId) continue;
    const bucket = clusters.get(clusterId) || [];
    bucket.push(pathInfo);
    clusters.set(clusterId, bucket);
  }
  if (clusters.size === 0) return elements;

  const pageBounds = boundsFromEdges(0, 0, pageWidth, pageHeight);
  const insertions = new Map<number, string[]>();
  for (const [clusterId, paths] of clusters) {
    const hasClippedGradient = paths.some((pathInfo) =>
      readSvgElementAttr(pathInfo.element, 'data-object-role') === 'decoration-gradient-strip'
      && /\bclip-path=["']/i.test(pathInfo.element)
    );
    if (!hasClippedGradient || paths.length < 8) continue;
    const clusterBounds = unionSvgBounds(paths.map((pathInfo) => pathInfo.bounds));
    if (!clusterBounds) continue;
    const clippedBounds = intersectBounds(pageBounds, clusterBounds);
    if (!clippedBounds) continue;
    const pageArea = Math.max(1, pageWidth * pageHeight);
    const clusterAreaRatio = Math.max(0, clippedBounds.width) * Math.max(0, clippedBounds.height) / pageArea;
    if (clusterAreaRatio <= 0 || clusterAreaRatio > 0.28) continue;

    const raster = rasterInfos.find((candidate) =>
      candidate.filePath
      && fs.existsSync(candidate.filePath)
      && (
        isBoundsInside(clippedBounds, candidate.bounds, 6)
        || getSvgBoundsOverlapRatio(clippedBounds, candidate.bounds) >= 0.6
      )
    );
    if (!raster?.filePath) continue;
    const visual = await createDecorationClusterTextureOverlay(
      clusterId,
      paths,
      raster,
      clippedBounds,
      snapshot,
      outSvgPath,
      pageWidth,
      pageHeight
    );
    if (!visual) continue;
    const insertIndex = Math.min(...paths.map((pathInfo) => pathInfo.index));
    const bucket = insertions.get(insertIndex) || [];
    bucket.push(visual);
    insertions.set(insertIndex, bucket);
  }

  if (insertions.size === 0) return elements;
  return elements.flatMap((element, index) => {
    const inserted = insertions.get(index);
    return inserted ? [...inserted, element] : element;
  });
}

async function createDecorationClusterTextureOverlay(
  clusterId: string,
  paths: SvgPathElementInfo[],
  raster: SvgRasterElementInfo,
  clusterBounds: SvgBounds,
  snapshot: SourceCanvasSnapshot,
  outSvgPath: string,
  pageWidth: number,
  pageHeight: number
): Promise<string | null> {
  if (!raster.filePath) return null;
  const x0 = clampInt(Math.floor(clusterBounds.left - 2), 0, pageWidth - 1);
  const y0 = clampInt(Math.floor(clusterBounds.top - 2), 0, pageHeight - 1);
  const x1 = clampInt(Math.ceil(clusterBounds.right + 2), x0 + 1, pageWidth);
  const y1 = clampInt(Math.ceil(clusterBounds.bottom + 2), y0 + 1, pageHeight);
  const cropWidth = x1 - x0;
  const cropHeight = y1 - y0;
  if (cropWidth <= 1 || cropHeight <= 1 || cropWidth * cropHeight > 1_500_000) return null;

  const mask = await renderDecorationClusterUnclippedMask(paths, boundsFromEdges(x0, y0, x1, y1), cropWidth, cropHeight);
  if (!mask) return null;

  const sharp = require('sharp');
  const { data: rasterData, info: rasterInfo } = await sharp(raster.filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rasterWidth = Number(rasterInfo.width || 0);
  const rasterHeight = Number(rasterInfo.height || 0);
  const rasterChannels = Number(rasterInfo.channels || 4);
  if (rasterWidth <= 1 || rasterHeight <= 1 || rasterChannels < 4) return null;

  const rasterMatrix = parseSvgTransformMatrix(readSvgElementAttr(raster.element, 'transform'));
  const inverseRasterMatrix = invertMatrix(rasterMatrix);
  if (!inverseRasterMatrix) return null;
  const imageX = Number(readSvgElementAttr(raster.element, 'x')) || 0;
  const imageY = Number(readSvgElementAttr(raster.element, 'y')) || 0;
  const imageWidth = Number(readSvgElementAttr(raster.element, 'width')) || rasterWidth;
  const imageHeight = Number(readSvgElementAttr(raster.element, 'height')) || rasterHeight;
  if (imageWidth <= 0 || imageHeight <= 0) return null;

  const overlay = Buffer.alloc(cropWidth * cropHeight * 4);
  let visiblePixels = 0;
  let minVisibleX = cropWidth;
  let minVisibleY = cropHeight;
  let maxVisibleX = -1;
  let maxVisibleY = -1;

  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      const maskAlpha = mask[y * cropWidth + x] ?? 0;
      if (maskAlpha <= 8) continue;
      const pageX = x0 + x;
      const pageY = y0 + y;
      const sourceOffset = (pageY * snapshot.width + pageX) * 4;
      if (sourceOffset + 3 >= snapshot.data.length) continue;
      const sourcePixel = {
        r: snapshot.data[sourceOffset] ?? 0,
        g: snapshot.data[sourceOffset + 1] ?? 0,
        b: snapshot.data[sourceOffset + 2] ?? 0,
        a: snapshot.data[sourceOffset + 3] ?? 255,
      };
      if (sourcePixel.a <= 8) continue;

      const local = transformPoint(inverseRasterMatrix, pageX + 0.5, pageY + 0.5);
      const rasterX = Math.round(((local.x - imageX) / imageWidth) * (rasterWidth - 1));
      const rasterY = Math.round(((local.y - imageY) / imageHeight) * (rasterHeight - 1));
      if (rasterX < 0 || rasterY < 0 || rasterX >= rasterWidth || rasterY >= rasterHeight) continue;
      const rasterOffset = (rasterY * rasterWidth + rasterX) * rasterChannels;
      const rasterPixel = {
        r: rasterData[rasterOffset] ?? 0,
        g: rasterData[rasterOffset + 1] ?? 0,
        b: rasterData[rasterOffset + 2] ?? 0,
        a: rasterData[rasterOffset + 3] ?? 255,
      };
      const alphaDiff = Math.abs(sourcePixel.a - rasterPixel.a);
      const colorDiff = colorDistance(sourcePixel, rasterPixel);
      if (alphaDiff < 24 && colorDiff < 18) continue;

      const targetOffset = (y * cropWidth + x) * 4;
      overlay[targetOffset] = sourcePixel.r;
      overlay[targetOffset + 1] = sourcePixel.g;
      overlay[targetOffset + 2] = sourcePixel.b;
      overlay[targetOffset + 3] = Math.min(sourcePixel.a, maskAlpha);
      visiblePixels++;
      if (x < minVisibleX) minVisibleX = x;
      if (y < minVisibleY) minVisibleY = y;
      if (x > maxVisibleX) maxVisibleX = x;
      if (y > maxVisibleY) maxVisibleY = y;
    }
  }

  if (visiblePixels < 32 || maxVisibleX < minVisibleX || maxVisibleY < minVisibleY) return null;
  const trimmedWidth = maxVisibleX - minVisibleX + 1;
  const trimmedHeight = maxVisibleY - minVisibleY + 1;
  const trimmed = Buffer.alloc(trimmedWidth * trimmedHeight * 4);
  for (let y = 0; y < trimmedHeight; y++) {
    const sourceStart = ((minVisibleY + y) * cropWidth + minVisibleX) * 4;
    const targetStart = y * trimmedWidth * 4;
    overlay.copy(trimmed, targetStart, sourceStart, sourceStart + trimmedWidth * 4);
  }

  const texturePath = buildDecorationClusterTexturePath(outSvgPath, clusterId);
  await sharp(trimmed, {
    raw: { width: trimmedWidth, height: trimmedHeight, channels: 4 },
  }).png().toFile(texturePath);
  const href = `/uploads/${path.relative(STORAGE.base, texturePath).replace(/\\/g, '/')}`;
  return `<image data-object-role="decoration-texture-fill" data-pdf-texture-fill="true" data-pdf-decoration-visual-from-cluster="true" href="${escapeXml(href)}" xlink:href="${escapeXml(href)}" x="${formatNum(x0 + minVisibleX)}" y="${formatNum(y0 + minVisibleY)}" width="${formatNum(trimmedWidth)}" height="${formatNum(trimmedHeight)}" preserveAspectRatio="none" data-pdf-cluster-id="${escapeXml(clusterId)}" />`;
}

async function renderDecorationClusterUnclippedMask(
  paths: SvgPathElementInfo[],
  bounds: SvgBounds,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  const maskElements = paths.map((pathInfo) => {
    let element = svgPathElementForMask(pathInfo.element);
    element = removeSvgElementAttr(element, 'clip-path');
    return element;
  });
  if (maskElements.length === 0) return null;
  const viewBox = [
    formatNum(bounds.left),
    formatNum(bounds.top),
    formatNum(bounds.width),
    formatNum(bounds.height),
  ].join(' ');
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="${viewBox}">`,
    ...maskElements,
    `</svg>`,
  ].join('\n');
  const sharp = require('sharp');
  const { data, info } = await sharp(Buffer.from(svg))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (Number(info.width) !== width || Number(info.height) !== height) return null;
  const mask = new Uint8Array(width * height);
  let maskedPixels = 0;
  for (let index = 0; index < mask.length; index++) {
    const offset = index * Number(info.channels || 4);
    const alpha = data[offset + 3] ?? 0;
    if (alpha <= 10) continue;
    mask[index] = alpha;
    maskedPixels++;
  }
  return maskedPixels >= 16 ? mask : null;
}

function classifySvgRasterImageRole(
  rasterInfo: SvgRasterElementInfo,
  rasterInfos: SvgRasterElementInfo[],
  pathInfos: SvgPathElementInfo[],
  decorationClusters: DecorationVectorCluster[],
  pageWidth: number,
  pageHeight: number,
  rasterArtifactStats: Map<number, SvgRasterArtifactStats>
): SvgRasterRoleClassification {
  const artifactStats = rasterArtifactStats.get(rasterInfo.index) || null;
  if (artifactStats?.maskLike) return { role: 'mask-artifact' };
  if (isSameBoundsMonochromeRasterMask(
    rasterInfo,
    rasterInfos,
    pageWidth,
    pageHeight,
    rasterArtifactStats
  )) {
    return { role: 'mask-artifact', artifactReason: 'same-bounds-monochrome-raster-mask' };
  }
  if (isOversizedDecorationShadowArtifact(
    rasterInfo,
    rasterInfos,
    decorationClusters,
    pageWidth,
    pageHeight,
    rasterArtifactStats
  )) {
    return { role: 'mask-artifact', artifactReason: 'oversized-shadow-effect' };
  }
  if (isSimpleMarkerShadowArtifact(
    rasterInfo,
    rasterInfos,
    pathInfos,
    pageWidth,
    pageHeight,
    rasterArtifactStats
  )) {
    return { role: 'mask-artifact', artifactReason: 'simple-mark-shadow-effect' };
  }
  if (isDecorationEffectRasterImage(
    rasterInfo,
    rasterInfos,
    decorationClusters,
    pageWidth,
    pageHeight,
    rasterArtifactStats
  )) {
    return { role: 'decoration-effect-raster' };
  }
  const role = isNearFullPageBounds(rasterInfo.bounds, pageWidth, pageHeight)
    ? 'visual-raster'
    : 'editable-raster';
  return { role };
}

function isSameBoundsMonochromeRasterMask(
  rasterInfo: SvgRasterElementInfo,
  rasterInfos: SvgRasterElementInfo[],
  pageWidth: number,
  pageHeight: number,
  rasterArtifactStats: Map<number, SvgRasterArtifactStats>
): boolean {
  const stats = rasterArtifactStats.get(rasterInfo.index) || null;
  if (!stats) return false;
  if (isNearFullPageBounds(rasterInfo.bounds, pageWidth, pageHeight)) return false;
  const pageArea = Math.max(1, pageWidth * pageHeight);
  const areaRatio = getSvgBoundsArea(rasterInfo.bounds) / pageArea;
  if (areaRatio <= 0 || areaRatio > 0.28) return false;

  const sameBoundsGroup = rasterInfos.filter((candidate) =>
    candidate.index !== rasterInfo.index
    && areSvgBoundsSame(candidate.bounds, rasterInfo.bounds, 2)
  );
  if (sameBoundsGroup.length === 0) return false;

  const siblingStats = sameBoundsGroup
    .map((candidate) => rasterArtifactStats.get(candidate.index) || null)
    .filter((item): item is SvgRasterArtifactStats => Boolean(item));
  if (siblingStats.length === 0) return false;

  const isMonochromeMask =
    stats.monochromeRatio >= 0.94
    && stats.saturatedRatio < 0.06
    && stats.darkRatio >= 0.18
    && stats.lightRatio >= 0.12
    && stats.darkRatio + stats.lightRatio >= 0.82
    && stats.midRatio < 0.16;
  if (!isMonochromeMask) return false;

  return siblingStats.some((sibling) =>
    sibling.contentLike === true
    || sibling.saturatedRatio >= 0.25
    || sibling.monochromeRatio <= 0.72
  );
}

function isOversizedDecorationShadowArtifact(
  rasterInfo: SvgRasterElementInfo,
  rasterInfos: SvgRasterElementInfo[],
  decorationClusters: DecorationVectorCluster[],
  pageWidth: number,
  pageHeight: number,
  rasterArtifactStats: Map<number, SvgRasterArtifactStats>
): boolean {
  const artifactStats = rasterArtifactStats.get(rasterInfo.index) || null;
  if (!artifactStats || artifactStats.maskLike) return false;
  if (isNearFullPageBounds(rasterInfo.bounds, pageWidth, pageHeight)) return false;
  if (findDecorationClusterForRaster(rasterInfo, decorationClusters)) return false;

  const pageArea = Math.max(1, pageWidth * pageHeight);
  const areaRatio = getSvgBoundsArea(rasterInfo.bounds) / pageArea;
  const widthRatio = rasterInfo.bounds.width / Math.max(1, pageWidth);
  const heightRatio = rasterInfo.bounds.height / Math.max(1, pageHeight);
  if (areaRatio < 0.045) return false;
  if (heightRatio < 0.25 && widthRatio < 0.25) return false;

  const sameBoundsGroup = rasterInfos.filter((candidate) =>
    areSvgBoundsSame(candidate.bounds, rasterInfo.bounds, 2)
  );
  if (sameBoundsGroup.length < 2) return false;

  const groupStats = sameBoundsGroup
    .map((candidate) => rasterArtifactStats.get(candidate.index) || null)
    .filter((stats): stats is SvgRasterArtifactStats => Boolean(stats));
  return groupStats.some(isSoftDecorationEffectRasterStats)
    && (
      isSoftDecorationEffectRasterStats(artifactStats)
      || isTintedDecorationEffectRasterStats(artifactStats)
      || sameBoundsGroup.length >= 2
    );
}

function isSimpleMarkerShadowArtifact(
  rasterInfo: SvgRasterElementInfo,
  rasterInfos: SvgRasterElementInfo[],
  pathInfos: SvgPathElementInfo[],
  pageWidth: number,
  pageHeight: number,
  rasterArtifactStats: Map<number, SvgRasterArtifactStats>
): boolean {
  const artifactStats = rasterArtifactStats.get(rasterInfo.index) || null;
  if (!artifactStats || artifactStats.maskLike) return false;
  if (isNearFullPageBounds(rasterInfo.bounds, pageWidth, pageHeight)) return false;

  const pageArea = Math.max(1, pageWidth * pageHeight);
  const rasterArea = getSvgBoundsArea(rasterInfo.bounds);
  if (rasterArea / pageArea > 0.04) return false;
  if (rasterInfo.bounds.width / Math.max(1, pageWidth) > 0.18) return false;
  if (rasterInfo.bounds.height / Math.max(1, pageHeight) > 0.2) return false;

  const sameBoundsGroup = rasterInfos.filter((candidate) =>
    areSvgBoundsSame(candidate.bounds, rasterInfo.bounds, 2)
  );
  if (sameBoundsGroup.length < 2) return false;

  const groupStats = sameBoundsGroup
    .map((candidate) => rasterArtifactStats.get(candidate.index) || null)
    .filter((stats): stats is SvgRasterArtifactStats => Boolean(stats));
  if (groupStats.length < 2) return false;
  if (!groupStats.some(isSoftDecorationEffectRasterStats)) return false;
  if (!groupStats.every((stats) =>
    isSoftDecorationEffectRasterStats(stats)
    || isTintedDecorationEffectRasterStats(stats)
    || (
      stats.contentLike !== true
      && stats.darkRatio >= 0.62
      && stats.lightRatio < 0.1
      && stats.monochromeRatio >= 0.78
      && stats.saturatedRatio < 0.16
    )
  )) return false;

  return pathInfos.some((pathInfo) => isSimpleLightMarkerPathNearRaster(pathInfo, rasterInfo.bounds, pageWidth, pageHeight));
}

function isSimpleLightMarkerPathNearRaster(
  pathInfo: SvgPathElementInfo,
  rasterBounds: SvgBounds,
  pageWidth: number,
  pageHeight: number
): boolean {
  const fill = parseSvgRgbColor(pathInfo.fill);
  if (!fill) return false;
  const max = Math.max(fill.r, fill.g, fill.b);
  const min = Math.min(fill.r, fill.g, fill.b);
  const brightness = (fill.r + fill.g + fill.b) / 3;
  if (brightness < 235 || max - min > 28) return false;

  const stroke = pathInfo.stroke.trim().toLowerCase();
  if (stroke && stroke !== 'none') return false;

  const markerArea = getSvgBoundsArea(pathInfo.bounds);
  const rasterArea = getSvgBoundsArea(rasterBounds);
  if (markerArea < 16 || rasterArea <= 0) return false;
  if (markerArea > rasterArea * 0.24) return false;
  if (pathInfo.bounds.width > rasterBounds.width * 0.7) return false;
  if (pathInfo.bounds.height > rasterBounds.height * 0.7) return false;
  if (pathInfo.bounds.width > pageWidth * 0.08) return false;
  if (pathInfo.bounds.height > pageHeight * 0.1) return false;
  if (pathInfo.commandCount > 16) return false;

  if (isBoundsInside(pathInfo.bounds, rasterBounds, 8)) return true;
  if (getSvgBoundsOverlapRatio(pathInfo.bounds, rasterBounds) >= 0.55) return true;
  const centerX = pathInfo.bounds.left + (pathInfo.bounds.width / 2);
  const centerY = pathInfo.bounds.top + (pathInfo.bounds.height / 2);
  return centerX >= rasterBounds.left - 4
    && centerX <= rasterBounds.right + 4
    && centerY >= rasterBounds.top - 4
    && centerY <= rasterBounds.bottom + 4;
}

function isDecorationEffectRasterImage(
  rasterInfo: SvgRasterElementInfo,
  rasterInfos: SvgRasterElementInfo[],
  decorationClusters: DecorationVectorCluster[],
  pageWidth: number,
  pageHeight: number,
  rasterArtifactStats: Map<number, SvgRasterArtifactStats>
): boolean {
  const artifactStats = rasterArtifactStats.get(rasterInfo.index) || null;
  if (!artifactStats) return false;
  if (isNearFullPageBounds(rasterInfo.bounds, pageWidth, pageHeight)) return false;

  const pageArea = Math.max(1, pageWidth * pageHeight);
  const rasterArea = getSvgBoundsArea(rasterInfo.bounds);
  if (rasterArea / pageArea > 0.24) return false;

  const sameBoundsGroup = rasterInfos.filter((candidate) =>
    areSvgBoundsSame(candidate.bounds, rasterInfo.bounds, 2)
  );
  if (sameBoundsGroup.length < 2) return false;

  const groupStats = sameBoundsGroup
    .map((candidate) => rasterArtifactStats.get(candidate.index) || null)
    .filter((stats): stats is SvgRasterArtifactStats => Boolean(stats));
  const hasSoftShadowLayer = groupStats.some(isSoftDecorationEffectRasterStats);
  const hasNearbyDecorationCluster = Boolean(findDecorationClusterForRaster(rasterInfo, decorationClusters));

  return isSoftDecorationEffectRasterStats(artifactStats)
    || (
      hasSoftShadowLayer
      && (hasNearbyDecorationCluster || isTintedDecorationEffectRasterStats(artifactStats))
    );
}

function isSoftDecorationEffectRasterStats(stats: SvgRasterArtifactStats): boolean {
  return stats.maskLike !== true
    && stats.monochromeRatio >= 0.86
    && stats.saturatedRatio < 0.12
    && stats.darkRatio >= 0.3
    && stats.lightRatio < 0.08
    && stats.contentLike !== true;
}

function isTintedDecorationEffectRasterStats(stats: SvgRasterArtifactStats): boolean {
  return stats.maskLike !== true
    && stats.saturatedRatio >= 0.82
    && stats.darkRatio >= 0.62
    && stats.lightRatio < 0.08
    && stats.midRatio < 0.34;
}

async function cleanDecorationOverprintedRasters(
  elements: string[],
  defs: string[],
  outSvgPath: string,
  pageWidth: number,
  pageHeight: number,
  snapshot: SourceCanvasSnapshot | null
): Promise<string[]> {
  const rasterInfos = elements
    .map((element, index) => parseSvgRasterElementInfo(element, index))
    .filter((info): info is SvgRasterElementInfo => Boolean(info))
    .filter((info) => readSvgElementAttr(info.element, 'data-object-role') === 'editable-raster');
  if (rasterInfos.length === 0) return elements;

  const pathInfos = elements
    .map((element, index) => parseSvgPathElementInfo(element, index))
    .filter((info): info is SvgPathElementInfo => Boolean(info));
  const targets = findDecorationRasterCleanTargets(pathInfos, rasterInfos, pageWidth, pageHeight);
  if (targets.length === 0) return elements;

  const nextElements = [...elements];
  const insertions = new Map<number, string[]>();
  let cleanedCount = 0;
  for (const target of targets) {
    const cleaned = await cleanRasterUnderDecorationTarget(target, defs, outSvgPath, snapshot);
    if (!cleaned) continue;
    nextElements[target.raster.index] = cleaned.element;
    if (cleaned.visualElement) {
      const bucket = insertions.get(target.raster.index) || [];
      bucket.push(cleaned.visualElement);
      insertions.set(target.raster.index, bucket);
    }
    cleanedCount++;
  }

  if (cleanedCount > 0) {
    logger.info(
      { scope: 'pdf', cleanedDecorationRasters: cleanedCount, outSvgPath },
      'PDF: cleaned overprinted decoration pixels from editable raster'
    );
  }
  if (insertions.size === 0) return nextElements;
  return nextElements.flatMap((element, index) => {
    const inserted = insertions.get(index);
    return inserted ? [element, ...inserted] : [element];
  });
}

function findDecorationRasterCleanTargets(
  pathInfos: SvgPathElementInfo[],
  rasterInfos: SvgRasterElementInfo[],
  pageWidth: number,
  pageHeight: number
): DecorationRasterCleanTarget[] {
  const decorationSeeds = pathInfos.filter((pathInfo) => {
    const role = readSvgElementAttr(pathInfo.element, 'data-object-role');
    return role === 'decoration-vector' || role === 'decoration-gradient-strip';
  });
  if (decorationSeeds.length <= 1) return [];

  type DecorationCluster = {
    bounds: SvgBounds;
    seeds: SvgPathElementInfo[];
    clusterId?: string;
  };
  const clusters: DecorationCluster[] = [];
  const assignedSeedIndexes = new Set<number>();
  const seedsByClusterId = new Map<string, SvgPathElementInfo[]>();
  for (const seed of decorationSeeds) {
    const clusterId = readSvgElementAttr(seed.element, 'data-pdf-cluster-id');
    if (!clusterId) continue;
    const bucket = seedsByClusterId.get(clusterId) || [];
    bucket.push(seed);
    seedsByClusterId.set(clusterId, bucket);
    assignedSeedIndexes.add(seed.index);
  }
  for (const [clusterId, seeds] of seedsByClusterId) {
    const bounds = unionSvgBounds(seeds.map((seed) => seed.bounds));
    if (bounds) clusters.push({ bounds, seeds, clusterId });
  }

  // Older SVGs may not have parser cluster ids. Keep the geometric fallback
  // isolated to those unassigned paths so it cannot merge two known groups.
  for (const seed of decorationSeeds) {
    if (assignedSeedIndexes.has(seed.index)) continue;
    const matches = clusters.filter((cluster) => areSvgBoundsNear(cluster.bounds, seed.bounds, 18));
    const fallbackMatches = matches.filter((cluster) => !cluster.clusterId);
    if (fallbackMatches.length === 0) {
      clusters.push({ bounds: { ...seed.bounds }, seeds: [seed] });
      continue;
    }

    const [primary, ...duplicates] = fallbackMatches;
    primary.seeds.push(seed);
    primary.bounds = unionSvgBounds([primary.bounds, seed.bounds]) || primary.bounds;
    duplicates.forEach((cluster) => {
      primary.seeds.push(...cluster.seeds);
      primary.bounds = unionSvgBounds([primary.bounds, cluster.bounds]) || primary.bounds;
      const index = clusters.indexOf(cluster);
      if (index >= 0) clusters.splice(index, 1);
    });
  }

  const pageArea = Math.max(1, pageWidth * pageHeight);
  const targets: DecorationRasterCleanTarget[] = [];
  for (const raster of rasterInfos) {
    const rasterArea = Math.max(0, raster.bounds.width) * Math.max(0, raster.bounds.height);
    if (rasterArea / pageArea < 0.08) continue;
    if (!raster.filePath || !fs.existsSync(raster.filePath)) continue;

    const matchingClusters = clusters.filter((cluster) => {
      if (cluster.seeds.length < 2) return false;
      const clusterArea = Math.max(0, cluster.bounds.width) * Math.max(0, cluster.bounds.height);
      if (clusterArea / pageArea > 0.35) return false;
      if (cluster.seeds.every((seed) => seed.index <= raster.index)) return false;
      return isBoundsInside(cluster.bounds, raster.bounds, 3)
        || getSvgBoundsOverlapRatio(cluster.bounds, raster.bounds) >= 0.75;
    });
    if (matchingClusters.length === 0) continue;

    const candidates = matchingClusters
      .map((cluster) => {
        const paths = pathInfos.filter((pathInfo) =>
          pathInfo.index > raster.index
          && shouldUsePathForDecorationRasterMask(pathInfo, cluster)
        );
        const pathArea = paths.reduce((sum, pathInfo) => sum + getSvgBoundsArea(pathInfo.bounds), 0);
        return {
          cluster,
          paths,
          // Prefer the parser's most substantial semantic group. Cleaning one
          // group per source raster avoids overwriting the same cleaned asset
          // and assigning a multi-group texture to an unrelated proxy.
          score: (cluster.seeds.length * 1_000_000) + pathArea,
        };
      })
      .filter((candidate) => candidate.paths.length >= 2)
      .sort((left, right) => right.score - left.score);
    const best = candidates[0];
    if (!best) continue;
    targets.push({
      raster,
      paths: best.paths,
      clusterBounds: best.cluster.bounds,
      clusterId: best.cluster.clusterId,
    });
  }

  return targets;
}

function shouldUsePathForDecorationRasterMask(
  pathInfo: SvgPathElementInfo,
  cluster: { bounds: SvgBounds; clusterId?: string }
): boolean {
  if (/\bdisplay=["']none["']/i.test(pathInfo.element)) return false;
  const role = readSvgElementAttr(pathInfo.element, 'data-object-role');
  const allowedRole =
    role === 'decoration-vector'
    || role === 'decoration-gradient-strip'
    || role === 'editable-vector'
    || role === 'text-outline';
  if (!allowedRole) return false;
  if (cluster.clusterId) {
    return readSvgElementAttr(pathInfo.element, 'data-pdf-cluster-id') === cluster.clusterId;
  }
  return isBoundsInside(pathInfo.bounds, cluster.bounds, 14)
    || getSvgBoundsOverlapRatio(pathInfo.bounds, cluster.bounds) >= 0.35
    || areSvgBoundsNear(pathInfo.bounds, cluster.bounds, 14);
}

async function cleanRasterUnderDecorationTarget(
  target: DecorationRasterCleanTarget,
  defs: string[],
  outSvgPath: string,
  snapshot: SourceCanvasSnapshot | null
): Promise<DecorationRasterCleanResult | null> {
  if (!target.raster.filePath || !fs.existsSync(target.raster.filePath)) return null;
  try {
    const sharp = require('sharp');
    const { data, info } = await sharp(target.raster.filePath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const width = Number(info.width || 0);
    const height = Number(info.height || 0);
    const channels = Number(info.channels || 4);
    if (width <= 1 || height <= 1 || channels < 4) return null;

    const mask = await renderDecorationMask(target, defs, width, height);
    if (!mask) return null;
    const maskStats = getBinaryMaskTightCoverage(mask, width, height);
    if (
      maskStats
      && maskStats.cropWidth >= 12
      && maskStats.cropHeight >= 6
      && maskStats.coverage >= 0.78
    ) {
      logger.debug(
        {
          scope: 'pdf',
          filePath: target.raster.filePath,
          clusterId: target.clusterId,
          coverage: maskStats.coverage,
          cropWidth: maskStats.cropWidth,
          cropHeight: maskStats.cropHeight,
        },
        'PDF: skipped overly dense decoration raster mask',
      );
      return null;
    }
    const vectorVisual = snapshot?.data
      ? await renderDecorationVisual(target, defs, width, height)
      : null;
    const visualElement = await createDecorationTextureFillElement(
      target,
      data,
      width,
      height,
      channels,
      mask,
      sharp,
      snapshot,
      vectorVisual,
    );
    const cleanedPixels = fillDecorationMaskedRasterPixels(data, width, height, channels, mask);
    const coverage = cleanedPixels / Math.max(1, width * height);
    if (cleanedPixels < 16 || coverage > 0.32) return null;

    const cleanedPath = buildDecorationCleanRasterPath(target.raster.filePath);
    await sharp(data, {
      raw: { width, height, channels },
    }).png().toFile(cleanedPath);
    const href = `/uploads/${path.relative(STORAGE.base, cleanedPath).replace(/\\/g, '/')}`;
    const element = setSvgElementAttr(
      setSvgElementAttr(
        setSvgElementAttr(target.raster.element, 'href', href),
        'xlink:href',
        href
      ),
      'data-pdf-raster-decor-cleaned',
      'true'
    );
    return { element, visualElement: visualElement || undefined };
  } catch (err) {
    logger.warn({ scope: 'pdf', err, filePath: target.raster.filePath }, 'PDF: decoration raster clean failed');
    return null;
  }
}

async function createDecorationTextureFillElement(
  target: DecorationRasterCleanTarget,
  data: Uint8Array,
  width: number,
  height: number,
  channels: number,
  mask: Uint8Array,
  sharp: any,
  snapshot: SourceCanvasSnapshot | null,
  vectorVisual: Uint8Array | null,
): Promise<string | null> {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let visiblePixels = 0;
  const retainMask = new Uint8Array(mask.length);
  let comparedPixels = 0;
  let retainedPixels = 0;
  const hasPreviewComparison = Boolean(snapshot?.data && vectorVisual?.length === width * height * 4);
  for (let index = 0; index < mask.length; index++) {
    if (!mask[index]) continue;
    const offset = index * channels;
    const alpha = data[offset + 3] ?? 255;
    if (alpha <= 8) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    let retain = true;
    if (hasPreviewComparison && snapshot) {
      const visualOffset = index * 4;
      const vectorAlpha = vectorVisual?.[visualOffset + 3] ?? 0;
      retain = false;
      if (vectorAlpha > 24) {
        const pageX = target.raster.bounds.left + ((x + 0.5) / width) * target.raster.bounds.width;
        const pageY = target.raster.bounds.top + ((y + 0.5) / height) * target.raster.bounds.height;
        const snapshotX = Math.round(pageX);
        const snapshotY = Math.round(pageY);
        if (
          snapshotX >= 0
          && snapshotY >= 0
          && snapshotX < snapshot.width
          && snapshotY < snapshot.height
        ) {
          const snapshotOffset = (snapshotY * snapshot.width + snapshotX) * 4;
          const sourcePixel = {
            r: snapshot.data[snapshotOffset] ?? 0,
            g: snapshot.data[snapshotOffset + 1] ?? 0,
            b: snapshot.data[snapshotOffset + 2] ?? 0,
          };
          const rasterPixel = {
            r: data[offset] ?? 0,
            g: data[offset + 1] ?? 0,
            b: data[offset + 2] ?? 0,
          };
          const vectorPixel = {
            r: vectorVisual?.[visualOffset] ?? 0,
            g: vectorVisual?.[visualOffset + 1] ?? 0,
            b: vectorVisual?.[visualOffset + 2] ?? 0,
          };
          const rasterError = colorDistance(rasterPixel, sourcePixel);
          const vectorError = colorDistance(vectorPixel, sourcePixel);
          retain = rasterError + 14 < vectorError;
          comparedPixels++;
        }
      }
    }
    if (!retain) continue;
    retainMask[index] = 1;
    retainedPixels++;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    visiblePixels++;
  }
  if (
    visiblePixels < 16
    || retainedPixels < 16
    || (hasPreviewComparison && comparedPixels < 16)
    || maxX < minX
    || maxY < minY
  ) return null;

  // Flat raster underprints are already represented by the decoration vectors.
  // Keeping them as a second image causes visible ghosts when Fabric rounds the
  // image and vector transforms differently. Preserve only real texture/gradient
  // detail that the vector paths cannot carry on their own.
  if (!hasMeaningfulDecorationTexture(data, channels, retainMask)) return null;

  const cropWidth = maxX - minX + 1;
  const cropHeight = maxY - minY + 1;
  if (cropWidth <= 1 || cropHeight <= 1 || cropWidth * cropHeight > 1_500_000) return null;

  const overlay = Buffer.alloc(cropWidth * cropHeight * 4);
  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      const sourceX = minX + x;
      const sourceY = minY + y;
      const sourceIndex = sourceY * width + sourceX;
      if (!retainMask[sourceIndex]) continue;
      const sourceOffset = sourceIndex * channels;
      const alpha = data[sourceOffset + 3] ?? 255;
      if (alpha <= 8) continue;
      const targetOffset = (y * cropWidth + x) * 4;
      overlay[targetOffset] = data[sourceOffset] ?? 0;
      overlay[targetOffset + 1] = data[sourceOffset + 1] ?? 0;
      overlay[targetOffset + 2] = data[sourceOffset + 2] ?? 0;
      overlay[targetOffset + 3] = alpha;
    }
  }

  if (!target.raster.filePath) return null;
  const texturePath = buildDecorationTextureRasterPath(target.raster.filePath);
  await sharp(overlay, {
    raw: { width: cropWidth, height: cropHeight, channels: 4 },
  }).png().toFile(texturePath);
  const href = `/uploads/${path.relative(STORAGE.base, texturePath).replace(/\\/g, '/')}`;
  const clusterId = getDecorationRasterCleanTargetClusterId(target);
  const sourceX = Number(readSvgElementAttr(target.raster.element, 'x')) || 0;
  const sourceY = Number(readSvgElementAttr(target.raster.element, 'y')) || 0;
  let element = target.raster.element;
  element = removeSvgElementAttr(element, 'data-pdf-raster');
  element = removeSvgElementAttr(element, 'data-pdf-raster-decor-cleaned');
  element = setSvgElementAttr(element, 'href', href);
  element = setSvgElementAttr(element, 'xlink:href', href);
  element = setSvgElementAttr(element, 'x', formatNum(sourceX + minX));
  element = setSvgElementAttr(element, 'y', formatNum(sourceY + minY));
  element = setSvgElementAttr(element, 'width', formatNum(cropWidth));
  element = setSvgElementAttr(element, 'height', formatNum(cropHeight));
  element = setSvgElementAttr(element, 'data-object-role', 'decoration-texture-fill');
  element = setSvgElementAttr(element, 'data-pdf-texture-fill', 'true');
  element = setSvgElementAttr(element, 'data-pdf-decoration-visual-from-raster', 'true');
  if (clusterId) {
    element = setSvgElementAttr(element, 'data-pdf-cluster-id', clusterId);
  }
  return element;
}

function hasMeaningfulDecorationTexture(
  data: Uint8Array,
  channels: number,
  retainMask: Uint8Array,
): boolean {
  let count = 0;
  const sums = [0, 0, 0];
  const squareSums = [0, 0, 0];
  const quantizedColors = new Set<number>();

  for (let index = 0; index < retainMask.length; index++) {
    if (!retainMask[index]) continue;
    const offset = index * channels;
    const alpha = data[offset + 3] ?? 255;
    if (alpha <= 8) continue;
    const red = data[offset] ?? 0;
    const green = data[offset + 1] ?? 0;
    const blue = data[offset + 2] ?? 0;
    const values = [red, green, blue];
    for (let channel = 0; channel < 3; channel++) {
      sums[channel] += values[channel];
      squareSums[channel] += values[channel] * values[channel];
    }
    quantizedColors.add(((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4));
    count++;
  }

  if (count < 16) return false;
  const maxChannelDeviation = Math.max(...sums.map((sum, channel) => {
    const mean = sum / count;
    const variance = Math.max(0, (squareSums[channel] / count) - (mean * mean));
    return Math.sqrt(variance);
  }));

  return maxChannelDeviation >= 24 || quantizedColors.size >= 96;
}

async function renderDecorationVisual(
  target: DecorationRasterCleanTarget,
  defs: string[],
  width: number,
  height: number,
): Promise<Uint8Array | null> {
  const visualElements = target.paths.map((pathInfo) => removeSvgElementAttr(pathInfo.element, 'display'));
  if (visualElements.length === 0) return null;
  const viewBox = [
    formatNum(target.raster.bounds.left),
    formatNum(target.raster.bounds.top),
    formatNum(target.raster.bounds.width),
    formatNum(target.raster.bounds.height),
  ].join(' ');
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="${viewBox}">`,
    ...defs,
    ...visualElements,
    `</svg>`,
  ].join('\n');
  try {
    const sharp = require('sharp');
    const { data, info } = await sharp(Buffer.from(svg, 'utf8'))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (Number(info.width) !== width || Number(info.height) !== height || Number(info.channels) < 4) {
      return null;
    }
    return new Uint8Array(data);
  } catch {
    return null;
  }
}

function getDecorationRasterCleanTargetClusterId(target: DecorationRasterCleanTarget): string | null {
  if (target.clusterId) return target.clusterId;
  for (const pathInfo of target.paths) {
    const clusterId = readSvgElementAttr(pathInfo.element, 'data-pdf-cluster-id');
    if (clusterId) return clusterId;
  }
  return null;
}

async function renderDecorationMask(
  target: DecorationRasterCleanTarget,
  defs: string[],
  width: number,
  height: number
): Promise<Uint8Array | null> {
  const maskElements = target.paths.map((pathInfo) => svgPathElementForMask(pathInfo.element));
  if (maskElements.length === 0) return null;
  const viewBox = [
    formatNum(target.raster.bounds.left),
    formatNum(target.raster.bounds.top),
    formatNum(target.raster.bounds.width),
    formatNum(target.raster.bounds.height),
  ].join(' ');
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="${viewBox}">`,
    ...defs,
    ...maskElements,
    `</svg>`,
  ].join('\n');
  const sharp = require('sharp');
  const { data, info } = await sharp(Buffer.from(svg))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (Number(info.width) !== width || Number(info.height) !== height) return null;

  const mask = new Uint8Array(width * height);
  let maskedPixels = 0;
  for (let index = 0; index < mask.length; index++) {
    const offset = index * Number(info.channels || 4);
    const alpha = data[offset + 3] ?? 0;
    if (alpha <= 10) continue;
    mask[index] = 1;
    maskedPixels++;
  }
  if (maskedPixels < 16) return null;
  // A wide dilation turns small glyph masks into visible rectangular halos
  // after background reconstruction. One pixel is enough for antialiasing.
  return dilateBinaryMask(mask, width, height, 1);
}

function getBinaryMaskTightCoverage(
  mask: Uint8Array,
  width: number,
  height: number,
): { coverage: number; cropWidth: number; cropHeight: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let activePixels = 0;
  for (let index = 0; index < mask.length; index++) {
    if (!mask[index]) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    activePixels++;
  }
  if (activePixels === 0 || maxX < minX || maxY < minY) return null;
  const cropWidth = maxX - minX + 1;
  const cropHeight = maxY - minY + 1;
  return {
    coverage: activePixels / Math.max(1, cropWidth * cropHeight),
    cropWidth,
    cropHeight,
  };
}

function svgPathElementForMask(element: string): string {
  let output = removeSvgElementAttr(element, 'data-object-role');
  output = removeSvgElementAttr(output, 'data-pdf-text-path');
  output = removeSvgElementAttr(output, 'data-pdf-text-glyph-id');
  output = removeSvgElementAttr(output, 'data-pdf-text-run-id');
  output = removeSvgElementAttr(output, 'data-pdf-text-glyph-index');
  output = removeSvgElementAttr(output, 'data-pdf-text-writing-mode');
  output = removeSvgElementAttr(output, 'data-pdf-text-matrix');
  output = removeSvgElementAttr(output, 'data-pdf-text-rotation');
  output = removeSvgElementAttr(output, 'data-pdf-text-bounds');
  output = removeSvgElementAttr(output, 'display');
  output = setSvgElementAttr(output, 'fill', '#ffffff');
  if (/\bstroke=["'](?!none["'])/i.test(output)) {
    output = setSvgElementAttr(output, 'stroke', '#ffffff');
  }
  return output;
}

function fillDecorationMaskedRasterPixels(
  data: Uint8Array,
  width: number,
  height: number,
  channels: number,
  mask: Uint8Array
): number {
  const activeMask = new Uint8Array(mask);
  const fallback = sampleMaskBoundaryColor(data, width, height, channels, activeMask)
    || { r: 0, g: 158, b: 210 };
  const neighbors = [
    [-1, 0], [1, 0], [0, -1], [0, 1],
    [-1, -1], [1, -1], [-1, 1], [1, 1],
  ];
  const unresolved = new Set<number>();
  for (let index = 0; index < activeMask.length; index++) {
    if (activeMask[index]) unresolved.add(index);
  }

  let cleaned = unresolved.size;
  for (let pass = 0; pass < 96 && unresolved.size > 0; pass++) {
    const resolvedThisPass: number[] = [];
    for (const index of unresolved) {
      const x = index % width;
      const y = Math.floor(index / width);
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let count = 0;
      for (const [dx, dy] of neighbors) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        const ni = yy * width + xx;
        if (activeMask[ni]) continue;
        const offset = ni * channels;
        const alpha = data[offset + 3] ?? 255;
        if (alpha <= 8) continue;
        sumR += data[offset] ?? 0;
        sumG += data[offset + 1] ?? 0;
        sumB += data[offset + 2] ?? 0;
        count++;
      }
      if (count <= 0) continue;
      const offset = index * channels;
      data[offset] = clampColorChannel(sumR / count);
      data[offset + 1] = clampColorChannel(sumG / count);
      data[offset + 2] = clampColorChannel(sumB / count);
      data[offset + 3] = 255;
      resolvedThisPass.push(index);
    }
    if (resolvedThisPass.length === 0) break;
    for (const index of resolvedThisPass) {
      activeMask[index] = 0;
      unresolved.delete(index);
    }
  }

  for (const index of unresolved) {
    const offset = index * channels;
    data[offset] = fallback.r;
    data[offset + 1] = fallback.g;
    data[offset + 2] = fallback.b;
    data[offset + 3] = 255;
    activeMask[index] = 0;
  }

  return cleaned;
}

function sampleMaskBoundaryColor(
  data: Uint8Array,
  width: number,
  height: number,
  channels: number,
  mask: Uint8Array
): { r: number; g: number; b: number } | null {
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
  const addPixel = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    if (mask[index]) return;
    const offset = index * channels;
    const alpha = data[offset + 3] ?? 255;
    if (alpha <= 8) return;
    const r = data[offset] ?? 0;
    const g = data[offset + 1] ?? 0;
    const b = data[offset + 2] ?? 0;
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    const bucket = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
    bucket.count++;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      addPixel(x - 1, y);
      addPixel(x + 1, y);
      addPixel(x, y - 1);
      addPixel(x, y + 1);
    }
  }

  let best: { count: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket;
  }
  if (!best || best.count <= 0) return null;
  return {
    r: clampColorChannel(best.r / best.count),
    g: clampColorChannel(best.g / best.count),
    b: clampColorChannel(best.b / best.count),
  };
}

function dilateBinaryMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const out = new Uint8Array(mask);
  const radiusSq = radius * radius;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy > radiusSq) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          out[yy * width + xx] = 1;
        }
      }
    }
  }
  return out;
}

function buildDecorationCleanRasterPath(filePath: string): string {
  const ext = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  return `${base}_decorclean.png`;
}

function buildDecorationTextureRasterPath(filePath: string): string {
  const ext = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  return `${base}_decortexture.png`;
}

function buildDecorationClusterTexturePath(outSvgPath: string, clusterId: string): string {
  const ext = path.extname(outSvgPath);
  const base = outSvgPath.slice(0, outSvgPath.length - ext.length);
  const safeClusterId = clusterId.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 64) || 'cluster';
  return `${base}_${safeClusterId}_decortexture.png`;
}

async function removeDuplicatePdfRasterMaskArtifacts(
  elements: string[],
  outSvgPath: string,
  pageWidth: number,
  pageHeight: number
): Promise<string[]> {
  const rasterInfos = elements
    .map((element, index) => parseSvgRasterElementInfo(element, index))
    .filter((info): info is SvgRasterElementInfo => Boolean(info));
  if (rasterInfos.length <= 1) return elements;

  const groups: SvgRasterElementInfo[][] = [];
  for (const info of rasterInfos) {
    const group = groups.find((candidate) => areNearSameSvgBounds(candidate[0].bounds, info.bounds));
    if (group) group.push(info);
    else groups.push([info]);
  }

  const removeIndexes = new Set<number>();
  for (const group of groups) {
    if (group.length <= 1) continue;
    const pageArea = Math.max(1, pageWidth * pageHeight);
    const groupArea = Math.max(0, group[0].bounds.width) * Math.max(0, group[0].bounds.height);
    if (groupArea / pageArea > 0.7) continue;

    const analyzed = await Promise.all(group.map(async (info) => ({
      info,
      stats: info.filePath ? await analyzeSvgRasterArtifact(info.filePath) : null,
    })));
    const hasContentLayer = analyzed.some((item) => item.stats?.contentLike === true);
    if (!hasContentLayer) continue;

    const maskItems = analyzed.filter((item) => item.stats?.maskLike === true);
    for (const item of maskItems) {
      removeIndexes.add(item.info.index);
      unlinkPdfRasterArtifactIfLocal(item.info.filePath, outSvgPath);
    }

    if (maskItems.length > 0) {
      logger.info(
        {
          scope: 'pdf',
          removedRasterMaskArtifacts: maskItems.length,
          bounds: {
            left: Math.round(group[0].bounds.left),
            top: Math.round(group[0].bounds.top),
            width: Math.round(group[0].bounds.width),
            height: Math.round(group[0].bounds.height),
          },
        },
        'PDF: removed duplicate raster mask artifacts from editable SVG'
      );
    }
  }

  return removeIndexes.size > 0
    ? elements.filter((_, index) => !removeIndexes.has(index))
    : elements;
}

function parseSvgRasterElementInfo(element: string, index: number): SvgRasterElementInfo | null {
  if (!/<image\b/i.test(element) || !/\bdata-pdf-raster=["']true["']/i.test(element)) return null;
  const href = readSvgElementAttr(element, 'href') || readSvgElementAttr(element, 'xlink:href');
  if (!href) return null;
  const width = Number(readSvgElementAttr(element, 'width')) || 0;
  const height = Number(readSvgElementAttr(element, 'height')) || 0;
  if (width <= 0 || height <= 0) return null;
  const x = Number(readSvgElementAttr(element, 'x')) || 0;
  const y = Number(readSvgElementAttr(element, 'y')) || 0;
  const matrix = parseSvgTransformMatrix(readSvgElementAttr(element, 'transform'));
  return {
    index,
    element,
    href,
    filePath: resolveSvgRasterHrefPath(href),
    bounds: transformedSvgBounds(matrix, x, y, width, height),
  };
}

function parseSvgPathElementInfo(element: string, index: number): SvgPathElementInfo | null {
  if (!/<path\b/i.test(element)) return null;
  const pathData = readSvgElementAttr(element, 'd') || '';
  if (!pathData) return null;
  const transform = parseSvgTransformMatrix(readSvgElementAttr(element, 'transform'));
  const bounds = transformedPathBounds(pathData, transform);
  if (!bounds || bounds.width < 0 || bounds.height < 0) return null;
  const commands = pathData.match(/[MLCQZ]/gi) || [];
  return {
    index,
    element,
    pathData,
    fill: readSvgElementAttr(element, 'fill') || '',
    stroke: readSvgElementAttr(element, 'stroke') || '',
    transform,
    bounds,
    commandCount: commands.length,
    hasCurve: commands.some((command) => command.toUpperCase() === 'C' || command.toUpperCase() === 'Q'),
  };
}

function isRasterMaskArtifactPath(
  pathInfo: SvgPathElementInfo,
  rasterInfos: SvgRasterElementInfo[],
  pageWidth: number,
  pageHeight: number
): boolean {
  if (rasterInfos.length === 0) return false;
  if (!isLikelySimpleFilledPath(pathInfo)) return false;
  if (isNearFullPageBounds(pathInfo.bounds, pageWidth, pageHeight)) return false;
  if (!rasterInfos.some((raster) => areNearSameSvgBounds(pathInfo.bounds, raster.bounds))) return false;

  const fill = parseSvgRgbColor(pathInfo.fill);
  if (!fill) return false;
  const max = Math.max(fill.r, fill.g, fill.b);
  const min = Math.min(fill.r, fill.g, fill.b);
  const brightness = (fill.r + fill.g + fill.b) / 3;
  return max - min <= 35 && (brightness <= 96 || brightness >= 236);
}

function isRasterReconstructionStripPath(
  pathInfo: SvgPathElementInfo,
  rasterInfos: SvgRasterElementInfo[],
  pageWidth: number,
  pageHeight: number
): boolean {
  if (rasterInfos.length === 0) return false;
  if (!isLikelySimpleRasterStripPath(pathInfo)) return false;
  if (isNearFullPageBounds(pathInfo.bounds, pageWidth, pageHeight)) return false;
  return rasterInfos.some((raster) => isBoundsInside(pathInfo.bounds, raster.bounds, 1.5));
}

function isLikelySimpleRasterStripPath(pathInfo: SvgPathElementInfo): boolean {
  if (!isLikelySimpleFilledPath(pathInfo)) return false;
  const narrowSide = Math.max(0.0001, Math.min(pathInfo.bounds.width, pathInfo.bounds.height));
  const longSide = Math.max(pathInfo.bounds.width, pathInfo.bounds.height);
  return narrowSide <= 8
    && longSide >= 24
    && longSide / narrowSide >= 8;
}

function isLikelySimpleFilledPath(pathInfo: SvgPathElementInfo): boolean {
  if (/[CQ]/i.test(pathInfo.pathData)) return false;
  if (pathInfo.commandCount === 0 || pathInfo.commandCount > 6) return false;
  const fill = pathInfo.fill.trim().toLowerCase();
  const stroke = pathInfo.stroke.trim().toLowerCase();
  if (!fill || fill === 'none') return false;
  if (stroke && stroke !== 'none') return false;
  return true;
}

function isDecorationVectorPath(pathInfo: SvgPathElementInfo, rasterInfos: SvgRasterElementInfo[]): boolean {
  if (rasterInfos.length === 0) return false;
  if (!rasterInfos.some((raster) => isBoundsInside(pathInfo.bounds, raster.bounds, 1.5))) return false;
  const area = Math.max(0, pathInfo.bounds.width) * Math.max(0, pathInfo.bounds.height);
  return pathInfo.commandCount > 120
    || (pathInfo.hasCurve && area > 1000);
}

function buildDecorationVectorClusters(
  pathInfos: SvgPathElementInfo[],
  rasterInfos: SvgRasterElementInfo[],
  pageWidth: number,
  pageHeight: number
): DecorationVectorCluster[] {
  const candidates = pathInfos.filter((pathInfo) =>
    isDecorationVectorPath(pathInfo, rasterInfos)
    || isStandaloneDecorationVectorSeed(pathInfo, pageWidth, pageHeight)
  );
  if (candidates.length <= 1) return [];

  type DecorationCluster = {
    bounds: SvgBounds;
    count: number;
  };
  const clusters: DecorationCluster[] = [];

  for (const candidate of candidates) {
    const matches = clusters.filter((cluster) => areSvgBoundsNear(cluster.bounds, candidate.bounds, 24));
    if (matches.length === 0) {
      clusters.push({ bounds: { ...candidate.bounds }, count: 1 });
      continue;
    }

    const [primary, ...duplicates] = matches;
    primary.bounds = unionSvgBounds([primary.bounds, candidate.bounds]) || primary.bounds;
    primary.count += 1;
    duplicates.forEach((cluster) => {
      primary.bounds = unionSvgBounds([primary.bounds, cluster.bounds]) || primary.bounds;
      primary.count += cluster.count;
      const index = clusters.indexOf(cluster);
      if (index >= 0) clusters.splice(index, 1);
    });
  }

  const pageArea = Math.max(1, pageWidth * pageHeight);
  return clusters
    .filter((cluster) => {
      if (cluster.count < 3) return false;
      const area = Math.max(0, cluster.bounds.width) * Math.max(0, cluster.bounds.height);
      if (area / pageArea > 0.35) return false;
      if (rasterInfos.some((raster) =>
        isBoundsInside(cluster.bounds, raster.bounds, 2)
        || getSvgBoundsOverlapRatio(cluster.bounds, raster.bounds) >= 0.75
      )) return true;
      return area >= 180
        && cluster.bounds.width >= 10
        && cluster.bounds.height >= 10;
    })
    .map((cluster, index) => ({
      id: `pdf-decoration-${index + 1}`,
      bounds: cluster.bounds,
      count: cluster.count,
    }));
}

function isStandaloneDecorationVectorSeed(
  pathInfo: SvgPathElementInfo,
  pageWidth: number,
  pageHeight: number
): boolean {
  if (isNearFullPageBounds(pathInfo.bounds, pageWidth, pageHeight)) return false;
  const fill = pathInfo.fill.trim().toLowerCase();
  const stroke = pathInfo.stroke.trim().toLowerCase();
  if (!fill || fill === 'none') return false;
  if (stroke && stroke !== 'none') return false;
  const area = Math.max(0, pathInfo.bounds.width) * Math.max(0, pathInfo.bounds.height);
  const pageArea = Math.max(1, pageWidth * pageHeight);
  if (area / pageArea > 0.18) return false;
  if (area < 2) return false;
  const color = parseSvgRgbColor(pathInfo.fill);
  const saturated = color
    ? Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) >= 24
    : false;
  return pathInfo.hasCurve
    || pathInfo.commandCount >= 8
    || saturated;
}

function findDecorationClusterForPath(
  pathInfo: SvgPathElementInfo,
  clusters: DecorationVectorCluster[]
): DecorationVectorCluster | null {
  return clusters.find((cluster) => {
    if (isBoundsInside(pathInfo.bounds, cluster.bounds, 3)) return true;
    if (getSvgBoundsOverlapRatio(pathInfo.bounds, cluster.bounds) >= 0.72) return true;
    if (!areSvgBoundsNear(pathInfo.bounds, cluster.bounds, 8)) return false;
    const pathArea = getSvgBoundsArea(pathInfo.bounds);
    const clusterArea = getSvgBoundsArea(cluster.bounds);
    return pathArea <= clusterArea * 6 && clusterArea <= pathArea * 24;
  }) || null;
}

function findDecorationClusterForRaster(
  rasterInfo: SvgRasterElementInfo,
  clusters: DecorationVectorCluster[]
): DecorationVectorCluster | null {
  return clusters.find((cluster) => {
    if (isBoundsInside(cluster.bounds, rasterInfo.bounds, 8)) return true;
    if (isBoundsInside(rasterInfo.bounds, cluster.bounds, 8)) return true;
    return getSvgBoundsOverlapRatio(cluster.bounds, rasterInfo.bounds) >= 0.62
      || getSvgBoundsOverlapRatio(rasterInfo.bounds, cluster.bounds) >= 0.62;
  }) || null;
}

function areSvgBoundsSame(left: SvgBounds, right: SvgBounds, tolerance: number): boolean {
  return Math.abs(left.left - right.left) <= tolerance
    && Math.abs(left.top - right.top) <= tolerance
    && Math.abs(left.right - right.right) <= tolerance
    && Math.abs(left.bottom - right.bottom) <= tolerance;
}

function getSvgBoundsArea(bounds: SvgBounds): number {
  return Math.max(0, bounds.width) * Math.max(0, bounds.height);
}

function areSvgBoundsNear(left: SvgBounds, right: SvgBounds, tolerance: number): boolean {
  return left.left <= right.right + tolerance
    && left.right >= right.left - tolerance
    && left.top <= right.bottom + tolerance
    && left.bottom >= right.top - tolerance;
}

function getSvgBoundsOverlapRatio(bounds: SvgBounds, container: SvgBounds): number {
  const left = Math.max(bounds.left, container.left);
  const top = Math.max(bounds.top, container.top);
  const right = Math.min(bounds.right, container.right);
  const bottom = Math.min(bounds.bottom, container.bottom);
  if (right <= left || bottom <= top) return 0;
  const overlapArea = (right - left) * (bottom - top);
  const boundsArea = Math.max(1, Math.max(0, bounds.width) * Math.max(0, bounds.height));
  return overlapArea / boundsArea;
}

function isBoundsInside(bounds: SvgBounds, container: SvgBounds, tolerance = 0): boolean {
  return bounds.left >= container.left - tolerance
    && bounds.top >= container.top - tolerance
    && bounds.right <= container.right + tolerance
    && bounds.bottom <= container.bottom + tolerance;
}

function isNearFullPageBounds(bounds: SvgBounds, pageWidth: number, pageHeight: number): boolean {
  const pageArea = Math.max(1, pageWidth * pageHeight);
  const area = Math.max(0, bounds.width) * Math.max(0, bounds.height);
  return area / pageArea > 0.7
    && bounds.left <= pageWidth * 0.05
    && bounds.top <= pageHeight * 0.05
    && bounds.right >= pageWidth * 0.95
    && bounds.bottom >= pageHeight * 0.95;
}

function withSvgObjectRole(element: string, role: SvgObjectRole, hidden = false): string {
  let output = setSvgElementAttr(element, 'data-object-role', role);
  if (hidden) {
    output = setSvgElementAttr(output, 'display', 'none');
  }
  return output;
}

function withSvgDecorationClusterId(element: string, clusterId?: string): string {
  return clusterId ? setSvgElementAttr(element, 'data-pdf-cluster-id', clusterId) : element;
}

function setSvgElementAttr(element: string, name: string, value: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedValue = escapeXml(value);
  const attrPattern = new RegExp(`\\b${escapedName}=["'][^"']*["']`, 'i');
  if (attrPattern.test(element)) {
    return element.replace(attrPattern, `${name}="${escapedValue}"`);
  }
  if (/\/>\s*$/.test(element)) {
    return element.replace(/\s*\/>\s*$/, ` ${name}="${escapedValue}" />`);
  }
  return element.replace(/\s*>\s*$/, ` ${name}="${escapedValue}">`);
}

function removeSvgElementAttr(element: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return element.replace(new RegExp(`\\s+${escapedName}=["'][^"']*["']`, 'i'), '');
}

function resolveSvgRasterHrefPath(href: string): string | null {
  if (!href.startsWith('/uploads/')) return null;
  return path.resolve(STORAGE.base, href.replace(/^\/uploads\//, ''));
}

async function analyzeSvgRasterArtifact(filePath: string): Promise<SvgRasterArtifactStats | null> {
  if (!fs.existsSync(filePath)) return null;
  try {
    return await analyzeRasterArtifactInput(filePath);
  } catch (err) {
    logger.warn({ scope: 'pdf', err, filePath }, 'PDF: raster artifact analysis failed');
    return null;
  }
}

async function analyzeRasterArtifactInput(input: string | Buffer): Promise<SvgRasterArtifactStats | null> {
  const sharp = require('sharp');
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = Number(info.width || 0);
  const height = Number(info.height || 0);
  const channels = Number(info.channels || 4);
  if (width <= 0 || height <= 0 || channels < 4) return null;
  return analyzeRasterArtifactPixels(data, width, height, channels);
}

function analyzeRasterArtifactPixels(
  data: Uint8Array,
  width: number,
  height: number,
  channels: number
): SvgRasterArtifactStats | null {
  let visiblePixels = 0;
  let monochromePixels = 0;
  let saturatedPixels = 0;
  let darkPixels = 0;
  let lightPixels = 0;
  let midPixels = 0;
  const darkLabels = new Uint8Array(width * height);
  const visibleLabels = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = y * width + x;
      const offset = pixelIndex * channels;
      const alpha = data[offset + 3] ?? 255;
      if (alpha <= 32) continue;
      visiblePixels++;
      visibleLabels[pixelIndex] = 1;
      const r = data[offset] ?? 0;
      const g = data[offset + 1] ?? 0;
      const b = data[offset + 2] ?? 0;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const luminance = (r * 0.299) + (g * 0.587) + (b * 0.114);
      if (max - min <= 18) monochromePixels++;
      if (max - min >= 40) saturatedPixels++;
      if (luminance <= 150) {
        darkPixels++;
        darkLabels[pixelIndex] = 1;
      } else if (luminance >= 215) {
        lightPixels++;
      } else {
        midPixels++;
      }
    }
  }
  if (visiblePixels <= 0) return null;

  let neighborPairs = 0;
  let transitions = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = y * width + x;
      if (!visibleLabels[pixelIndex]) continue;
      const isDark = darkLabels[pixelIndex] === 1;
      if (x + 1 < width) {
        const rightIndex = pixelIndex + 1;
        if (visibleLabels[rightIndex]) {
          neighborPairs++;
          if (isDark !== (darkLabels[rightIndex] === 1)) transitions++;
        }
      }
      if (y + 1 < height) {
        const bottomIndex = pixelIndex + width;
        if (visibleLabels[bottomIndex]) {
          neighborPairs++;
          if (isDark !== (darkLabels[bottomIndex] === 1)) transitions++;
        }
      }
    }
  }

  const seen = new Uint8Array(width * height);
  const queue: number[] = [];
  let largeDarkComponents = 0;
  for (let index = 0; index < darkLabels.length; index++) {
    if (!darkLabels[index] || seen[index]) continue;
    seen[index] = 1;
    queue.push(index);
    let size = 0;
    while (queue.length > 0) {
      const current = queue.pop() as number;
      size++;
      const y = Math.floor(current / width);
      const neighbors = [
        current - 1,
        current + 1,
        current - width,
        current + width,
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || neighbor >= darkLabels.length) continue;
        if ((neighbor === current - 1 || neighbor === current + 1) && Math.floor(neighbor / width) !== y) continue;
        if (!darkLabels[neighbor] || seen[neighbor]) continue;
        seen[neighbor] = 1;
        queue.push(neighbor);
      }
    }
    if (size >= 8) largeDarkComponents++;
  }

  const monochromeRatio = monochromePixels / visiblePixels;
  const saturatedRatio = saturatedPixels / visiblePixels;
  const darkRatio = darkPixels / visiblePixels;
  const lightRatio = lightPixels / visiblePixels;
  const midRatio = midPixels / visiblePixels;
  const transitionRatio = transitions / Math.max(1, neighborPairs);
  const darkComponentDensity = largeDarkComponents / Math.max(1, visiblePixels / 10_000);
  const highFrequencyContent =
    saturatedRatio >= 0.12
    || transitionRatio >= 0.04
    || darkComponentDensity >= 8
    || (
      saturatedRatio >= 0.02
      && (darkComponentDensity >= 2.5 || transitionRatio >= 0.018)
    );
  const maskLike =
    !highFrequencyContent
    && monochromeRatio >= 0.82
    && saturatedRatio < 0.08
    && darkRatio >= 0.02
    && lightRatio >= 0.1
    && darkRatio + lightRatio >= 0.72
    && midRatio < 0.24;

  return {
    visiblePixels,
    monochromeRatio,
    saturatedRatio,
    darkRatio,
    lightRatio,
    midRatio,
    darkComponentDensity,
    transitionRatio,
    maskLike,
    contentLike: highFrequencyContent,
  };
}

function unlinkPdfRasterArtifactIfLocal(filePath: string | null, outSvgPath: string): void {
  if (!filePath) return;
  try {
    const svgDir = path.resolve(path.dirname(outSvgPath));
    const target = path.resolve(filePath);
    if (!target.startsWith(`${svgDir}${path.sep}`)) return;
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch {}
}

function areNearSameSvgBounds(left: SvgBounds, right: SvgBounds): boolean {
  const tolerance = 2;
  return Math.abs(left.left - right.left) <= tolerance
    && Math.abs(left.top - right.top) <= tolerance
    && Math.abs(left.width - right.width) <= tolerance
    && Math.abs(left.height - right.height) <= tolerance;
}

function readSvgElementAttr(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\b${escaped}=["']([^"']+)["']`, 'i').exec(tag);
  return match?.[1] || null;
}

function parseSvgTransformMatrix(value: string | null): Matrix {
  if (!value) return [...IDENTITY_MATRIX];
  const match = /matrix\(([^)]+)\)/i.exec(value);
  if (!match) return [...IDENTITY_MATRIX];
  const nums = match[1].split(/[\s,]+/).map(Number).filter((item) => Number.isFinite(item));
  return [
    nums[0] ?? 1,
    nums[1] ?? 0,
    nums[2] ?? 0,
    nums[3] ?? 1,
    nums[4] ?? 0,
    nums[5] ?? 0,
  ];
}

function transformedSvgBounds(
  matrix: Matrix,
  x: number,
  y: number,
  width: number,
  height: number
): SvgBounds {
  const points = [
    transformPoint(matrix, x, y),
    transformPoint(matrix, x + width, y),
    transformPoint(matrix, x, y + height),
    transformPoint(matrix, x + width, y + height),
  ];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function cleanupPdfOperatorSvgArtifacts(outSvgPath: string) {
  try {
    if (fs.existsSync(outSvgPath)) fs.unlinkSync(outSvgPath);
    const dir = path.dirname(outSvgPath);
    const base = path.basename(outSvgPath, path.extname(outSvgPath));
    const rasterPrefix = `${base}_raster_`;
    const previewRasterPrefix = `${base}_raster_preview_`;
    for (const entry of fs.readdirSync(dir)) {
      if (
        entry.toLowerCase().endsWith('.png')
        && (entry.startsWith(rasterPrefix) || entry.startsWith(previewRasterPrefix))
      ) {
        fs.unlinkSync(path.join(dir, entry));
      }
    }
  } catch {}
}

function collectTextColors(ops: Record<string, number>, opList: { fnArray: number[]; argsArray: any[] }): string[] {
  let fillColor = '#000000';
  const colors: string[] = [];

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];

    if (fn === ops.setFillRGBColor) fillColor = rgbColor(args);
    else if (fn === ops.setFillGray) fillColor = grayColor(args);
    else if (fn === ops.setFillCMYKColor) fillColor = cmykColor(args);
    else if (fn === ops.setFillColor || fn === ops.setFillColorN) fillColor = genericColor(args, fillColor);
    else if (
      fn === ops.showText
      || fn === ops.showSpacedText
      || fn === ops.nextLineShowText
      || fn === ops.nextLineSetSpacingShowText
    ) {
      colors.push(fillColor);
    }
  }

  return colors;
}

function cloneState(state: SvgState): SvgState {
  return {
    ctm: [...state.ctm],
    fillColor: state.fillColor,
    strokeColor: state.strokeColor,
    fillUsesPattern: state.fillUsesPattern,
    strokeUsesPattern: state.strokeUsesPattern,
    lineWidth: state.lineWidth,
    currentPath: state.currentPath,
    text: cloneSvgTextState(state.text),
    clipBounds: state.clipBounds ? { ...state.clipBounds } : null,
      clipPath: state.clipPath
      ? {
          pathData: state.clipPath.pathData,
          matrix: [...state.clipPath.matrix],
          bounds: { ...state.clipPath.bounds },
          source: state.clipPath.source,
        }
      : null,
  };
}

const TEXT_RENDERING_MODE_FILL = 0;
const TEXT_RENDERING_MODE_STROKE = 1;
const TEXT_RENDERING_MODE_FILL_STROKE = 2;
const TEXT_RENDERING_MODE_INVISIBLE = 3;
const TEXT_RENDERING_MODE_ADD_TO_PATH = 4;

function createDefaultSvgTextState(): SvgTextState {
  return {
    fontName: null,
    font: null,
    fontSize: 1,
    fontDirection: 1,
    fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
    textMatrix: [...IDENTITY_MATRIX],
    textMatrixScale: 1,
    x: 0,
    y: 0,
    lineX: 0,
    lineY: 0,
    leading: 0,
    charSpacing: 0,
    wordSpacing: 0,
    textHScale: 1,
    textRise: 0,
    textRenderingMode: TEXT_RENDERING_MODE_FILL,
  };
}

function cloneSvgTextState(text: SvgTextState): SvgTextState {
  return {
    ...text,
    fontMatrix: [...text.fontMatrix],
    textMatrix: [...text.textMatrix],
  };
}

function applySvgTextFont(text: SvgTextState, page: any, args: any): void {
  const fontName = typeof args?.[0] === 'string' ? args[0] : null;
  let fontSize = Number(args?.[1] ?? 1);
  if (!Number.isFinite(fontSize) || fontSize === 0) fontSize = 1;
  text.fontDirection = fontSize < 0 ? -1 : 1;
  text.fontSize = Math.abs(fontSize);
  text.fontName = fontName;
  text.font = null;
  if (fontName) {
    try {
      text.font = page.commonObjs?.get?.(fontName) || null;
    } catch {
      text.font = null;
    }
  }
  const matrix = Array.isArray(text.font?.fontMatrix) ? text.font.fontMatrix : null;
  text.fontMatrix = matrix && matrix.length >= 6
    ? [
        Number(matrix[0]) || 0.001,
        Number(matrix[1]) || 0,
        Number(matrix[2]) || 0,
        Number(matrix[3]) || 0.001,
        Number(matrix[4]) || 0,
        Number(matrix[5]) || 0,
      ]
    : [0.001, 0, 0, 0.001, 0, 0];
}

function moveSvgText(text: SvgTextState, x: number, y: number): void {
  text.x = text.lineX += Number.isFinite(x) ? x : 0;
  text.y = text.lineY += Number.isFinite(y) ? y : 0;
}

function appendPdfTextGlyphPaths(
  state: SvgState,
  glyphs: unknown[],
  page: any,
  nextGlyphId: () => string
): {
  elements: string[];
  glyphPaths: PdfTextGlyphPath[];
  glyphCount: number;
  pathCount: number;
  missingGlyphCount: number;
  clipPathData?: string;
  clipBounds?: SvgBounds;
} {
  const text = state.text;
  const font = text.font;
  if (!font || !glyphs.length || text.fontSize === 0) {
    return { elements: [], glyphPaths: [], glyphCount: 0, pathCount: 0, missingGlyphCount: 0 };
  }

  const paintMode = text.textRenderingMode & 3;
  const addsToClip = (text.textRenderingMode & TEXT_RENDERING_MODE_ADD_TO_PATH) !== 0;
  if (paintMode === TEXT_RENDERING_MODE_INVISIBLE && !addsToClip) {
    advanceSvgTextPosition(text, glyphs);
    return { elements: [], glyphPaths: [], glyphCount: 0, pathCount: 0, missingGlyphCount: 0 };
  }

  const elements: string[] = [];
  const glyphPaths: PdfTextGlyphPath[] = [];
  const clipSegments: string[] = [];
  const clipBoundsList: SvgBounds[] = [];
  let glyphCount = 0;
  let pathCount = 0;
  let missingGlyphCount = 0;
  let x = 0;
  let glyphIndex = 0;
  const textRunId = `tr-${nextGlyphId()}`;
  const fontSize = Math.max(0.0001, text.fontSize);
  const fontDirection = text.fontDirection || 1;
  const textHScale = text.textHScale * fontDirection;
  const widthAdvanceScale = fontSize * (text.fontMatrix[0] || 0.001);
  const vertical = Boolean(font.vertical);
  const spacingDir = vertical ? 1 : -1;
  const defaultVMetrics = normalizeVerticalMetrics(font.defaultVMetrics);
  const baseMatrix = multiplyMatrix(
    multiplyMatrix(
      multiplyMatrix(state.ctm, text.textMatrix),
      [1, 0, 0, 1, text.x, text.y + text.textRise]
    ),
    fontDirection > 0 ? [textHScale, 0, 0, -1, 0, 0] : [textHScale, 0, 0, 1, 0, 0]
  );

  for (const rawGlyph of glyphs) {
    if (typeof rawGlyph === 'number') {
      x += spacingDir * rawGlyph * fontSize / 1000;
      continue;
    }
    const glyph = rawGlyph as Record<string, unknown>;
    const fontChar = typeof glyph.fontChar === 'string' ? glyph.fontChar : '';
    const unicode = typeof glyph.unicode === 'string' ? glyph.unicode : '';
    if (!fontChar) continue;

    glyphCount++;
    const currentGlyphIndex = glyphIndex++;
    let width = Number(glyph.width ?? 0) || 0;
    const spacing = (glyph.isSpace ? text.wordSpacing : 0) + text.charSpacing;
    let scaledX = x;
    let scaledY = 0;
    if (vertical) {
      const glyphVMetrics = normalizeVerticalMetrics(glyph.vmetric);
      const vmetric = glyphVMetrics || defaultVMetrics;
      const vx = -(glyphVMetrics ? glyphVMetrics[1] : width * 0.5) * widthAdvanceScale;
      const vy = (vmetric ? vmetric[2] : 0) * widthAdvanceScale;
      if (vmetric) width = -vmetric[0];
      scaledX = vx;
      scaledY = x + vy;
    }
    const glyphMatrix = multiplyMatrix(baseMatrix, [1, 0, 0, 1, scaledX, scaledY]);
    const glyphPath = recordPdfGlyphPath(font, page, fontChar, fontSize, glyphMatrix);
    if (glyphPath?.pathData && glyphPath.bounds) {
      const glyphId = nextGlyphId();
      if (addsToClip) {
        clipSegments.push(glyphPath.pathData);
        clipBoundsList.push(glyphPath.bounds);
      }
      const element = paintMode === TEXT_RENDERING_MODE_INVISIBLE
        ? null
        : pdfTextPathElement(glyphPath.pathData, state, paintMode, unicode, glyphId, glyphPath.bounds, {
            textRunId,
            glyphIndex: currentGlyphIndex,
            writingMode: vertical ? 'vertical-rl' : 'horizontal-tb',
            textMatrix: baseMatrix,
            rotation: matrixRotationDegrees(baseMatrix),
          });
      if (element) {
        elements.push(element);
        glyphPaths.push({
          id: glyphId,
          text: unicode || fontChar,
          bounds: glyphPath.bounds,
          textRunId,
          glyphIndex: currentGlyphIndex,
          writingMode: vertical ? 'vertical-rl' : 'horizontal-tb',
          textMatrix: baseMatrix,
          rotation: matrixRotationDegrees(baseMatrix),
        });
        pathCount++;
      }
    } else if (String(unicode || fontChar).trim()) {
      missingGlyphCount++;
    }

    x += vertical
      ? width * widthAdvanceScale - spacing * fontDirection
      : width * widthAdvanceScale + spacing * fontDirection;
  }

  if (vertical) text.y -= x;
  else text.x += x * textHScale;
  const clipBounds = unionSvgBounds(clipBoundsList);
  return {
    elements,
    glyphPaths,
    glyphCount,
    pathCount,
    missingGlyphCount,
    clipPathData: clipSegments.length > 0 ? clipSegments.join(' ') : undefined,
    clipBounds: clipBounds || undefined,
  };
}

function advanceSvgTextPosition(text: SvgTextState, glyphs: unknown[]): void {
  const font = text.font;
  const fontSize = Math.max(0.0001, text.fontSize);
  const fontDirection = text.fontDirection || 1;
  const widthAdvanceScale = fontSize * (text.fontMatrix[0] || 0.001);
  const textHScale = text.textHScale * fontDirection;
  const vertical = Boolean(font?.vertical);
  const spacingDir = vertical ? 1 : -1;
  const defaultVMetrics = normalizeVerticalMetrics(font?.defaultVMetrics);
  let x = 0;
  for (const rawGlyph of glyphs) {
    if (typeof rawGlyph === 'number') {
      x += spacingDir * rawGlyph * fontSize / 1000;
      continue;
    }
    const glyph = rawGlyph as Record<string, unknown>;
    let width = Number(glyph.width ?? 0) || 0;
    const spacing = (glyph.isSpace ? text.wordSpacing : 0) + text.charSpacing;
    if (vertical) {
      const glyphVMetrics = normalizeVerticalMetrics(glyph.vmetric);
      const vmetric = glyphVMetrics || defaultVMetrics;
      if (vmetric) width = -vmetric[0];
    }
    x += vertical
      ? width * widthAdvanceScale - spacing * fontDirection
      : width * widthAdvanceScale + spacing * fontDirection;
  }
  if (vertical) text.y -= x;
  else text.x += x * textHScale;
}

function normalizeVerticalMetrics(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const v0 = Number(value[0]);
  const v1 = Number(value[1]);
  const v2 = Number(value[2]);
  if (!Number.isFinite(v0) || !Number.isFinite(v1) || !Number.isFinite(v2)) return null;
  return [v0, v1, v2];
}

function recordPdfGlyphPath(
  font: any,
  page: any,
  fontChar: string,
  fontSize: number,
  matrix: Matrix
): { pathData: string; bounds: SvgBounds | null } | null {
  try {
    const addToPath = font.getPathGenerator?.(page.commonObjs, fontChar);
    if (typeof addToPath !== 'function') return null;
    const recorder = new SvgGlyphPathRecorder(matrix);
    addToPath(recorder, fontSize);
    const pathData = recorder.toPathData();
    if (!pathData) return null;
    return { pathData, bounds: recorder.getBounds() };
  } catch (err) {
    logger.warn({ scope: 'pdf', err }, 'PDF: glyph path generation failed');
    return null;
  }
}

function pdfTextPathElement(
  pathData: string,
  state: SvgState,
  paintMode: number,
  unicode: string,
  glyphId: string,
  bounds: SvgBounds,
  metadata: {
    textRunId?: string;
    glyphIndex?: number;
    writingMode?: 'horizontal-tb' | 'vertical-rl';
    textMatrix?: number[];
    rotation?: number;
  } = {}
): string | null {
  if (!pathData) return null;
  const fill = paintMode === TEXT_RENDERING_MODE_STROKE ? 'none' : state.fillColor;
  const stroke = paintMode === TEXT_RENDERING_MODE_STROKE || paintMode === TEXT_RENDERING_MODE_FILL_STROKE
    ? state.strokeColor
    : 'none';
  const strokeAttrs = stroke === 'none'
    ? `stroke="none"`
    : `stroke="${escapeXml(stroke)}" stroke-width="${formatNum(Math.max(0.01, state.lineWidth))}"`;
  const textAttr = unicode ? ` data-pdf-text="${escapeXml(unicode)}"` : '';
  const runAttr = metadata.textRunId ? ` data-pdf-text-run-id="${escapeXml(metadata.textRunId)}"` : '';
  const glyphIndexAttr = Number.isFinite(metadata.glyphIndex)
    ? ` data-pdf-text-glyph-index="${formatNum(Number(metadata.glyphIndex))}"`
    : '';
  const writingModeAttr = metadata.writingMode ? ` data-pdf-writing-mode="${escapeXml(metadata.writingMode)}"` : '';
  const matrixAttrValue = Array.isArray(metadata.textMatrix)
    ? ` data-pdf-text-matrix="${escapeXml(metadata.textMatrix.map(formatNum).join(','))}"`
    : '';
  const rotationAttr = Number.isFinite(metadata.rotation)
    ? ` data-pdf-text-rotation="${formatNum(Number(metadata.rotation))}"`
    : '';
  const boundsAttr = [
    bounds.left,
    bounds.top,
    bounds.width,
    bounds.height,
  ].map(formatNum).join(',');
  return `<path data-pdf-text-path="true" data-pdf-text-glyph-id="${escapeXml(glyphId)}"${textAttr}${runAttr}${glyphIndexAttr}${writingModeAttr}${matrixAttrValue}${rotationAttr} data-pdf-text-bounds="${escapeXml(boundsAttr)}" d="${escapeXml(pathData)}" fill="${escapeXml(fill)}" ${strokeAttrs} fill-rule="nonzero" />`;
}

class SvgGlyphPathRecorder {
  private matrix: Matrix;
  private readonly stack: Matrix[] = [];
  private readonly commands: string[] = [];
  private bounds: SvgBounds | null = null;

  constructor(matrix: Matrix) {
    this.matrix = [...matrix];
  }

  beginPath() {
    // Glyph generators append into the current recorder path.
  }

  save() {
    this.stack.push([...this.matrix]);
  }

  restore() {
    const previous = this.stack.pop();
    if (previous) this.matrix = previous;
  }

  transform(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.matrix = multiplyMatrix(this.matrix, [
      Number(a) || 0,
      Number(b) || 0,
      Number(c) || 0,
      Number(d) || 0,
      Number(e) || 0,
      Number(f) || 0,
    ]);
  }

  scale(x: number, y: number) {
    this.transform(Number(x) || 0, 0, 0, Number(y) || 0, 0, 0);
  }

  translate(x: number, y: number) {
    this.transform(1, 0, 0, 1, Number(x) || 0, Number(y) || 0);
  }

  moveTo(x: number, y: number) {
    const point = transformPoint(this.matrix, x, y);
    this.includePoint(point);
    this.commands.push(`M ${formatNum(point.x)} ${formatNum(point.y)}`);
  }

  lineTo(x: number, y: number) {
    const point = transformPoint(this.matrix, x, y);
    this.includePoint(point);
    this.commands.push(`L ${formatNum(point.x)} ${formatNum(point.y)}`);
  }

  rect(x: number, y: number, width: number, height: number) {
    this.moveTo(x, y);
    this.lineTo(x + width, y);
    this.lineTo(x + width, y + height);
    this.lineTo(x, y + height);
    this.closePath();
  }

  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number) {
    const p1 = transformPoint(this.matrix, x1, y1);
    const p2 = transformPoint(this.matrix, x2, y2);
    const end = transformPoint(this.matrix, x, y);
    this.includePoint(p1);
    this.includePoint(p2);
    this.includePoint(end);
    this.commands.push(`C ${formatNum(p1.x)} ${formatNum(p1.y)} ${formatNum(p2.x)} ${formatNum(p2.y)} ${formatNum(end.x)} ${formatNum(end.y)}`);
  }

  quadraticCurveTo(x1: number, y1: number, x: number, y: number) {
    const p1 = transformPoint(this.matrix, x1, y1);
    const end = transformPoint(this.matrix, x, y);
    this.includePoint(p1);
    this.includePoint(end);
    this.commands.push(`Q ${formatNum(p1.x)} ${formatNum(p1.y)} ${formatNum(end.x)} ${formatNum(end.y)}`);
  }

  closePath() {
    this.commands.push('Z');
  }

  toPathData(): string {
    return this.commands.join(' ');
  }

  getBounds(): SvgBounds | null {
    return this.bounds ? { ...this.bounds } : null;
  }

  private includePoint(point: { x: number; y: number }) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    if (!this.bounds) {
      this.bounds = {
        left: point.x,
        top: point.y,
        right: point.x,
        bottom: point.y,
        width: 0,
        height: 0,
      };
      return;
    }
    this.bounds.left = Math.min(this.bounds.left, point.x);
    this.bounds.top = Math.min(this.bounds.top, point.y);
    this.bounds.right = Math.max(this.bounds.right, point.x);
    this.bounds.bottom = Math.max(this.bounds.bottom, point.y);
    this.bounds.width = this.bounds.right - this.bounds.left;
    this.bounds.height = this.bounds.bottom - this.bounds.top;
  }
}

function multiplyMatrix(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function invertMatrix(matrix: Matrix): Matrix | null {
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) return null;
  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ];
}

function toMatrix(args: any): Matrix {
  return [
    Number(args?.[0] ?? 1),
    Number(args?.[1] ?? 0),
    Number(args?.[2] ?? 0),
    Number(args?.[3] ?? 1),
    Number(args?.[4] ?? 0),
    Number(args?.[5] ?? 0),
  ];
}

function pathFromConstructPath(ops: Record<string, number>, args: any): string {
  const pathOps = Array.from(args?.[0] || []) as number[];
  const coords = Array.from(args?.[1] || []) as number[];
  const d: string[] = [];
  let cursor = 0;
  let currentX = 0;
  let currentY = 0;

  for (const op of pathOps) {
    if (op === ops.moveTo) {
      currentX = Number(coords[cursor++]);
      currentY = Number(coords[cursor++]);
      d.push(`M ${formatNum(currentX)} ${formatNum(currentY)}`);
    } else if (op === ops.lineTo) {
      currentX = Number(coords[cursor++]);
      currentY = Number(coords[cursor++]);
      d.push(`L ${formatNum(currentX)} ${formatNum(currentY)}`);
    } else if (op === ops.curveTo) {
      const x1 = Number(coords[cursor++]);
      const y1 = Number(coords[cursor++]);
      const x2 = Number(coords[cursor++]);
      const y2 = Number(coords[cursor++]);
      currentX = Number(coords[cursor++]);
      currentY = Number(coords[cursor++]);
      d.push(`C ${formatNum(x1)} ${formatNum(y1)} ${formatNum(x2)} ${formatNum(y2)} ${formatNum(currentX)} ${formatNum(currentY)}`);
    } else if (op === ops.curveTo2) {
      const x2 = Number(coords[cursor++]);
      const y2 = Number(coords[cursor++]);
      const x = Number(coords[cursor++]);
      const y = Number(coords[cursor++]);
      d.push(`C ${formatNum(currentX)} ${formatNum(currentY)} ${formatNum(x2)} ${formatNum(y2)} ${formatNum(x)} ${formatNum(y)}`);
      currentX = x;
      currentY = y;
    } else if (op === ops.curveTo3) {
      const x1 = Number(coords[cursor++]);
      const y1 = Number(coords[cursor++]);
      const x = Number(coords[cursor++]);
      const y = Number(coords[cursor++]);
      d.push(`C ${formatNum(x1)} ${formatNum(y1)} ${formatNum(x)} ${formatNum(y)} ${formatNum(x)} ${formatNum(y)}`);
      currentX = x;
      currentY = y;
    } else if (op === ops.closePath) {
      d.push('Z');
    } else if (op === ops.rectangle) {
      const x = Number(coords[cursor++]);
      const y = Number(coords[cursor++]);
      const w = Number(coords[cursor++]);
      const h = Number(coords[cursor++]);
      d.push(`M ${formatNum(x)} ${formatNum(y)} L ${formatNum(x + w)} ${formatNum(y)} L ${formatNum(x + w)} ${formatNum(y + h)} L ${formatNum(x)} ${formatNum(y + h)} Z`);
      currentX = x;
      currentY = y;
    }
  }

  return d.join(' ');
}

function svgPathElement(
  state: SvgState,
  options: { fill: string; stroke: string; fillRule: 'nonzero' | 'evenodd' },
  clipPathId: string | null = null
): string {
  const transform = matrixAttr(state.ctm);
  const clipPathAttr = clipPathId ? ` clip-path="url(#${escapeXml(clipPathId)})"` : '';
  const strokeAttrs = options.stroke === 'none'
    ? `stroke="none"`
    : `stroke="${escapeXml(options.stroke)}" stroke-width="${formatNum(state.lineWidth)}"`;
  return `<path d="${escapeXml(state.currentPath)}" fill="${escapeXml(options.fill)}" ${strokeAttrs} fill-rule="${options.fillRule}"${transform}${clipPathAttr} />`;
}

function svgImageElement(state: SvgState, image: SvgRasterImage, clipPathId: string | null = null): string {
  const pixelWidth = Math.max(1, image.pixelWidth || image.width || 1);
  const pixelHeight = Math.max(1, image.pixelHeight || image.height || 1);
  const transform = matrixAttr(image.transform || multiplyMatrix(state.ctm, [1 / pixelWidth, 0, 0, -1 / pixelHeight, 0, 1]));
  const href = escapeXml(image.href);
  const clipPathAttr = clipPathId ? ` clip-path="url(#${escapeXml(clipPathId)})"` : '';
  return `<image data-pdf-raster="true" href="${href}" xlink:href="${href}" x="${formatNum(image.x)}" y="${formatNum(image.y)}" width="${formatNum(pixelWidth)}" height="${formatNum(pixelHeight)}" preserveAspectRatio="none"${transform}${clipPathAttr} />`;
}

function svgTextureFillImageElement(image: SvgRasterImage): string {
  const pixelWidth = Math.max(1, image.pixelWidth || image.width || 1);
  const pixelHeight = Math.max(1, image.pixelHeight || image.height || 1);
  const transform = matrixAttr(image.transform || [1, 0, 0, 1, 0, 0]);
  const href = escapeXml(image.href);
  return `<image data-object-role="decoration-texture-fill" data-pdf-texture-fill="true" href="${href}" xlink:href="${href}" x="${formatNum(image.x)}" y="${formatNum(image.y)}" width="${formatNum(pixelWidth)}" height="${formatNum(pixelHeight)}" preserveAspectRatio="none"${transform} />`;
}

function matrixAttr(matrix: Matrix): string {
  if (matrix.every((value, index) => Math.abs(value - IDENTITY_MATRIX[index]) < 0.00001)) return '';
  return ` transform="matrix(${matrix.map(formatNum).join(' ')})"`;
}

function isRasterPaintedAsFullPage(matrix: Matrix, pageWidth: number, pageHeight: number): boolean {
  const bounds = unitBoundsForMatrix(matrix);
  return bounds.width >= pageWidth * 0.85
    && bounds.height >= pageHeight * 0.85
    && bounds.left <= pageWidth * 0.1
    && bounds.top <= pageHeight * 0.1
    && bounds.right >= pageWidth * 0.9
    && bounds.bottom >= pageHeight * 0.9;
}

function unitBoundsForMatrix(matrix: Matrix): {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
} {
  const points = [
    transformPoint(matrix, 0, 0),
    transformPoint(matrix, 1, 0),
    transformPoint(matrix, 0, 1),
    transformPoint(matrix, 1, 1),
  ];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function transformPoint(matrix: Matrix, x: number, y: number): { x: number; y: number } {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  };
}

async function cropRasterToClipBounds(raster: SvgRasterImage, state: SvgState): Promise<SvgRasterImage | null> {
  if (!raster.pngBuffer || !state.clipBounds) return raster;
  const displayBounds = unitBoundsForMatrix(raster.transform || state.ctm);
  const clipped = intersectBounds(displayBounds, state.clipBounds);
  if (!clipped || clipped.width <= 1 || clipped.height <= 1) return null;

  const leftRatio = (clipped.left - displayBounds.left) / Math.max(1, displayBounds.width);
  const topRatio = (clipped.top - displayBounds.top) / Math.max(1, displayBounds.height);
  const rightRatio = (clipped.right - displayBounds.left) / Math.max(1, displayBounds.width);
  const bottomRatio = (clipped.bottom - displayBounds.top) / Math.max(1, displayBounds.height);
  const cropLeft = clampInt(Math.floor(leftRatio * raster.pixelWidth), 0, raster.pixelWidth - 1);
  const cropTop = clampInt(Math.floor(topRatio * raster.pixelHeight), 0, raster.pixelHeight - 1);
  const cropRight = clampInt(Math.ceil(rightRatio * raster.pixelWidth), cropLeft + 1, raster.pixelWidth);
  const cropBottom = clampInt(Math.ceil(bottomRatio * raster.pixelHeight), cropTop + 1, raster.pixelHeight);
  const cropWidth = cropRight - cropLeft;
  const cropHeight = cropBottom - cropTop;
  if (cropWidth <= 1 || cropHeight <= 1) return null;

  const sharp = require('sharp');
  const { data, info } = await sharp(raster.pngBuffer)
    .ensureAlpha()
    .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = Number(info.channels || 4);
  const clipApplied = Boolean(state.clipPath?.pathData);
  if (clipApplied && channels >= 4 && state.clipPath) {
    const mask = await renderRasterClipMask(state.clipPath, clipped, cropWidth, cropHeight);
    if (mask) {
      for (let index = 0; index < mask.length; index++) {
        const offset = index * channels;
        data[offset + 3] = Math.round(((data[offset + 3] ?? 255) * mask[index]) / 255);
      }
    }
  }
  const pngBuffer = await sharp(data, {
    raw: { width: cropWidth, height: cropHeight, channels },
  }).png().toBuffer();

  return {
    ...raster,
    pngBuffer,
    href: `data:image/png;base64,${pngBuffer.toString('base64')}`,
    pixelWidth: cropWidth,
    pixelHeight: cropHeight,
    clipApplied,
    transform: [clipped.width / cropWidth, 0, 0, clipped.height / cropHeight, clipped.left, clipped.top],
  };
}

async function renderRasterClipMask(
  clipPath: SvgClipPath,
  viewBoxBounds: SvgBounds,
  width: number,
  height: number
): Promise<Uint8Array | null> {
  if (width <= 0 || height <= 0) return null;
  const viewBox = [
    formatNum(viewBoxBounds.left),
    formatNum(viewBoxBounds.top),
    formatNum(viewBoxBounds.width),
    formatNum(viewBoxBounds.height),
  ].join(' ');
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}">`,
    `<path d="${escapeXml(clipPath.pathData)}"${matrixAttr(clipPath.matrix)} fill="#ffffff" />`,
    `</svg>`,
  ].join('');
  try {
    const sharp = require('sharp');
    const { data, info } = await sharp(Buffer.from(svg))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (Number(info.width) !== width || Number(info.height) !== height) return null;
    const channels = Number(info.channels || 4);
    const mask = new Uint8Array(width * height);
    let visible = 0;
    for (let index = 0; index < mask.length; index++) {
      const offset = index * channels;
      const alpha = data[offset + 3] ?? 0;
      mask[index] = alpha;
      if (alpha > 0) visible++;
    }
    return visible > 0 ? mask : null;
  } catch (err) {
    logger.warn({ scope: 'pdf', err }, 'PDF: raster clip mask render failed');
    return null;
  }
}

async function cropSparseRasterToVisibleBounds(
  raster: SvgRasterImage,
  state: SvgState,
  pageWidth: number,
  pageHeight: number
): Promise<SvgRasterImage | null> {
  if (!raster.pngBuffer || !raster.visibleBounds) return raster;
  const bounds = raster.visibleBounds;
  if (bounds.width <= 1 || bounds.height <= 1) return null;

  const pad = Math.max(2, Math.min(12, Math.round(Math.max(bounds.width, bounds.height) * 0.015)));
  const left = Math.max(0, Math.floor(bounds.left - pad));
  const top = Math.max(0, Math.floor(bounds.top - pad));
  const right = Math.min(raster.pixelWidth, Math.ceil(bounds.right + pad));
  const bottom = Math.min(raster.pixelHeight, Math.ceil(bounds.bottom + pad));
  const cropWidth = right - left;
  const cropHeight = bottom - top;
  if (cropWidth <= 1 || cropHeight <= 1) return null;

  const sharp = require('sharp');
  const pngBuffer = await sharp(raster.pngBuffer)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .png()
    .toBuffer();

  const displayBounds = unitBoundsForMatrix(state.ctm);
  const displayLeft = displayBounds.left + (left / Math.max(1, raster.pixelWidth)) * displayBounds.width;
  const displayTop = displayBounds.top + (top / Math.max(1, raster.pixelHeight)) * displayBounds.height;
  const displayWidth = (cropWidth / Math.max(1, raster.pixelWidth)) * displayBounds.width;
  const displayHeight = (cropHeight / Math.max(1, raster.pixelHeight)) * displayBounds.height;

  if (
    displayWidth <= 0
    || displayHeight <= 0
    || displayLeft > pageWidth
    || displayTop > pageHeight
    || displayLeft + displayWidth < 0
    || displayTop + displayHeight < 0
  ) {
    return null;
  }

  return {
    ...raster,
    pngBuffer,
    href: `data:image/png;base64,${pngBuffer.toString('base64')}`,
    pixelWidth: cropWidth,
    pixelHeight: cropHeight,
    transform: [displayWidth / cropWidth, 0, 0, displayHeight / cropHeight, displayLeft, displayTop],
  };
}

function transformedPathBounds(pathData: string, matrix: Matrix): SvgBounds | null {
  const nums = (pathData.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number).filter(Number.isFinite);
  if (nums.length < 2) return null;
  const points: Array<{ x: number; y: number }> = [];
  for (let index = 0; index + 1 < nums.length; index += 2) {
    points.push(transformPoint(matrix, nums[index], nums[index + 1]));
  }
  if (!points.length) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return boundsFromEdges(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

function intersectBounds(left: SvgBounds | null | undefined, right: SvgBounds): SvgBounds | null {
  if (!left) return { ...right };
  const x1 = Math.max(left.left, right.left);
  const y1 = Math.max(left.top, right.top);
  const x2 = Math.min(left.right, right.right);
  const y2 = Math.min(left.bottom, right.bottom);
  if (x2 <= x1 || y2 <= y1) return null;
  return boundsFromEdges(x1, y1, x2, y2);
}

function boundsFromEdges(left: number, top: number, right: number, bottom: number): SvgBounds {
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function shouldSkipHiddenPdfPath(
  state: SvgState,
  options: { fill: string; stroke: string; fillRule: 'nonzero' | 'evenodd' },
  snapshot: SourceCanvasSnapshot | null
): { skip: boolean; bounds: SvgBounds | null } {
  if (!snapshot || options.fill === 'none') return { skip: false, bounds: null };
  const fill = parseSvgRgbColor(options.fill);
  if (!fill || !isLikelyHiddenMaskFill(fill)) return { skip: false, bounds: null };

  const bounds = transformedPathBounds(state.currentPath, state.ctm);
  if (!bounds || bounds.width < 4 || bounds.height < 4 || bounds.width * bounds.height < 32) {
    return { skip: false, bounds };
  }
  if (!isLikelySimpleHiddenMaskPath(state.currentPath)) {
    return { skip: false, bounds };
  }

  const stats = sampleColorMatches(snapshot, bounds, fill);
  if (stats.samples < 24) return { skip: false, bounds };

  // Illustrator can leave clipped white helper geometry in the PDF operator list.
  // The server PNG is the visual ground truth; if the white fill cannot be found
  // in that area at all, do not expose it as an editable SVG object.
  const matchRatio = stats.matches / stats.samples;
  return { skip: matchRatio < 0.0025, bounds };
}

function isLikelySimpleHiddenMaskPath(pathData: string): boolean {
  const commands = pathData.match(/[MLCQZ]/gi) || [];
  if (/[CQ]/i.test(pathData)) return false;
  if (commands.length > 8) return false;
  const numbers = (pathData.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [])
    .map(Number)
    .filter(Number.isFinite);
  if (numbers.length > 16) return false;
  return true;
}

function shouldSkipHiddenFollowerStroke(bounds: SvgBounds, hiddenFillBounds: SvgBounds | null): boolean {
  if (!hiddenFillBounds) return false;
  const intersection = intersectBounds(hiddenFillBounds, bounds);
  if (!intersection) return false;
  const intersectionArea = intersection.width * intersection.height;
  const smallerArea = Math.min(hiddenFillBounds.width * hiddenFillBounds.height, bounds.width * bounds.height);
  return smallerArea > 0 && intersectionArea / smallerArea > 0.92;
}

function parseSvgRgbColor(value: string): SvgRgbColor | null {
  const match = /^rgb\((\d+),(\d+),(\d+)\)$/i.exec(value.trim());
  if (!match) return null;
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

function isLikelyHiddenMaskFill(color: SvgRgbColor): boolean {
  return color.r >= 248 && color.g >= 248 && color.b >= 248;
}

function sampleColorMatches(
  snapshot: SourceCanvasSnapshot,
  bounds: SvgBounds,
  color: SvgRgbColor
): { samples: number; matches: number } {
  const left = clampInt(Math.floor(bounds.left), 0, snapshot.width - 1);
  const top = clampInt(Math.floor(bounds.top), 0, snapshot.height - 1);
  const right = clampInt(Math.ceil(bounds.right), 0, snapshot.width - 1);
  const bottom = clampInt(Math.ceil(bounds.bottom), 0, snapshot.height - 1);
  if (right < left || bottom < top) return { samples: 0, matches: 0 };

  const pixelCount = (right - left + 1) * (bottom - top + 1);
  const step = Math.max(1, Math.ceil(Math.sqrt(pixelCount / 12_000)));
  let samples = 0;
  let matches = 0;

  for (let y = top; y <= bottom; y += step) {
    for (let x = left; x <= right; x += step) {
      const offset = (y * snapshot.width + x) * 4;
      const delta =
        Math.abs((snapshot.data[offset] ?? 0) - color.r)
        + Math.abs((snapshot.data[offset + 1] ?? 0) - color.g)
        + Math.abs((snapshot.data[offset + 2] ?? 0) - color.b);
      samples++;
      if (delta <= 80) matches++;
    }
  }

  return { samples, matches };
}

function getPageObject(page: any, id: string): Promise<PdfImageData | null> {
  return new Promise((resolve) => {
    try {
      page.objs.get(id, (obj: PdfImageData) => resolve(obj || null));
    } catch {
      resolve(null);
    }
  });
}

function imageToSvgRasterImage(
  image: PdfImageData,
  createCanvas: (width: number, height: number) => any,
  ImageDataCtor: new (data: Uint8ClampedArray, width: number, height: number) => any
): SvgRasterImage | null {
  const pixelCount = image.width * image.height;
  const source = image.data || new Uint8ClampedArray();
  const channels = Math.max(1, Math.floor(source.length / pixelCount));
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  let nonWhitePixels = 0;
  let visiblePixels = 0;
  let minVisibleX = image.width;
  let minVisibleY = image.height;
  let maxVisibleX = -1;
  let maxVisibleY = -1;

  for (let i = 0; i < pixelCount; i++) {
    const src = i * channels;
    const dst = i * 4;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 255;
    if (channels >= 4) {
      r = source[src] ?? 0;
      g = source[src + 1] ?? 0;
      b = source[src + 2] ?? 0;
      a = source[src + 3] ?? 255;
    } else if (channels >= 3) {
      r = source[src] ?? 0;
      g = source[src + 1] ?? 0;
      b = source[src + 2] ?? 0;
    } else {
      r = source[src] ?? 0;
      g = r;
      b = r;
    }

    rgba[dst] = r;
    rgba[dst + 1] = g;
    rgba[dst + 2] = b;
    rgba[dst + 3] = a;

    if (a > 4) {
      visiblePixels++;
      const x = i % image.width;
      const y = Math.floor(i / image.width);
      if (x < minVisibleX) minVisibleX = x;
      if (y < minVisibleY) minVisibleY = y;
      if (x > maxVisibleX) maxVisibleX = x;
      if (y > maxVisibleY) maxVisibleY = y;
      if (!isNearWhite(r, g, b)) {
        nonWhitePixels++;
      }
    }
  }

  if (visiblePixels === 0) return null;

  const nonWhiteRatio = nonWhitePixels / pixelCount;
  const visibleRatio = visiblePixels / pixelCount;
  const sparseMask =
    Math.max(image.width, image.height) >= 800
    && visibleRatio < 0.09;
  if (sparseMask && channels < 4) {
    for (let i = 0; i < pixelCount; i++) {
      const dst = i * 4;
      if (isNearWhite(rgba[dst] ?? 255, rgba[dst + 1] ?? 255, rgba[dst + 2] ?? 255)) {
        rgba[dst + 3] = 0;
      }
    }
  }

  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageDataCtor(rgba, image.width, image.height), 0, 0);
  const pngBuffer = canvas.toBuffer('image/png');
  return {
    href: `data:image/png;base64,${pngBuffer.toString('base64')}`,
    pngBuffer,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    pixelWidth: image.width,
    pixelHeight: image.height,
    nonWhiteRatio,
    sparseMask,
    visibleBounds: maxVisibleX >= minVisibleX && maxVisibleY >= minVisibleY
      ? {
          left: minVisibleX,
          top: minVisibleY,
          right: maxVisibleX + 1,
          bottom: maxVisibleY + 1,
          width: maxVisibleX - minVisibleX + 1,
          height: maxVisibleY - minVisibleY + 1,
        }
    : undefined,
  };
}

async function restoreRasterAlphaFromPreview(
  raster: SvgRasterImage,
  state: SvgState,
  snapshot: SourceCanvasSnapshot | null
): Promise<SvgRasterImage> {
  if (!snapshot || !raster.pngBuffer) return raster;

  const displayMatrix = getRasterDisplayMatrix(raster, state, raster.pixelWidth, raster.pixelHeight);
  const displayBounds = unitBoundsForMatrix(displayMatrix);
  const snapshotArea = Math.max(1, snapshot.width * snapshot.height);
  const displayArea = Math.max(0, displayBounds.width) * Math.max(0, displayBounds.height);
  if (displayArea / snapshotArea > 0.7) return raster;

  try {
    const sharp = require('sharp');
    const rasterStats = await analyzeRasterArtifactInput(raster.pngBuffer).catch(() => null);
    if (rasterStats?.maskLike || rasterStats?.contentLike) {
      return raster;
    }
    const { data, info } = await sharp(raster.pngBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const width = Number(info.width || 0);
    const height = Number(info.height || 0);
    const channels = Number(info.channels || 4);
    if (width <= 0 || height <= 0 || channels < 4) return raster;

    const matrix = getRasterDisplayMatrix(raster, state, width, height);
    const sampleStep = Math.max(1, Math.ceil(Math.sqrt((width * height) / 30_000)));
    const stats = collectBlackAlphaRepairStats(data, width, height, channels, matrix, snapshot, sampleStep);
    if (!shouldRepairBlackAlpha(stats)) return raster;

    let clearedPixels = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * channels;
        const alpha = data[offset + 3] ?? 255;
        if (!isOpaqueNearBlack(data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0, alpha)) continue;
        const preview = samplePreviewPixel(snapshot, matrix, x + 0.5, y + 0.5);
        if (!preview || isPreviewPixelBlack(preview)) continue;
        data[offset + 3] = 0;
        clearedPixels++;
      }
    }
    if (clearedPixels <= 0) return raster;

    const pngBuffer = await sharp(data, {
      raw: { width, height, channels },
    }).png().toBuffer();
    const visibility = analyzeRasterVisibility(data, width, height, channels);
    logger.info(
      {
        scope: 'pdf',
        clearedPixels,
        width,
        height,
        blackSampleRatio: stats.blackPixels / Math.max(1, stats.visiblePixels),
        clearSampleRatio: stats.clearCandidates / Math.max(1, stats.blackPixels),
      },
      'PDF: restored transparent alpha for raster image from preview'
    );
    return {
      ...raster,
      pngBuffer,
      href: `data:image/png;base64,${pngBuffer.toString('base64')}`,
      pixelWidth: width,
      pixelHeight: height,
      nonWhiteRatio: visibility.nonWhiteRatio,
      sparseMask: visibility.sparseMask,
      visibleBounds: visibility.visibleBounds,
    };
  } catch (err) {
    logger.warn({ scope: 'pdf', err }, 'PDF: raster alpha restore failed');
    return raster;
  }
}

function getRasterDisplayMatrix(
  raster: SvgRasterImage,
  state: SvgState,
  pixelWidth: number,
  pixelHeight: number
): Matrix {
  if (raster.transform) return raster.transform;
  return multiplyMatrix(state.ctm, [
    1 / Math.max(1, pixelWidth),
    0,
    0,
    -1 / Math.max(1, pixelHeight),
    0,
    1,
  ]);
}

function collectBlackAlphaRepairStats(
  data: Uint8Array,
  width: number,
  height: number,
  channels: number,
  matrix: Matrix,
  snapshot: SourceCanvasSnapshot,
  step: number
): { visiblePixels: number; blackPixels: number; clearCandidates: number } {
  let visiblePixels = 0;
  let blackPixels = 0;
  let clearCandidates = 0;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const offset = (y * width + x) * channels;
      const alpha = data[offset + 3] ?? 255;
      if (alpha <= 220) continue;
      visiblePixels++;
      if (!isOpaqueNearBlack(data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0, alpha)) continue;
      blackPixels++;
      const preview = samplePreviewPixel(snapshot, matrix, x + 0.5, y + 0.5);
      if (preview && !isPreviewPixelBlack(preview)) clearCandidates++;
    }
  }

  return { visiblePixels, blackPixels, clearCandidates };
}

function shouldRepairBlackAlpha(stats: { visiblePixels: number; blackPixels: number; clearCandidates: number }): boolean {
  if (stats.visiblePixels < 32 || stats.blackPixels < 16 || stats.clearCandidates < 12) return false;
  const blackRatio = stats.blackPixels / Math.max(1, stats.visiblePixels);
  const clearRatio = stats.clearCandidates / Math.max(1, stats.blackPixels);
  const clearVisibleRatio = stats.clearCandidates / Math.max(1, stats.visiblePixels);
  return blackRatio >= 0.08 && clearRatio >= 0.25 && clearVisibleRatio >= 0.03;
}

function samplePreviewPixel(
  snapshot: SourceCanvasSnapshot,
  matrix: Matrix,
  localX: number,
  localY: number
): { r: number; g: number; b: number; a: number } | null {
  const point = transformPoint(matrix, localX, localY);
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  if (x < 0 || y < 0 || x >= snapshot.width || y >= snapshot.height) return null;
  const offset = (y * snapshot.width + x) * 4;
  return {
    r: snapshot.data[offset] ?? 0,
    g: snapshot.data[offset + 1] ?? 0,
    b: snapshot.data[offset + 2] ?? 0,
    a: snapshot.data[offset + 3] ?? 255,
  };
}

function isOpaqueNearBlack(r: number, g: number, b: number, alpha: number): boolean {
  return alpha > 220 && r <= 36 && g <= 36 && b <= 36;
}

function isPreviewPixelBlack(pixel: { r: number; g: number; b: number; a: number }): boolean {
  if (pixel.a <= 16) return false;
  const max = Math.max(pixel.r, pixel.g, pixel.b);
  const luminance = (pixel.r * 0.299) + (pixel.g * 0.587) + (pixel.b * 0.114);
  return max <= 58 || luminance <= 42;
}

function analyzeRasterVisibility(
  data: Uint8Array,
  width: number,
  height: number,
  channels: number
): {
  nonWhiteRatio: number;
  sparseMask: boolean;
  visibleBounds?: SvgRasterImage['visibleBounds'];
} {
  let nonWhitePixels = 0;
  let visiblePixels = 0;
  let minVisibleX = width;
  let minVisibleY = height;
  let maxVisibleX = -1;
  let maxVisibleY = -1;
  const pixelCount = Math.max(1, width * height);

  for (let i = 0; i < pixelCount; i++) {
    const offset = i * channels;
    const alpha = data[offset + 3] ?? 255;
    const r = data[offset] ?? 0;
    const g = data[offset + 1] ?? 0;
    const b = data[offset + 2] ?? 0;
    if (alpha <= 4) continue;
    visiblePixels++;
    const x = i % width;
    const y = Math.floor(i / width);
    if (x < minVisibleX) minVisibleX = x;
    if (y < minVisibleY) minVisibleY = y;
    if (x > maxVisibleX) maxVisibleX = x;
    if (y > maxVisibleY) maxVisibleY = y;
    if (!isNearWhite(r, g, b)) {
      nonWhitePixels++;
    }
  }

  const nonWhiteRatio = nonWhitePixels / pixelCount;
  const visibleRatio = visiblePixels / pixelCount;
  return {
    nonWhiteRatio,
    sparseMask: Math.max(width, height) >= 800 && visibleRatio < 0.09,
    visibleBounds: maxVisibleX >= minVisibleX && maxVisibleY >= minVisibleY
      ? {
          left: minVisibleX,
          top: minVisibleY,
          right: maxVisibleX + 1,
          bottom: maxVisibleY + 1,
          width: maxVisibleX - minVisibleX + 1,
          height: maxVisibleY - minVisibleY + 1,
        }
      : undefined,
  };
}

function isNearWhite(r: number, g: number, b: number): boolean {
  return r >= 248 && g >= 248 && b >= 248;
}

function applyGraphicState(state: SvgState, args: any): void {
  const entries = Array.isArray(args) ? args : [];
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    const [key, value] = entry;
    if (key === 'LW') state.lineWidth = Number(value) || state.lineWidth;
  }
}

function rgbColor(args: any): string {
  return `rgb(${clampColor(args?.[0])},${clampColor(args?.[1])},${clampColor(args?.[2])})`;
}

function grayColor(args: any): string {
  const value = clampColor((Number(args?.[0] ?? 0) || 0) * 255);
  return `rgb(${value},${value},${value})`;
}

function cmykColor(args: any): string {
  const c = normalizeUnit(args?.[0]);
  const m = normalizeUnit(args?.[1]);
  const y = normalizeUnit(args?.[2]);
  const k = normalizeUnit(args?.[3]);
  return `rgb(${Math.round(255 * (1 - c) * (1 - k))},${Math.round(255 * (1 - m) * (1 - k))},${Math.round(255 * (1 - y) * (1 - k))})`;
}

function genericColor(args: any, fallback: string): string {
  if (!args) return fallback;
  if (isPdfPatternColorArgs(args)) return fallback;
  if (args.length >= 4) return cmykColor(args);
  if (args.length >= 3) return rgbColor(args);
  if (args.length >= 1) return grayColor(args);
  return fallback;
}

function isPdfPatternColorArgs(args: any): boolean {
  if (!Array.isArray(args)) return false;
  return args.some((item) => {
    if (typeof item === 'string') return /pattern/i.test(item);
    if (!item || typeof item !== 'object') return false;
    return Array.isArray((item as { fnArray?: unknown }).fnArray)
      || Array.isArray((item as { argsArray?: unknown }).argsArray)
      || typeof (item as { operatorList?: unknown }).operatorList === 'object';
  });
}

function normalizeUnit(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? Math.min(n / 255, 1) : Math.max(n, 0);
}

function clampColor(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n > 1 ? n : n * 255)));
}

function formatNum(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Number(value.toFixed(4)).toString();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function createAiThumbnail(sourcePngPath: string, thumbPath: string): Promise<void> {
  try {
    const sharp = require('sharp');
    await sharp(sourcePngPath)
      .resize({ width: 800, withoutEnlargement: true })
      .png()
      .toFile(thumbPath);
  } catch {
    fs.copyFileSync(sourcePngPath, thumbPath);
  }
}

interface ParseAiOptions {
  clientAssistSnapshot?: ClientParseAssistSnapshot | null;
  getClientAssistSnapshot?: (() => ClientParseAssistSnapshot | null | undefined) | null;
  allowClientAssistWait?: boolean;
}

/** Retain Illustrator's established ArtBox geometry on explicitly cropped pages. */
export function hasAiArtBoxCrop(filePath: string, pages: PdfPageInfo[]): boolean {
  return pages.some(page => {
    const width = Math.max(1, Math.round(page.width));
    const height = Math.max(1, Math.round(page.height));
    const box = resolvePdfRenderPageBox(filePath, { view: page.view }, page.pageNumber, 1, width, height, 'artBox');
    return box.cropLeft !== 0 || box.cropTop !== 0 || box.width !== width || box.height !== height;
  });
}

export async function parseAi(fileId: number, options: ParseAiOptions = {}): Promise<void> {
  const file = await DesignFile.findByPk(fileId);
  if (!file) throw new Error(`File not found: ${fileId}`);

  // Illustrator's PDF-compatible files need the same fidelity-checked editable
  // extraction as PDFs. Keep PostScript AI on its existing conversion path.
  const sourcePath = resolveParserFilePath(file.filePath);
  const handle = await fs.promises.open(sourcePath, 'r');
  let pdfCompatible = false;
  try {
    const header = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    pdfCompatible = header.subarray(0, bytesRead).includes(Buffer.from('%PDF-'));
  } finally { await handle.close(); }
  const compatiblePages = pdfCompatible ? await getPdfPageInfos(sourcePath) : [];
  if (pdfCompatible && !hasAiArtBoxCrop(sourcePath, compatiblePages)) {
    const { parsePdf } = await import('./pdfParser');
    await parsePdf(fileId, { ...options, resultFileType: 'ai' });
    return;
  }

  await updateParserFile(file, { parseStatus: 'parsing' });
  await ParsedLayer.destroy({ where: { fileId }, transaction: getParserLayerTransaction() });

  const filePath = resolveParserFilePath(file.filePath);
  const parsedDir = getParserOutputDirectory(fileId);
  if (!fs.existsSync(parsedDir)) fs.mkdirSync(parsedDir, { recursive: true });

  const pngPath = path.join(STORAGE.base, getParserThumbnailPath(fileId));
  const pageInfos = await getPdfPageInfos(filePath).catch(() => []);
  const pageCount = Math.max(1, pageInfos.length || 1);
  const clientAssistSnapshot = await resolveClientParseAssistSnapshot(
    options.clientAssistSnapshot,
    options.getClientAssistSnapshot,
    options.allowClientAssistWait,
  );

  const hasInkscape = ENABLE_AI_INKSCAPE_PARSE && await checkInkscape();
  if (hasInkscape && pageCount <= 1) {
    try {
      const svgPath = path.join(parsedDir, 'converted.svg');
      await execInkscape([filePath, '--export-type=svg', `--export-filename=${svgPath}`]);
      const clientThumbnailUsed = await writeClientAssistPreviewToPath(clientAssistSnapshot, pngPath);
      if (!clientThumbnailUsed) {
        await execInkscape([filePath, '--export-type=png', `--export-filename=${pngPath}`, '--export-width=800']);
      }

      const svgInfo = readSvgInfo(svgPath);
      const svgRoleStats = countSvgObjectRoleStats(svgPath);
      const hasRoleStats = svgRoleStats.editableVectorCount
        + svgRoleStats.decorationVectorCount
        + svgRoleStats.editableRasterCount > 0;
      const editableVectorCount = hasRoleStats
        ? svgRoleStats.editableVectorCount
        : svgInfo.elementCount;
      if (svgInfo.elementCount <= 0) {
        throw new Error('Inkscape SVG contains no editable elements');
      }

      await updateParserFile(file, {
        thumbnailPath: getParserThumbnailPath(fileId),
        width: svgInfo.width,
        height: svgInfo.height,
        parseStatus: 'completed',
        parseResult: {
          aiParserVersion: AI_PARSER_VERSION,
          method: 'inkscape',
          svgPath: `${getParserArtifactDirectory(fileId) || `parsed/${fileId}`}/converted.svg`,
          editableSvg: true,
          svgOmitsText: false,
          layerCount: svgInfo.elementCount,
          vectorLayerCount: svgInfo.elementCount,
          editableVectorCount,
          decorationVectorCount: svgRoleStats.decorationVectorCount,
          editableRasterCount: svgRoleStats.editableRasterCount,
          visualOnlyCount: svgRoleStats.visualOnlyCount,
          editableTextLayerCount: 0,
          width: svgInfo.width,
          height: svgInfo.height,
          ...(clientThumbnailUsed ? { clientParseAssist: { preview: true } } : {}),
        },
      });
      if (!isIsolatedParser()) warmUploadThumbnailVariants(getParserThumbnailPath(fileId));

      logger.info({ scope: 'ai', method: 'inkscape', name: file.name }, 'AI: parse completed');
      return;
    } catch (err) {
      logger.warn({ scope: 'ai', err }, 'AI: inkscape conversion failed, trying pdfjs SVG parser');
    }
  }

  try {
    logger.info({ scope: 'ai', method: 'pdfjs-svg', name: file.name }, 'AI: parsing');
    const renderedPages: Array<PdfEditableRenderResult & {
      relativeImagePath: string;
      relativeSvgPath?: string;
      relativeTextlessPreviewPath?: string;
      svgRoleStats: SvgRoleStats;
    }> = [];
    let totalSvgElementCount = 0;
    let totalSvgRasterImageCount = 0;
    let totalTextGlyphCount = 0;
    let totalTextPathCount = 0;
    let totalTextMissingGlyphCount = 0;

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const pagePngName = `ai_page_${pageNumber}.png`;
      const pageSvgName = `ai_page_${pageNumber}.svg`;
      const pagePngPath = path.join(parsedDir, pagePngName);
      const pageSvgPath = path.join(parsedDir, pageSvgName);
      let rendered = await renderWithPdfjs(filePath, pagePngPath, pageSvgPath, pageNumber, {
        allowSvgFallback: true,
        operatorSvgTimeoutMs: PDFJS_OPERATOR_SVG_TIMEOUT_MS,
        pageBox: 'artBox',
      });
      if (pdfCompatible && (rendered.svgElementCount === 0 || rendered.svgVisualReliable === false || rendered.svgOmitsFullPageRaster === true)) {
        try {
          const info = pageInfos.find(page => page.pageNumber === pageNumber);
          if (!info?.view) throw new Error('AI page bounds unavailable');
          const scale = Math.min(2, 1600 / info.width);
          const pageWidth = Math.floor(info.width * scale), pageHeight = Math.floor(info.height * scale);
          const box = resolvePdfRenderPageBox(filePath, { view: info.view }, pageNumber, scale, pageWidth, pageHeight, 'artBox');
          if (box.width !== rendered.width || box.height !== rendered.height) throw new Error('AI ArtBox dimensions changed');
          const cairo = await renderPdfCairoEditable({ filePath, outSvgPath: pageSvgPath, previewPath: pagePngPath,
            width: rendered.width, height: rendered.height, pageNumber, allowSingleSourceImage: true,
            artifactUrlPrefix: `/uploads/${path.relative(STORAGE.base, parsedDir).split(path.sep).join('/')}`,
            sourceCrop: { left: box.cropLeft / scale, top: box.cropTop / scale, width: box.width / scale, height: box.height / scale,
              pageWidth: info.width, pageHeight: info.height } });
          rendered = { ...rendered, ...cairo, svgVisualReliable: true, svgOmitsFullPageRaster: false,
            textGlyphCount: 0, textPathCount: 0, textMissingGlyphCount: 0, textPathGlyphs: [],
            svgWarning: 'AI artwork recovered as independent source shapes and images.' };
        } catch (error) {
          logger.warn({ scope: 'ai', pageNumber, err: error }, 'AI: alternate extraction failed its ArtBox fidelity gate');
        }
      }
      const relativeImagePath = `${getParserArtifactDirectory(fileId) || `parsed/${fileId}`}/${pagePngName}`;
      const relativeSvgPath = rendered.svgElementCount > 0
        && rendered.svgOmitsFullPageRaster !== true
        ? `${getParserArtifactDirectory(fileId) || `parsed/${fileId}`}/${pageSvgName}`
        : undefined;
      const relativeTextlessPreviewPath = rendered.textlessPngPath
        ? `${getParserArtifactDirectory(fileId) || `parsed/${fileId}`}/${path.basename(rendered.textlessPngPath)}`
        : undefined;
      const svgRoleStats = relativeSvgPath
        ? countSvgObjectRoleStats(pageSvgPath)
        : {
            editableVectorCount: 0,
            decorationVectorCount: 0,
            editableRasterCount: 0,
            visualOnlyCount: 0,
          };
      renderedPages.push({ ...rendered, relativeImagePath, relativeSvgPath, relativeTextlessPreviewPath, svgRoleStats });
      totalSvgElementCount += relativeSvgPath ? rendered.svgElementCount : 0;
      totalSvgRasterImageCount += relativeSvgPath ? (rendered.svgRasterImageCount || 0) : 0;
      totalTextGlyphCount += relativeSvgPath ? (rendered.textGlyphCount || 0) : 0;
      totalTextPathCount += relativeSvgPath ? (rendered.textPathCount || 0) : 0;
      totalTextMissingGlyphCount += relativeSvgPath ? (rendered.textMissingGlyphCount || 0) : 0;

      if (pageNumber === 1) {
        const clientThumbnailUsed = await writeClientAssistPreviewToPath(clientAssistSnapshot, pngPath);
        if (!clientThumbnailUsed) await createAiThumbnail(pagePngPath, pngPath);
      }
    }

    const firstPage = renderedPages[0];
    const previewOnlyFallback = totalSvgElementCount === 0;
    const previewPageCount = renderedPages.filter((page) => !page.relativeSvgPath).length;
    const sourceTextLayerCount = renderedPages.reduce(
      (sum, page) => sum + (page.relativeSvgPath ? page.textLayers.length : 0),
      0
    );
    const totalEditableVectorCount = renderedPages.reduce((sum, page) => sum + page.svgRoleStats.editableVectorCount, 0);
    const totalDecorationVectorCount = renderedPages.reduce((sum, page) => sum + page.svgRoleStats.decorationVectorCount, 0);
    const totalEditableRasterCount = renderedPages.reduce((sum, page) => sum + page.svgRoleStats.editableRasterCount, 0);
    const totalVisualOnlyCount = renderedPages.reduce((sum, page) => sum + page.svgRoleStats.visualOnlyCount, 0);
    const totalRedundantClipPathCount = renderedPages.reduce((sum, page) => sum + (page.redundantClipPathCount || 0), 0);
    const parsePages = renderedPages.map((page) => ({
      page: page.pageNumber,
      name: pageCount > 1 ? `画板 ${page.pageNumber}` : undefined,
      width: page.width,
      height: page.height,
      previewPath: page.relativeImagePath,
      ...(page.relativeTextlessPreviewPath ? { textlessPreviewPath: page.relativeTextlessPreviewPath } : {}),
      ...(page.relativeSvgPath ? { svgPath: page.relativeSvgPath } : {}),
      layerCount: page.relativeSvgPath ? page.svgElementCount + page.textLayers.length : 1,
      vectorLayerCount: page.relativeSvgPath ? page.svgElementCount : 0,
      editableTextLayerCount: 0,
      textLayerCount: page.relativeSvgPath ? page.textLayers.length : 0,
      sourceTextLayerCount: page.relativeSvgPath ? page.textLayers.length : 0,
      textOnDemandLayerCount: page.relativeSvgPath ? page.textLayers.length : 0,
      textMetadataLayerCount: 0,
      svgRoleStats: page.relativeSvgPath ? page.svgRoleStats : {
        editableVectorCount: 0,
        decorationVectorCount: 0,
        editableRasterCount: 0,
        visualOnlyCount: 0,
      },
      editableVectorCount: page.relativeSvgPath ? page.svgRoleStats.editableVectorCount : 0,
      decorationVectorCount: page.relativeSvgPath ? page.svgRoleStats.decorationVectorCount : 0,
      editableRasterCount: page.relativeSvgPath ? page.svgRoleStats.editableRasterCount : 0,
      visualOnlyCount: page.relativeSvgPath ? page.svgRoleStats.visualOnlyCount : 0,
      textPathGlyphCount: page.relativeSvgPath ? (page.textGlyphCount || 0) : 0,
      textPathLayerCount: page.relativeSvgPath ? (page.textPathCount || 0) : 0,
      textPathMissingGlyphCount: page.relativeSvgPath ? (page.textMissingGlyphCount || 0) : 0,
      svgRasterImageCount: page.relativeSvgPath ? (page.svgRasterImageCount || 0) : 0,
      svgContainsRasterImages: page.relativeSvgPath ? (page.svgRasterImageCount || 0) > 0 : false,
      svgOmitsRasterImages: page.relativeSvgPath ? page.svgOmitsFullPageRaster === true : false,
      svgOmittedFullPageRaster: page.relativeSvgPath ? page.svgOmitsFullPageRaster === true : false,
      redundantClipPathCount: page.relativeSvgPath ? (page.redundantClipPathCount || 0) : 0,
      previewLayerCount: page.relativeSvgPath ? 0 : 1,
      previewOnly: !page.relativeSvgPath,
      ...(page.svgFidelityMethod ? { svgFidelityMethod: page.svgFidelityMethod, svgSourceVisualDiffRatio: page.svgSourceVisualDiffRatio, ...(page.sourceImageOnly ? { sourceImageOnly: true } : {}) } : {}),
      ...(typeof page.svgVisualDiffRatio === 'number' ? { svgVisualDiffRatio: page.svgVisualDiffRatio } : {}),
      ...(page.svgVisualReliable === false ? { svgVisualReliable: false } : {}),
    }));

    const hasOmittedSvgRasterImages = renderedPages.some((page) =>
      Boolean(page.relativeSvgPath) && page.svgOmitsFullPageRaster === true
    );
    const shouldUseExplicitVisualBacking = hasOmittedSvgRasterImages
      || renderedPages.some((page) =>
        Boolean(page.relativeSvgPath)
        && page.svgVisualReliable === false
        && (page.svgRasterImageCount || 0) === 0
      );

    const parseResult: Record<string, unknown> = {
      aiParserVersion: AI_PARSER_VERSION,
      method: previewOnlyFallback ? 'pdf-compatible-ai-preview' : 'pdf-compatible-ai-svg',
      width: firstPage.width,
      height: firstPage.height,
      pageCount,
      pages: parsePages,
      layerCount: totalSvgElementCount + sourceTextLayerCount + previewPageCount,
      vectorLayerCount: totalSvgElementCount,
      editableTextLayerCount: 0,
      textLayerCount: sourceTextLayerCount,
      sourceTextLayerCount,
      textOnDemandLayerCount: sourceTextLayerCount,
      textMetadataLayerCount: 0,
      previewLayerCount: previewPageCount,
      editableVectorCount: totalEditableVectorCount,
      decorationVectorCount: totalDecorationVectorCount,
      editableRasterCount: totalEditableRasterCount,
      visualOnlyCount: totalVisualOnlyCount,
      editableSvg: totalSvgElementCount > 0,
      svgOmitsText: false,
      textLayersAreMetadata: renderedPages.some(page => page.svgFidelityMethod === 'cairo-source'),
      svgOmitsRasterImages: hasOmittedSvgRasterImages,
      svgOmittedFullPageRaster: hasOmittedSvgRasterImages,
      svgRasterImageCount: totalSvgRasterImageCount,
      svgContainsRasterImages: totalSvgRasterImageCount > 0,
      explicitVisualBacking: shouldUseExplicitVisualBacking,
      textPathGlyphCount: totalTextGlyphCount,
      textPathLayerCount: totalTextPathCount,
      textPathMissingGlyphCount: totalTextMissingGlyphCount,
      textPathCoverage: totalTextGlyphCount ? Math.min(1, totalTextPathCount / Math.max(1, totalTextGlyphCount)) : 1,
      redundantClipPathCount: totalRedundantClipPathCount,
    };
    if (firstPage.svgFidelityMethod) {
      parseResult.svgFidelityMethod = firstPage.svgFidelityMethod;
      parseResult.svgSourceVisualDiffRatio = firstPage.svgSourceVisualDiffRatio;
    }
    if (typeof firstPage.svgVisualDiffRatio === 'number') {
      parseResult.svgVisualDiffRatio = firstPage.svgVisualDiffRatio;
    }
    if (clientAssistSnapshot) {
      parseResult.clientParseAssist = {
        preview: Boolean(clientAssistSnapshot.previewPath),
        textLayerCandidateCount: clientAssistSnapshot.textLayers.length,
        imageOpCount: clientAssistSnapshot.imageOpCount,
        pathOpCount: clientAssistSnapshot.pathOpCount,
      };
    }
    const svgWarnings = renderedPages
      .map((page) => page.svgWarning)
      .filter((item): item is string => Boolean(item));
    if (svgWarnings.length > 0) {
      parseResult.warning = previewOnlyFallback
        ? `AI editable SVG extraction fell back to preview: ${svgWarnings[0]}`
        : `AI editable SVG visual diff is high; kept editable SVG: ${svgWarnings[0]}`;
    } else if (previewOnlyFallback) {
      parseResult.warning = 'AI file rendered as preview only because no editable SVG vector elements were found.';
    }
    if (firstPage.relativeSvgPath) parseResult.svgPath = firstPage.relativeSvgPath;
    if (firstPage.relativeImagePath) parseResult.previewPath = firstPage.relativeImagePath;
    if (totalTextMissingGlyphCount > 0) {
      parseResult.warning = [
        typeof parseResult.warning === 'string' ? parseResult.warning : null,
        `AI-compatible PDF text path generation missed ${totalTextMissingGlyphCount} glyph(s); source text metadata was not overlaid with fallback fonts.`,
      ].filter(Boolean).join(' ');
    }

    await updateParserFile(file, {
      thumbnailPath: getParserThumbnailPath(fileId),
      width: firstPage.width,
      height: firstPage.height,
      parseStatus: 'completed',
      parseResult,
    });
    if (!isIsolatedParser()) warmUploadThumbnailVariants(getParserThumbnailPath(fileId));

    const textLayerRows = renderedPages.filter((page) => Boolean(page.relativeSvgPath)).flatMap((page, pageIndex) => (
      page.textLayers.map((layer, index) => ({
          fileId,
          layerName: pageCount > 1
            ? `画板 ${page.pageNumber} / ${layer.text.slice(0, 48) || `Text ${index + 1}`}`
            : layer.text.slice(0, 60) || `Text ${index + 1}`,
          layerType: 'text' as const,
          parentLayerId: null,
          sortOrder: pageIndex * 100000 + page.svgElementCount + index + 1,
          visible: true,
          x: layer.x,
          y: layer.y,
          width: layer.width,
          height: layer.height,
          textContent: layer.text,
          textStyle: {
            fontSize: layer.fontSize,
            font: { name: layer.fontName || '' },
            fillColor: layer.fillColor,
          },
          properties: {
            source: 'ai',
            page: page.pageNumber,
            editableAs: 'text-on-demand',
            role: 'source-text',
            textSource: layer.source || 'pdfjs',
            confidence: layer.confidence ?? null,
            textPathGlyphIds: layer.textPathGlyphIds || [],
            textPathBounds: layer.textPathBounds || null,
            fontName: layer.fontName || '',
            writingMode: layer.writingMode || 'horizontal-tb',
            textMatrix: layer.textMatrix || null,
            rotation: layer.rotation ?? 0,
          },
        }))
    ));
    if (textLayerRows.length > 0) {
      await ParsedLayer.bulkCreate(textLayerRows, { transaction: getParserLayerTransaction() });
    }

    logger.info(
      {
        scope: 'ai',
        method: parseResult.method,
        name: file.name,
        pages: pageCount,
        vectors: totalSvgElementCount,
        sourceText: sourceTextLayerCount,
        textPaths: totalTextPathCount,
        missingTextGlyphs: totalTextMissingGlyphCount,
      },
      'AI: parse completed'
    );
    return;
  } catch (err) {
    logger.warn({ scope: 'ai', err }, 'AI: pdfjs SVG parse failed');
  }

  try {
    const sharp = require('sharp');

    const clientFallbackUsed = await writeClientAssistPreviewToPath(clientAssistSnapshot, pngPath);
    if (!clientFallbackUsed) {
      await sharp(filePath, { density: 150 })
        .png()
        .toFile(pngPath);
    }

    const meta = await sharp(pngPath).metadata();

    await updateParserFile(file, {
      thumbnailPath: getParserThumbnailPath(fileId),
      width: meta.width || null,
      height: meta.height || null,
      parseStatus: 'completed',
        parseResult: {
          aiParserVersion: AI_PARSER_VERSION,
          method: 'sharp',
          previewPath: path.relative(STORAGE.base, pngPath).split(path.sep).join('/'),
          previewOnly: true,
          previewLayerCount: 1,
          pageCount: 1,
          pages: [{ page: 1, width: meta.width, height: meta.height, previewOnly: true,
            previewPath: path.relative(STORAGE.base, pngPath).split(path.sep).join('/'), previewLayerCount: 1 }],
          width: meta.width,
          height: meta.height,
          layerCount: 0,
          vectorLayerCount: 0,
          editableVectorCount: 0,
          decorationVectorCount: 0,
          editableRasterCount: 0,
          visualOnlyCount: 0,
          editableTextLayerCount: 0,
          editableSvg: false,
          ...(clientFallbackUsed ? { clientParseAssist: { preview: true } } : {}),
          warning: 'AI file could not be parsed into editable vector data; thumbnail is for library preview only.',
        },
      });
    if (!isIsolatedParser()) warmUploadThumbnailVariants(getParserThumbnailPath(fileId));

    logger.info({ scope: 'ai', method: 'sharp', name: file.name }, 'AI: thumbnail-only fallback (no editable layers)');
    return;
  } catch (err) {
    logger.warn({ scope: 'ai', err }, 'AI: Sharp parse failed');
  }

  await updateParserFile(file, {
    parseStatus: 'failed',
    parseResult: {
      aiParserVersion: AI_PARSER_VERSION,
      method: 'none',
      error: 'AI file could not be parsed by any available conversion strategy.',
      warning: 'AI file could not be parsed',
      layerCount: 0,
      vectorLayerCount: 0,
      editableVectorCount: 0,
      decorationVectorCount: 0,
      editableRasterCount: 0,
      visualOnlyCount: 0,
      editableTextLayerCount: 0,
      editableSvg: false,
    },
  });

  logger.error({ scope: 'ai', name: file.name }, 'AI: all parse strategies failed');
  throw new Error('AI file could not be parsed by any available conversion strategy.');
}
