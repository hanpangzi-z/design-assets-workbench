import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import {
  appendClientParseAssistToFormData,
  generateClientParseAssist,
  type ClientParseAssist,
} from './clientParseAssist';

export interface ClientUploadPreview {
  dataUrl: string;
  width: number;
  height: number;
  mimeType: string;
  source: 'browser-image' | 'browser-pdf-first-page' | 'browser-pdfjs-worker';
  parseAssist?: ClientParseAssist;
}

const SUPPORTED_IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);
const SUPPORTED_PDF_PREVIEW_TYPES = new Set(['pdf', 'ai']);
const MAX_PREVIEW_SIDE = 960;
const RETRY_PREVIEW_SIDE = 640;
const MAX_DATA_URL_LENGTH = 2_800_000;
const IMAGE_PREVIEW_TIMEOUT_MS = 8000;
const DOCUMENT_PREVIEW_TIMEOUT_MS = 12000;

export async function appendClientUploadPreview(formData: FormData, file: File) {
  const preview = await generateClientUploadPreview(file);
  if (!preview) return null;

  if (preview.parseAssist) {
    appendClientParseAssistToFormData(formData, preview.parseAssist);
  } else {
    formData.set('clientThumbnailDataUrl', preview.dataUrl);
    formData.set('clientPreviewWidth', String(preview.width));
    formData.set('clientPreviewHeight', String(preview.height));
    formData.set('clientPreviewSource', preview.source);
  }
  return preview;
}

export async function generateClientUploadPreview(file: File): Promise<ClientUploadPreview | null> {
  if (canGenerateImagePreview(file)) {
    try {
      return await withTimeout(renderImagePreview(file, MAX_PREVIEW_SIDE), IMAGE_PREVIEW_TIMEOUT_MS);
    } catch {
      return null;
    }
  }

  if (canGeneratePdfPreview(file)) {
    try {
      const assist = await withTimeout(generateClientParseAssist(file), DOCUMENT_PREVIEW_TIMEOUT_MS);
      if (assist?.previewDataUrl) {
        return {
          dataUrl: assist.previewDataUrl,
          width: assist.width,
          height: assist.height,
          mimeType: assist.previewMimeType || 'image/png',
          source: assist.source,
          parseAssist: assist,
        };
      }
      return await withTimeout(renderPdfFirstPagePreview(file, MAX_PREVIEW_SIDE), DOCUMENT_PREVIEW_TIMEOUT_MS);
    } catch {
      return null;
    }
  }

  return null;
}

function canGenerateImagePreview(file: File) {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  return file.type.startsWith('image/') || SUPPORTED_IMAGE_TYPES.has(ext);
}

function canGeneratePdfPreview(file: File) {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  return file.type === 'application/pdf' || SUPPORTED_PDF_PREVIEW_TYPES.has(ext);
}

async function renderImagePreview(file: File, maxSide: number): Promise<ClientUploadPreview | null> {
  const { image, url } = await loadImage(file);
  try {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) return null;

    const scaled = fitInside(width, height, maxSide);
    const canvas = document.createElement('canvas');
    canvas.width = scaled.width;
    canvas.height = scaled.height;
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) return null;

    context.clearRect(0, 0, scaled.width, scaled.height);
    context.drawImage(image, 0, 0, scaled.width, scaled.height);

    const blob = await canvasToBlob(canvas, 'image/webp', 0.82)
      || await canvasToBlob(canvas, 'image/png');
    if (!blob) return null;

    const dataUrl = await blobToDataUrl(blob);
    if (dataUrl.length > MAX_DATA_URL_LENGTH && maxSide > RETRY_PREVIEW_SIDE) {
      return renderImagePreview(file, RETRY_PREVIEW_SIDE);
    }
    if (dataUrl.length > MAX_DATA_URL_LENGTH) return null;

    return {
      dataUrl,
      width,
      height,
      mimeType: blob.type || 'image/png',
      source: 'browser-image',
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function renderPdfFirstPagePreview(file: File, maxSide: number): Promise<ClientUploadPreview | null> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: true,
    stopAtErrors: false,
  });

  try {
    const pdfDocument = await loadingTask.promise;
    if (pdfDocument.numPages < 1) return null;

    const page = await pdfDocument.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));
    const scaled = fitInside(width, height, maxSide);
    const scale = scaled.width / width;
    const renderViewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(renderViewport.width));
    canvas.height = Math.max(1, Math.ceil(renderViewport.height));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return null;

    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport: renderViewport }).promise;
    page.cleanup();

    const blob = await canvasToBlob(canvas, 'image/webp', 0.82)
      || await canvasToBlob(canvas, 'image/png');
    if (!blob) return null;

    const dataUrl = await blobToDataUrl(blob);
    if (dataUrl.length > MAX_DATA_URL_LENGTH && maxSide > RETRY_PREVIEW_SIDE) {
      return renderPdfFirstPagePreview(file, RETRY_PREVIEW_SIDE);
    }
    if (dataUrl.length > MAX_DATA_URL_LENGTH) return null;

    return {
      dataUrl,
      width,
      height,
      mimeType: blob.type || 'image/png',
      source: 'browser-pdf-first-page',
    };
  } finally {
    loadingTask.destroy?.();
  }
}

function loadImage(file: File): Promise<{ image: HTMLImageElement; url: string }> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve({ image, url });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image preview failed'));
    };
    image.src = url;
  });
}

function fitInside(width: number, height: number, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Preview read failed'));
    reader.readAsDataURL(blob);
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error('Preview timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  });
}
