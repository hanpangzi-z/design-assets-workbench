import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { STORAGE } from '../../config/storage';
import { logger } from '../../utils/logger';

export interface ClientParseAssistTextLayer {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontName?: string;
}

export interface ClientParseAssistSnapshot {
  version: 1;
  source: 'browser-pdfjs-worker';
  fileName?: string;
  fileType: 'pdf' | 'ai';
  width: number;
  height: number;
  pageCount: number;
  renderScale?: number;
  previewDataUrl?: string;
  previewPath?: string;
  previewWidth?: number;
  previewHeight?: number;
  previewMimeType?: string;
  textItemCount: number;
  imageOpCount: number;
  pathOpCount: number;
  hasFullPageImage: boolean;
  elapsedMs?: number;
  textLayers: ClientParseAssistTextLayer[];
}

const ENABLE_CLIENT_PARSE_ASSIST = String(process.env.ENABLE_CLIENT_PARSE_ASSIST ?? 'true').toLowerCase() !== 'false';
const MAX_ASSIST_JSON_LENGTH = 1_500_000;
const MAX_PREVIEW_BYTES = 3 * 1024 * 1024;
const MAX_PREVIEW_SIDE = 6000;
const MAX_PREVIEW_PIXELS = 40_000_000;
const MAX_PAGE_COUNT = 200;
const MAX_TEXT_LAYERS = 800;
const CLIENT_PREVIEW_DATA_URL = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/;
const CLIENT_PARSE_ASSIST_WAIT_MS = readPositiveIntEnv('CLIENT_PARSE_ASSIST_WAIT_MS', 1500);
const CLIENT_PARSE_ASSIST_POLL_MS = 100;

type ClientParseAssistBody = {
  clientParseAssist?: unknown;
  clientThumbnailDataUrl?: unknown;
};

export function normalizeClientParseAssistFromBody(
  body: ClientParseAssistBody | undefined,
  fallback?: { fileType?: string | null; fileName?: string | null },
): ClientParseAssistSnapshot | null {
  if (!ENABLE_CLIENT_PARSE_ASSIST || !body) return null;
  const raw = parseRawAssist(body.clientParseAssist);
  if (!raw) return null;
  const snapshot = normalizeRawAssist(raw, fallback);
  if (!snapshot) return null;
  if (!snapshot.previewDataUrl && typeof body.clientThumbnailDataUrl === 'string') {
    snapshot.previewDataUrl = body.clientThumbnailDataUrl;
  }
  return snapshot;
}

export async function saveClientParseAssistTempFromBody(
  body: ClientParseAssistBody | undefined,
  targetPath: string,
  fallback?: { fileType?: string | null; fileName?: string | null },
): Promise<ClientParseAssistSnapshot | null> {
  const snapshot = normalizeClientParseAssistFromBody(body, fallback);
  if (!snapshot) return null;
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.promises.writeFile(targetPath, JSON.stringify({ ...snapshot, previewDataUrl: undefined }), 'utf8');
  return snapshot;
}

export async function readClientParseAssistTemp(tempPath: string, previewPath?: string | null): Promise<ClientParseAssistSnapshot | null> {
  if (!ENABLE_CLIENT_PARSE_ASSIST || !fs.existsSync(tempPath)) return null;
  try {
    const snapshot = normalizeRawAssist(JSON.parse(await fs.promises.readFile(tempPath, 'utf8')));
    if (!snapshot) return null;
    if (previewPath && fs.existsSync(previewPath)) {
      snapshot.previewPath = previewPath;
    }
    return snapshot;
  } catch (err) {
    logger.warn({ scope: 'client-parse-assist', err }, 'client parse assist temp ignored');
    return null;
  }
}

export async function materializeClientParseAssistPreview(
  fileId: number,
  snapshot: ClientParseAssistSnapshot | null | undefined,
  fallbackPreviewPath?: string | null,
): Promise<ClientParseAssistSnapshot | null> {
  if (!ENABLE_CLIENT_PARSE_ASSIST || !snapshot) return null;
  const parsedDir = path.join(STORAGE.parsed, String(fileId));
  const targetPath = path.join(parsedDir, 'client_assist_preview.png');

  try {
    await fs.promises.mkdir(parsedDir, { recursive: true });
    const previewBuffer = decodeClientPreviewDataUrl(snapshot.previewDataUrl);
    if (previewBuffer) {
      await normalizePreviewBuffer(previewBuffer, targetPath);
    } else if (fallbackPreviewPath && fs.existsSync(fallbackPreviewPath)) {
      await normalizePreviewPath(fallbackPreviewPath, targetPath);
    }

    const next: ClientParseAssistSnapshot = {
      ...snapshot,
      previewDataUrl: undefined,
      previewPath: fs.existsSync(targetPath) ? targetPath : snapshot.previewPath,
    };
    logger.info(
      {
        scope: 'client-parse-assist',
        fileId,
        fileType: next.fileType,
        hasPreview: Boolean(next.previewPath),
        textLayers: next.textLayers.length,
        imageOpCount: next.imageOpCount,
        pathOpCount: next.pathOpCount,
      },
      'client parse assist accepted'
    );
    return next;
  } catch (err) {
    logger.warn({ scope: 'client-parse-assist', fileId, err }, 'client parse assist preview ignored');
    return { ...snapshot, previewDataUrl: undefined, previewPath: undefined };
  }
}

export async function writeClientAssistPreviewToPath(
  snapshot: ClientParseAssistSnapshot | null | undefined,
  outPngPath: string,
): Promise<boolean> {
  if (!ENABLE_CLIENT_PARSE_ASSIST || !snapshot) return false;

  try {
    if (snapshot.previewPath && fs.existsSync(snapshot.previewPath)) {
      await normalizePreviewPath(snapshot.previewPath, outPngPath);
      return true;
    }
    const previewBuffer = decodeClientPreviewDataUrl(snapshot.previewDataUrl);
    if (!previewBuffer) return false;
    await normalizePreviewBuffer(previewBuffer, outPngPath);
    return true;
  } catch (err) {
    logger.warn({ scope: 'client-parse-assist', err }, 'client parse assist preview render skipped');
    return false;
  }
}

export async function resolveClientParseAssistSnapshot(
  initial?: ClientParseAssistSnapshot | null,
  getter?: (() => ClientParseAssistSnapshot | null | undefined) | null,
  allowWait = false,
): Promise<ClientParseAssistSnapshot | null> {
  if (initial) return initial;
  const current = getter?.();
  if (current || !allowWait || CLIENT_PARSE_ASSIST_WAIT_MS <= 0) return current || null;

  const deadline = Date.now() + CLIENT_PARSE_ASSIST_WAIT_MS;
  while (Date.now() < deadline) {
    await wait(Math.min(CLIENT_PARSE_ASSIST_POLL_MS, Math.max(0, deadline - Date.now())));
    const next = getter?.();
    if (next) return next;
  }
  return getter?.() || null;
}

function parseRawAssist(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'string') {
    if (value.length > MAX_ASSIST_JSON_LENGTH) return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function normalizeRawAssist(raw: Record<string, unknown>, fallback?: { fileType?: string | null; fileName?: string | null }): ClientParseAssistSnapshot | null {
  const fileType = String(raw.fileType || fallback?.fileType || '').toLowerCase();
  if (raw.version !== 1 || raw.source !== 'browser-pdfjs-worker') return null;
  if (fileType !== 'pdf' && fileType !== 'ai') return null;

  const width = toBoundedInt(raw.width, 1, 12000);
  const height = toBoundedInt(raw.height, 1, 12000);
  const pageCount = toBoundedInt(raw.pageCount, 1, MAX_PAGE_COUNT);
  if (!width || !height || !pageCount) return null;

  const textLayers = Array.isArray(raw.textLayers)
    ? raw.textLayers.map(normalizeTextLayer).filter(Boolean).slice(0, MAX_TEXT_LAYERS) as ClientParseAssistTextLayer[]
    : [];

  return {
    version: 1,
    source: 'browser-pdfjs-worker',
    fileName: typeof raw.fileName === 'string' ? raw.fileName.slice(0, 500) : (fallback?.fileName || undefined),
    fileType,
    width,
    height,
    pageCount,
    renderScale: toNumber(raw.renderScale),
    previewDataUrl: typeof raw.previewDataUrl === 'string' ? raw.previewDataUrl : undefined,
    previewWidth: toBoundedInt(raw.previewWidth, 1, MAX_PREVIEW_SIDE) || undefined,
    previewHeight: toBoundedInt(raw.previewHeight, 1, MAX_PREVIEW_SIDE) || undefined,
    previewMimeType: typeof raw.previewMimeType === 'string' ? raw.previewMimeType.slice(0, 80) : undefined,
    textItemCount: toBoundedInt(raw.textItemCount, 0, 100000) ?? textLayers.length,
    imageOpCount: toBoundedInt(raw.imageOpCount, 0, 100000) ?? 0,
    pathOpCount: toBoundedInt(raw.pathOpCount, 0, 100000) ?? 0,
    hasFullPageImage: raw.hasFullPageImage === true,
    elapsedMs: toBoundedInt(raw.elapsedMs, 0, 120000) || undefined,
    textLayers,
  };
}

function normalizeTextLayer(value: unknown): ClientParseAssistTextLayer | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const text = typeof item.text === 'string' ? item.text.trim() : '';
  if (!text) return null;
  const x = toNumber(item.x);
  const y = toNumber(item.y);
  const width = toNumber(item.width);
  const height = toNumber(item.height);
  const fontSize = toNumber(item.fontSize);
  if ([x, y, width, height, fontSize].some((n) => typeof n !== 'number')) return null;
  if (width! <= 0 || height! <= 0 || fontSize! <= 0) return null;
  return {
    text: text.slice(0, 1000),
    x: Math.round(x!),
    y: Math.round(y!),
    width: Math.round(width!),
    height: Math.round(height!),
    fontSize: Math.round(fontSize!),
    fontName: typeof item.fontName === 'string' ? item.fontName.slice(0, 120) : undefined,
  };
}

function decodeClientPreviewDataUrl(value: unknown) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const match = CLIENT_PREVIEW_DATA_URL.exec(value.trim());
  if (!match) return null;
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (buffer.length === 0 || buffer.length > MAX_PREVIEW_BYTES) return null;
  return buffer;
}

async function normalizePreviewBuffer(buffer: Buffer, targetPath: string) {
  const meta = await sharp(buffer, { limitInputPixels: MAX_PREVIEW_PIXELS }).metadata();
  assertPreviewMetadata(meta.width, meta.height);
  await sharp(buffer, { limitInputPixels: MAX_PREVIEW_PIXELS }).png().toFile(targetPath);
}

async function normalizePreviewPath(sourcePath: string, targetPath: string) {
  const meta = await sharp(sourcePath, { limitInputPixels: MAX_PREVIEW_PIXELS }).metadata();
  assertPreviewMetadata(meta.width, meta.height);
  await sharp(sourcePath, { limitInputPixels: MAX_PREVIEW_PIXELS }).png().toFile(targetPath);
}

function assertPreviewMetadata(width?: number, height?: number) {
  if (!width || !height) throw new Error('Invalid client assist preview dimensions');
  if (width > MAX_PREVIEW_SIDE || height > MAX_PREVIEW_SIDE) {
    throw new Error('Client assist preview dimensions exceed limit');
  }
}

function toNumber(value: unknown): number | undefined {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function toBoundedInt(value: unknown, min: number, max: number): number | undefined {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return undefined;
  const intValue = Math.round(numberValue);
  return intValue >= min && intValue <= max ? intValue : undefined;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
