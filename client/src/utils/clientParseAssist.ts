export interface ClientParseAssistTextLayer {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontName?: string;
}

export interface ClientParseAssist {
  version: 1;
  source: 'browser-pdfjs-worker';
  fileName: string;
  fileType: string;
  width: number;
  height: number;
  pageCount: number;
  renderScale: number;
  previewDataUrl?: string;
  previewWidth?: number;
  previewHeight?: number;
  previewMimeType?: string;
  textItemCount: number;
  imageOpCount: number;
  pathOpCount: number;
  hasFullPageImage: boolean;
  elapsedMs: number;
  textLayers: ClientParseAssistTextLayer[];
}

type WorkerResponse = {
  id: string;
  ok: boolean;
  assist?: ClientParseAssist;
  error?: string;
};

const SUPPORTED_ASSIST_TYPES = new Set(['pdf', 'ai']);
const MAX_ASSIST_FILE_SIZE = 40 * 1024 * 1024;
const MAX_ASSIST_PREVIEW_SIDE = 960;
const MAX_ASSIST_JSON_LENGTH = 1_500_000;
const ASSIST_TIMEOUT_MS = 12_000;

export function canGenerateClientParseAssist(fileOrName: File | string, fileType?: string) {
  const name = typeof fileOrName === 'string' ? fileOrName : fileOrName.name;
  const ext = (fileType || name.split('.').pop() || '').toLowerCase();
  return SUPPORTED_ASSIST_TYPES.has(ext);
}

export async function generateClientParseAssist(file: File): Promise<ClientParseAssist | null> {
  if (!canGenerateClientParseAssist(file)) return null;
  if (file.size <= 0 || file.size > MAX_ASSIST_FILE_SIZE) return null;
  if (typeof Worker === 'undefined') return null;

  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const fileType = (file.name.split('.').pop() || '').toLowerCase();
  const worker = new Worker(new URL('./clientParseAssist.worker.ts', import.meta.url), { type: 'module' });

  try {
    const buffer = await file.arrayBuffer();
    const response = await withTimeout(new Promise<WorkerResponse>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        if (event.data?.id === id) resolve(event.data);
      };
      worker.onerror = (event) => reject(new Error(event.message || 'client parse assist worker failed'));
      worker.postMessage({
        id,
        fileName: file.name,
        fileType,
        buffer,
        maxPreviewSide: MAX_ASSIST_PREVIEW_SIDE,
      }, [buffer]);
    }), ASSIST_TIMEOUT_MS);

    if (!response.ok || !response.assist) return null;
    const assist = response.assist;
    if (!isValidClientParseAssist(assist)) return null;
    if (JSON.stringify(stripClientParseAssistPreview(assist)).length > MAX_ASSIST_JSON_LENGTH) return null;
    return assist;
  } catch {
    return null;
  } finally {
    worker.terminate();
  }
}

export function stripClientParseAssistPreview(assist: ClientParseAssist): ClientParseAssist {
  const { previewDataUrl, ...rest } = assist;
  void previewDataUrl;
  return rest;
}

export function appendClientParseAssistToFormData(formData: FormData, assist: ClientParseAssist | null | undefined) {
  if (!assist) return;
  formData.set('clientParseAssist', JSON.stringify(stripClientParseAssistPreview(assist)));
  if (assist.previewDataUrl) {
    formData.set('clientThumbnailDataUrl', assist.previewDataUrl);
    formData.set('clientPreviewWidth', String(assist.width));
    formData.set('clientPreviewHeight', String(assist.height));
    formData.set('clientPreviewSource', assist.source);
  }
}

export async function buildClientParseAssistFromFileDownload(
  fileId: number,
  filename: string,
  mimeType = 'application/pdf',
  downloadBlob: (id: number) => Promise<Blob>,
) {
  const blob = await downloadBlob(fileId);
  const file = new File([blob], filename, { type: blob.type || mimeType });
  return generateClientParseAssist(file);
}

function isValidClientParseAssist(value: ClientParseAssist) {
  return value.version === 1
    && value.source === 'browser-pdfjs-worker'
    && SUPPORTED_ASSIST_TYPES.has(String(value.fileType || '').toLowerCase())
    && isPositiveNumber(value.width)
    && isPositiveNumber(value.height)
    && value.width <= 12000
    && value.height <= 12000
    && Number.isInteger(value.pageCount)
    && value.pageCount > 0
    && value.pageCount <= 200
    && Array.isArray(value.textLayers)
    && value.textLayers.length <= 800;
}

function isPositiveNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error('Client parse assist timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  });
}
