import { Router } from 'express';
import type { NextFunction, Response } from 'express';
import {
  getUploadThumbnailVariantPath,
  isUploadThumbnailVariantWidth,
  normalizeUploadThumbnailSource,
  uploadRelativePathToUrl,
} from '../services/uploadThumbnailVariants';
import { logger } from '../utils/logger';

const router = Router();

router.get(['/:width/:encodedSource/:cacheToken', '/:width/:encodedSource', '/:width', '/_thumb/:width'], async (req, res, next: NextFunction) => {
  const width = Number(req.params.width);
  const sourceInput = decodeSourcePathSegment(readRouteParam(req.params.encodedSource)) || req.query.src;
  const source = normalizeUploadThumbnailSource(sourceInput);

  if (!isUploadThumbnailVariantWidth(width) || !source) {
    next();
    return;
  }

  try {
    const targetPath = await getUploadThumbnailVariantPath(source, width);
    sendVariant(res, targetPath);
  } catch (err) {
    logger.warn({ err, width, src: req.query.src }, 'upload thumbnail variant failed');
    res.redirect(302, uploadRelativePathToUrl(source.relativePath));
  }
});

function readRouteParam(value?: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

function decodeSourcePathSegment(value?: string) {
  if (!value) return null;
  try {
    return decodeURIComponent(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function sendVariant(res: Response, filePath: string) {
  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  res.sendFile(filePath);
}

export default router;
