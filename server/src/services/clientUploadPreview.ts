import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { DesignFile } from '../models';
import { STORAGE } from '../config/storage';
import { warmUploadThumbnailVariants } from './uploadThumbnailVariants';
import { logger } from '../utils/logger';

const MAX_CLIENT_PREVIEW_BYTES = 3 * 1024 * 1024;
const MAX_CLIENT_PREVIEW_SIDE = 6000;
const MAX_CLIENT_PREVIEW_PIXELS = 40_000_000;
const CLIENT_PREVIEW_DATA_URL = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/;

interface ClientPreviewBody {
  clientThumbnailDataUrl?: unknown;
  clientPreviewWidth?: unknown;
  clientPreviewHeight?: unknown;
  clientPreviewSource?: unknown;
}

export async function saveClientUploadPreviewTempFromBody(body: ClientPreviewBody | undefined, tempPath: string) {
  const buffer = decodeClientPreviewDataUrl(body?.clientThumbnailDataUrl);
  if (!buffer) return null;

  try {
    await fs.promises.mkdir(path.dirname(tempPath), { recursive: true });
    await normalizeClientPreview(buffer, tempPath, 1200);
    logger.info(
      {
        scope: 'client-preview',
        status: 'accepted',
        source: normalizePreviewSource(body?.clientPreviewSource),
      },
      'client upload preview accepted'
    );
    return tempPath;
  } catch (err) {
    logger.warn(
      {
        scope: 'client-preview',
        status: 'ignored',
        source: normalizePreviewSource(body?.clientPreviewSource),
        err,
      },
      'client upload preview ignored'
    );
    await fs.promises.unlink(tempPath).catch(() => {});
    return null;
  }
}

export async function applyClientUploadPreviewBodyToFile(file: DesignFile, body: ClientPreviewBody | undefined) {
  const tempPath = path.join(STORAGE.base, '_client-preview', `${file.id}-${Date.now()}.png`);
  const savedPath = await saveClientUploadPreviewTempFromBody(body, tempPath);
  if (!savedPath) return false;

  try {
    return await applyClientUploadPreviewToFile(file, savedPath, {
      width: toPositiveInt(body?.clientPreviewWidth),
      height: toPositiveInt(body?.clientPreviewHeight),
    });
  } finally {
    await fs.promises.unlink(savedPath).catch(() => {});
  }
}

export async function applyClientUploadPreviewToFile(
  file: DesignFile,
  previewPath: string | null | undefined,
  dimensions?: { width?: number | null; height?: number | null },
) {
  if (!previewPath || !fs.existsSync(previewPath)) return false;

  try {
    const meta = await sharp(previewPath, { limitInputPixels: MAX_CLIENT_PREVIEW_PIXELS }).metadata();
    assertPreviewMetadata(meta.width, meta.height);

    const thumbFilename = `${file.id}_thumb.png`;
    const thumbPath = path.join(STORAGE.thumbnails, thumbFilename);
    await fs.promises.mkdir(STORAGE.thumbnails, { recursive: true });

    await sharp(previewPath, { limitInputPixels: MAX_CLIENT_PREVIEW_PIXELS })
      .resize(400, 300, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toFile(thumbPath);

    await file.update({
      thumbnailPath: `thumbnails/${thumbFilename}`,
      width: dimensions?.width || meta.width || null,
      height: dimensions?.height || meta.height || null,
    });
    warmUploadThumbnailVariants(`thumbnails/${thumbFilename}`);
    logger.info(
      {
        scope: 'client-preview',
        status: 'applied',
        fileId: file.id,
        fileType: file.fileType,
        width: dimensions?.width || meta.width || null,
        height: dimensions?.height || meta.height || null,
      },
      'client upload preview applied'
    );
    return true;
  } catch (err) {
    logger.warn(
      {
        scope: 'client-preview',
        status: 'ignored',
        fileId: file.id,
        fileType: file.fileType,
        err,
      },
      'client upload thumbnail ignored'
    );
    return false;
  }
}

function decodeClientPreviewDataUrl(value: unknown) {
  if (typeof value !== 'string' || value.length === 0) return null;

  const match = CLIENT_PREVIEW_DATA_URL.exec(value.trim());
  if (!match) return null;

  const base64 = match[2].replace(/\s/g, '');
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0 || buffer.length > MAX_CLIENT_PREVIEW_BYTES) return null;
  return buffer;
}

async function normalizeClientPreview(buffer: Buffer, targetPath: string, maxSide: number) {
  const meta = await sharp(buffer, { limitInputPixels: MAX_CLIENT_PREVIEW_PIXELS }).metadata();
  assertPreviewMetadata(meta.width, meta.height);

  await sharp(buffer, { limitInputPixels: MAX_CLIENT_PREVIEW_PIXELS })
    .resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toFile(targetPath);
}

function assertPreviewMetadata(width?: number, height?: number) {
  if (!width || !height) throw new Error('Invalid client preview dimensions');
  if (width > MAX_CLIENT_PREVIEW_SIDE || height > MAX_CLIENT_PREVIEW_SIDE) {
    throw new Error('Client preview dimensions exceed limit');
  }
}

function toPositiveInt(value: unknown) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizePreviewSource(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 80) : null;
}
