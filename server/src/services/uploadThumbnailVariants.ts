import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { STORAGE } from '../config/storage';
import { logger } from '../utils/logger';

export const UPLOAD_THUMBNAIL_VARIANT_WIDTHS = [240, 320, 480, 640, 960] as const;
const PREHEAT_THUMBNAIL_WIDTHS = [320, 640] as const;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;
const UPLOAD_ROOT = path.resolve(STORAGE.base);
const VARIANT_ROOT = path.join(UPLOAD_ROOT, '_thumb');
const ALLOWED_WIDTHS = new Set<number>(UPLOAD_THUMBNAIL_VARIANT_WIDTHS);
const inFlightVariants = new Map<string, Promise<string>>();

export type UploadThumbnailSource = {
  relativePath: string;
  absolutePath: string;
};

export function isUploadThumbnailVariantWidth(width: number) {
  return ALLOWED_WIDTHS.has(width);
}

export function normalizeUploadThumbnailSource(value: unknown): UploadThumbnailSource | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !raw.trim()) return null;

  let pathname = raw.trim().replace(/\\/g, '/').split('?')[0];
  if (/^https?:\/\//i.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname;
    } catch {
      return null;
    }
  }

  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  let relativePath = '';
  if (pathname.startsWith('/uploads/')) {
    relativePath = pathname.slice('/uploads/'.length);
  } else if (pathname.startsWith('uploads/')) {
    relativePath = pathname.slice('uploads/'.length);
  } else if (/^[a-zA-Z]:\//.test(pathname) || pathname.startsWith('//')) {
    const absolutePath = path.resolve(pathname);
    const relativeFromRoot = path.relative(UPLOAD_ROOT, absolutePath);
    if (relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) return null;
    relativePath = relativeFromRoot.replace(/\\/g, '/');
  } else if (pathname.startsWith('/')) {
    return null;
  } else {
    relativePath = pathname;
  }

  relativePath = path.posix.normalize(relativePath.replace(/^\/+/, ''));
  if (
    !relativePath ||
    relativePath === '.' ||
    relativePath.startsWith('../') ||
    relativePath.includes('/../') ||
    relativePath.startsWith('_thumb/') ||
    !IMAGE_EXT_RE.test(relativePath)
  ) {
    return null;
  }

  const absolutePath = path.resolve(UPLOAD_ROOT, relativePath);
  const relativeFromRoot = path.relative(UPLOAD_ROOT, absolutePath);
  if (relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) return null;

  return { relativePath, absolutePath };
}

export async function getUploadThumbnailVariantPath(source: UploadThumbnailSource, width: number) {
  if (!isUploadThumbnailVariantWidth(width)) {
    throw new Error(`Unsupported thumbnail variant width: ${width}`);
  }

  const sourceStat = await fs.stat(source.absolutePath);
  if (!sourceStat.isFile()) {
    throw new Error(`Thumbnail source is not a file: ${source.relativePath}`);
  }

  const cacheKey = createCacheKey(source.relativePath, width, sourceStat.size, sourceStat.mtimeMs);
  const targetDir = path.join(VARIANT_ROOT, String(width));
  const targetPath = path.join(targetDir, `${cacheKey}.webp`);

  try {
    await fs.access(targetPath);
    return targetPath;
  } catch {
    // Cache miss: generate below.
  }

  const inFlightKey = `${width}:${cacheKey}`;
  const pending = inFlightVariants.get(inFlightKey);
  if (pending) return pending;

  const request = generateVariant(source, width, targetDir, targetPath)
    .finally(() => {
      inFlightVariants.delete(inFlightKey);
    });
  inFlightVariants.set(inFlightKey, request);
  return request;
}

export function warmUploadThumbnailVariants(sourceValue: string, widths: readonly number[] = PREHEAT_THUMBNAIL_WIDTHS) {
  const source = normalizeUploadThumbnailSource(sourceValue);
  if (!source) return;

  for (const width of widths) {
    if (!isUploadThumbnailVariantWidth(width)) continue;
    void getUploadThumbnailVariantPath(source, width).catch((err) => {
      logger.debug({ err, width, src: source.relativePath }, 'upload thumbnail preheat skipped');
    });
  }
}

export function uploadRelativePathToUrl(relativePath: string) {
  return `/uploads/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

async function generateVariant(
  source: UploadThumbnailSource,
  width: number,
  targetDir: string,
  targetPath: string,
) {
  let tempPath: string | null = null;

  try {
    await fs.mkdir(targetDir, { recursive: true });
    tempPath = path.join(targetDir, `${path.basename(targetPath, '.webp')}.${process.pid}.${Date.now()}.tmp`);

    await sharp(source.absolutePath)
      .rotate()
      .resize({ width, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78, effort: 4 })
      .toFile(tempPath);

    const generatedPath = tempPath;
    try {
      await fs.rename(generatedPath, targetPath);
      tempPath = null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      await fs.rm(generatedPath, { force: true });
      tempPath = null;
    }

    return targetPath;
  } catch (err) {
    if (tempPath) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
    throw err;
  }
}

function createCacheKey(relativePath: string, width: number, size: number, mtimeMs: number) {
  return crypto
    .createHash('sha1')
    .update(`${width}:${relativePath}:${size}:${Math.floor(mtimeMs)}`)
    .digest('hex')
    .slice(0, 28);
}
