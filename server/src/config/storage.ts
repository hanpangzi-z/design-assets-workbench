import path from 'path';

const DEFAULT_UPLOAD_BASE = path.resolve(__dirname, '../../uploads');
const configuredUploadDir = process.env.UPLOAD_DIR?.trim();
const UPLOAD_BASE = configuredUploadDir
  ? path.resolve(__dirname, '../..', configuredUploadDir)
  : DEFAULT_UPLOAD_BASE;

export const STORAGE = {
  base: UPLOAD_BASE,
  originals: path.join(UPLOAD_BASE, 'originals'),
  thumbnails: path.join(UPLOAD_BASE, 'thumbnails'),
  parsed: path.join(UPLOAD_BASE, 'parsed'),
  exports: path.join(UPLOAD_BASE, 'exports'),
  fonts: path.join(UPLOAD_BASE, 'fonts'),
};
