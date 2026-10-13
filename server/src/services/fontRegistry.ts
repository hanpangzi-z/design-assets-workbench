import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { STORAGE } from '../config/storage';

export interface FontMeta {
  id: string;
  name: string;
  family: string;
  filename: string;
  originalName: string;
  format: string;
  uploadedAt: string;
  aliases?: string[];
}

export const FONT_FILE_TYPES = new Set(['ttf', 'otf', 'ttc', 'woff', 'woff2']);
export const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.woff', '.woff2']);

const FONT_META_PATH = path.join(STORAGE.fonts, '_fonts.json');

export function isFontFileType(fileType: string) {
  return FONT_FILE_TYPES.has(fileType.toLowerCase());
}

export function isFontFilename(filename: string) {
  return FONT_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

export function fixMojibake(value: string): string {
  if (!value) return value;
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  try {
    const decoded = Buffer.from(value, 'latin1').toString('utf8');
    if (decoded && !decoded.includes('\uFFFD')) return decoded;
  } catch {
    // Keep the original value when it is already valid text.
  }
  return value;
}

export function readFontMeta(): FontMeta[] {
  if (!fs.existsSync(FONT_META_PATH)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(FONT_META_PATH, 'utf-8')) as FontMeta[];
    return Array.isArray(raw) ? raw.map(normalizeFontMeta) : [];
  } catch {
    return [];
  }
}

export function writeFontMeta(fonts: FontMeta[]) {
  if (!fs.existsSync(STORAGE.fonts)) fs.mkdirSync(STORAGE.fonts, { recursive: true });
  fs.writeFileSync(FONT_META_PATH, JSON.stringify(fonts.map(normalizeFontMeta), null, 2));
}

export function registerResourceFont(file: Express.Multer.File): FontMeta {
  if (!fs.existsSync(STORAGE.fonts)) fs.mkdirSync(STORAGE.fonts, { recursive: true });

  const originalName = fixMojibake(file.originalname);
  const ext = path.extname(originalName).toLowerCase();
  if (!FONT_EXTENSIONS.has(ext)) {
    throw new Error('UNSUPPORTED_FONT_TYPE');
  }

  const filename = `${uuidv4()}${ext}`;
  const targetPath = path.join(STORAGE.fonts, filename);
  fs.copyFileSync(file.path, targetPath);

  const fontMeta = createFontMeta({
    ...file,
    originalname: originalName,
    filename,
    path: targetPath,
  });
  const fonts = readFontMeta();
  fonts.push(fontMeta);
  writeFontMeta(fonts);

  return fontMeta;
}

function createFontMeta(file: Express.Multer.File): FontMeta {
  const originalName = fixMojibake(file.originalname);
  const ext = path.extname(originalName).toLowerCase();
  const baseName = path.basename(originalName, ext);
  const aliases = buildFontAliases(baseName, extractFontAliases(file.path || ''));
  return {
    id: uuidv4(),
    name: baseName,
    family: aliases[0] || baseName,
    filename: file.filename,
    originalName,
    format: fontFormat(ext),
    uploadedAt: new Date().toISOString(),
    aliases,
  };
}

function normalizeFontMeta(font: FontMeta): FontMeta {
  const ext = path.extname(font.originalName || font.filename).toLowerCase();
  const baseName = fixMojibake(font.name || path.basename(font.originalName || font.filename, ext));
  const family = fixMojibake(font.family || baseName);
  const aliases = buildFontAliases(baseName, [
    family,
    ...(Array.isArray(font.aliases) ? font.aliases.map(fixMojibake) : []),
  ]);
  return {
    ...font,
    name: baseName,
    family: family || aliases[0] || baseName,
    originalName: fixMojibake(font.originalName || ''),
    aliases,
  };
}

function fontFormat(ext: string) {
  if (ext === '.ttf' || ext === '.ttc') return 'truetype';
  if (ext === '.otf') return 'opentype';
  return ext.replace('.', '');
}

function extractFontAliases(filePath: string): string[] {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    const buffer = fs.readFileSync(filePath);
    if (buffer.length < 12) return [];
    if (buffer.toString('ascii', 0, 4) === 'ttcf') {
      const count = safeReadUInt32BE(buffer, 8);
      const aliases: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const offset = safeReadUInt32BE(buffer, 12 + index * 4);
        aliases.push(...parseSfntFontNames(buffer, offset));
      }
      return aliases;
    }
    return parseSfntFontNames(buffer, 0);
  } catch {
    return [];
  }
}

function parseSfntFontNames(buffer: Buffer, offset: number): string[] {
  if (offset < 0 || offset + 12 > buffer.length) return [];
  const signature = buffer.toString('ascii', offset, offset + 4);
  const version = safeReadUInt32BE(buffer, offset);
  const isSfnt = signature === 'OTTO' || signature === 'true' || signature === 'typ1' || version === 0x00010000;
  if (!isSfnt) return [];

  const numTables = safeReadUInt16BE(buffer, offset + 4);
  let nameOffset = -1;
  for (let index = 0; index < numTables; index += 1) {
    const recordOffset = offset + 12 + index * 16;
    if (recordOffset + 16 > buffer.length) break;
    if (buffer.toString('ascii', recordOffset, recordOffset + 4) !== 'name') continue;
    nameOffset = safeReadUInt32BE(buffer, recordOffset + 8);
    break;
  }

  if (nameOffset < 0 || nameOffset + 6 > buffer.length) return [];
  const count = safeReadUInt16BE(buffer, nameOffset + 2);
  const stringStorageOffset = safeReadUInt16BE(buffer, nameOffset + 4);
  const names: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const recordOffset = nameOffset + 6 + index * 12;
    if (recordOffset + 12 > buffer.length) break;
    const platformId = safeReadUInt16BE(buffer, recordOffset);
    const encodingId = safeReadUInt16BE(buffer, recordOffset + 2);
    const nameId = safeReadUInt16BE(buffer, recordOffset + 6);
    if (![1, 2, 4, 6, 16, 17].includes(nameId)) continue;

    const length = safeReadUInt16BE(buffer, recordOffset + 8);
    const stringOffset = safeReadUInt16BE(buffer, recordOffset + 10);
    const start = nameOffset + stringStorageOffset + stringOffset;
    const end = start + length;
    if (start < 0 || end > buffer.length || start >= end) continue;

    const decoded = decodeFontName(buffer.subarray(start, end), platformId, encodingId);
    if (decoded) names.push(decoded);
  }

  return names;
}

function decodeFontName(data: Buffer, platformId: number, encodingId: number): string {
  const text = (platformId === 0 || platformId === 3 || encodingId === 10)
    ? decodeUtf16Be(data)
    : data.toString('latin1');
  return text.replace(/\0/g, '').replace(/\s+/g, ' ').trim();
}

function decodeUtf16Be(data: Buffer): string {
  let text = '';
  for (let index = 0; index + 1 < data.length; index += 2) {
    text += String.fromCharCode(data.readUInt16BE(index));
  }
  return text;
}

function buildFontAliases(baseName: string, names: string[]): string[] {
  const aliases = uniqueStrings([baseName, ...names].flatMap(expandFontAlias));
  const normalized = aliases.map(normalizeFontName).join(' ');
  if (normalized.includes('dinpro')) {
    aliases.push('DIN Pro', 'DINPro', 'DIN Alternate');
  }
  return uniqueStrings(aliases).slice(0, 32);
}

function expandFontAlias(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const alias = value.trim();
  if (!alias) return [];
  const withoutExt = alias.replace(/\.(ttf|otf|ttc|woff2?)$/i, '');
  return uniqueStrings([
    alias,
    withoutExt,
    withoutExt.replace(/[_-]+/g, ' '),
  ]);
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    if (typeof value !== 'string') return;
    const text = value.trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    result.push(text);
  });
  return result;
}

function normalizeFontName(value: string): string {
  return value.toLowerCase().replace(/[\s"'_-]/g, '');
}

function safeReadUInt16BE(buffer: Buffer, offset: number): number {
  return offset >= 0 && offset + 2 <= buffer.length ? buffer.readUInt16BE(offset) : 0;
}

function safeReadUInt32BE(buffer: Buffer, offset: number): number {
  return offset >= 0 && offset + 4 <= buffer.length ? buffer.readUInt32BE(offset) : 0;
}
