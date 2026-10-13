import type { DesignFile } from 'shared/types';

const DIRECT_IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

export function getAssetPreviewPath(file: DesignFile, options: { preferOriginalForPortrait?: boolean } = {}) {
  const thumbnailPath = normalizeUploadAssetPath(file.thumbnailPath);
  const originalPath = isDirectImageType(file.fileType) ? normalizeUploadAssetPath(file.filePath) : '';

  if (options.preferOriginalForPortrait && isPortraitFile(file) && originalPath) {
    return originalPath;
  }

  if (usesLegacyResourceThumbnail(file.thumbnailPath) && originalPath) {
    return originalPath;
  }

  return thumbnailPath || originalPath;
}

export function appendAssetVersion(src: string, version?: string | number | null) {
  if (!version || /^(data:|blob:)/i.test(src)) return src;
  return `${src}${src.includes('?') ? '&' : '?'}v=${encodeURIComponent(String(version))}`;
}

export function normalizeUploadAssetPath(assetPath?: string | null) {
  if (!assetPath) return '';
  const normalized = assetPath.replace(/\\/g, '/');
  if (/^(https?:|data:|blob:|\/uploads\/)/i.test(normalized)) return normalized;
  if (/^uploads\//i.test(normalized)) return `/${normalized}`;

  const uploadIndex = normalized.toLowerCase().lastIndexOf('/uploads/');
  if (uploadIndex >= 0) return normalized.slice(uploadIndex);

  return `/uploads/${normalized.replace(/^\/+/, '')}`;
}

function isDirectImageType(fileType?: string | null) {
  return DIRECT_IMAGE_TYPES.has(String(fileType || '').toLowerCase());
}

function isPortraitFile(file: DesignFile) {
  const width = Number(file.width || 0);
  const height = Number(file.height || 0);
  return width > 0 && height / width > 1.15;
}

function usesLegacyResourceThumbnail(thumbnailPath?: string | null) {
  return /_resource_thumb\.(png|jpe?g|webp)$/i.test(thumbnailPath || '');
}
