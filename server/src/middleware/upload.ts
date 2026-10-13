import multer from 'multer';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { STORAGE } from '../config/storage';
import { AppError } from './errorHandler';
import fs from 'fs';

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = STORAGE.originals;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuid()}${ext}`);
  },
});

const ALLOWED_TYPES = [
  'image/png', 'image/jpeg', 'image/svg+xml', 'image/gif', 'image/webp',
  'application/pdf',
  'application/postscript',     // .ai
  'application/illustrator',
  'image/vnd.adobe.photoshop',  // .psd
  'image/psd',                  // .psd
  'application/photoshop',
  'application/psd',
  'application/psb',
  'application/x-photoshop',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'font/ttf',
  'font/otf',
  'font/woff',
  'font/woff2',
  'application/font-sfnt',
  'application/x-font-ttf',
  'application/x-font-otf',
  'application/x-font-woff',
  'application/x-font-woff2',
  // Browsers send `application/octet-stream` whenever the OS has no MIME
  // mapping for the extension — common for .psd / .ai / .ttc on Windows.
  // Pairing this with the extension allow-list (AND below) means "trust the
  // extension when the browser has no opinion", but still reject e.g. an
  // .exe claiming image/png since the extension itself fails the check.
  'application/octet-stream',
];

const ALLOWED_EXTENSIONS = [
  '.psd', '.psb', '.ai', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.pptx', '.ppt',
  '.ttf', '.otf', '.ttc', '.woff', '.woff2',
];

const uploadMiddleware = multer({
  storage,
  limits: {
    fileSize: 30 * 1024 * 1024, // 30MB
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext) && ALLOWED_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError(`不支持的文件格式: ${ext} (${file.mimetype})`, 400));
    }
  },
});

export default uploadMiddleware;
