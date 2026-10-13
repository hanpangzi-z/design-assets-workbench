import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Layer, Psd } from 'ag-psd';
import { DesignFile } from '../../models';
import { STORAGE } from '../../config/storage';
import { logger } from '../../utils/logger';
import { warmUploadThumbnailVariants } from '../uploadThumbnailVariants';
import { resolveParserFilePath } from './resolveParserFilePath';
import { ParserLayerStore as ParsedLayer, getParserArtifactDirectory, getParserLayerTransaction, isIsolatedParser, updateParserFile } from './parserExecution';
import { PSD_PARSER_VERSION } from './parserVersions';
export { PSD_PARSER_VERSION } from './parserVersions';
import { canRestorePsdVectorContent, checkPsdDecodedBudget, checkPsdSourceSize, classifyPsdLayer, createPsdMaskRenderer, createPsdSourceKeyResolver, firstPsdEffects, inspectPsdHeader, normalizePsdOpacity as normalizeOpacity, psdClippingBaseKeys, releasePsdLayerPixels, renderPsdVectorContent, serializePsdEffects, type PsdDiagnostic, type PsdMaskRaster } from './psdSemantics';

// 初始化 ag-psd 的 canvas 支持
let agPsdInitialized = false;
const AG_PSD_CMYK_COLOR_MODE = 4;

type PsdCanvas = {
  width?: number;
  height?: number;
  toBuffer: (fmt: string) => Buffer;
  getContext?: (type: '2d') => any;
};

type NormalizedPsdRaster = {
  canvas: PsdCanvas;
  left: number;
  top: number;
  width: number;
  height: number;
  documentClipped: boolean;
  alphaTrimmed: boolean;
};

function ensureAgPsdInit() {
  if (agPsdInitialized) return;
  try {
    enableAgPsdCmykReadSupport();
    const napiCanvas = require('@napi-rs/canvas');
    const agPsd = require('ag-psd');
    agPsd.initializeCanvas(
      (w: number, h: number) => napiCanvas.createCanvas(w, h),
      (w: number, h: number) => {
        const c = napiCanvas.createCanvas(w, h);
        const ctx = c.getContext('2d');
        return ctx.createImageData(w, h);
      }
    );
    agPsdInitialized = true;
    logger.info({ scope: 'psd' }, 'PSD: Canvas initialized (@napi-rs/canvas)');
  } catch (err) {
    logger.warn({ scope: 'psd', err }, 'PSD: @napi-rs/canvas unavailable, layer image rendering will be skipped');
  }
}

function normalizePsdRasterCanvas(
  sourceCanvas: PsdCanvas,
  layerLeft: number,
  layerTop: number,
): NormalizedPsdRaster | null {
  const sourceWidth = Math.max(0, Math.round(Number(sourceCanvas.width || 0)));
  const sourceHeight = Math.max(0, Math.round(Number(sourceCanvas.height || 0)));
  if (!sourceWidth || !sourceHeight) return null;

  // Raw layers keep off-canvas pixels so hidden or displaced content can be
  // moved into the document later. Only transparent margins are discarded;
  // the scene renderer clips the composed output to document dimensions.
  let cropLeft = 0;
  let cropTop = 0;
  let cropRight = sourceWidth;
  let cropBottom = sourceHeight;
  let alphaTrimmed = false;

  try {
    const ctx = sourceCanvas.getContext?.('2d');
    if (ctx) {
      const scanWidth = sourceWidth;
      const scanHeight = sourceHeight;
      const pixels = ctx.getImageData(
        0,
        0,
        scanWidth,
        scanHeight,
      ).data as Uint8ClampedArray;
      let minX = scanWidth;
      let minY = scanHeight;
      let maxX = -1;
      let maxY = -1;

      for (let y = 0; y < scanHeight; y++) {
        for (let x = 0; x < scanWidth; x++) {
          if (pixels[(y * scanWidth + x) * 4 + 3] === 0) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }

      if (maxX < minX || maxY < minY) return null;
      cropLeft = minX;
      cropTop = minY;
      cropRight = maxX + 1;
      cropBottom = maxY + 1;
      alphaTrimmed =
        cropLeft !== 0 || cropTop !== 0 ||
        cropRight !== sourceWidth || cropBottom !== sourceHeight;
    }
  } catch (err) {
    logger.warn({ scope: 'psd', err }, 'PSD: raster alpha bounds scan failed');
  }

  const cropWidth = cropRight - cropLeft;
  const cropHeight = cropBottom - cropTop;
  if (cropWidth <= 0 || cropHeight <= 0) return null;

  const needsCrop =
    cropLeft !== 0 || cropTop !== 0 || cropRight !== sourceWidth || cropBottom !== sourceHeight;

  let outputCanvas = sourceCanvas;
  if (needsCrop) {
    const napiCanvas = require('@napi-rs/canvas');
    const cropped = napiCanvas.createCanvas(cropWidth, cropHeight);
    const croppedCtx = cropped.getContext('2d') as any;
    croppedCtx.drawImage(
      sourceCanvas as any,
      cropLeft,
      cropTop,
      cropWidth,
      cropHeight,
      0,
      0,
      cropWidth,
      cropHeight,
    );
    outputCanvas = cropped as PsdCanvas;
  }

  return {
    canvas: outputCanvas,
    left: layerLeft + cropLeft,
    top: layerTop + cropTop,
    width: cropWidth,
    height: cropHeight,
    documentClipped: false,
    alphaTrimmed,
  };
}

function enableAgPsdCmykReadSupport() {
  const candidates = [
    'ag-psd/dist/psdReader.js',
    'ag-psd/dist/psdReader',
  ];
  let patched = false;

  for (const specifier of candidates) {
    try {
      const reader = require(specifier);
      const supportedColorModes = reader.supportedColorModes as number[] | undefined;
      if (Array.isArray(supportedColorModes)) {
        if (!supportedColorModes.includes(AG_PSD_CMYK_COLOR_MODE)) {
          supportedColorModes.push(AG_PSD_CMYK_COLOR_MODE);
        }
        patched = true;
      }
    } catch {
      // Some ag-psd package layouts do not expose every deep path; try the next candidate.
    }
  }

  if (!patched) {
    logger.warn({ scope: 'psd' }, 'PSD: CMYK read support patch could not find ag-psd reader module');
  }
}

function isAgPsdCmykReadEnabled(): boolean {
  try {
    const reader = require('ag-psd/dist/psdReader.js');
    const supportedColorModes = reader.supportedColorModes as number[] | undefined;
    return Array.isArray(supportedColorModes) && supportedColorModes.includes(AG_PSD_CMYK_COLOR_MODE);
  } catch (err) {
    logger.warn({ scope: 'psd', err }, 'PSD: CMYK read support check failed');
    return false;
  }
}

export async function parsePsd(fileId: number): Promise<void> {
  const file = await DesignFile.findByPk(fileId);
  if (!file) throw new Error(`File not found: ${fileId}`);

  await updateParserFile(file, { parseStatus: 'parsing' });
  const stagedDirectory = getParserArtifactDirectory(fileId);
  const artifactDirectory = stagedDirectory || `parsed/${fileId}/${randomUUID()}`;
  const parsedDir = path.join(STORAGE.base, artifactDirectory);
  const diagnostics: PsdDiagnostic[] = [];

  try {
    await ParsedLayer.destroy({ where: { fileId }, transaction: getParserLayerTransaction() });
    enableAgPsdCmykReadSupport();
    ensureAgPsdInit();
    if (!isAgPsdCmykReadEnabled()) {
      logger.warn({ scope: 'psd', fileId }, 'PSD: CMYK read support is not enabled');
    }
    const { readPsd } = require('ag-psd');

    const filePath = resolveParserFilePath(file.filePath);
    checkPsdSourceSize(fs.statSync(filePath).size);
    let buf = fs.readFileSync(filePath);
    const header = inspectPsdHeader(buf);
    if (!agPsdInitialized) throw new Error('PSD 图层图像解码器不可用');
    // The metadata pass checks layer and mask budgets before allocating pixels.
    const estimatedDecodedBytes = checkPsdDecodedBudget(readPsd(buf, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true }) as Psd);
    // ag-psd accepts Buffer directly; do not copy the whole input ArrayBuffer.
    const psd = readPsd(buf, { skipThumbnail: true }) as Psd;
    buf = Buffer.alloc(0);

    logger.info(
      { scope: 'psd', name: file.name, width: psd.width, height: psd.height, topLayers: psd.children?.length || 0 },
      'PSD: parsing'
    );

    // 确保输出目录存在
    if (!fs.existsSync(parsedDir)) fs.mkdirSync(parsedDir, { recursive: true });

    // 生成合成缩略图
    let thumbnailPath: string | null = null;
    let compositePath: string | null = null;
    if (psd.canvas) {
      try {
        const compositeBuffer = (psd.canvas as unknown as PsdCanvas).toBuffer('image/png');
        fs.writeFileSync(path.join(parsedDir, 'composite.png'), compositeBuffer);
        compositePath = `${artifactDirectory}/composite.png`;
        const sharp = require('sharp');
        const thumbnailBuffer = await sharp(compositeBuffer)
          .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
          .png()
          .toBuffer();
        const thumbFilename = 'thumbnail.png';
        const thumbFullPath = path.join(parsedDir, thumbFilename);
        fs.writeFileSync(thumbFullPath, thumbnailBuffer);
        thumbnailPath = `${artifactDirectory}/${thumbFilename}`;
        logger.info({ scope: 'psd', bytes: thumbnailBuffer.length }, 'PSD: composite thumbnail generated');
      } catch (err) {
        logger.warn({ scope: 'psd', err }, 'PSD: composite thumbnail failed');
        diagnostics.push({ code: 'composite-export-failed', severity: 'warning', message: `PSD 合成预览导出失败: ${(err as Error).message}` });
      }
    }

    delete psd.canvas;
    delete psd.imageData;
    if (!compositePath) diagnostics.push({ code: 'composite-missing', severity: 'warning', message: 'PSD 没有可用的合成预览' });

    // 递归解析图层
    let sortCounter = 0;
    let exportedImageCount = 0;
    let exportedMaskCount = 0;
    const renderMask = createPsdMaskRenderer();
    const sourceKeyOf = createPsdSourceKeyResolver(psd.children || []);
    let documentClippedRasterCount = 0;
    let alphaTrimmedRasterCount = 0;
    let vectorMaskFeatherRestoredCount = 0;
    // 汇总文档里出现过的所有字体名（默认 style + 每个 styleRun 的 font.name），
    // 解析结束后写到 parseResult.usedFonts，供前端比对哪些字体没上传。
    const usedFontsSet = new Set<string>();

    async function processLayers(
      layers: Layer[],
      parentId: number | null,
      treePath: number[] = [],
    ) {
      if (!layers) return;
      const clippingKeys = psdClippingBaseKeys(layers, treePath, sourceKeyOf);
      for (let index = 0; index < layers.length; index++) {
        const layer = layers[index];
        const l = layer as unknown as Record<string, unknown>;
        const layerKey = sourceKeyOf(layer, [...treePath, index]);
        const layerName = layer.name || `Layer ${sortCounter + 1}`;
        const warn = (code: string, message: string, severity: 'warning' | 'error' = 'warning') => { diagnostics.push({ code, severity, message, layerKey, layerName }); };
        sortCounter++;

        const hasChildren = Array.isArray(layer.children);
        const layerType = classifyPsdLayer(layer);

        const left = (l.left as number) || 0;
        const top = (l.top as number) || 0;
        const right = (l.right as number) || 0;
        const bottom = (l.bottom as number) || 0;
        const width = right - left;
        const height = bottom - top;
        const enabledEffects = serializePsdEffects(layer.effects);
        const restoreVectorContent = canRestorePsdVectorContent(layer);
        const intrinsicVectorBaked = layerType === 'shape' && Boolean(layer.canvas) && !restoreVectorContent && Boolean(layer.vectorMask || layer.mask?.fromVectorData);
        if (intrinsicVectorBaked) warn('vector-content-raster-fallback', '保留矢量图层的原始栅格几何；复杂填充、矢量描边或其羽化请用原稿保真预览核对');
        if (layer.vectorFill?.type === 'solid' && (layer.vectorFill.dither || layer.vectorFill.interpolationMethod === 'perceptual')) warn('vector-gradient-approximate', '渐变色标和透明度已保留；抖动及感知插值请用原稿保真预览核对');

        // Content and alpha masks are independent resources. Group masks are
        // applied once after group composition, never baked into descendants.
        let maskRaster: PsdMaskRaster | null = null;
        let maskMetadata: Record<string, unknown> | undefined;
        let userMaskMetadata: Record<string, unknown> | undefined;
        const maskIncludesVectorGeometry = !intrinsicVectorBaked && Boolean((layer.vectorMask && !layer.vectorMask.disable) || layer.mask?.fromVectorData);
        try {
          maskRaster = await renderMask(layer, psd, { skipVectorMask: intrinsicVectorBaked });
          if (maskRaster) {
            const filename = `mask_${sortCounter}.png`;
            fs.writeFileSync(path.join(parsedDir, filename), maskRaster.canvas.toBuffer('image/png'));
            maskMetadata = { imagePath: `${artifactDirectory}/${filename}`, x: maskRaster.x, y: maskRaster.y, width: maskRaster.width, height: maskRaster.height, defaultColor: maskRaster.defaultColor };
            exportedMaskCount++;
            if (layer.mask?.fromVectorData && (layer.mask.vectorMaskFeather || 0) > 0) vectorMaskFeatherRestoredCount++;
            if (layerType === 'shape' && maskIncludesVectorGeometry) {
              const userMask = await renderMask(layer, psd, { skipVectorMask: true });
              if (userMask) {
                const userFilename = `user_mask_${sortCounter}.png`;
                fs.writeFileSync(path.join(parsedDir, userFilename), userMask.canvas.toBuffer('image/png'));
                userMaskMetadata = { imagePath: `${artifactDirectory}/${userFilename}`, x: userMask.x, y: userMask.y, width: userMask.width, height: userMask.height, defaultColor: userMask.defaultColor };
                exportedMaskCount++;
              }
            }
          }
        } catch (err) { warn('mask-export-failed', `蒙版导出失败: ${(err as Error).message}`, 'error'); }
        let imagePath: string | null = null;
        let rasterGeometry: NormalizedPsdRaster | null = null;
        if (layer.canvas && layerType !== 'group') {
          try {
            let content = layer.canvas as unknown as PsdCanvas;
            let contentLeft = left;
            let contentTop = top;
            // Cached shape pixels already contain intrinsic vector alpha.
            // Rebuild supported fill planes before applying that alpha once.
            if (restoreVectorContent && maskRaster) {
              const bounds = maskRaster.defaultColor > 0 ? { x: 0, y: 0, width: psd.width, height: psd.height } : maskRaster;
              content = renderPsdVectorContent(layer, bounds, psd) as PsdCanvas;
              contentLeft = bounds.x;
              contentTop = bounds.y;
            }
            rasterGeometry = layerType === 'image' || layerType === 'shape'
              ? normalizePsdRasterCanvas(content, contentLeft, contentTop)
              : { canvas: content, left: contentLeft, top: contentTop, width: Number(content.width || width), height: Number(content.height || height), documentClipped: false, alphaTrimmed: false };
            if (rasterGeometry) {
              const filename = `layer_${sortCounter}.png`;
              fs.writeFileSync(path.join(parsedDir, filename), rasterGeometry.canvas.toBuffer('image/png'));
              imagePath = `${artifactDirectory}/${filename}`;
              exportedImageCount++;
              if (rasterGeometry.documentClipped) documentClippedRasterCount++;
              if (rasterGeometry.alphaTrimmed) alphaTrimmedRasterCount++;
            }
          } catch (err) { warn('layer-image-export-failed', `图层图像导出失败: ${(err as Error).message}`, 'error'); }
        }
        if (layerType === 'adjustment') warn('adjustment-layer', `调整参数已保留，由合成器应用: ${layer.adjustment?.type}`);
        if (layerType !== 'group' && layerType !== 'adjustment' && !imagePath && width > 0 && height > 0 && layer.hidden !== true) warn('layer-raster-missing', '图层没有可用的栅格预览');
        if (layer.clipping && !clippingKeys[index]) warn('clipping-base-missing', '剪贴图层没有同级基础图层');

        // 提取文字信息（含 transform 缩放）
        const textObj = l.text as Record<string, unknown> | undefined;
        const textContent = textObj?.text as string || null;
        const rawStyle = textObj?.style as Record<string, unknown> || null;
        const transform = textObj?.transform as number[] | undefined;
        const textOrientation = typeof textObj?.orientation === 'string' ? textObj.orientation : undefined;
        const textScaleX = transform ? Math.hypot(transform[0] || 0, transform[1] || 0) : 1;
        const textScaleY = transform ? Math.hypot(transform[2] || 0, transform[3] || 0) : textScaleX;
        const textScale = textScaleX;

        // 兼容 ag-psd 的多 run 文字：保留每段 run 的字符偏移与样式，下游按字符区间逐段还原。
        // 同一图层中常见多种字号 / 是否加粗 / 是否带删除线 的混排（例如「99元/8个装包邮（单果225g以上）105」）。
        const styleRuns = (textObj?.styleRuns || textObj?.runs || textObj?.runArray) as
          | Array<{ length?: number; style?: Record<string, unknown> }>
          | undefined;
        const normalizedRuns: Array<{
          from: number;
          length: number;
          fontSize?: number;
          fillColor?: { r: number; g: number; b: number };
          strokeColor?: { r: number; g: number; b: number };
          strokeFlag?: boolean;
          fillFirst?: boolean;
          outlineWidth?: number;
          underline?: boolean;
          strikethrough?: boolean;
          fontName?: string;
          fauxBold?: boolean;
          fauxItalic?: boolean;
          tracking?: number;
          leading?: number;
        }> = [];
        if (Array.isArray(styleRuns)) {
          let cursor = 0;
          for (const run of styleRuns) {
            const len = typeof run?.length === 'number' ? run.length : 0;
            if (len <= 0) continue;
            const s = (run.style || {}) as Record<string, unknown>;
            const font = s.font as Record<string, unknown> | undefined;
            normalizedRuns.push({
              from: cursor,
              length: len,
              fontSize: typeof s.fontSize === 'number' ? s.fontSize : undefined,
              fillColor:
                s.fillColor && typeof s.fillColor === 'object'
                  ? (s.fillColor as { r: number; g: number; b: number })
                  : undefined,
              strokeColor:
                s.strokeColor && typeof s.strokeColor === 'object'
                  ? (s.strokeColor as { r: number; g: number; b: number })
                  : undefined,
              strokeFlag: s.strokeFlag === true,
              fillFirst: s.fillFirst === true,
              outlineWidth: typeof s.outlineWidth === 'number' ? s.outlineWidth : undefined,
              underline: s.underline === true,
              strikethrough:
                s.strikethrough === true ||
                (s as Record<string, unknown>).linethrough === true ||
                (s as Record<string, unknown>).lineThrough === true,
              fontName: typeof font?.name === 'string' ? (font.name as string) : undefined,
              fauxBold: s.fauxBold === true,
              fauxItalic: s.fauxItalic === true,
              tracking: typeof s.tracking === 'number' ? s.tracking : undefined,
              leading: typeof s.leading === 'number' ? s.leading : undefined,
            });
            // 收集这一段 run 用到的字体名
            if (typeof font?.name === 'string' && font.name.trim()) {
              usedFontsSet.add(font.name.trim());
            }
            cursor += len;
          }
        }
        // 默认 style 上的字体也算（万一某段 run 没显式覆盖，仍会用到这个）
        const defaultFont = rawStyle?.font as Record<string, unknown> | undefined;
        if (typeof defaultFont?.name === 'string' && defaultFont.name.trim()) {
          usedFontsSet.add((defaultFont.name as string).trim());
        }
        // 合并 transform 缩放、段落样式、图层特效到 textStyle
        const textStyle = textObj ? {
          ...(rawStyle || {}),
          textScale,
          textScaleX,
          textScaleY,
          ...(textOrientation ? { textOrientation } : {}),
          // 仅当默认样式自身带装饰时才标记到顶层；分段装饰由 runs 表达。
          underline: rawStyle?.underline === true,
          strikethrough:
            rawStyle?.strikethrough === true ||
            (rawStyle as Record<string, unknown>)?.linethrough === true ||
            (rawStyle as Record<string, unknown>)?.lineThrough === true,
          // 字符级 run 数组：[{ from, length, fontSize?, underline?, strikethrough?, ... }]
          runs: normalizedRuns,
          ...(transform ? {
            textTransform: transform,
            textBaselineX: transform[4],
            textBaselineY: transform[5],
          } : {}),
          textBounds: {
            left,
            top,
            right,
            bottom,
            width,
            height,
          },
          ...(textObj?.paragraphStyle ? { paragraphStyle: textObj.paragraphStyle } : {}),
          ...(textObj?.paragraphStyleRuns ? { paragraphStyleRuns: textObj.paragraphStyleRuns } : {}),
          ...(textObj?.shapeType ? { shapeType: textObj.shapeType } : {}),
          ...(textObj?.boxBounds ? { boxBounds: textObj.boxBounds } : {}),
          ...(textObj?.warp ? { warp: textObj.warp } : {}),
          ...(Object.keys(enabledEffects).length > 0 ? { effects: firstPsdEffects(enabledEffects) } : {}),
        } : null;

        const properties: Record<string, unknown> = {
          psdSourceKey: layerKey, psdRasterRole: 'content',
          sourceBounds: { left, top, right, bottom, width, height },
        };
        if (layer.clipping) {
          properties.clipping = true;
          if (clippingKeys[index]) properties.psdClipBaseKey = clippingKeys[index];
        }
        if (maskMetadata) properties.psdMask = maskMetadata;
        if (maskMetadata && maskIncludesVectorGeometry) properties.psdMaskIncludesVectorGeometry = true;
        if (userMaskMetadata) properties.psdUserMask = userMaskMetadata;
        if (layer.mask?.vectorMaskFeather !== undefined) properties.vectorMaskFeather = layer.mask.vectorMaskFeather;
        if (layer.mask?.vectorMaskDensity !== undefined) properties.vectorMaskDensity = layer.mask.vectorMaskDensity;
        if (layer.adjustment) properties.psdAdjustment = layer.adjustment;
        if (layer.vectorMask) properties.psdVectorMask = layer.vectorMask;
        if (layer.vectorOrigination) properties.psdVectorOrigination = layer.vectorOrigination;
        if (intrinsicVectorBaked) properties.psdIntrinsicVectorMaskBaked = true;
        if (layer.placedLayer) properties.psdPlacedLayer = layer.placedLayer;
        if (layer.artboard) properties.psdArtboard = layer.artboard;
        if (layer.transparencyProtected) properties.transparencyProtected = true;
        if (typeof layer.fillOpacity === 'number') properties.fillOpacity = normalizeOpacity(layer.fillOpacity);
        if (typeof layer.transparencyShapesLayer === 'boolean') properties.transparencyShapesLayer = layer.transparencyShapesLayer;
        if (layer.vectorFill) properties.vectorFill = layer.vectorFill;
        if (layer.vectorStroke) properties.vectorStroke = layer.vectorStroke;
        if (Object.keys(enabledEffects).length) properties.effects = enabledEffects;
        if (layer.effects?.disabled) properties.psdEffectsDisabled = true;
        if (typeof psd.imageResources?.globalAngle === 'number') properties.psdGlobalAngle = psd.imageResources.globalAngle;
        if (typeof layer.blendClippendElements === 'boolean') properties.blendClippedElements = layer.blendClippendElements;
        if (typeof layer.blendInteriorElements === 'boolean') properties.blendInteriorElements = layer.blendInteriorElements;
        if (layer.knockout) properties.psdKnockout = true;
        if (rasterGeometry) {
          properties.rasterBoundsNormalized = true;
          properties.documentClipped = rasterGeometry.documentClipped;
          properties.alphaTrimmed = rasterGeometry.alphaTrimmed;
        }

        const exportedLeft = imagePath && rasterGeometry ? rasterGeometry.left : left;
        const exportedTop = imagePath && rasterGeometry ? rasterGeometry.top : top;
        const exportedWidth = imagePath && rasterGeometry ? rasterGeometry.width : width;
        const exportedHeight = imagePath && rasterGeometry ? rasterGeometry.height : height;

        const dbLayer = await ParsedLayer.create({
          fileId,
          layerName,
          layerType: layerType as 'group' | 'image' | 'text' | 'shape' | 'adjustment',
          parentLayerId: parentId,
          sortOrder: sortCounter,
          visible: l.hidden !== true,
          opacity: normalizeOpacity(layer.opacity),
          blendMode: (l.blendMode as string) || 'normal',
          x: exportedLeft,
          y: exportedTop,
          width: exportedWidth > 0 ? exportedWidth : null,
          height: exportedHeight > 0 ? exportedHeight : null,
          imagePath,
          textContent,
          textStyle,
          properties: Object.keys(properties).length > 0 ? properties : null,
        }, { transaction: getParserLayerTransaction() });

        renderMask.release(layer);
        releasePsdLayerPixels(layer);
        maskRaster = null;
        rasterGeometry = null;
        if (hasChildren) await processLayers(layer.children || [], dbLayer.id, [...treePath, index]);
      }
    }

    await processLayers(psd.children || [], null);

    await updateParserFile(file, {
      parseStatus: 'completed',
      width: psd.width,
      height: psd.height,
      ...(thumbnailPath ? { thumbnailPath } : {}),
      parseResult: {
        width: psd.width,
        height: psd.height,
        layerCount: sortCounter,
        psdParserVersion: PSD_PARSER_VERSION,
        colorMode: psd.colorMode,
        bitsPerChannel: psd.bitsPerChannel,
        hasImages: exportedImageCount > 0, exportedImageCount, exportedMaskCount,
        rasterContentMode: 'raw', artifactDirectory, compositePath,
        psdVersion: header.version, estimatedDecodedBytes, diagnostics,
        hasErrors: diagnostics.some(item => item.severity === 'error'),
        rasterBoundsNormalized: true,
        documentClippedRasterCount,
        alphaTrimmedRasterCount,
        vectorMaskFeatherRestoredCount,
        // 文档用到的所有字体名，供前端做「缺失字体」比对
        usedFonts: Array.from(usedFontsSet).sort(),
      },
    });
    if (thumbnailPath && !isIsolatedParser()) warmUploadThumbnailVariants(thumbnailPath);

    logger.info(
      { scope: 'psd', name: file.name, layers: sortCounter, exportedImageCount, diagnostics: diagnostics.length },
      'PSD: parse completed'
    );
  } catch (err) {
    logger.error({ scope: 'psd', err }, 'PSD: parse failed');
    await updateParserFile(file, {
      parseStatus: 'failed',
      parseResult: { error: (err as Error).message, psdParserVersion: PSD_PARSER_VERSION, artifactDirectory, diagnostics },
    });
    if (!stagedDirectory) {
      const absoluteDirectory = path.resolve(parsedDir);
      const expectedParent = path.resolve(STORAGE.base, 'parsed', String(fileId));
      if (path.dirname(absoluteDirectory) === expectedParent) {
        fs.rmSync(absoluteDirectory, { recursive: true, force: true });
      }
    }
    if (isIsolatedParser()) throw err;
  }
}
