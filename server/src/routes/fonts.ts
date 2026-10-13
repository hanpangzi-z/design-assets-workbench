import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { STORAGE } from '../config/storage';
import { authMiddleware } from '../middleware/auth';
import { logger } from '../utils/logger';

const router = Router();

if (!fs.existsSync(STORAGE.fonts)) fs.mkdirSync(STORAGE.fonts, { recursive: true });

const ALLOWED_FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.woff', '.woff2']);

const upload = multer({
  storage: multer.diskStorage({
    destination: STORAGE.fonts,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${uuidv4()}${ext}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_FONT_EXTENSIONS.has(ext)) {
      cb(new Error('UNSUPPORTED_FONT_TYPE'));
      return;
    }
    cb(null, true);
  },
  limits: { fileSize: 20 * 1024 * 1024 },
});

const FONT_META_PATH = path.join(STORAGE.fonts, '_fonts.json');
const SYSTEM_FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.woff', '.woff2']);
const DEFAULT_CN_EDIT_FONT_FAMILY = 'Alibaba PuHuiTi 3.0 55 Regular';
const DEFAULT_CN_EDIT_FONT_FILENAME = 'AlibabaPuHuiTi-3-55-Regular.ttf';
const DEFAULT_CN_EDIT_FONT_DEV_PATH = 'D:\\Doucuments\\WXWork\\1688856025681076\\Cache\\File\\2026-06\\AlibabaPuHuiTi-3-55-Regular.ttf';
const DEFAULT_CN_EDIT_FONT_ALIASES = [
  DEFAULT_CN_EDIT_FONT_FAMILY,
  DEFAULT_CN_EDIT_FONT_FILENAME,
  'AlibabaPuHuiTi-3-55-Regular',
  'Alibaba PuHuiTi 3 55 Regular',
  'Alibaba PuHuiTi 3.0 55 Regular',
  'Alibaba PuHuiTi',
  'AlibabaPuHuiTi',
  '阿里巴巴普惠体',
];
const GENERIC_FONT_ALIAS_NAMES = new Set([
  'regular',
  'normal',
  'book',
  'roman',
  'medium',
  'light',
  'thin',
  'bold',
  'heavy',
  'black',
  'italic',
  'oblique',
]);

interface FontMeta {
  id: string;
  name: string;
  family: string;
  filename: string;
  originalName: string;
  format: string;
  uploadedAt: string;
  aliases?: string[];
}

/**
 * multer 拿到 multipart 的 filename 时按 latin1 把字节当字符，UTF-8 中文文件名进来
 * 就变成 `æ¹æ­£å°äº­ä¸­é»_GBK` 这种 mojibake。这里反向操作把它还原。
 *
 * 安全性：纯 ASCII 文件名（"test.ttf"）的 latin1 字节跟 UTF-8 字节相同，转换后不变；
 * 含中文的 mojibake 字符串里的字节本来就是 UTF-8，转换后还原成正确中文；
 * 已是正确 UTF-8 的字符串（理论上不会出现，但防御一下），latin1→utf8 会破坏。
 * 用 � 替换字符做哨兵：转换后出现 → 原串不是 mojibake，回退到原值。
 */
function fixMojibake(value: string): string {
  if (!value) return value;
  // 全部都是 ASCII 字符 → 走转换也是无操作，直接返回
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  try {
    const decoded = Buffer.from(value, 'latin1').toString('utf8');
    if (decoded && !decoded.includes('�')) return decoded;
  } catch {
    // ignore
  }
  return value;
}

function readFontMeta(): FontMeta[] {
  if (!fs.existsSync(FONT_META_PATH)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(FONT_META_PATH, 'utf-8')) as FontMeta[];
    // 老数据自动迁移：把 mojibake 的 name / family / originalName / aliases 还原回中文
    let dirty = false;
    const migrated = raw.map((font) => {
      const before = JSON.stringify(font);
      const fixed: FontMeta = {
        ...font,
        name: fixMojibake(font.name),
        family: fixMojibake(font.family),
        originalName: fixMojibake(font.originalName || ''),
        aliases: Array.isArray(font.aliases) ? font.aliases.map(fixMojibake) : font.aliases,
      };
      if (JSON.stringify(fixed) !== before) dirty = true;
      return fixed;
    });
    // 持久化写回，下次启动就不再迁移
    if (dirty) {
      try {
        fs.writeFileSync(FONT_META_PATH, JSON.stringify(migrated, null, 2));
        logger.info({ scope: 'font' }, 'Font: detected mojibake, migrated _fonts.json');
      } catch (err) {
        logger.warn({ scope: 'font', err }, 'Font: failed to persist migration (runtime not affected)');
      }
    }
    return migrated.map(normalizeFontMeta);
  } catch {
    return [];
  }
}

function writeFontMeta(fonts: FontMeta[]) {
  fs.writeFileSync(FONT_META_PATH, JSON.stringify(fonts, null, 2));
}

function fontFormat(ext: string) {
  if (ext === '.ttf' || ext === '.ttc') return 'truetype';
  if (ext === '.otf') return 'opentype';
  return ext.replace('.', '');
}

function inferCssFontWeight(font: FontMeta): string {
  const rawNames = [font.name, font.family, font.originalName, ...(font.aliases || [])].join(' ');
  const normalized = normalizeFontName(
    rawNames,
  );
  if (
    normalized.includes('light')
    || normalized.includes('xihei')
    || rawNames.includes('细黑')
    || rawNames.includes('纤黑')
  ) return '300';
  if (
    normalized.includes('bold')
    || normalized.includes('heavy')
    || normalized.includes('black')
    || normalized.includes('extrabold')
    || normalized.includes('fzltch')
    || normalized.includes('fzltth')
    || normalized.includes('fzltdhk')
    || rawNames.includes('粗黑')
    || rawNames.includes('特黑')
    || rawNames.includes('大黑')
  ) {
    return '700';
  }
  return '400';
}

function inferCssFontStyle(font: FontMeta): string {
  const normalized = normalizeFontName(
    [font.name, font.family, font.originalName, ...(font.aliases || [])].join(' '),
  );
  return normalized.includes('italic') ? 'italic' : 'normal';
}

function createFontMeta(file: Express.Multer.File): FontMeta {
  // multer 默认按 latin1 解 multipart filename，中文 UTF-8 文件名会变成 mojibake；
  // 这里在落库前就还原回正确的中文，不再依赖 readFontMeta 兜底迁移。
  const properOriginalName = fixMojibake(file.originalname);
  const ext = path.extname(properOriginalName).toLowerCase();
  const baseName = path.basename(properOriginalName, ext);
  const aliases = buildFontAliases(baseName, extractFontAliases(file.path || path.join(STORAGE.fonts, file.filename)));
  return {
    id: uuidv4(),
    name: baseName,
    family: aliases[0] || baseName,
    filename: file.filename,
    originalName: properOriginalName,
    format: fontFormat(ext),
    uploadedAt: new Date().toISOString(),
    aliases,
  };
}

function extractFontAliases(filePath: string): string[] {
  try {
    if (!fs.existsSync(filePath)) return [];
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
  } catch (error) {
    logger.warn({ scope: 'font', filePath, err: error }, 'Font: failed to read font names');
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
    const tag = buffer.toString('ascii', recordOffset, recordOffset + 4);
    if (tag !== 'name') continue;
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

function safeReadUInt16BE(buffer: Buffer, offset: number): number {
  return offset >= 0 && offset + 2 <= buffer.length ? buffer.readUInt16BE(offset) : 0;
}

function safeReadUInt32BE(buffer: Buffer, offset: number): number {
  return offset >= 0 && offset + 4 <= buffer.length ? buffer.readUInt32BE(offset) : 0;
}

function buildFontAliases(baseName: string, names: string[]): string[] {
  const aliases = uniqueStrings([baseName, ...names].flatMap(expandFontAlias));
  const normalized = aliases.map(normalizeFontName).join(' ');
  const isLanTingThin = normalized.includes('fzltxih')
    || aliases.some((alias) => alias.includes('兰亭细黑'));
  if (
    normalized.includes('fzltzhk')
    || (normalized.includes('fzlantinghei') && (normalized.includes('db') || normalized.includes('zhonghei')))
    || aliases.some((alias) => alias.includes('兰亭中黑'))
  ) {
    aliases.push('FZLTZHK--GBK1-0', 'FZLanTingHei-DB-GBK', '方正兰亭中黑_GBK', '方正兰亭中黑');
  }
  if (
    !isLanTingThin
    && (
      normalized.includes('fzlthk')
      || normalized.includes('fzlantingheir')
      || normalized.includes('fzlantingheisr')
      || aliases.some((alias) => alias.includes('兰亭黑') && !alias.includes('细黑') && !alias.includes('中黑'))
    )
  ) {
    aliases.push('FZLTHK--GBK1-0', 'FZLanTingHei-R-GBK', '方正兰亭黑_GBK', '方正兰亭黑');
  }
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

function fontNameMatches(left: string, right: string): boolean {
  const a = normalizeFontName(left);
  const b = normalizeFontName(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function isGenericFontAlias(value: string): boolean {
  const normalized = normalizeFontName(value);
  return !normalized || GENERIC_FONT_ALIAS_NAMES.has(normalized);
}

function isSpecificDefaultCnEditFontName(value: string): boolean {
  const candidates = expandFontAlias(value).filter((name) => !isGenericFontAlias(name));
  const expected = new Set(
    DEFAULT_CN_EDIT_FONT_ALIASES
      .flatMap(expandFontAlias)
      .filter((name) => !isGenericFontAlias(name))
      .map(normalizeFontName),
  );
  return candidates.some((candidate) => {
    const normalized = normalizeFontName(candidate);
    return Boolean(normalized && (expected.has(normalized) || normalized.includes('alibabapuhuiti')));
  });
}

function escapeCssString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function normalizeFontMeta(font: FontMeta): FontMeta {
  const ext = path.extname(font.originalName || font.filename).toLowerCase();
  const baseName = font.name || path.basename(font.originalName || font.filename, ext);
  const filePath = path.join(STORAGE.fonts, font.filename);
  const parsedAliases = Array.isArray(font.aliases) && font.aliases.length > 0
    ? font.aliases
    : extractFontAliases(filePath);
  const aliases = buildFontAliases(baseName, [font.family, ...parsedAliases]);
  return {
    ...font,
    name: baseName,
    family: font.family || aliases[0] || baseName,
    aliases,
  };
}

function sendUploadError(res: Response, error: unknown) {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? '单个字体不能超过 20MB'
      : `字体上传失败：${error.message}`;
    return res.status(400).json({ code: 400, message });
  }
  if (error instanceof Error && error.message === 'UNSUPPORTED_FONT_TYPE') {
    return res.status(400).json({ code: 400, message: '请上传字体文件(.ttf/.otf/.ttc/.woff/.woff2)' });
  }
  if (error instanceof Error) {
    return res.status(400).json({ code: 400, message: error.message });
  }
  return res.status(400).json({ code: 400, message: '字体上传失败' });
}

function getSystemFontPath(filename: string): string | null {
  const safeName = path.basename(filename).toLowerCase();
  if (!SYSTEM_FONT_EXTENSIONS.has(path.extname(safeName))) return null;
  const windowsDir = process.env.WINDIR || 'C:\\Windows';
  const fontDir = path.resolve(windowsDir, 'Fonts');
  const fontPath = path.resolve(fontDir, safeName);
  if (!fontPath.startsWith(fontDir + path.sep)) return null;
  return fs.existsSync(fontPath) ? fontPath : null;
}

function resolveExistingFontPath(candidate: string | undefined): string | null {
  if (!candidate) return null;
  const fontPath = path.resolve(candidate);
  if (!SYSTEM_FONT_EXTENSIONS.has(path.extname(fontPath).toLowerCase())) return null;
  return fs.existsSync(fontPath) ? fontPath : null;
}

function isDefaultCnEditFont(font: FontMeta): boolean {
  const names = uniqueStrings([
    font.family,
    font.name,
    font.originalName,
    font.filename,
    ...(font.aliases || []),
  ]);
  return names.some(isSpecificDefaultCnEditFontName);
}

function findUploadedDefaultCnEditFont(): { fontPath: string; font: FontMeta } | null {
  for (const font of readFontMeta()) {
    if (!isDefaultCnEditFont(font)) continue;
    const fontPath = path.resolve(STORAGE.fonts, font.filename);
    if (!fontPath.startsWith(path.resolve(STORAGE.fonts) + path.sep)) continue;
    if (!SYSTEM_FONT_EXTENSIONS.has(path.extname(fontPath).toLowerCase())) continue;
    if (fs.existsSync(fontPath)) return { fontPath, font };
  }
  return null;
}

type DefaultCnEditFontResolution = {
  fontPath: string;
  source: 'env' | 'uploaded' | 'storage-filename' | 'dev-path';
  font?: FontMeta;
};

function getDefaultCnEditFontResolution(): DefaultCnEditFontResolution | null {
  const envFontPath = resolveExistingFontPath(process.env.DEFAULT_CN_EDIT_FONT_PATH);
  if (envFontPath) return { fontPath: envFontPath, source: 'env' };

  const uploaded = findUploadedDefaultCnEditFont();
  if (uploaded) return { ...uploaded, source: 'uploaded' };

  const storageFontPath = resolveExistingFontPath(path.join(STORAGE.fonts, DEFAULT_CN_EDIT_FONT_FILENAME));
  if (storageFontPath) return { fontPath: storageFontPath, source: 'storage-filename' };

  const devFontPath = resolveExistingFontPath(DEFAULT_CN_EDIT_FONT_DEV_PATH);
  if (devFontPath) return { fontPath: devFontPath, source: 'dev-path' };

  return null;
}

function getDefaultCnEditFontPath(): string | null {
  return getDefaultCnEditFontResolution()?.fontPath || null;
}

router.get('/', (_req: Request, res: Response) => {
  res.json({ code: 200, data: readFontMeta() });
});

router.get('/css', (_req: Request, res: Response) => {
  const defaultFontCss = getDefaultCnEditFontPath()
    ? `@font-face { font-family: "${escapeCssString(DEFAULT_CN_EDIT_FONT_FAMILY)}"; src: url("/api/v1/fonts/default-cn-edit"); font-weight: 400; font-style: normal; font-display: swap; }\n`
    : '';
  const css = defaultFontCss + readFontMeta()
    .flatMap((font) => uniqueStrings([font.family, font.name, ...(font.aliases || [])]).map((family) =>
      `@font-face { font-family: "${escapeCssString(family)}"; src: url("/uploads/fonts/${font.filename}"); font-weight: ${inferCssFontWeight(font)}; font-style: ${inferCssFontStyle(font)}; font-display: swap; }`
    ))
    .join('\n');
  res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
  res.type('text/css').send(css);
});

/**
 * GET /api/v1/fonts/match?names=A,B,C
 *
 * 客户端把 PSD 解析出来的字体名（含原始 PSD font.name 与各种别名）打包过来，
 * 这里跟已上传字体的 family / name / aliases 做规范化匹配（大小写、空格、下划线全归一），
 * 命中就返回匹配的 FontMeta，未命中即视为「缺失字体」。
 *
 * 返回结构：
 *   {
 *     matched:  [{ requestedName: string, font: FontMeta }],
 *     missing:  string[],     // 没找到对应字体文件的原始名字
 *     resolved: Record<string, string>  // requestedName -> 实际可用的 css family（用于 fontFamily 渲染）
 *   }
 */
router.get('/match', (req: Request, res: Response) => {
  const raw = (req.query.names as string) || '';
  const requestedNames = uniqueStrings(
    raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
  );
  const fonts = readFontMeta();

  // 把每个已上传字体的所有 family / name / alias 归一化建索引：normalized -> FontMeta
  const index = new Map<string, FontMeta>();
  for (const font of fonts) {
    const allNames = uniqueStrings([font.family, font.name, ...(font.aliases || [])]);
    for (const n of allNames) {
      const key = normalizeFontName(n);
      if (key && !index.has(key)) index.set(key, font);
    }
  }

  const matched: Array<{ requestedName: string; font: FontMeta }> = [];
  const missing: string[] = [];
  const resolved: Record<string, string> = {};

  for (const name of requestedNames) {
    // 同时尝试原名 + expandFontAlias 衍生出的别名（去扩展名 / 下划线变空格 等）
    const candidates = uniqueStrings(expandFontAlias(name));
    let hit: FontMeta | undefined;
    for (const c of candidates) {
      const found = index.get(normalizeFontName(c));
      if (found) {
        hit = found;
        break;
      }
    }
    if (hit) {
      matched.push({ requestedName: name, font: hit });
      // 优先返回字体的主 family，让前端在 fontFamily 链里把它放最前
      resolved[name] = hit.family || hit.name;
    } else {
      missing.push(name);
    }
  }

  res.json({
    code: 200,
    data: {
      matched,
      missing,
      resolved,
      totalRequested: requestedNames.length,
      totalAvailableFonts: fonts.length,
    },
  });
});

router.get('/default-cn-edit', (_req: Request, res: Response) => {
  const resolution = getDefaultCnEditFontResolution();
  if (!resolution) return res.status(404).json({ code: 404, message: 'Default Chinese edit font not found' });
  const filename = resolution.font?.filename || path.basename(resolution.fontPath);
  res.set('X-Benlai-Font-Source', resolution.source);
  res.set('X-Benlai-Font-Filename', filename);
  if (resolution.font?.id) res.set('X-Benlai-Font-Id', resolution.font.id);
  if (resolution.font?.originalName) res.set('X-Benlai-Font-Original-Name', encodeURIComponent(resolution.font.originalName));
  res.set('Content-Disposition', `inline; filename="${path.basename(filename).replace(/"/g, '')}"`);
  res.sendFile(resolution.fontPath);
});

router.get('/default-cn-edit/status', (_req: Request, res: Response) => {
  const resolution = getDefaultCnEditFontResolution();
  res.json({
    code: 200,
    data: resolution
      ? {
          found: true,
          source: resolution.source,
          filename: resolution.font?.filename || path.basename(resolution.fontPath),
          originalName: resolution.font?.originalName || path.basename(resolution.fontPath),
          fontId: resolution.font?.id || null,
          fontPath: resolution.fontPath,
        }
      : { found: false },
  });
});

router.get('/system/:filename', (req: Request, res: Response) => {
  const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
  const fontPath = getSystemFontPath(filename);
  if (!fontPath) return res.status(404).json({ code: 404, message: 'System font not found' });
  res.sendFile(fontPath);
});

router.post('/', authMiddleware, (req: Request, res: Response) => {
  upload.single('file')(req, res, (error) => {
    if (error) return sendUploadError(res, error);
    const file = req.file;
    if (!file) {
      return res.status(400).json({ code: 400, message: '请上传字体文件(.ttf/.otf/.ttc/.woff/.woff2)' });
    }

    const fontMeta = createFontMeta(file);
    const fonts = readFontMeta();
    fonts.push(fontMeta);
    writeFontMeta(fonts);
    logger.info({ scope: 'font', name: fontMeta.name, filename: file.filename }, 'Font: uploaded');

    return res.status(201).json({ code: 201, message: '字体上传成功', data: fontMeta });
  });
});

router.post('/batch', authMiddleware, (req: Request, res: Response) => {
  upload.array('files', 100)(req, res, (error) => {
    if (error) return sendUploadError(res, error);
    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) {
      return res.status(400).json({ code: 400, message: '请至少上传一个字体文件(.ttf/.otf/.ttc/.woff/.woff2)' });
    }

    const uploadedFonts = files.map(createFontMeta);
    const fonts = readFontMeta();
    fonts.push(...uploadedFonts);
    writeFontMeta(fonts);
    uploadedFonts.forEach((font) =>
      logger.info({ scope: 'font', name: font.name, filename: font.filename }, 'Font: uploaded')
    );

    return res.status(201).json({
      code: 201,
      message: `已上传 ${uploadedFonts.length} 个字体`,
      data: uploadedFonts,
    });
  });
});

router.delete('/:id', authMiddleware, (req: Request, res: Response) => {
  const fonts = readFontMeta();
  const index = fonts.findIndex((font) => font.id === req.params.id);
  if (index === -1) return res.status(404).json({ code: 404, message: '字体不存在' });

  const [font] = fonts.splice(index, 1);
  const filePath = path.join(STORAGE.fonts, font.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  writeFontMeta(fonts);
  logger.info({ scope: 'font', name: font.name }, 'Font: deleted');

  res.json({ code: 200, message: '已删除' });
});

export default router;
