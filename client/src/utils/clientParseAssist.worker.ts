import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

type AssistRequest = {
  id: string;
  fileName: string;
  fileType: string;
  buffer: ArrayBuffer;
  maxPreviewSide: number;
};

type AssistTextLayer = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontName?: string;
};

type AssistResponse = {
  id: string;
  ok: boolean;
  assist?: {
    version: 1;
    source: 'browser-pdfjs-worker';
    fileName: string;
    fileType: string;
    width: number;
    height: number;
    pageCount: number;
    renderScale: number;
    previewDataUrl: string;
    previewWidth: number;
    previewHeight: number;
    previewMimeType: string;
    textItemCount: number;
    imageOpCount: number;
    pathOpCount: number;
    hasFullPageImage: boolean;
    elapsedMs: number;
    textLayers: AssistTextLayer[];
  };
  error?: string;
};

const MAX_TEXT_LAYERS = 800;
const MAX_PREVIEW_DATA_URL_LENGTH = 2_800_000;

self.onmessage = (event: MessageEvent<AssistRequest>) => {
  void handleAssistRequest(event.data);
};

async function handleAssistRequest(request: AssistRequest) {
  const startedAt = performance.now();
  try {
    const data = new Uint8Array(request.buffer);
    const loadingTask = (pdfjs as any).getDocument({
      data,
      disableFontFace: true,
      useSystemFonts: true,
      stopAtErrors: false,
      disableWorker: true,
    } as any);
    const doc = await loadingTask.promise;
    try {
      if (doc.numPages < 1) throw new Error('empty document');
      const page = await doc.getPage(1);
      const baseViewport = page.getViewport({ scale: 1 });
      const renderScale = Math.min(2, 1600 / Math.max(1, baseViewport.width));
      const viewport = page.getViewport({ scale: renderScale });
      const width = Math.max(1, Math.floor(viewport.width));
      const height = Math.max(1, Math.floor(viewport.height));

      const opList = await page.getOperatorList();
      const ops = pdfjs.OPS as Record<string, number>;
      const imageOpCount = countOps(opList.fnArray, [
        ops.paintImageXObject,
        ops.paintInlineImageXObject,
        ops.paintImageMaskXObject,
        ops.paintJpegXObject,
      ]);
      const pathOpCount = countOps(opList.fnArray, [
        ops.constructPath,
        ops.stroke,
        ops.fill,
        ops.eoFill,
        ops.fillStroke,
        ops.eoFillStroke,
      ]);

      const textContent = await (page as any).getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
      const textLayers = normalizeTextLayers(pdfjs, viewport, textContent).slice(0, MAX_TEXT_LAYERS);

      const preview = await renderPreviewDataUrl(page, width, height, request.maxPreviewSide, viewport);
      if (!preview || preview.dataUrl.length > MAX_PREVIEW_DATA_URL_LENGTH) {
        throw new Error('preview too large');
      }

      page.cleanup();
      postResponse({
        id: request.id,
        ok: true,
        assist: {
          version: 1,
          source: 'browser-pdfjs-worker',
          fileName: request.fileName,
          fileType: request.fileType,
          width,
          height,
          pageCount: doc.numPages,
          renderScale,
          previewDataUrl: preview.dataUrl,
          previewWidth: preview.width,
          previewHeight: preview.height,
          previewMimeType: preview.mimeType,
          textItemCount: textLayers.length,
          imageOpCount,
          pathOpCount,
          hasFullPageImage: imageOpCount === 1 && pathOpCount <= 2 && textLayers.length <= 2,
          elapsedMs: Math.round(performance.now() - startedAt),
          textLayers,
        },
      });
    } finally {
      await doc.destroy?.();
      loadingTask.destroy?.();
    }
  } catch (error) {
    postResponse({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : 'client parse assist failed',
    });
  }
}

function normalizeTextLayers(pdfjs: any, viewport: any, textContent: any): AssistTextLayer[] {
  return (textContent.items || [])
    .map((item: any): AssistTextLayer | null => {
      const text = String(item.str || '').trim();
      if (!text) return null;

      const tx = pdfjs.Util.transform(viewport.transform, item.transform);
      const fontSize = Math.max(6, Math.hypot(tx[2], tx[3]));
      return {
        text,
        x: Math.round(tx[4]),
        y: Math.round(tx[5] - fontSize),
        width: Math.max(8, Math.round(Math.abs(Number(item.width || text.length * fontSize * 0.55) * viewport.scale))),
        height: Math.max(8, Math.round(fontSize * 1.15)),
        fontSize: Math.round(fontSize),
        fontName: typeof item.fontName === 'string' ? item.fontName.slice(0, 120) : undefined,
      };
    })
    .filter(Boolean) as AssistTextLayer[];
}

async function renderPreviewDataUrl(page: any, worldWidth: number, worldHeight: number, maxSide: number, sourceViewport: any) {
  const scale = Math.min(1, maxSide / Math.max(worldWidth, worldHeight));
  const previewWidth = Math.max(1, Math.round(worldWidth * scale));
  const previewHeight = Math.max(1, Math.round(worldHeight * scale));
  const previewViewport = page.getViewport({ scale: sourceViewport.scale * scale });
  const canvas = new OffscreenCanvas(previewWidth, previewHeight);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return null;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, previewWidth, previewHeight);
  await page.render({ canvasContext: context as any, viewport: previewViewport }).promise;

  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 })
    .catch(() => canvas.convertToBlob({ type: 'image/png' }));
  const dataUrl = await blobToDataUrl(blob);
  return {
    dataUrl,
    width: previewWidth,
    height: previewHeight,
    mimeType: blob.type || 'image/png',
  };
}

function countOps(fnArray: number[], targets: Array<number | undefined>) {
  const targetSet = new Set(targets.filter((value): value is number => typeof value === 'number'));
  return fnArray.reduce((count, fn) => count + (targetSet.has(fn) ? 1 : 0), 0);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

function postResponse(response: AssistResponse) {
  self.postMessage(response);
}
