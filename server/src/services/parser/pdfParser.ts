import fs from 'fs';
import path from 'path';
import { exec, execFile, type ChildProcess } from 'child_process';
import { DesignFile } from '../../models';
import { STORAGE } from '../../config/storage';
import { logger } from '../../utils/logger';
import { warmUploadThumbnailVariants } from '../uploadThumbnailVariants';
import {
  checkInkscape,
  getPdfPageInfos,
  getPdfjsDocumentOptions,
  normalizePdfTextLayers,
  readSvgInfo,
  type PdfTextLayer,
} from './aiParser';
import { countSvgObjectRoleStats, type SvgRoleStats } from './svgRoles';
import { resolveParserFilePath } from './resolveParserFilePath';
import { ParserLayerStore as ParsedLayer, getParserLayerTransaction, isIsolatedParser, updateParserFile,
  getParserArtifactDirectory, getParserOutputDirectory, getParserThumbnailPath } from './parserExecution';
import { AI_PARSER_VERSION, PDF_PARSER_VERSION } from './parserVersions';
import { renderPdfEditableIsolated } from './pdfEditableRenderSupervisor';
import { renderPdfCairoEditable, pdfSvgNeedsVisualBacking } from './pdfCairoRender';
export { PDF_PARSER_VERSION } from './parserVersions';
import {
  resolveClientParseAssistSnapshot,
  writeClientAssistPreviewToPath,
  type ClientParseAssistSnapshot,
} from './clientParseAssist';

const PDF_EDITABLE_SVG_TIMEOUT_MS = 45_000;

function isPdfiumDisabled(): boolean {
  if (['1', 'true', 'yes'].includes(String(process.env.ENABLE_PDFIUM_NATIVE || '').toLowerCase())) {
    return false;
  }
  return true;
}

// 跟踪活跃的 inkscape 子进程，进程退出时统一清理（防 pm2 重启后留孤儿）
const activeInkscapeProcs = new Set<ChildProcess>();

function execInkscape(cmd: string, opts: Record<string, unknown>): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { ...opts, encoding: 'utf8' } as any, (err, stdout, stderr) => {
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

interface RenderedPdfPage {
  bufferPath: string;
  relativeImagePath: string;
  width: number;
  height: number;
  method: string;
  textLayers: PdfTextLayer[];
  textLayersAreMetadata?: boolean;
  rasterLayers: PdfRasterLayer[];
  svgElementCount: number;
  svgRasterImageCount?: number;
  svgWarning?: string;
  svgVisualDiffRatio?: number;
  svgVisualReliable?: boolean;
  svgFidelityMethod?: 'cairo-source';
  svgSourceVisualDiffRatio?: number;
  sourceImageOnly?: true;
  relativeSvgPath?: string;
  relativeTextlessPreviewPath?: string;
  textGlyphCount?: number;
  textPathCount?: number;
  textMissingGlyphCount?: number;
  redundantClipPathCount?: number;
  pageNumber?: number;
}

interface PdfRasterLayer {
  imagePath: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ParsePdfOptions {
  resultFileType?: 'ai';
  clientAssistSnapshot?: ClientParseAssistSnapshot | null;
  getClientAssistSnapshot?: (() => ClientParseAssistSnapshot | null | undefined) | null;
  allowClientAssistWait?: boolean;
}

function countEditableSvgRasterImages(svgPath: string): number {
  try {
    if (!fs.existsSync(svgPath)) return 0;
    const svg = fs.readFileSync(svgPath, 'utf8');
    return (svg.match(/<image\b(?=[^>]*\bdata-object-role=["']editable-raster["'])/gi) || []).length;
  } catch (err) {
    logger.warn({ scope: 'pdf', err, svgPath }, 'PDF: failed to count editable SVG raster images');
    return 0;
  }
}

export async function parsePdf(fileId: number, options: ParsePdfOptions = {}): Promise<void> {
  const file = await DesignFile.findByPk(fileId);
  if (!file) throw new Error(`File not found: ${fileId}`);

  await updateParserFile(file, { parseStatus: 'parsing' });
  await ParsedLayer.destroy({ where: { fileId }, transaction: getParserLayerTransaction() });

  const filePath = resolveParserFilePath(file.filePath);
  const parsedDir = getParserOutputDirectory(fileId);
  if (!fs.existsSync(parsedDir)) fs.mkdirSync(parsedDir, { recursive: true });

  try {
    const clientAssistSnapshot = await resolveClientParseAssistSnapshot(
      options.clientAssistSnapshot,
      options.getClientAssistSnapshot,
      options.allowClientAssistWait,
    );
    const pageInfos = await getPdfPageInfos(filePath).catch(() => []);
    const pageCount = Math.max(1, pageInfos.length || 1);
    const renderedPages: Array<{
      rendered: RenderedPdfPage;
      sourceTextLayers: PdfTextLayer[];
      hasEditableSvg: boolean;
      hasPreviewFallback: boolean;
      svgNeedsVisualBacking: boolean;
      editableSvgRasterImageCount: number;
      svgRoleStats: SvgRoleStats;
    }> = [];

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const pagePath = path.join(parsedDir, `pdf_page_${pageNumber}.png`);
      const svgPath = path.join(parsedDir, `pdf_page_${pageNumber}.svg`);
      let rendered = await renderFirstPage(filePath, fileId, pagePath, svgPath, clientAssistSnapshot, pageNumber, options.resultFileType === 'ai');
      const hasEditableSvg = Boolean(rendered.relativeSvgPath && rendered.svgElementCount > 0);
      rendered = await dropPdfRasterTextMaskArtifacts(rendered, rendered.textLayers);
      const sourceTextLayers = await applyPreviewSampledTextColors(
        rendered.textLayers,
        rendered.bufferPath,
        rendered.width,
        rendered.height
      );
      const hasPreviewFallback = !hasEditableSvg && rendered.rasterLayers.length === 0;
      const editableSvgRasterImageCount = hasEditableSvg
        ? countEditableSvgRasterImages(svgPath)
        : rendered.rasterLayers.length;
      const svgRoleStats = hasEditableSvg
        ? countSvgObjectRoleStats(svgPath)
        : {
            editableVectorCount: 0,
            decorationVectorCount: 0,
            editableRasterCount: rendered.rasterLayers.length,
            visualOnlyCount: 0,
          };
      const svgRasterImageCount = rendered.svgRasterImageCount || 0;
      const svgNeedsVisualBacking = hasEditableSvg && svgRasterImageCount === 0 && (
        pdfSvgNeedsVisualBacking(rendered)
      );
      renderedPages.push({
        rendered,
        sourceTextLayers,
        hasEditableSvg,
        hasPreviewFallback,
        svgNeedsVisualBacking,
        editableSvgRasterImageCount,
        svgRoleStats,
      });
    }

    const firstPage = renderedPages[0]?.rendered;
    if (!firstPage) throw new Error('PDF rendered no pages');
    const thumbFilename = `${fileId}_thumb.png`;
    const thumbPath = path.join(STORAGE.base, getParserThumbnailPath(fileId));
    await createThumbnail(firstPage.bufferPath, thumbPath);

    const totalSvgElementCount = renderedPages.reduce((sum, page) => sum + (page.hasEditableSvg ? page.rendered.svgElementCount : 0), 0);
    const totalRasterLayerCount = renderedPages.reduce((sum, page) => sum + page.rendered.rasterLayers.length, 0);
    const totalEditableSvgRasterImageCount = renderedPages.reduce((sum, page) => sum + page.editableSvgRasterImageCount, 0);
    const totalEditableVectorCount = renderedPages.reduce((sum, page) => sum + page.svgRoleStats.editableVectorCount, 0);
    const totalDecorationVectorCount = renderedPages.reduce((sum, page) => sum + page.svgRoleStats.decorationVectorCount, 0);
    const totalEditableRasterCount = renderedPages.reduce((sum, page) => sum + page.svgRoleStats.editableRasterCount, 0);
    const totalVisualOnlyCount = renderedPages.reduce((sum, page) => sum + page.svgRoleStats.visualOnlyCount, 0);
    const totalSvgRasterImageCount = renderedPages.reduce((sum, page) => sum + (page.hasEditableSvg ? (page.rendered.svgRasterImageCount || 0) : 0), 0);
    const totalTextLayerCount = renderedPages.reduce((sum, page) => sum + page.sourceTextLayers.length, 0);
    const totalTextMetadataLayerCount = renderedPages.reduce((sum, page) => sum + (page.rendered.textLayersAreMetadata ? page.sourceTextLayers.length : 0), 0);
    const totalTextOnDemandLayerCount = totalTextLayerCount - totalTextMetadataLayerCount;
    const totalPreviewLayerCount = renderedPages.reduce((sum, page) => sum + (page.hasPreviewFallback || page.svgNeedsVisualBacking ? 1 : 0), 0);
    const totalTextGlyphCount = renderedPages.reduce((sum, page) => sum + (page.rendered.textGlyphCount || 0), 0);
    const totalTextPathCount = renderedPages.reduce((sum, page) => sum + (page.rendered.textPathCount || 0), 0);
    const totalTextMissingGlyphCount = renderedPages.reduce((sum, page) => sum + (page.rendered.textMissingGlyphCount || 0), 0);
    const totalRedundantClipPathCount = renderedPages.reduce((sum, page) => sum + (page.rendered.redundantClipPathCount || 0), 0);
    const textPathCoverage = totalTextGlyphCount
      ? Math.min(1, totalTextPathCount / Math.max(1, totalTextGlyphCount))
      : 1;
    const parsePages = renderedPages.map((page, pageIndex) => {
      const rendered = page.rendered;
      const pageNumber = rendered.pageNumber || pageIndex + 1;
      const svgRasterImageCount = page.hasEditableSvg ? (rendered.svgRasterImageCount || 0) : 0;
      return {
        page: pageNumber,
        name: pageCount > 1 ? `画板 ${pageNumber}` : undefined,
        width: rendered.width,
        height: rendered.height,
        previewPath: rendered.relativeImagePath,
        ...(rendered.relativeTextlessPreviewPath ? { textlessPreviewPath: rendered.relativeTextlessPreviewPath } : {}),
        ...(rendered.relativeSvgPath ? { svgPath: rendered.relativeSvgPath } : {}),
        layerCount: page.hasEditableSvg
          ? rendered.svgElementCount + rendered.rasterLayers.length + page.sourceTextLayers.length
          : (page.hasPreviewFallback ? 1 : rendered.rasterLayers.length + page.sourceTextLayers.length),
        vectorLayerCount: page.hasEditableSvg ? rendered.svgElementCount : 0,
        rasterLayerCount: rendered.rasterLayers.length,
        editableTextLayerCount: 0,
        textLayerCount: page.sourceTextLayers.length,
        sourceTextLayerCount: page.sourceTextLayers.length,
        textOnDemandLayerCount: rendered.textLayersAreMetadata ? 0 : page.sourceTextLayers.length,
        textMetadataLayerCount: rendered.textLayersAreMetadata ? page.sourceTextLayers.length : 0,
        textLayersAreMetadata: rendered.textLayersAreMetadata === true,
        previewLayerCount: page.hasPreviewFallback || page.svgNeedsVisualBacking ? 1 : 0,
        previewOnly: page.hasPreviewFallback,
        rasterImageLayerCount: page.editableSvgRasterImageCount,
        svgRoleStats: page.svgRoleStats,
        editableVectorCount: page.svgRoleStats.editableVectorCount,
        decorationVectorCount: page.svgRoleStats.decorationVectorCount,
        editableRasterCount: page.svgRoleStats.editableRasterCount,
        visualOnlyCount: page.svgRoleStats.visualOnlyCount,
        textPathGlyphCount: rendered.textGlyphCount || 0,
        textPathLayerCount: rendered.textPathCount || 0,
        textPathMissingGlyphCount: rendered.textMissingGlyphCount || 0,
        svgRasterImageCount,
        svgContainsRasterImages: svgRasterImageCount > 0,
        svgOmitsRasterImages: false,
        explicitVisualBacking: page.svgNeedsVisualBacking,
        redundantClipPathCount: page.hasEditableSvg ? (rendered.redundantClipPathCount || 0) : 0,
        ...(typeof rendered.svgVisualDiffRatio === 'number' ? { svgVisualDiffRatio: rendered.svgVisualDiffRatio } : {}),
        ...(rendered.svgFidelityMethod ? { svgFidelityMethod: rendered.svgFidelityMethod, svgSourceVisualDiffRatio: rendered.svgSourceVisualDiffRatio, ...(rendered.sourceImageOnly ? { sourceImageOnly: true } : {}) } : {}),
        ...(rendered.svgVisualReliable === false ? { svgVisualReliable: false } : {}),
      };
    });
    const uniqueMethods = Array.from(new Set(renderedPages.map((page) => page.rendered.method))).join(',');
    const parseResult: Record<string, unknown> = {
      pdfParserVersion: PDF_PARSER_VERSION,
      ...(options.resultFileType === 'ai' ? { aiParserVersion: AI_PARSER_VERSION } : {}),
      method: uniqueMethods || firstPage.method,
      width: firstPage.width,
      height: firstPage.height,
      pageCount,
      pages: parsePages,
      layerCount: totalSvgElementCount + totalRasterLayerCount + totalTextOnDemandLayerCount + totalPreviewLayerCount,
      vectorLayerCount: totalSvgElementCount,
      rasterLayerCount: totalRasterLayerCount,
      editableTextLayerCount: 0,
      textLayerCount: totalTextLayerCount,
      sourceTextLayerCount: totalTextLayerCount,
      textOnDemandLayerCount: totalTextOnDemandLayerCount,
      textMetadataLayerCount: totalTextMetadataLayerCount,
      previewLayerCount: totalPreviewLayerCount,
      previewOnly: renderedPages.every((page) => page.hasPreviewFallback),
      previewOnlyPages: renderedPages.flatMap((page, index) => page.hasPreviewFallback ? [page.rendered.pageNumber || index + 1] : []),
      rasterImageLayerCount: totalEditableSvgRasterImageCount,
      editableVectorCount: totalEditableVectorCount,
      decorationVectorCount: totalDecorationVectorCount,
      editableRasterCount: totalEditableRasterCount,
      visualOnlyCount: totalVisualOnlyCount,
      editableSvg: totalSvgElementCount > 0,
      svgOmitsText: false,
      svgOmitsRasterImages: false,
      svgRasterImageCount: totalSvgRasterImageCount,
      svgContainsRasterImages: totalSvgRasterImageCount > 0,
      explicitVisualBacking: renderedPages.some((page) => page.svgNeedsVisualBacking),
      textLayersAreMetadata: renderedPages.every((page) => page.rendered.textLayersAreMetadata === true),
      textPathGlyphCount: totalTextGlyphCount,
      textPathLayerCount: totalTextPathCount,
      textPathMissingGlyphCount: totalTextMissingGlyphCount,
      textPathCoverage,
      previewPath: firstPage.relativeImagePath,
      redundantClipPathCount: totalRedundantClipPathCount,
    };
    if (firstPage.relativeSvgPath) parseResult.svgPath = firstPage.relativeSvgPath;
    if (firstPage.relativeTextlessPreviewPath) parseResult.textlessPreviewPath = firstPage.relativeTextlessPreviewPath;
    if (renderedPages.some((page) => page.rendered.method.includes('client-assist-preview'))) {
      parseResult.clientParseAssist = {
        preview: true,
        textLayerCandidateCount: clientAssistSnapshot?.textLayers.length || 0,
        imageOpCount: clientAssistSnapshot?.imageOpCount || 0,
        pathOpCount: clientAssistSnapshot?.pathOpCount || 0,
      };
    }
    const svgWarnings = renderedPages
      .map((page) => page.rendered.svgWarning
        ? page.rendered.textLayersAreMetadata
          ? page.rendered.svgWarning
          : page.hasEditableSvg
            ? `PDF editable SVG visual diff is high; kept editable SVG: ${page.rendered.svgWarning}`
            : `PDF editable SVG extraction fell back to preview: ${page.rendered.svgWarning}`
        : undefined)
      .filter((item): item is string => Boolean(item));
    if (svgWarnings.length > 0) {
      parseResult.warning = Array.from(new Set(svgWarnings)).join(' ');
    }
    if (typeof firstPage.svgVisualDiffRatio === 'number') parseResult.svgVisualDiffRatio = firstPage.svgVisualDiffRatio;
    if (firstPage.svgFidelityMethod) {
      parseResult.svgFidelityMethod = firstPage.svgFidelityMethod;
      parseResult.svgSourceVisualDiffRatio = firstPage.svgSourceVisualDiffRatio;
    }
    if (totalTextMissingGlyphCount > 0) {
      parseResult.warning = [
        typeof parseResult.warning === 'string' ? parseResult.warning : null,
        `PDF text path generation missed ${totalTextMissingGlyphCount} glyph(s); source text metadata was not overlaid with fallback fonts.`,
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

    const imageLayerRows = renderedPages.flatMap((page, pageIndex) => {
      const rendered = page.rendered;
      const imageLayers = rendered.rasterLayers.length > 0
        ? rendered.rasterLayers
        : (page.hasPreviewFallback ? [{
            imagePath: rendered.relativeImagePath,
            x: 0,
            y: 0,
            width: rendered.width,
            height: rendered.height,
          }] : []);
      return imageLayers.map((layer, index) => ({
        fileId,
        layerName: pageCount > 1
          ? `${file.name} 画板 ${rendered.pageNumber || pageIndex + 1} 图片 ${index + 1}`
          : `${file.name} 图片 ${index + 1}`,
        layerType: 'image' as const,
        parentLayerId: null,
        sortOrder: pageIndex * 100000 + index + 1,
        visible: true,
        x: Math.round(layer.x),
        y: Math.round(layer.y),
        width: Math.round(layer.width),
        height: Math.round(layer.height),
        imagePath: layer.imagePath,
        properties: {
          source: 'pdf',
          page: rendered.pageNumber || pageIndex + 1,
          editableAs: rendered.rasterLayers.length > 0 ? 'image' : 'preview',
          extractedFrom: rendered.rasterLayers.length > 0 ? 'pdf-raster' : 'page-preview',
          role: rendered.rasterLayers.length > 0 ? undefined : 'page-preview',
        },
      }));
    });
    if (imageLayerRows.length > 0) {
      await ParsedLayer.bulkCreate(imageLayerRows, { transaction: getParserLayerTransaction() });
    }

    const textLayerRows = renderedPages.flatMap((page, pageIndex) => page.sourceTextLayers.map((layer, index) => ({
      fileId,
      layerName: pageCount > 1
        ? `画板 ${page.rendered.pageNumber || pageIndex + 1} / ${layer.text.slice(0, 48) || `Text ${index + 1}`}`
        : layer.text.slice(0, 60) || `Text ${index + 1}`,
      layerType: 'text' as const,
      parentLayerId: null,
      sortOrder: pageIndex * 100000 + page.rendered.rasterLayers.length + page.rendered.svgElementCount + index + 1,
      visible: true,
      x: Math.round(layer.x),
      y: Math.round(layer.y),
      width: Math.round(layer.width),
      height: Math.round(layer.height),
      textContent: layer.text,
      textStyle: {
        fontSize: Math.round(layer.fontSize),
        fillColor: layer.fillColor || '#141413',
        font: { name: layer.fontName || '' },
        source: 'pdf',
      },
      properties: {
        source: 'pdf',
        page: page.rendered.pageNumber || pageIndex + 1,
        editableAs: page.rendered.textLayersAreMetadata ? 'metadata' : 'text-on-demand',
        role: page.rendered.textLayersAreMetadata ? 'text-metadata' : 'source-text',
        textSource: layer.source || 'pdfjs',
        confidence: layer.confidence ?? null,
        textPathGlyphIds: layer.textPathGlyphIds || [],
        textPathBounds: layer.textPathBounds || null,
        fontName: layer.fontName || '',
        writingMode: layer.writingMode || 'horizontal-tb',
        textMatrix: layer.textMatrix || null,
        rotation: layer.rotation ?? 0,
      },
    })));
    if (textLayerRows.length > 0) {
      await ParsedLayer.bulkCreate(textLayerRows, { transaction: getParserLayerTransaction() });
    }

    logger.info(
      {
        scope: 'pdf',
        name: file.name,
        width: firstPage.width,
        height: firstPage.height,
        pages: pageCount,
        method: parseResult.method,
        vectors: totalSvgElementCount,
        rasters: totalRasterLayerCount,
        sourceText: totalTextLayerCount,
        textPaths: totalTextPathCount,
        missingTextGlyphs: totalTextMissingGlyphCount,
      },
      'PDF: parse completed'
    );
  } catch (err) {
    logger.error({ scope: 'pdf', err }, 'PDF: parse failed');
    await updateParserFile(file, {
      parseStatus: 'failed',
      parseResult: { error: (err as Error).message },
    });
    throw err;
  }
}

async function parsePdfLegacySinglePage(fileId: number, options: ParsePdfOptions = {}): Promise<void> {
  const file = await DesignFile.findByPk(fileId);
  if (!file) throw new Error(`File not found: ${fileId}`);

  await updateParserFile(file, { parseStatus: 'parsing' });
  await ParsedLayer.destroy({ where: { fileId }, transaction: getParserLayerTransaction() });

  const filePath = resolveParserFilePath(file.filePath);
  const parsedDir = getParserOutputDirectory(fileId);
  if (!fs.existsSync(parsedDir)) fs.mkdirSync(parsedDir, { recursive: true });

  const pageFilename = 'pdf_page_1.png';
  const svgFilename = 'pdf_page_1.svg';
  const pagePath = path.join(parsedDir, pageFilename);
  const svgPath = path.join(parsedDir, svgFilename);

  try {
    const clientAssistSnapshot = await resolveClientParseAssistSnapshot(
      options.clientAssistSnapshot,
      options.getClientAssistSnapshot,
      options.allowClientAssistWait,
    );
    let rendered = await renderFirstPage(filePath, fileId, pagePath, svgPath, clientAssistSnapshot);
    const thumbFilename = `${fileId}_thumb.png`;
    const thumbPath = path.join(STORAGE.base, getParserThumbnailPath(fileId));
    await createThumbnail(rendered.bufferPath, thumbPath);

    const hasEditableSvg = Boolean(rendered.relativeSvgPath && rendered.svgElementCount > 0);
    rendered = await dropPdfRasterTextMaskArtifacts(rendered, rendered.textLayers);
    const sourceTextLayers = hasEditableSvg
      ? await applyPreviewSampledTextColors(
          rendered.textLayers,
          rendered.bufferPath,
          rendered.width,
          rendered.height
        )
      : [];
    const hasPreviewFallback = !hasEditableSvg && rendered.rasterLayers.length === 0;
    const editableSvgRasterImageCount = hasEditableSvg
      ? countEditableSvgRasterImages(svgPath)
      : rendered.rasterLayers.length;
    const svgRoleStats = hasEditableSvg
      ? countSvgObjectRoleStats(svgPath)
      : {
          editableVectorCount: 0,
          decorationVectorCount: 0,
          editableRasterCount: rendered.rasterLayers.length,
          visualOnlyCount: 0,
        };
    const svgRasterImageCount = rendered.svgRasterImageCount || 0;
    const svgIncludesRasterImages = svgRasterImageCount > 0;
    const svgNeedsVisualBacking = hasEditableSvg && !svgIncludesRasterImages && (
      pdfSvgNeedsVisualBacking(rendered)
    );
    const textPathCoverage = rendered.textGlyphCount
      ? Math.min(1, (rendered.textPathCount || 0) / Math.max(1, rendered.textGlyphCount))
      : 1;
    const parseResult: Record<string, unknown> = {
      pdfParserVersion: PDF_PARSER_VERSION,
      method: rendered.method,
      width: rendered.width,
      height: rendered.height,
      pages: 1,
      layerCount: rendered.svgElementCount + rendered.rasterLayers.length + sourceTextLayers.length + (hasPreviewFallback || svgNeedsVisualBacking ? 1 : 0),
      vectorLayerCount: rendered.svgElementCount,
      rasterLayerCount: rendered.rasterLayers.length,
      editableTextLayerCount: 0,
      textLayerCount: sourceTextLayers.length,
      sourceTextLayerCount: sourceTextLayers.length,
      textOnDemandLayerCount: sourceTextLayers.length,
      textMetadataLayerCount: 0,
      previewLayerCount: hasPreviewFallback || svgNeedsVisualBacking ? 1 : 0,
      rasterImageLayerCount: editableSvgRasterImageCount,
      svgRoleStats,
      editableVectorCount: svgRoleStats.editableVectorCount,
      decorationVectorCount: svgRoleStats.decorationVectorCount,
      editableRasterCount: svgRoleStats.editableRasterCount,
      visualOnlyCount: svgRoleStats.visualOnlyCount,
      editableSvg: hasEditableSvg,
      svgOmitsText: false,
      svgOmitsRasterImages: false,
      svgRasterImageCount,
      svgContainsRasterImages: svgIncludesRasterImages,
      explicitVisualBacking: svgNeedsVisualBacking,
      textLayersAreMetadata: false,
      textPathGlyphCount: rendered.textGlyphCount || 0,
      textPathLayerCount: rendered.textPathCount || 0,
      textPathMissingGlyphCount: rendered.textMissingGlyphCount || 0,
      redundantClipPathCount: rendered.redundantClipPathCount || 0,
      textPathCoverage,
      previewPath: rendered.relativeImagePath,
    };
    if (rendered.method.includes('client-assist-preview')) {
      parseResult.clientParseAssist = {
        preview: true,
        textLayerCandidateCount: clientAssistSnapshot?.textLayers.length || 0,
        imageOpCount: clientAssistSnapshot?.imageOpCount || 0,
        pathOpCount: clientAssistSnapshot?.pathOpCount || 0,
      };
    }
    if (rendered.method.includes('pdfjs-svg') && rendered.svgWarning) {
      parseResult.warning = `PDF editable SVG visual diff is high; kept editable SVG: ${rendered.svgWarning}`;
    }
    if (rendered.method.includes('pdfjs-preview') && rendered.svgWarning) {
      parseResult.warning = `PDF editable SVG extraction fell back to preview: ${rendered.svgWarning}`;
    }
    if (typeof rendered.svgVisualDiffRatio === 'number') parseResult.svgVisualDiffRatio = rendered.svgVisualDiffRatio;
    if (rendered.svgFidelityMethod) {
      parseResult.svgFidelityMethod = rendered.svgFidelityMethod;
      parseResult.svgSourceVisualDiffRatio = rendered.svgSourceVisualDiffRatio;
      if (rendered.svgWarning) parseResult.warning = rendered.svgWarning;
    }
    if (rendered.relativeSvgPath) parseResult.svgPath = rendered.relativeSvgPath;
    if ((rendered.textMissingGlyphCount || 0) > 0) {
      parseResult.warning = [
        typeof parseResult.warning === 'string' ? parseResult.warning : null,
        `PDF text path generation missed ${rendered.textMissingGlyphCount} glyph(s); source text metadata was not overlaid with fallback fonts.`,
      ].filter(Boolean).join(' ');
    }

    await updateParserFile(file, {
      thumbnailPath: getParserThumbnailPath(fileId),
      width: rendered.width,
      height: rendered.height,
      parseStatus: 'completed',
      parseResult,
    });
    if (!isIsolatedParser()) warmUploadThumbnailVariants(getParserThumbnailPath(fileId));

    const imageLayers = rendered.rasterLayers.length > 0
      ? rendered.rasterLayers
      : (hasPreviewFallback ? [{
          imagePath: rendered.relativeImagePath,
          x: 0,
          y: 0,
          width: rendered.width,
          height: rendered.height,
        }] : []);

    if (imageLayers.length > 0) {
      await ParsedLayer.bulkCreate(imageLayers.map((layer, index) => {
        return {
          fileId,
          layerName: `${file.name} 图片 ${index + 1}`,
          layerType: 'image' as const,
          parentLayerId: null,
          sortOrder: index + 1,
          visible: true,
          x: Math.round(layer.x),
          y: Math.round(layer.y),
          width: Math.round(layer.width),
          height: Math.round(layer.height),
          imagePath: layer.imagePath,
          properties: {
            source: 'pdf',
            page: 1,
            editableAs: rendered.rasterLayers.length > 0 ? 'image' : 'preview',
            extractedFrom: rendered.rasterLayers.length > 0 ? 'pdf-raster' : 'page-preview',
            role: rendered.rasterLayers.length > 0 ? undefined : 'page-preview',
          },
        };
      }), { transaction: getParserLayerTransaction() });
    }

    if (sourceTextLayers.length > 0) {
      await ParsedLayer.bulkCreate(sourceTextLayers.map((layer, index) => ({
        fileId,
        layerName: layer.text.slice(0, 60) || `Text ${index + 1}`,
        layerType: 'text',
        parentLayerId: null,
        sortOrder: rendered.rasterLayers.length + rendered.svgElementCount + index + 1,
        visible: true,
        x: Math.round(layer.x),
        y: Math.round(layer.y),
        width: Math.round(layer.width),
        height: Math.round(layer.height),
        textContent: layer.text,
        textStyle: {
          fontSize: Math.round(layer.fontSize),
          fillColor: layer.fillColor || '#141413',
          font: { name: layer.fontName || '' },
          source: 'pdf',
        },
        properties: {
          source: 'pdf',
          page: 1,
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
      })), { transaction: getParserLayerTransaction() });
    }

    logger.info(
      {
        scope: 'pdf',
        name: file.name,
        width: rendered.width,
        height: rendered.height,
        method: rendered.method,
        vectors: rendered.svgElementCount,
        rasters: rendered.rasterLayers.length,
        sourceText: sourceTextLayers.length,
        textPaths: rendered.textPathCount || 0,
        missingTextGlyphs: rendered.textMissingGlyphCount || 0,
      },
      'PDF: parse completed'
    );
  } catch (err) {
    logger.error({ scope: 'pdf', err }, 'PDF: parse failed');
    await updateParserFile(file, {
      parseStatus: 'failed',
      parseResult: { error: (err as Error).message },
    });
    throw err;
  }
}

async function renderFirstPage(
  filePath: string,
  fileId: number,
  outPngPath: string,
  outSvgPath: string,
  clientAssist?: ClientParseAssistSnapshot | null,
  pageNumber = 1,
  allowSingleSourceImage = false
): Promise<RenderedPdfPage> {
  const pagePreviewResult = await renderPdfWithPoppler(filePath, fileId, outPngPath, pageNumber)
    || await renderPdfWithClientAssist(fileId, outPngPath, clientAssist, pageNumber)
    || await renderPdfWithPdfium(filePath, fileId, outPngPath, pageNumber);
  const editablePngPath = outPngPath.replace(/\.png$/i, '.editable.png');

  try {
    const rendered = await renderPdfEditableIsolated(filePath, editablePngPath, outSvgPath, pageNumber, {
      allowSvgFallback: true,
      operatorSvgTimeoutMs: PDF_EDITABLE_SVG_TIMEOUT_MS,
      trustedPreviewPath: pagePreviewResult?.method === 'poppler-preview' ? pagePreviewResult.bufferPath : undefined,
    });
    const canUseEditableSvg = rendered.svgElementCount > 0
      && rendered.svgOmitsFullPageRaster !== true;
    if (pagePreviewResult?.method === 'poppler-preview' && (!canUseEditableSvg || rendered.svgVisualReliable === false)) {
      try {
        const cairo = await renderPdfCairoEditable({ filePath, outSvgPath,
          previewPath: pagePreviewResult.bufferPath, width: rendered.width, height: rendered.height, pageNumber, allowSingleSourceImage,
          artifactUrlPrefix: `/uploads/${getParserArtifactDirectory(fileId) || `parsed/${fileId}`}` });
        await ensurePreviewMatchesWorldBounds(pagePreviewResult.bufferPath, rendered.width, rendered.height);
        return { ...pagePreviewResult, ...cairo, width: rendered.width, height: rendered.height,
          method: 'poppler-preview+cairo-svg', svgVisualReliable: true,
          relativeSvgPath: `${getParserArtifactDirectory(fileId) || `parsed/${fileId}`}/pdf_page_${pageNumber}.svg`,
          textLayers: rendered.textLayers, textLayersAreMetadata: true,
          svgWarning: '已恢复独立图形和图片。转曲文字和复合效果可移动、缩放，不能直接修改字词；细密纹理可能有少量显示差异。' };
      } catch (error) {
        logger.warn({ scope: 'pdf', pageNumber, err: error }, 'PDF: alternate editable extraction failed its fidelity gate');
      }
      await ensurePreviewMatchesWorldBounds(pagePreviewResult.bufferPath, rendered.width, rendered.height);
      logger.warn({ scope: 'pdf', pageNumber, svgVisualDiffRatio: rendered.svgVisualDiffRatio },
        'PDF: complex editable SVG differs from the source; keeping the faithful page preview');
      return {
        ...pagePreviewResult,
        width: rendered.width,
        height: rendered.height,
        textLayers: rendered.textLayers,
        textLayersAreMetadata: true,
        svgElementCount: 0,
        svgRasterImageCount: 0,
        svgVisualReliable: false,
        svgVisualDiffRatio: rendered.svgVisualDiffRatio,
        svgWarning: '复杂 PDF 已使用原页图像保留外观；原有元素暂不能逐个编辑，可添加内容。',
      };
    }
    const svgInfo = canUseEditableSvg
      ? readSvgInfo(outSvgPath, rendered.width, rendered.height)
      : { width: rendered.width, height: rendered.height, elementCount: 0 };
    if (!canUseEditableSvg) {
      logger.warn(
        {
          scope: 'pdf',
          svgElementCount: rendered.svgElementCount,
          svgOmitsFullPageRaster: rendered.svgOmitsFullPageRaster,
          svgVisualDiffRatio: rendered.svgVisualDiffRatio,
          textLayerCount: rendered.textLayers.length,
        },
        'PDF: editable SVG is unavailable; using page preview as world-aligned fallback'
      );
    } else if (rendered.svgVisualReliable === false) {
      logger.warn(
        {
          scope: 'pdf',
          svgElementCount: rendered.svgElementCount,
          svgVisualDiffRatio: rendered.svgVisualDiffRatio,
          textLayerCount: rendered.textLayers.length,
        },
        'PDF: editable SVG visual diff is high; keeping editable SVG with warning'
      );
    }
    const editableResult: RenderedPdfPage = {
      bufferPath: editablePngPath,
      relativeImagePath: `${getParserArtifactDirectory(fileId) || `parsed/${fileId}`}/pdf_page_${pageNumber}.png`,
      relativeSvgPath: canUseEditableSvg ? `${getParserArtifactDirectory(fileId) || `parsed/${fileId}`}/pdf_page_${pageNumber}.svg` : undefined,
      relativeTextlessPreviewPath: canUseEditableSvg && rendered.textlessPngPath
        ? `${getParserArtifactDirectory(fileId) || `parsed/${fileId}`}/${path.basename(rendered.textlessPngPath)}`
        : undefined,
      width: rendered.width,
      height: rendered.height,
      method: canUseEditableSvg ? 'pdfjs-svg' : 'pdfjs-preview',
      textLayers: rendered.textLayers.length > 0
        ? rendered.textLayers
        : clientAssistTextLayers(clientAssist, rendered.width, rendered.height),
      rasterLayers: [],
      svgElementCount: canUseEditableSvg ? Math.max(rendered.svgElementCount, svgInfo.elementCount) : 0,
      svgRasterImageCount: canUseEditableSvg ? (rendered.svgRasterImageCount || 0) : 0,
      svgWarning: rendered.svgWarning,
      svgVisualDiffRatio: rendered.svgVisualDiffRatio,
      svgVisualReliable: rendered.svgVisualReliable,
      textGlyphCount: rendered.textGlyphCount,
      textPathCount: rendered.textPathCount,
      textMissingGlyphCount: rendered.textMissingGlyphCount,
      redundantClipPathCount: rendered.redundantClipPathCount,
      pageNumber,
    };
    const previewAlignedResult = await withPreviewResult(fileId, outPngPath, pagePreviewResult, editableResult, pageNumber);
    if (!canUseEditableSvg) {
      writeRasterPageFallbackSvg(
        outSvgPath,
        previewAlignedResult.relativeImagePath,
        previewAlignedResult.width,
        previewAlignedResult.height,
      );
      return {
        ...previewAlignedResult,
        relativeSvgPath: `${getParserArtifactDirectory(fileId) || `parsed/${fileId}`}/pdf_page_${pageNumber}.svg`,
        method: `${previewAlignedResult.method}+raster-page-fallback`,
        textLayers: previewAlignedResult.textLayers,
        svgElementCount: 1,
        svgRasterImageCount: 1,
      };
    }
    return previewAlignedResult;
  } catch (err) {
    logger.warn({ scope: 'pdf', err }, 'PDF: pdfjs editable SVG parse failed, trying Inkscape');
  }

  const inkscapeResult = await renderPdfWithInkscape(filePath, fileId, outPngPath, outSvgPath, pageNumber);
  if (inkscapeResult) return await withPreviewResult(fileId, outPngPath, pagePreviewResult, inkscapeResult, pageNumber);

  if (pagePreviewResult) return pagePreviewResult;

  logger.warn({ scope: 'pdf' }, 'PDF: editable parse failed, falling back to page image');
  return renderImageFallback(filePath, fileId, outPngPath, pageNumber);
}

function writeRasterPageFallbackSvg(
  outSvgPath: string,
  relativeImagePath: string,
  width: number,
  height: number
): void {
  const safeWidth = Math.max(1, Math.round(width || 1));
  const safeHeight = Math.max(1, Math.round(height || 1));
  const href = `/uploads/${relativeImagePath.replace(/\\/g, '/')}`;
  const svg = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${safeWidth}" height="${safeHeight}" viewBox="0 0 ${safeWidth} ${safeHeight}">`,
    `<image data-pdf-raster="true" data-object-role="editable-raster" data-pdf-page-rasterized="true" aria-label="raster page fallback" href="${escapeXml(href)}" xlink:href="${escapeXml(href)}" x="0" y="0" width="${safeWidth}" height="${safeHeight}" preserveAspectRatio="none" />`,
    `</svg>`,
  ].join('\n');
  fs.writeFileSync(outSvgPath, svg, 'utf8');
}

function escapeXml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function renderPdfWithClientAssist(
  fileId: number,
  outPngPath: string,
  clientAssist?: ClientParseAssistSnapshot | null,
  pageNumber = 1
): Promise<RenderedPdfPage | null> {
  if (pageNumber !== 1) return null;
  if (!clientAssist || clientAssist.fileType !== 'pdf') return null;
  const written = await writeClientAssistPreviewToPath(clientAssist, outPngPath);
  if (!written) return null;
  return {
    bufferPath: outPngPath,
    relativeImagePath: `${getParserArtifactDirectory(fileId) || `parsed/${fileId}`}/pdf_page_${pageNumber}.png`,
    width: clientAssist.width,
    height: clientAssist.height,
    method: 'client-assist-preview',
    textLayers: clientAssistTextLayers(clientAssist, clientAssist.width, clientAssist.height),
    rasterLayers: [],
    svgRasterImageCount: 0,
    svgElementCount: 0,
    pageNumber,
  };
}

function clientAssistTextLayers(
  clientAssist: ClientParseAssistSnapshot | null | undefined,
  targetWidth: number,
  targetHeight: number
): PdfTextLayer[] {
  if (!clientAssist || clientAssist.textLayers.length === 0) return [];
  const widthDelta = Math.abs(clientAssist.width - targetWidth);
  const heightDelta = Math.abs(clientAssist.height - targetHeight);
  if (widthDelta > Math.max(4, targetWidth * 0.01) || heightDelta > Math.max(4, targetHeight * 0.01)) {
    return [];
  }

  return normalizePdfTextLayers(clientAssist.textLayers
    .filter((layer) => (
      layer.x > -targetWidth * 0.05
      && layer.y > -targetHeight * 0.05
      && layer.x + layer.width < targetWidth * 1.05
      && layer.y + layer.height < targetHeight * 1.05
    ))
    .map((layer) => ({
      text: layer.text,
      x: layer.x,
      y: layer.y,
      width: layer.width,
      height: layer.height,
      fontSize: layer.fontSize,
      fillColor: '#141413',
      fontName: mapPdfFont(layer.fontName || 'sans-serif'),
      source: 'client-assist',
    })));
}

function overlapsPdfTextMaskArtifact(text: PdfTextLayer, raster: PdfRasterLayer): boolean {
  const textBounds = {
    x: text.x - Math.max(2, text.fontSize * 0.16),
    y: text.y - Math.max(2, text.fontSize * 0.16),
    width: text.width + Math.max(4, text.fontSize * 0.32),
    height: text.height + Math.max(4, text.fontSize * 0.32),
  };
  const intersection = rectIntersectionArea(textBounds, raster);
  if (intersection <= 0) return false;
  const textArea = Math.max(1, textBounds.width * textBounds.height);
  const rasterArea = Math.max(1, raster.width * raster.height);
  return intersection / textArea >= 0.35 || intersection / rasterArea >= 0.18;
}

async function dropPdfRasterTextMaskArtifacts(
  rendered: RenderedPdfPage,
  textLayers: PdfTextLayer[]
): Promise<RenderedPdfPage> {
  if (textLayers.length === 0 || rendered.rasterLayers.length <= 1) return rendered;
  const filtered = rendered.rasterLayers.filter((raster) => {
    if (isFullPageRasterLayer(raster, rendered.width, rendered.height)) return true;
    return !textLayers.some((text) => overlapsPdfTextMaskArtifact(text, raster));
  });
  if (filtered.length === rendered.rasterLayers.length) return rendered;
  logger.info(
    {
      scope: 'pdf',
      droppedRasterTextMaskArtifacts: rendered.rasterLayers.length - filtered.length,
      rasterCount: rendered.rasterLayers.length,
    },
    'PDF: dropped rasterized text mask artifacts'
  );
  return { ...rendered, rasterLayers: filtered };
}

function rectIntersectionArea(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

async function withPreviewResult(
  fileId: number,
  outPngPath: string,
  previewResult: RenderedPdfPage | null,
  editableResult: RenderedPdfPage,
  pageNumber = 1,
  allowSingleSourceImage = false
): Promise<RenderedPdfPage> {
  if (!previewResult) {
    try {
      fs.copyFileSync(editableResult.bufferPath, outPngPath);
    } catch {
      // editableResult.bufferPath 仍可用于缩略图，copy 失败不影响编辑层。
    }
    return {
      ...editableResult,
      bufferPath: fs.existsSync(outPngPath) ? outPngPath : editableResult.bufferPath,
      relativeImagePath: `${getParserArtifactDirectory(fileId) || `parsed/${fileId}`}/pdf_page_${pageNumber}.png`,
      pageNumber,
    };
  }

  await ensurePreviewMatchesWorldBounds(previewResult.bufferPath, editableResult.width, editableResult.height);
  return {
    ...editableResult,
    bufferPath: previewResult.bufferPath,
    relativeImagePath: previewResult.relativeImagePath,
    method: `${previewResult.method}+${editableResult.method}`,
    pageNumber,
  };
}

async function ensurePreviewMatchesWorldBounds(
  previewPath: string,
  worldWidth: number,
  worldHeight: number
): Promise<void> {
  if (!fs.existsSync(previewPath)) return;

  try {
    const sharp = require('sharp');
    const meta = await sharp(previewPath).metadata();
    const width = Math.max(1, Math.round(worldWidth));
    const height = Math.max(1, Math.round(worldHeight));
    if (meta.width === width && meta.height === height) return;

    const tmpPath = previewPath.replace(/\.png$/i, '.world.png');
    await sharp(previewPath)
      .resize(width, height, { fit: 'fill' })
      .png()
      .toFile(tmpPath);
    fs.renameSync(tmpPath, previewPath);
  } catch (err) {
    logger.warn(
      { scope: 'pdf', err, previewPath, worldWidth, worldHeight },
      'PDF: failed to align preview image to editable world bounds'
    );
  }
}

async function renderPdfWithPoppler(
  filePath: string,
  fileId: number,
  outPngPath: string,
  pageNumber = 1
): Promise<RenderedPdfPage | null> {
  const binary = resolvePdfToPpmBinary();
  if (!binary) return null;

  const outputPrefix = outPngPath.replace(/\.png$/i, '');
  const renderedPath = `${outputPrefix}.png`;
  try {
    if (fs.existsSync(renderedPath)) fs.unlinkSync(renderedPath);
    await execFileUtf8(binary, [
      '-f',
      String(Math.max(1, pageNumber)),
      '-singlefile',
      '-cropbox',
      '-png',
      '-r',
      '150',
      filePath,
      outputPrefix,
    ], { timeout: 45_000 });
    if (!fs.existsSync(renderedPath)) return null;
    if (path.resolve(renderedPath) !== path.resolve(outPngPath)) {
      fs.copyFileSync(renderedPath, outPngPath);
    }

    const sharp = require('sharp');
    const meta = await sharp(outPngPath).metadata();
    return {
      bufferPath: outPngPath,
      relativeImagePath: `${getParserArtifactDirectory(fileId) || `parsed/${fileId}`}/pdf_page_${pageNumber}.png`,
      width: meta.width || 1080,
      height: meta.height || 1080,
      method: 'poppler-preview',
      textLayers: [],
      rasterLayers: [],
      svgRasterImageCount: 0,
      svgElementCount: 0,
      pageNumber,
    };
  } catch (err) {
    logger.warn({ scope: 'pdf', err, binary }, 'PDF: Poppler preview render failed');
    return null;
  }
}

function resolvePdfToPpmBinary(): string | null {
  const explicit = process.env.PDFTOPPM_PATH || process.env.POPPLER_PDFTOPPM_PATH;
  const candidates = [
    explicit,
    process.platform === 'win32' && process.env.USERPROFILE
      ? path.join(
          process.env.USERPROFILE,
          '.cache',
          'codex-runtimes',
          'codex-primary-runtime',
          'dependencies',
          'native',
          'poppler',
          'Library',
          'bin',
          'pdftoppm.exe'
        )
      : null,
    process.platform === 'win32' ? 'pdftoppm.exe' : 'pdftoppm',
    'pdftoppm',
  ].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
    return candidate;
  }
  return null;
}

function execFileUtf8(
  command: string,
  args: string[],
  opts: { timeout?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...opts, encoding: 'utf8' } as any, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function renderPdfWithPdfium(
  filePath: string,
  fileId: number,
  outPngPath: string,
  pageNumber = 1
): Promise<RenderedPdfPage | null> {
  if (isPdfiumDisabled()) {
    logger.warn({ scope: 'pdf' }, 'PDF: PDFium native render skipped; enable with ENABLE_PDFIUM_NATIVE=1');
    return null;
  }

  try {
    const { loadDocument } = await import('pdfium-native');
    const sharp = require('sharp');

    const doc = await loadDocument(filePath);
    try {
      const page = await doc.getPage(Math.max(0, pageNumber - 1));
      try {
        const scale = Math.min(2, 1600 / Math.max(page.width, 1));
        await page.render({
          scale,
          format: 'png',
          output: outPngPath,
        });

        const meta = await sharp(outPngPath).metadata();
        const width = meta.width || Math.max(1, Math.round(page.width * scale));
        const height = meta.height || Math.max(1, Math.round(page.height * scale));

        return {
          bufferPath: outPngPath,
          relativeImagePath: `${getParserArtifactDirectory(fileId) || `parsed/${fileId}`}/pdf_page_${pageNumber}.png`,
          width,
          height,
          method: 'pdfium-native',
          textLayers: [],
          rasterLayers: [],
          svgRasterImageCount: 0,
          svgElementCount: 0,
          pageNumber,
        };
      } finally {
        page.close();
      }
    } finally {
      doc.destroy();
    }
  } catch (err) {
    logger.warn({ scope: 'pdf', err }, 'PDF: PDFium render failed, trying legacy fallback chain');
    return null;
  }
}

async function renderPdfWithInkscape(
  filePath: string,
  fileId: number,
  outPngPath: string,
  outSvgPath: string,
  pageNumber = 1
): Promise<RenderedPdfPage | null> {
  if (!(await checkInkscape())) return null;

  try {
    // 15s 是 inkscape 的判罚线：正常 PDF 几秒就完，超过 15s 多半是触发了
    // inkscape 内部 CPU 死循环或巨型位图矢量化 —— 放弃后自动 fallback 到 pdfjs-svg
    // 也能给出矢量 SVG，体验更好。清 DISPLAY 防 X server 干扰（虽不是根因，但稳）。
    const inkscapeEnv = { ...process.env };
    delete inkscapeEnv.DISPLAY;
    const inkscapeOpts = { timeout: 15_000, killSignal: 'SIGKILL' as const, env: inkscapeEnv };
    await execInkscape(`inkscape "${filePath}" --pdf-page=${pageNumber} --export-type=svg --export-filename="${outSvgPath}"`, inkscapeOpts);
    const svgInfo = readSvgInfo(outSvgPath);
    if (svgInfo.elementCount <= 0) {
      throw new Error('Inkscape SVG contains no editable elements');
    }

    await execInkscape(`inkscape "${filePath}" --pdf-page=${pageNumber} --export-type=png --export-filename="${outPngPath}" --export-width=1600`, inkscapeOpts);

    return {
      bufferPath: outPngPath,
      relativeImagePath: `${getParserArtifactDirectory(fileId) || `parsed/${fileId}`}/pdf_page_${pageNumber}.png`,
      relativeSvgPath: `${getParserArtifactDirectory(fileId) || `parsed/${fileId}`}/pdf_page_${pageNumber}.svg`,
      width: svgInfo.width,
      height: svgInfo.height,
      method: 'inkscape-svg',
      textLayers: [],
      rasterLayers: [],
      svgRasterImageCount: 0,
      svgElementCount: svgInfo.elementCount,
      pageNumber,
    };
  } catch (err) {
    logger.warn({ scope: 'pdf', err }, 'PDF: Inkscape SVG parse failed, trying pdfjs SVG parser');
    return null;
  }
}

async function renderImageFallback(
  filePath: string,
  fileId: number,
  outPngPath: string,
  pageNumber = 1,
  allowSingleSourceImage = false
): Promise<RenderedPdfPage> {
  try {
    const sharp = require('sharp');
    await sharp(filePath, { density: 180, page: Math.max(0, pageNumber - 1) })
      .flatten({ background: '#ffffff' })
      .png()
      .toFile(outPngPath);

    const meta = await sharp(outPngPath).metadata();
    const width = meta.width || 1080;
    const height = meta.height || 1080;

    return {
      bufferPath: outPngPath,
      relativeImagePath: `${getParserArtifactDirectory(fileId) || `parsed/${fileId}`}/pdf_page_${pageNumber}.png`,
      width,
      height,
      method: 'sharp-image',
      textLayers: await extractPdfTextLayers(filePath, width, height, pageNumber),
      rasterLayers: [],
      svgRasterImageCount: 0,
      svgElementCount: 0,
      pageNumber,
    };
  } catch (err) {
    logger.warn({ scope: 'pdf', err }, 'PDF: Sharp image fallback failed, using pdfjs canvas');
    return renderWithPdfjsImage(filePath, fileId, outPngPath, pageNumber);
  }
}

async function renderWithPdfjsImage(
  filePath: string,
  fileId: number,
  outPngPath: string,
  pageNumber = 1,
  allowSingleSourceImage = false
): Promise<RenderedPdfPage> {
  const { createCanvas } = require('@napi-rs/canvas');
  const pdfjs = await dynamicImport('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const loadingTask = pdfjs.getDocument(getPdfjsDocumentOptions(data, { disableFontFace: true }));
  const doc = await loadingTask.promise;
  const page = await doc.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(3, Math.max(1, 1600 / Math.max(baseViewport.width, baseViewport.height)));
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d');

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({
    canvasContext: context,
    viewport,
    canvas,
  }).promise;

  fs.writeFileSync(outPngPath, canvas.toBuffer('image/png'));

  const textLayers = await extractTextLayersFromPage(pdfjs, page, viewport);
  await doc.destroy?.();

  return {
    bufferPath: outPngPath,
    relativeImagePath: `${getParserArtifactDirectory(fileId) || `parsed/${fileId}`}/pdf_page_${pageNumber}.png`,
    width: canvas.width,
    height: canvas.height,
    method: 'pdfjs-image',
    textLayers,
    rasterLayers: [],
    svgRasterImageCount: 0,
    svgElementCount: 0,
    pageNumber,
  };
}

async function extractPdfTextLayers(
  filePath: string,
  targetWidth: number,
  targetHeight: number,
  pageNumber = 1
): Promise<PdfTextLayer[]> {
  const pdfjs = await dynamicImport('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const loadingTask = pdfjs.getDocument(getPdfjsDocumentOptions(data, { disableFontFace: true }));
  const doc = await loadingTask.promise;
  const page = await doc.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(targetWidth / baseViewport.width, targetHeight / baseViewport.height);
  const viewport = page.getViewport({ scale });
  const layers = await extractTextLayersFromPage(pdfjs, page, viewport);
  await doc.destroy?.();
  return layers;
}

async function extractTextLayersFromPage(pdfjs: any, page: any, viewport: any): Promise<PdfTextLayer[]> {
  const content = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
  const styles = content.styles || {};

  return normalizePdfTextLayers((content.items || [])
    .map((item: any): PdfTextLayer | null => {
      const text = String(item.str || '').trim();
      if (!text) return null;

      const tx = pdfjs.Util.transform(viewport.transform, item.transform);
      const fontSize = Math.max(6, Math.hypot(tx[2], tx[3]));
      const writingMode = item.dir === 'ttb' ? 'vertical-rl' : 'horizontal-tb';
      const itemWidth = Math.max(8, Math.abs(Number(item.width || text.length * fontSize * 0.55) * viewport.scale));
      const itemHeight = Math.max(8, Math.abs(Number(item.height || fontSize) * viewport.scale));
      const x = tx[4];
      const width = writingMode === 'vertical-rl' ? Math.max(fontSize * 1.15, itemWidth) : itemWidth;
      const height = writingMode === 'vertical-rl'
        ? Math.max(itemHeight, fontSize * text.length * 1.05)
        : Math.max(8, fontSize * 1.15);
      const y = writingMode === 'vertical-rl' ? tx[5] : tx[5] - height;
      const style = styles[item.fontName] || {};

      return {
        text,
        x,
        y,
        width,
        height,
        fontSize,
        fillColor: '#141413',
        fontName: mapPdfFont(String(style.fontFamily || item.fontName || 'sans-serif')),
        source: 'pdfjs',
        writingMode,
        textMatrix: Array.isArray(tx) ? tx.map((value: unknown) => Number(value) || 0) : undefined,
        rotation: matrixRotationDegrees(tx),
      };
    })
    .filter(Boolean) as PdfTextLayer[]);
}

function matrixRotationDegrees(matrix: unknown): number {
  if (!Array.isArray(matrix) || matrix.length < 2) return 0;
  const a = Number(matrix[0]) || 0;
  const b = Number(matrix[1]) || 0;
  const angle = Math.atan2(b, a) * 180 / Math.PI;
  return Number.isFinite(angle) ? angle : 0;
}

async function applyPreviewSampledTextColors(
  layers: PdfTextLayer[],
  previewPath: string,
  logicalWidth: number,
  logicalHeight: number
): Promise<PdfTextLayer[]> {
  if (layers.length === 0 || !fs.existsSync(previewPath)) return layers;

  try {
    const sharp = require('sharp');
    const { data, info } = await sharp(previewPath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const scaleX = info.width / logicalWidth;
    const scaleY = info.height / logicalHeight;
    return layers.map((layer) => ({
      ...layer,
      fillColor: sampleTextColorFromPreview(
        {
          ...layer,
          x: layer.x * scaleX,
          y: layer.y * scaleY,
          width: layer.width * scaleX,
          height: layer.height * scaleY,
          fontSize: layer.fontSize * scaleY,
        },
        data,
        info.width,
        info.height,
        info.channels
      ) || layer.fillColor || '#141413',
    }));
  } catch (err) {
    logger.warn({ scope: 'pdf', err }, 'PDF: preview text color sampling failed');
    return layers;
  }
}

function isFullPageRasterLayer(layer: PdfRasterLayer, pageWidth: number, pageHeight: number): boolean {
  const width = Math.max(1, pageWidth);
  const height = Math.max(1, pageHeight);
  const areaRatio = (layer.width * layer.height) / Math.max(1, width * height);
  return (
    layer.x <= width * 0.04
    && layer.y <= height * 0.04
    && layer.x + layer.width >= width * 0.96
    && layer.y + layer.height >= height * 0.96
  ) || areaRatio >= 0.82;
}

function sampleTextColorFromPreview(
  layer: PdfTextLayer,
  pixels: Uint8Array,
  pageWidth: number,
  pageHeight: number,
  channels: number
): string | null {
  const pad = Math.max(2, Math.round(layer.fontSize * 0.25));
  const x0 = clampInt(Math.floor(layer.x - pad), 0, pageWidth - 1);
  const y0 = clampInt(Math.floor(layer.y - pad), 0, pageHeight - 1);
  const x1 = clampInt(Math.ceil(layer.x + layer.width + pad), x0 + 1, pageWidth);
  const y1 = clampInt(Math.ceil(layer.y + layer.height + pad), y0 + 1, pageHeight);
  const cropWidth = x1 - x0;
  const cropHeight = y1 - y0;
  if (cropWidth <= 1 || cropHeight <= 1) return null;

  const border = Math.max(1, Math.min(pad, Math.floor(Math.min(cropWidth, cropHeight) / 3)));
  const background = dominantPreviewColor(pixels, pageWidth, channels, x0, y0, cropWidth, cropHeight, (x, y) =>
    x < border || y < border || x >= cropWidth - border || y >= cropHeight - border
  ) || dominantPreviewColor(pixels, pageWidth, channels, x0, y0, cropWidth, cropHeight);
  if (!background) return null;

  const candidates = new Map<string, { count: number; r: number; g: number; b: number; distance: number }>();
  let candidateCount = 0;

  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      const idx = ((y0 + y) * pageWidth + x0 + x) * channels;
      const alpha = channels >= 4 ? pixels[idx + 3] ?? 255 : 255;
      if (alpha <= 8) continue;
      const r = pixels[idx] ?? 0;
      const g = pixels[idx + 1] ?? 0;
      const b = pixels[idx + 2] ?? 0;
      const distance = previewColorDistance({ r, g, b }, background);
      if (distance < 42) continue;
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

function dominantPreviewColor(
  pixels: Uint8Array,
  pageWidth: number,
  channels: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
  include?: (x: number, y: number) => boolean
): { r: number; g: number; b: number } | null {
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (include && !include(x, y)) continue;
      const idx = ((y0 + y) * pageWidth + x0 + x) * channels;
      const alpha = channels >= 4 ? pixels[idx + 3] ?? 255 : 255;
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

function previewColorDistance(left: { r: number; g: number; b: number }, right: { r: number; g: number; b: number }): number {
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

async function extractPdfSvgRasterLayers(svgPath: string, fileId: number): Promise<PdfRasterLayer[]> {
  if (!fs.existsSync(svgPath)) return [];
  const svg = fs.readFileSync(svgPath, 'utf8');
  const layers: PdfRasterLayer[] = [];
  const seen = new Set<string>();
  for (const match of svg.matchAll(/<image\b[^>]*>/gi)) {
    const tag = match[0];
    const href = readSvgAttr(tag, 'href') || readSvgAttr(tag, 'xlink:href');
    if (!href || href.startsWith('data:')) continue;
    const imagePath = href.replace(/^\/uploads\//, '');
    const width = Number(readSvgAttr(tag, 'width')) || 0;
    const height = Number(readSvgAttr(tag, 'height')) || 0;
    if (width <= 0 || height <= 0) continue;
    const x = Number(readSvgAttr(tag, 'x')) || 0;
    const y = Number(readSvgAttr(tag, 'y')) || 0;
    const matrix = parseSvgMatrix(readSvgAttr(tag, 'transform'));
    const bounds = svgTransformedBounds(matrix, x, y, width, height);
    if (bounds.width <= 1 || bounds.height <= 1) continue;
    const key = `${imagePath}|${Math.round(bounds.left)}|${Math.round(bounds.top)}|${Math.round(bounds.width)}|${Math.round(bounds.height)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    layers.push({
      imagePath,
      x: bounds.left,
      y: bounds.top,
      width: bounds.width,
      height: bounds.height,
    });
  }
  const extracted = layers.filter((layer) => layer.imagePath.startsWith(`${getParserArtifactDirectory(fileId) || `parsed/${fileId}`}/`));
  return filterWhitePdfRasterOverlays(extracted);
}

async function filterWhitePdfRasterOverlays(layers: PdfRasterLayer[]): Promise<PdfRasterLayer[]> {
  if (layers.length <= 1) return layers;

  const maxWidth = Math.max(...layers.map((layer) => layer.width));
  const maxHeight = Math.max(...layers.map((layer) => layer.height));
  const filtered: PdfRasterLayer[] = [];

  for (const layer of layers) {
    const fullPageLike = layer.width >= maxWidth * 0.95 && layer.height >= maxHeight * 0.95;
    if (fullPageLike && await isMostlyWhiteOpaqueRaster(layer.imagePath)) {
      logger.info({ scope: 'pdf', imagePath: layer.imagePath }, 'PDF: dropped mostly-white raster overlay');
      continue;
    }
    filtered.push(layer);
  }

  return filterDuplicatePdfRasterMasks(filtered.length > 0 ? filtered : layers);
}

async function isMostlyWhiteOpaqueRaster(relativeImagePath: string): Promise<boolean> {
  const imagePath = path.join(STORAGE.base, relativeImagePath);
  if (!fs.existsSync(imagePath)) return false;

  try {
    const sharp = require('sharp');
    const { data, info } = await sharp(imagePath)
      .ensureAlpha()
      .resize({ width: 420, height: 420, fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });

    let opaque = 0;
    let white = 0;
    const pixels = Math.max(1, info.width * info.height);
    for (let offset = 0; offset < data.length; offset += info.channels) {
      const r = data[offset] || 0;
      const g = data[offset + 1] || 0;
      const b = data[offset + 2] || 0;
      const a = data[offset + 3] || 0;
      if (a <= 240) continue;
      opaque++;
      if (r >= 248 && g >= 248 && b >= 248) white++;
    }

    return opaque / pixels > 0.95 && white / Math.max(1, opaque) > 0.8;
  } catch (err) {
    logger.warn({ scope: 'pdf', err, imagePath: relativeImagePath }, 'PDF: white raster overlay check failed');
    return false;
  }
}

async function filterDuplicatePdfRasterMasks(layers: PdfRasterLayer[]): Promise<PdfRasterLayer[]> {
  if (layers.length <= 1) return layers;

  const groups = new Map<string, PdfRasterLayer[]>();
  for (const layer of layers) {
    const key = [
      Math.round(layer.x),
      Math.round(layer.y),
      Math.round(layer.width),
      Math.round(layer.height),
    ].join('|');
    groups.set(key, [...(groups.get(key) || []), layer]);
  }

  const result: PdfRasterLayer[] = [];
  for (const group of groups.values()) {
    if (group.length <= 1) {
      result.push(...group);
      continue;
    }

    const analyzed = await Promise.all(group.map(async (layer) => ({
      layer,
      maskLike: await isMostlyMonochromeOpaqueRaster(layer.imagePath),
    })));
    const hasContentLayer = analyzed.some((item) => !item.maskLike);
    const kept = hasContentLayer
      ? analyzed.filter((item) => !item.maskLike).map((item) => item.layer)
      : group;

    if (kept.length < group.length) {
      logger.info(
        {
          scope: 'pdf',
          droppedDuplicateRasterMasks: group.length - kept.length,
          bounds: {
            x: Math.round(group[0].x),
            y: Math.round(group[0].y),
            width: Math.round(group[0].width),
            height: Math.round(group[0].height),
          },
        },
        'PDF: dropped duplicate raster mask overlays'
      );
    }
    result.push(...kept);
  }

  return result;
}

async function isMostlyMonochromeOpaqueRaster(relativeImagePath: string): Promise<boolean> {
  const imagePath = path.join(STORAGE.base, relativeImagePath);
  if (!fs.existsSync(imagePath)) return false;

  try {
    const sharp = require('sharp');
    const { data, info } = await sharp(imagePath)
      .ensureAlpha()
      .resize({ width: 360, height: 360, fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });

    let visible = 0;
    let monochrome = 0;
    let saturated = 0;
    for (let offset = 0; offset < data.length; offset += info.channels) {
      const a = data[offset + 3] ?? 255;
      if (a <= 32) continue;
      visible++;
      const r = data[offset] ?? 0;
      const g = data[offset + 1] ?? 0;
      const b = data[offset + 2] ?? 0;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max - min <= 10) monochrome++;
      if (max - min >= 40) saturated++;
    }

    if (visible <= 0) return false;
    return monochrome / visible > 0.88 && saturated / visible < 0.08;
  } catch (err) {
    logger.warn({ scope: 'pdf', err, imagePath: relativeImagePath }, 'PDF: duplicate raster mask check failed');
    return false;
  }
}

function readSvgAttr(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\b${escaped}=["']([^"']+)["']`, 'i').exec(tag);
  return match?.[1] || null;
}

function parseSvgMatrix(value: string | null): [number, number, number, number, number, number] {
  if (!value) return [1, 0, 0, 1, 0, 0];
  const match = /matrix\(([^)]+)\)/i.exec(value);
  if (!match) return [1, 0, 0, 1, 0, 0];
  const nums = match[1].split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
  return [
    nums[0] ?? 1,
    nums[1] ?? 0,
    nums[2] ?? 0,
    nums[3] ?? 1,
    nums[4] ?? 0,
    nums[5] ?? 0,
  ];
}

function svgTransformedBounds(
  matrix: [number, number, number, number, number, number],
  x: number,
  y: number,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } {
  const points = [
    transformSvgPoint(matrix, x, y),
    transformSvgPoint(matrix, x + width, y),
    transformSvgPoint(matrix, x, y + height),
    transformSvgPoint(matrix, x + width, y + height),
  ];
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return { left, top, width: right - left, height: bottom - top };
}

function transformSvgPoint(matrix: [number, number, number, number, number, number], x: number, y: number): { x: number; y: number } {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  };
}

function mapPdfFont(fontFamily: string): string {
  const lower = fontFamily.toLowerCase();
  if (lower.includes('song') || lower.includes('serif')) return 'SimSun, "Noto Serif SC", serif';
  if (lower.includes('hei') || lower.includes('sans')) return '"Noto Sans SC", "Source Han Sans CN", "Microsoft YaHei", sans-serif';
  return `"${fontFamily}", "Noto Sans SC", "Source Han Sans CN", "Microsoft YaHei", sans-serif`;
}

async function createThumbnail(sourcePath: string, thumbPath: string) {
  const sharp = require('sharp');
  await sharp(sourcePath)
    .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toFile(thumbPath);
}

function dynamicImport(specifier: string): Promise<any> {
  return new Function('specifier', 'return import(specifier)')(specifier);
}
