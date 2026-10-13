import { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { SaxesParser } from 'saxes';
import sharp from 'sharp';
import { pipeline } from 'stream/promises';
import { Op, type Transaction } from 'sequelize';
import { sequelize, DesignFile, Category, User, Tag, FileTag, FileCategory, ParsedLayer, Library, FileVersion } from '../models';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth';
import { STORAGE } from '../config/storage';
import { enqueueParse, getParseQueuePhase } from '../services/parser/parseOrchestrator';
import { deriveParseFreshness, effectiveParseStatus } from '../services/parser/parseFreshness';
import { PDF_PARSER_VERSION, AI_PARSER_VERSION, PSD_PARSER_VERSION } from '../services/parser/parserVersions';
import { isFontFileType, registerResourceFont } from '../services/fontRegistry';
import { warmUploadThumbnailVariants } from '../services/uploadThumbnailVariants';
import { applyClientUploadPreviewBodyToFile } from '../services/clientUploadPreview';
import {
  materializeClientParseAssistPreview,
  normalizeClientParseAssistFromBody,
  type ClientParseAssistSnapshot,
} from '../services/parser/clientParseAssist';
import { logger } from '../utils/logger';
import { exportPngToCmykPdf } from '../services/cmykPdfExport';

const TRASH_RETENTION_DAYS = 7;

// 「我的」个人文件数量上限：防止用户只增不删导致文件堆积。
// 仅统计未删除的个人文件；删除到回收站即释放名额。
const MY_FILES_LIMIT = 200;
const MY_FILES_LIMIT_MESSAGE = `「我的」文件已达上限 ${MY_FILES_LIMIT} 个，请先删除部分文件后再继续`;

export async function exportCmykPdf(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new AppError('CMYK 导出失败：没有收到画布 PNG', 400);
    }
    const pageWidth = Number(req.query.pageWidth);
    const pageHeight = Number(req.query.pageHeight);
    if (
      !Number.isFinite(pageWidth)
      || !Number.isFinite(pageHeight)
      || pageWidth < 1
      || pageHeight < 1
      || pageWidth > 100_000
      || pageHeight > 100_000
    ) {
      throw new AppError('CMYK 导出失败：页面尺寸无效', 400);
    }

    const result = await exportPngToCmykPdf({
      png: req.body,
      pageWidth,
      pageHeight,
      title: String(req.query.title || '设计稿').slice(0, 200),
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(result.pdf.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-CMYK-Profile', encodeURIComponent(result.profileLabel));
    res.send(result.pdf);
  } catch (error) {
    next(error);
  }
}

/** 统计某用户「我的」里的有效个人文件数量（不含回收站）。 */
async function countMyFiles(userId: number): Promise<number> {
  return DesignFile.count({
    where: { uploadedBy: userId, isPersonalCopy: true, isDeleted: false },
  });
}

function getFileType(filename: string): string {
  const ext = path.extname(filename).toLowerCase().slice(1);
  const map: Record<string, string> = { jpeg: 'jpg', ppt: 'pptx', psb: 'psd' };
  return map[ext] || ext;
}

const FILE_MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  psd: 'application/octet-stream',
  ai: 'application/octet-stream',
  pptx: 'application/octet-stream',
  ttf: 'font/ttf',
  otf: 'font/otf',
  ttc: 'font/collection',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

function getFileMimeType(fileType?: string | null) {
  return FILE_MIME_MAP[String(fileType || '').toLowerCase()] || 'application/octet-stream';
}

function getDownloadFilename(file: InstanceType<typeof DesignFile>) {
  return file.originalFilename || file.name || `file-${file.id}`;
}

function getContentDisposition(filename: string) {
  const asciiFallback = filename.replace(/[^\x20-\x7E]+/g, '_').replace(/["\\]/g, '_') || 'download';
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function parseRangeHeader(rangeHeader: string | undefined, fileSize: number) {
  if (!rangeHeader) return null;
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return 'invalid' as const;

  const [, startValue, endValue] = match;
  if (!startValue && !endValue) return 'invalid' as const;

  let start: number;
  let end: number;
  if (!startValue) {
    const suffixLength = Number(endValue);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return 'invalid' as const;
    start = Math.max(fileSize - suffixLength, 0);
    end = fileSize - 1;
  } else {
    start = Number(startValue);
    end = endValue ? Number(endValue) : fileSize - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= fileSize) {
    return 'invalid' as const;
  }

  return { start, end: Math.min(end, fileSize - 1) };
}

function parseIdList(value: unknown): number[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => Number(item)).filter((id) => Number.isInteger(id) && id > 0);
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parseIdList(parsed);
    } catch {
      return value.split(',').map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
    }
  }
  return [];
}

function getTrashExpireBefore() {
  return new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

async function destroyFileRecord(file: DesignFile) {
  await DesignFile.update(
    { sourceFileId: null },
    { where: { sourceFileId: file.id } },
  );
  await FileTag.destroy({ where: { fileId: file.id } });
  await FileCategory.destroy({ where: { fileId: file.id } });
  await FileVersion.destroy({ where: { fileId: file.id } });
  await ParsedLayer.destroy({ where: { fileId: file.id } });
  await file.destroy();
}

async function purgeExpiredTrash(uploadedBy?: number) {
  const where: any = {
    isDeleted: true,
    updatedAt: { [Op.lt]: getTrashExpireBefore() },
  };
  if (uploadedBy) where.uploadedBy = uploadedBy;

  const expiredFiles = await DesignFile.findAll({ where });
  for (const file of expiredFiles) {
    await destroyFileRecord(file);
  }
}

function canManageFileTrash(req: AuthRequest, file: DesignFile) {
  const role = req.user?.get('role') as { name?: string } | undefined;
  const roleName = role?.name;
  const isOwner = file.uploadedBy === req.user?.id;
  const canDeleteAll = roleName === 'admin' || req.userPermissions?.delete_files === true;
  const canDeleteOwnTemplate = roleName === 'designer' && isOwner;
  const canDeleteOwnPersonalCopy = file.isPersonalCopy && isOwner;
  return canDeleteAll || canDeleteOwnTemplate || canDeleteOwnPersonalCopy;
}

function getBatchFileIds(value: unknown) {
  const ids = Array.from(new Set(parseIdList(value)));
  if (ids.length === 0) {
    throw new AppError('No files selected', 400);
  }
  return ids;
}

function assertCanManageFiles(req: AuthRequest, files: DesignFile[]) {
  const denied = files.find((file) => !canManageFileTrash(req, file));
  if (denied) {
    throw new AppError('Permission denied', 403);
  }
}

async function getCategoryGroupFileIds(
  categoryIds: number[],
  libraryId?: number | null,
) {
  const categories = await Category.findAll({
    where: { id: { [Op.in]: categoryIds } },
    attributes: ['id', 'name', 'parentId', 'libraryId'],
  }) as Category[];

  const assignmentRows = await FileCategory.findAll({
    attributes: ['fileId'],
    where: { categoryId: { [Op.in]: categoryIds } },
    raw: true,
  }) as unknown as Array<{ fileId: number }>;
  const assignedFileIds = Array.from(new Set(
    assignmentRows
      .map((row) => Number(row.fileId))
      .filter((id) => Number.isInteger(id) && id > 0),
  ));

  const legacyFileIds = await getLegacyCategoryTagFileIds(categories, libraryId);
  const matchedIds = Array.from(new Set([...assignedFileIds, ...legacyFileIds]));

  const where: any = {
    isDeleted: false,
    [Op.or]: [
      { categoryId: { [Op.in]: categoryIds } },
      ...(matchedIds.length > 0 ? [{ id: { [Op.in]: matchedIds } }] : []),
    ],
  };
  if (libraryId !== undefined && libraryId !== null) where.libraryId = libraryId;

  const rows = await DesignFile.findAll({
    attributes: ['id'],
    where,
    raw: true,
  });

  return new Set(
    rows
      .map((row) => Number(row.id))
      .filter((id) => Number.isInteger(id) && id > 0),
  );
}

async function getLegacyCategoryTagFileIds(categories: Category[], libraryId?: number | null) {
  const rules = categories
    .map((category) => ({ categoryId: category.id, names: [category.name].filter(Boolean) }))
    .filter((rule) => rule.names.length > 0);

  const tagNames = Array.from(new Set(rules.flatMap((rule) => rule.names)));
  if (tagNames.length === 0) return [];

  const sameNameCategories = await Category.findAll({
    where: {
      name: { [Op.in]: tagNames },
      dimension: { [Op.ne]: null },
      ...(libraryId !== undefined && libraryId !== null ? { libraryId } : {}),
    },
    attributes: ['id', 'name'],
    raw: true,
  }) as unknown as Array<{ id: number; name: string }>;
  const sameNameCategoryIdsByName = new Map<string, Set<number>>();
  sameNameCategories.forEach((category) => {
    if (!sameNameCategoryIdsByName.has(category.name)) sameNameCategoryIdsByName.set(category.name, new Set<number>());
    sameNameCategoryIdsByName.get(category.name)!.add(Number(category.id));
  });
  const sameNameCategoryIds = Array.from(new Set(sameNameCategories.map((category) => Number(category.id))));

  const tags = await Tag.findAll({
    where: { name: { [Op.in]: tagNames } },
    attributes: ['id', 'name'],
    raw: true,
  }) as unknown as Array<{ id: number; name: string }>;
  if (tags.length === 0) return [];

  const tagNameById = new Map(tags.map((tag) => [Number(tag.id), tag.name]));
  const fileTags = await FileTag.findAll({
    where: { tagId: { [Op.in]: tags.map((tag) => tag.id) } },
    attributes: ['fileId', 'tagId'],
    raw: true,
  }) as unknown as Array<{ fileId: number; tagId: number }>;
  const taggedFileIds = Array.from(new Set(
    fileTags
      .map((row) => Number(row.fileId))
      .filter((id) => Number.isInteger(id) && id > 0),
  ));
  if (taggedFileIds.length === 0) return [];

  const fileWhere: any = {
    id: { [Op.in]: taggedFileIds },
    isDeleted: false,
  };
  if (libraryId !== undefined && libraryId !== null) fileWhere.libraryId = libraryId;

  const validFiles = await DesignFile.findAll({
    attributes: ['id', 'categoryId'],
    where: fileWhere,
    raw: true,
  }) as unknown as Array<{ id: number; categoryId: number | null }>;
  const validFileIds = new Set(validFiles.map((file) => Number(file.id)));
  if (validFileIds.size === 0) return [];

  const structuredCategoryIdsByFileId = new Map<number, Set<number>>();
  validFiles.forEach((file) => {
    const categoryId = Number(file.categoryId);
    if (!Number.isInteger(categoryId) || categoryId <= 0) return;
    structuredCategoryIdsByFileId.set(Number(file.id), new Set([categoryId]));
  });

  if (sameNameCategoryIds.length > 0) {
    const categoryRows = await FileCategory.findAll({
      attributes: ['fileId', 'categoryId'],
      where: {
        fileId: { [Op.in]: Array.from(validFileIds) },
        categoryId: { [Op.in]: sameNameCategoryIds },
      },
      raw: true,
    }) as unknown as Array<{ fileId: number; categoryId: number }>;
    categoryRows.forEach((row) => {
      const fileId = Number(row.fileId);
      const categoryId = Number(row.categoryId);
      if (!structuredCategoryIdsByFileId.has(fileId)) structuredCategoryIdsByFileId.set(fileId, new Set<number>());
      structuredCategoryIdsByFileId.get(fileId)!.add(categoryId);
    });
  }

  const namesByFileId = new Map<number, Set<string>>();
  for (const row of fileTags) {
    if (!validFileIds.has(Number(row.fileId))) continue;
    const name = tagNameById.get(Number(row.tagId));
    if (!name) continue;
    const fileId = Number(row.fileId);
    if (!namesByFileId.has(fileId)) namesByFileId.set(fileId, new Set<string>());
    namesByFileId.get(fileId)!.add(name);
  }

  const matchedIds: number[] = [];
  namesByFileId.forEach((names, fileId) => {
    if (rules.some((rule) => {
      if (!rule.names.every((name) => names.has(name))) return false;
      const categoryName = rule.names[0];
      const sameNameIds = sameNameCategoryIdsByName.get(categoryName) || new Set<number>();
      const structuredIds = structuredCategoryIdsByFileId.get(fileId) || new Set<number>();
      const hasOtherSameNameCategory = Array.from(structuredIds).some((id) => sameNameIds.has(id) && id !== rule.categoryId);
      return !hasOtherSameNameCategory;
    })) {
      matchedIds.push(fileId);
    }
  });

  return matchedIds;
}

async function getCategoryMatchedFileIds(categoryIds: number[], libraryId?: number | null) {
  const categories = await Category.findAll({ where: { id: { [Op.in]: categoryIds } } });
  const idsByDimension = new Map<string, number[]>();

  for (const category of categories) {
    const key = category.dimension || `category-${category.id}`;
    const ids = idsByDimension.get(key) || [];
    ids.push(category.id);
    idsByDimension.set(key, ids);
  }

  let matchedFileIds: Set<number> | null = null;
  for (const ids of idsByDimension.values()) {
    const groupFileIds = await getCategoryGroupFileIds(ids, libraryId);
    if (matchedFileIds === null) {
      matchedFileIds = groupFileIds;
    } else {
      const previousIds: number[] = Array.from(matchedFileIds as Set<number>);
      matchedFileIds = new Set<number>(previousIds.filter((id: number) => groupFileIds.has(id)));
    }
    if (matchedFileIds.size === 0) break;
  }

  return [...(matchedFileIds || new Set<number>())];
}

async function expandCategoryIdsWithDescendants(categoryIds: number[], libraryId?: number | null) {
  const uniqueIds = Array.from(new Set(categoryIds.filter((id) => Number.isInteger(id) && id > 0)));
  if (uniqueIds.length === 0) return [];

  const where: any = {};
  if (libraryId !== undefined && libraryId !== null) where.libraryId = libraryId;
  const categories = await Category.findAll({
    where,
    attributes: ['id', 'parentId'],
    raw: true,
  }) as unknown as Array<{ id: number; parentId: number | null }>;

  const childrenByParent = new Map<number, number[]>();
  categories.forEach((category) => {
    if (category.parentId == null) return;
    childrenByParent.set(category.parentId, [...(childrenByParent.get(category.parentId) || []), category.id]);
  });

  const result = new Set(uniqueIds);
  const stack = [...uniqueIds];
  while (stack.length > 0) {
    const currentId = stack.pop()!;
    for (const childId of childrenByParent.get(currentId) || []) {
      if (result.has(childId)) continue;
      result.add(childId);
      stack.push(childId);
    }
  }

  return Array.from(result);
}

async function ensureCategoriesInLibrary(libraryId: number | null, categoryIds: number[]) {
  const uniqueIds = Array.from(new Set(categoryIds.filter((id) => Number.isInteger(id) && id > 0)));
  if (uniqueIds.length === 0) return;
  if (!libraryId) throw new AppError('Please select a library before selecting categories', 400);

  const count = await Category.count({
    where: {
      id: { [Op.in]: uniqueIds },
      libraryId,
    },
  });

  if (count !== uniqueIds.length) {
    throw new AppError('Selected categories do not belong to this library', 400);
  }
}

async function syncFileCategoryAssignments(
  fileId: number,
  categoryIds: number[],
  libraryId: number | null,
  scopedCategories?: Category[],
) {
  const uniqueIds = Array.from(new Set(categoryIds.filter((id) => Number.isInteger(id) && id > 0)));
  await ensureCategoriesInLibrary(libraryId, uniqueIds);

  const allCategories = scopedCategories || await Category.findAll({
    where: {
      dimension: { [Op.ne]: null },
      libraryId: libraryId ?? null,
    },
  });
  const allCategoryIds = allCategories.map((cat) => cat.id);
  if (allCategoryIds.length > 0) {
    await FileCategory.destroy({ where: { fileId, categoryId: { [Op.in]: allCategoryIds } } });
  }

  if (uniqueIds.length === 0) return;

  const selectedCategories = allCategories.filter((cat) => uniqueIds.includes(cat.id));
  for (const cat of selectedCategories) {
    await FileCategory.findOrCreate({ where: { fileId, categoryId: cat.id } });
  }
}

async function syncCategoryTags(fileId: number, categoryIds: number[], libraryId: number | null) {
  const uniqueIds = Array.from(new Set(categoryIds.filter((id) => Number.isInteger(id) && id > 0)));
  await ensureCategoriesInLibrary(libraryId, uniqueIds);

  const allCategories = await Category.findAll({
    where: {
      dimension: { [Op.ne]: null },
      libraryId: libraryId ?? null,
    },
  });
  await syncFileCategoryAssignments(fileId, uniqueIds, libraryId, allCategories as Category[]);
  const categoryNames = Array.from(new Set(allCategories.map((cat) => cat.name).filter(Boolean)));

  if (categoryNames.length > 0) {
    const existingCategoryTags = await Tag.findAll({ where: { name: { [Op.in]: categoryNames } } });
    const tagIdsToClear = existingCategoryTags.map((tag) => tag.id);
    if (tagIdsToClear.length > 0) {
      await FileTag.destroy({ where: { fileId, tagId: { [Op.in]: tagIdsToClear } } });
    }
  }

  if (uniqueIds.length === 0) return;

  const selectedCategories = allCategories.filter((cat) => uniqueIds.includes(cat.id));
  for (const cat of selectedCategories) {
    const [tag] = await Tag.findOrCreate({
      where: { name: cat.name },
      defaults: { name: cat.name, color: '#1A6B6B' },
    });
    await FileTag.findOrCreate({ where: { fileId, tagId: tag.id } });
  }
}

function fileIncludes() {
  return [
    { model: User, as: 'uploader', attributes: ['id', 'displayName'] },
    { model: Library, as: 'library', attributes: ['id', 'name'] },
    { model: Category, as: 'category' },
    { model: Category, as: 'categoryAssignments', attributes: ['id', 'name', 'parentId', 'dimension', 'libraryId'], through: { attributes: [] } },
    { model: Tag, as: 'tags', through: { attributes: [] } },
  ];
}

async function cloneParsedLayers(sourceFileId: number, targetFileId: number, transaction?: Transaction) {
  const layers = await ParsedLayer.findAll({
    where: { fileId: sourceFileId },
    order: [['sort_order', 'ASC'], ['id', 'ASC']],
    transaction,
  });
  const idMap = new Map<number, number>();
  const pending = [...layers];

  while (pending.length > 0) {
    let progressed = false;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const layer = pending[i];
      if (layer.parentLayerId && !idMap.has(layer.parentLayerId)) continue;
      const clone = await ParsedLayer.create({
        fileId: targetFileId,
        layerName: layer.layerName,
        layerType: layer.layerType,
        parentLayerId: layer.parentLayerId ? idMap.get(layer.parentLayerId) || null : null,
        sortOrder: layer.sortOrder,
        visible: layer.visible,
        opacity: layer.opacity,
        blendMode: layer.blendMode,
        x: layer.x,
        y: layer.y,
        width: layer.width,
        height: layer.height,
        imagePath: layer.imagePath,
        textContent: layer.textContent,
        textStyle: layer.textStyle,
        properties: layer.properties,
      }, { transaction });
      idMap.set(layer.id, clone.id);
      pending.splice(i, 1);
      progressed = true;
    }
    if (!progressed) throw new AppError('源图层包含无效父子关系，请重新解析', 409);
  }
}

function readParserVersion(file: DesignFile, key: string): number {
  const parseResult = file.parseResult as Record<string, unknown> | null | undefined;
  const value = Number(parseResult?.[key]);
  return Number.isFinite(value) ? value : 0;
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function getParserVersionKey(fileType: string): string | null {
  if (fileType === 'pdf') return 'pdfParserVersion';
  if (fileType === 'ai') return 'aiParserVersion';
  if (fileType === 'psd') return 'psdParserVersion';
  return null;
}

function shouldRefreshPersonalCopyParsedContent(source: DesignFile, copy: DesignFile) {
  if (source.parseStatus !== 'completed') return false;
  if (source.fileType !== copy.fileType) return false;
  const parserVersionKey = getParserVersionKey(source.fileType);
  if (parserVersionKey && readParserVersion(source, parserVersionKey) !== readParserVersion(copy, parserVersionKey)) {
    return true;
  }
  return (
    copy.parseStatus !== source.parseStatus
    || copy.thumbnailPath !== source.thumbnailPath
    || copy.width !== source.width
    || copy.height !== source.height
    || stableJson(copy.parseResult) !== stableJson(source.parseResult)
  );
}

async function refreshPersonalCopyParsedContent(source: DesignFile, copy: DesignFile) {
  if (source.parseStatus !== 'completed' || source.fileType !== copy.fileType) return;
  if (!shouldRefreshPersonalCopyParsedContent(source, copy)) {
    if (await ParsedLayer.findOne({ where: { fileId: copy.id }, attributes: ['id'] })) return;
    if (!await ParsedLayer.findOne({ where: { fileId: source.id }, attributes: ['id'] })) return;
  }
  await sequelize.transaction(async (transaction) => {
    // Publication locks the source first. Clone rows and metadata from that same locked generation.
    const lockedSource = await DesignFile.findByPk(source.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!lockedSource || lockedSource.isDeleted || lockedSource.parseStatus !== 'completed'
        || lockedSource.fileType !== copy.fileType) return;
    const lockedCopy = await DesignFile.findByPk(copy.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!lockedCopy || lockedCopy.isDeleted || !lockedCopy.isPersonalCopy || lockedCopy.sourceFileId !== source.id) return;
    if (!shouldRefreshPersonalCopyParsedContent(lockedSource, lockedCopy)) {
      if (await ParsedLayer.findOne({ where: { fileId: lockedCopy.id }, attributes: ['id'], transaction })) return;
      if (!await ParsedLayer.findOne({ where: { fileId: lockedSource.id }, attributes: ['id'], transaction })) return;
    }
    await ParsedLayer.destroy({ where: { fileId: lockedCopy.id }, transaction });
    await cloneParsedLayers(lockedSource.id, lockedCopy.id, transaction);
    await lockedCopy.update({
      thumbnailPath: lockedSource.thumbnailPath,
      width: lockedSource.width,
      height: lockedSource.height,
      parseStatus: lockedSource.parseStatus,
      parseResult: lockedSource.parseResult,
    }, { transaction });
  });
  await copy.reload();
}

function getCurrentParserVersion(fileType: string): { key: string; version: number } | null {
  if (fileType === 'pdf') return { key: 'pdfParserVersion', version: PDF_PARSER_VERSION };
  if (fileType === 'ai') return { key: 'aiParserVersion', version: AI_PARSER_VERSION };
  if (fileType === 'psd') return { key: 'psdParserVersion', version: PSD_PARSER_VERSION };
  return null;
}

async function isStaleParsedContent(file: DesignFile) {
  const current = getCurrentParserVersion(file.fileType);
  if (!current || file.parseStatus !== 'completed') return false;
  if (readParserVersion(file, current.key) < current.version) return true;
  return ['pdf', 'ai'].includes(file.fileType) && !await hasUsablePdfResources(file.parseResult);
}

async function localParsedAsset(value: unknown, relativeDirectory = STORAGE.base): Promise<string | null> {
  if (typeof value !== 'string' || !value.trim() || /[\0?#]/.test(value) || /^[a-z]+:\/\//i.test(value)) return null;
  try {
    let relative = decodeURIComponent(value);
    if (relative.startsWith('/uploads/')) { relative = relative.slice('/uploads/'.length); relativeDirectory = STORAGE.base; }
    else if (relative.startsWith('uploads/')) { relative = relative.slice('uploads/'.length); relativeDirectory = STORAGE.base; }
    const absolute = path.resolve(relativeDirectory, relative);
    const within = path.relative(STORAGE.base, absolute);
    if (!within || within.startsWith('..') || path.isAbsolute(within)) return null;
    const [root, real] = await Promise.all([fs.promises.realpath(STORAGE.base), fs.promises.realpath(absolute)]);
    const realWithin = path.relative(root, real);
    if (!realWithin || realWithin.startsWith('..') || path.isAbsolute(realWithin)) return null;
    const stat = await fs.promises.stat(real);
    return stat.isFile() && stat.size > 0 && stat.size <= 64 * 1024 * 1024 ? real : null;
  } catch { return null; }
}

const parsedImageHealthCache = new Map<string, string>();
async function usableParsedImage(value: unknown, relativeDirectory = STORAGE.base): Promise<boolean> {
  const asset = await localParsedAsset(value, relativeDirectory);
  if (!asset) return false;
  try {
    const stat = await fs.promises.stat(asset);
    const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (parsedImageHealthCache.get(asset) === stamp) return true;
    const metadata = await sharp(asset, { limitInputPixels: 32_000_000, failOn: 'warning' }).metadata();
    if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp'].includes(metadata.format || '')) return false;
    await sharp(asset, { limitInputPixels: 32_000_000, failOn: 'warning' }).stats();
    if (parsedImageHealthCache.size >= 128) parsedImageHealthCache.delete(parsedImageHealthCache.keys().next().value!);
    parsedImageHealthCache.set(asset, stamp);
    return true;
  } catch { return false; }
}

type ParsedSvgNode = { name: string; attributes: Record<string, string>; children: ParsedSvgNode[]; text: string };
function importableSvgPath(data: string): boolean {
  if (!/^\s*m/i.test(data) || /[^mlhvcsqtaez0-9\s,.+\-]/i.test(data)) return false;
  const arities: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
  let draws = false;
  for (const block of data.match(/[mlhvcsqtaz][^mlhvcsqtaz]*/gi) || []) {
    const command = block[0].toLowerCase();
    const body = block.slice(1);
    const numbers = body.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi) || [];
    if (body.replace(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi, '').replace(/[\s,]/g, '')
      || numbers.some(value => !Number.isFinite(Number(value)))) return false;
    const arity = arities[command];
    if (arity === 0 ? numbers.length !== 0 : numbers.length === 0 || numbers.length % arity !== 0) return false;
    if (command !== 'm' && command !== 'z' || command === 'm' && numbers.length > 2) draws = true;
  }
  return draws;
}
async function usableParsedSvg(value: unknown): Promise<boolean> {
  const asset = await localParsedAsset(value);
  if (!asset) return false;
  try {
    const xml = await fs.promises.readFile(asset, 'utf8');
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return false;
    const stack: ParsedSvgNode[] = [];
    const ids = new Map<string, ParsedSvgNode>();
    let root: ParsedSvgNode | undefined;
    let count = 0;
    const parser = new SaxesParser({ xmlns: false });
    parser.on('opentag', tag => {
      if (++count > 100_000 || stack.length >= 128) throw new Error('SVG exceeds import limits');
      const node: ParsedSvgNode = { name: tag.name.split(':').pop()!.toLowerCase(), attributes: tag.attributes as Record<string, string>, children: [], text: '' };
      if (stack.length) stack[stack.length - 1].children.push(node);
      else if (root) throw new Error('Multiple SVG roots');
      else root = node;
      if (node.attributes.id) {
        if (ids.has(node.attributes.id)) throw new Error('Duplicate SVG id');
        ids.set(node.attributes.id, node);
      }
      stack.push(node);
    });
    parser.on('text', text => { if (stack.length) stack[stack.length - 1].text += text; });
    parser.on('closetag', () => { stack.pop(); });
    parser.write(xml).close();
    if (!root || root.name !== 'svg') return false;
    const images: string[] = [];
    let visits = 0;
    const visit = (node: ParsedSvgNode, active = new Set<string>(), referenced = false): number => {
      if (++visits > 100_000) throw new Error('SVG references exceed import limits');
      if (['defs', 'pattern', 'clippath', 'mask', 'metadata', 'title', 'desc', 'script', 'foreignobject'].includes(node.name)
        || node.name === 'symbol' && !referenced
        || ['mask-artifact', 'raster-reconstruction-strip', 'visual-raster', 'preview-fallback'].includes(node.attributes['data-object-role'])
        || node.attributes['data-pdf-mask-artifact'] === 'true') return 0;
      if (node.name === 'use') {
        const href = node.attributes.href || node.attributes['xlink:href'] || '';
        if (!href.startsWith('#') || !ids.has(href.slice(1)) || active.has(href) || active.size >= 64) throw new Error('Invalid SVG reference');
        return visit(ids.get(href.slice(1))!, new Set([...active, href]), true);
      }
      const positive = (key: string) => Number.isFinite(Number.parseFloat(node.attributes[key])) && Number.parseFloat(node.attributes[key]) > 0;
      let drawings = 0;
      if (node.name === 'path' && importableSvgPath(node.attributes.d || '')) drawings++;
      else if (node.name === 'rect' && positive('width') && positive('height')) drawings++;
      else if (node.name === 'circle' && positive('r')) drawings++;
      else if (node.name === 'ellipse' && positive('rx') && positive('ry')) drawings++;
      else if (['polygon', 'polyline'].includes(node.name)) {
        const points = (node.attributes.points || '').trim().split(/[\s,]+/).map(Number);
        if (points.length >= (node.name === 'polygon' ? 6 : 4) && points.length % 2 === 0 && points.every(Number.isFinite)) drawings++;
      } else if (node.name === 'line') {
        const points = ['x1', 'y1', 'x2', 'y2'].map(key => Number(node.attributes[key] || 0));
        if (points.every(Number.isFinite) && (points[0] !== points[2] || points[1] !== points[3])) drawings++;
      }
      else if (node.name === 'text' && (node.text.trim() || node.children.some(child => child.text.trim()))) drawings++;
      else if (node.name === 'image' && positive('width') && positive('height')) {
        images.push(node.attributes.href || node.attributes['xlink:href'] || '');
        drawings++;
      }
      return drawings + node.children.reduce((sum, child) => sum + visit(child, active), 0);
    };
    if (visit(root) === 0) return false;
    for (const image of new Set(images)) {
      if (/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(image)) {
        const buffer = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
        const metadata = await sharp(buffer, { limitInputPixels: 32_000_000, failOn: 'warning' }).metadata();
        if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp'].includes(metadata.format || '')) return false;
        await sharp(buffer, { limitInputPixels: 32_000_000, failOn: 'warning' }).stats();
      } else if (!await usableParsedImage(image, image.startsWith('/uploads/') ? STORAGE.base : path.dirname(asset))) return false;
    }
    return true;
  } catch { return false; }
}

async function hasUsablePdfResources(parseResult: Record<string, unknown> | null | undefined): Promise<boolean> {
  if (!parseResult) return false;
  const pages = Array.isArray(parseResult.pages) && parseResult.pages.length ? parseResult.pages : [parseResult];
  if (Number(parseResult.pageCount) > pages.length) return false;
  for (const raw of pages) {
    if (!raw || typeof raw !== 'object') return false;
    const page = raw as Record<string, unknown>;
    // A completed current preview is a deliberate fidelity fallback, not a retry request.
    const previewOnly = page.previewOnly === true || parseResult.previewOnly === true
      || !page.svgPath && parseResult.editableSvg === false && Number(page.previewLayerCount || parseResult.previewLayerCount) > 0;
    if (previewOnly ? !await usableParsedImage(page.previewPath) : !await usableParsedSvg(page.svgPath)) return false;
  }
  return true;
}

function isParseInFlight(file: DesignFile) {
  return file.parseStatus === 'pending' || file.parseStatus === 'parsing';
}

async function queueSourceParseForPersonalCopy(
  source: DesignFile,
  copy: DesignFile,
  options: { force?: boolean; clientAssistSnapshot?: ClientParseAssistSnapshot | null } = {},
) {
  if (!getCurrentParserVersion(source.fileType)) return false;
  if (!options.force && copy.parseStatus === 'failed') return false;
  if (!options.force && source.parseStatus === 'failed') {
    if (isParseInFlight(copy)) {
      const previous = copy.parseResult;
      const retained = previous && (!previous.error || previous.hasRetainedResult === true) ? previous : null;
      const failure: Record<string, unknown> = { error: source.parseResult?.error || '源文件解析失败' };
      const version = getCurrentParserVersion(copy.fileType);
      if (version) failure[version.key] = version.version;
      await copy.update({
        parseStatus: 'failed',
        parseResult: { ...failure, ...(retained || {}), error: failure.error,
          ...(retained ? { hasRetainedResult: true, lastParseAttempt: failure } : {}) },
      });
    }
    return false;
  }
  const sourceInFlight = isParseInFlight(source);
  const sourceIsStale = await isStaleParsedContent(source);
  const sourceQueuePhase = getParseQueuePhase(source.id);
  const needsSourceParse = options.force || sourceInFlight || sourceIsStale
    || sourceQueuePhase === 'queued' || sourceQueuePhase === 'parsing';

  if (!needsSourceParse) {
    await refreshPersonalCopyParsedContent(source, copy);
    return false;
  }

  // Reparse only the copy that initiated this lazy update. Existing personal copies
  // keep both their parsed snapshot and historical editor state until opened directly.
  await enqueueParse(source.id, {
    priority: 'interactive',
    resetSource: !sourceInFlight,
    preserveEditorState: Boolean(source.isPersonalCopy),
    syncPersonalCopyIds: [copy.id],
    syncAllPersonalCopies: false,
    clientAssistSnapshot: options.clientAssistSnapshot,
    allowClientAssistWait: true,
  });
  return true;
}

async function queueStandaloneParse(
  file: DesignFile,
  options: { clientAssistSnapshot?: ClientParseAssistSnapshot | null; syncAllPersonalCopies?: boolean } = {},
) {
  await enqueueParse(file.id, {
    priority: 'interactive',
    resetSource: true,
    preserveEditorState: Boolean(file.isPersonalCopy),
    clientAssistSnapshot: options.clientAssistSnapshot,
    allowClientAssistWait: true,
    syncAllPersonalCopies: options.syncAllPersonalCopies,
  });
}

async function submitParseAssistForFile(file: DesignFile, userId: number, clientAssistSnapshot: ClientParseAssistSnapshot | null) {
  if (!clientAssistSnapshot || !getCurrentParserVersion(file.fileType)) return false;

  if (file.isPersonalCopy) {
    if (!file.sourceFileId) {
      if (await isStaleParsedContent(file) || isParseInFlight(file)) {
        await queueStandaloneParse(file, { clientAssistSnapshot });
        return true;
      }
      return false;
    }

    const source = await DesignFile.findByPk(file.sourceFileId);
    if (!source || source.isDeleted) return false;
    return queueSourceParseForPersonalCopy(source, file, { clientAssistSnapshot });
  }

  const personalCopy = await DesignFile.findOne({
    where: {
      sourceFileId: file.id,
      uploadedBy: userId,
      isPersonalCopy: true,
      isDeleted: false,
    },
    order: [['updated_at', 'DESC']],
  });

  if (personalCopy) {
    return queueSourceParseForPersonalCopy(file, personalCopy, { clientAssistSnapshot });
  }

  return false;
}

export async function upload(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new AppError('未上传文件', 400);

    const file = req.file;
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const fileType = getFileType(originalName);
    const name = path.basename(originalName, path.extname(originalName));
    const rawLibraryId = req.body.libraryId;
    const hasLibraryId = rawLibraryId !== undefined
      && rawLibraryId !== null
      && String(rawLibraryId).trim() !== '';
    const libraryId = hasLibraryId ? Number(rawLibraryId) : null;
    const isPersonalUpload = !hasLibraryId && req.body.storageScope === 'my';

    if (!isPersonalUpload && req.userPermissions?.upload !== true) {
      await fs.promises.unlink(file.path).catch(() => {});
      throw new AppError('权限不足', 403);
    }

    // 个人上传也计入「我的」上限；超限时清理已落盘的临时文件后拒绝
    if (isPersonalUpload && (await countMyFiles(req.user!.id)) >= MY_FILES_LIMIT) {
      await fs.promises.unlink(file.path).catch(() => {});
      throw new AppError(MY_FILES_LIMIT_MESSAGE, 409);
    }

    if (libraryId) {
      const library = await Library.findByPk(libraryId);
      if (!library || library.isDeleted) throw new AppError('资源库不存在', 400);
    }

    const categoryTagIds = parseIdList(req.body.categoryTagIds);
    const primaryCategoryId = req.body.categoryId
      ? Number(req.body.categoryId)
      : categoryTagIds[0] || null;
    const assignedCategoryIds = categoryTagIds.length > 0
      ? categoryTagIds
      : (primaryCategoryId ? [primaryCategoryId] : []);

    await ensureCategoriesInLibrary(libraryId, Array.from(new Set([primaryCategoryId, ...assignedCategoryIds].filter(Boolean) as number[])));

    const fontMeta = isFontFileType(fileType)
      ? registerResourceFont({ ...file, originalname: originalName })
      : null;

    const designFile = await DesignFile.create({
      name,
      originalFilename: originalName,
      fileType,
      filePath: file.path.replace(/\\/g, '/'),
      fileSize: file.size,
      libraryId,
      categoryId: primaryCategoryId,
      isPersonalCopy: isPersonalUpload,
      uploadedBy: req.user!.id,
      parseStatus: fontMeta ? 'completed' : 'pending',
      parseResult: fontMeta ? { type: 'font', font: fontMeta } : null,
    });

    for (const tagId of parseIdList(req.body.tagIds)) {
      await FileTag.findOrCreate({ where: { fileId: designFile.id, tagId } });
    }

    await syncCategoryTags(designFile.id, assignedCategoryIds, libraryId);

    const clientThumbnailApplied = await applyClientUploadPreviewBodyToFile(designFile, req.body);
    const clientAssistSnapshot = await materializeClientParseAssistPreview(
      designFile.id,
      normalizeClientParseAssistFromBody(req.body, { fileType, fileName: originalName }),
    );

    if (['png', 'jpg', 'svg', 'gif', 'webp'].includes(fileType)) {
      try {
        const sharp = require('sharp');
        const thumbFilename = `${designFile.id}_thumb.png`;
        if (!clientThumbnailApplied) {
          const thumbPath = path.join(STORAGE.thumbnails, thumbFilename);

          await sharp(file.path)
            .resize(400, 300, { fit: 'inside', withoutEnlargement: true })
            .png()
            .toFile(thumbPath);
        }

        const meta = await sharp(file.path).metadata();
        await designFile.update({
          thumbnailPath: `thumbnails/${thumbFilename}`,
          width: meta.width || null,
          height: meta.height || null,
          parseStatus: 'completed',
        });
        if (!clientThumbnailApplied) warmUploadThumbnailVariants(`thumbnails/${thumbFilename}`);
      } catch {
        // Keep the original file even if thumbnail generation fails.
      }
    }

    if (['psd', 'ai', 'pdf'].includes(fileType)) {
      enqueueParse(designFile.id, { clientAssistSnapshot, priority: 'interactive' });
    }

    const result = await DesignFile.findByPk(designFile.id, { include: fileIncludes() });
    logger.info(
      {
        scope: 'audit',
        action: 'file.upload',
        userId: req.user!.id,
        fileId: designFile.id,
        name,
        fileType,
        size: file.size,
        libraryId,
      },
      'audit: file uploaded'
    );
    res.status(201).json({ code: 201, message: '上传成功', data: result });
  } catch (err) {
    next(err);
  }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const {
      page = '1',
      pageSize = '20',
      keyword,
      libraryId,
      categoryId,
      categoryIds,
      includeChildren,
      uncategorized,
      fileType,
      tagIds,
      scope,
      myView,
      includePersonal,
      sortBy = 'created_at',
      sortOrder = 'desc',
    } = req.query;

    const pageNum = Number(page);
    const size = Number(pageSize);
    const offset = (pageNum - 1) * size;
    const scopeValue = typeof scope === 'string' ? scope : '';
    const myViewValue = typeof myView === 'string' ? myView : 'space';
    const where: any = {};
    await purgeExpiredTrash(scopeValue === 'my' ? (req as AuthRequest).user!.id : undefined);

    if (scopeValue === 'my') {
      where.uploadedBy = (req as AuthRequest).user!.id;
      where.isPersonalCopy = true;
      where.isDeleted = myViewValue === 'trash';
      if (myViewValue === 'favorites') where.isFavorite = true;
      if (myViewValue === 'drafts') where.isDraft = true;
      if (myViewValue === 'shares') where.isShared = true;
      if (myViewValue === 'publish') where.isPublished = true;
    } else {
      where.isDeleted = false;
    }

    if (scopeValue !== 'my' && includePersonal !== 'true') {
      where.isPersonalCopy = false;
    }

    if (keyword) {
      where[Op.or] = [
        { name: { [Op.like]: `%${keyword}%` } },
        { originalFilename: { [Op.like]: `%${keyword}%` } },
      ];
    }

    if (libraryId) where.libraryId = Number(libraryId);

    if (uncategorized === 'true') {
      where.categoryId = null;
    }

    const libraryFilterId = libraryId ? Number(libraryId) : undefined;
    const shouldIncludeChildren = includeChildren === 'true';
    const parsedCategoryIds = shouldIncludeChildren
      ? await expandCategoryIdsWithDescendants(parseIdList(categoryIds), libraryFilterId)
      : parseIdList(categoryIds);

    // 关键：所有按关联表过滤的条件都预查成 file id 集合并合并到 where.id，
    // 这样第 1 步分页查询的 where 不含任何 JOIN 列引用，可以裸查主表，
    // LIMIT 干净地套在 design_files 上，不会被 hasMany 关联的笛卡尔积截断。
    if (parsedCategoryIds.length > 0) {
      const matchedFileIds = await getCategoryMatchedFileIds(parsedCategoryIds, libraryFilterId);
      where.id = { [Op.in]: matchedFileIds.length > 0 ? matchedFileIds : [0] };
    } else if (categoryId) {
      const parsedCategoryId = Number(categoryId);
      if (!Number.isNaN(parsedCategoryId)) {
        const filterCategoryIds = shouldIncludeChildren
          ? await expandCategoryIdsWithDescendants([parsedCategoryId], libraryFilterId)
          : [parsedCategoryId];
        const matchedFileIds = await getCategoryMatchedFileIds(filterCategoryIds, libraryFilterId);
        where.id = { [Op.in]: matchedFileIds.length > 0 ? matchedFileIds : [0] };
      }
    }

    if (fileType) where.fileType = fileType;

    const parsedTagIds = typeof tagIds === 'string'
      ? tagIds.split(',').map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
      : [];

    if (parsedTagIds.length > 0) {
      const tagRows = await FileTag.findAll({
        where: { tagId: { [Op.in]: parsedTagIds } },
        attributes: ['fileId'],
        raw: true,
      });
      const tagMatchedIds = Array.from(new Set(tagRows.map((r: any) => Number(r.fileId))));
      const existingIdFilter = (where.id as any)?.[Op.in] as number[] | undefined;
      const finalIds = existingIdFilter
        ? existingIdFilter.filter((id) => tagMatchedIds.includes(id))
        : tagMatchedIds;
      where.id = { [Op.in]: finalIds.length > 0 ? finalIds : [0] };
    }

    const include = [
      { model: User, as: 'uploader', attributes: ['id', 'displayName'] },
      { model: Library, as: 'library', attributes: ['id', 'name'] },
      { model: Category, as: 'category', attributes: ['id', 'name'] },
      { model: Category, as: 'categoryAssignments', attributes: ['id', 'name', 'parentId', 'dimension', 'libraryId'], through: { attributes: [] } },
      { model: Tag, as: 'tags', attributes: ['id', 'name', 'color'], through: { attributes: [] } },
    ];

    const sortField = String(sortBy);
    const sortDirection = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const orderClause: any[] = [[sortField, sortDirection]];
    if (sortField !== 'id') orderClause.push(['id', sortDirection]);

    // 第 1 步：裸查主表 id，LIMIT 准确生效
    const { count, rows: idRows } = await DesignFile.findAndCountAll({
      where,
      attributes: ['id'],
      order: orderClause,
      limit: size,
      offset,
    });
    const pageIds = idRows.map((row) => row.id);

    // 第 2 步：按 id 集合带回完整关联（不带 limit，不会被 JOIN 笛卡尔积截断）
    const rows = pageIds.length === 0
      ? []
      : await DesignFile.findAll({
          where: { id: { [Op.in]: pageIds } },
          include,
          attributes: { exclude: ['editorState', 'parseResult'] },
          order: orderClause,
        });

    res.json({
      code: 200,
      message: '获取成功',
      data: {
        list: rows,
        pagination: { page: pageNum, pageSize: size, total: count },
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function useTemplate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const sourceId = Number(req.params.id);
    const requestedFile = await DesignFile.findByPk(sourceId);
    if (!requestedFile || requestedFile.isDeleted) throw new AppError('模板不存在', 404);
    if (requestedFile.isPersonalCopy && requestedFile.uploadedBy !== req.user!.id) {
      throw new AppError('无权使用此模板副本', 403);
    }

    // Calling use-template with an existing personal copy still means "create a new
    // work". Prefer its original source when available; opening an existing copy from
    // "My" never calls this endpoint and therefore keeps the same file id.
    let source = requestedFile;
    if (requestedFile.isPersonalCopy && requestedFile.sourceFileId) {
      const originalSource = await DesignFile.findByPk(requestedFile.sourceFileId);
      if (originalSource && !originalSource.isDeleted) source = originalSource;
    }

    if (source.parseStatus === 'failed') {
      throw new AppError('该模板解析失败，请先手动重新解析或重新上传', 409);
    }

    // 每次从模板入口使用资源都创建全新的个人副本；历史副本只从「我的」继续打开。
    if ((await countMyFiles(req.user!.id)) >= MY_FILES_LIMIT) {
      throw new AppError(MY_FILES_LIMIT_MESSAGE, 409);
    }

    let shouldQueueLazyParse = false;

    const personalCopy = await sequelize.transaction(async (transaction) => {
      const lockedSource = await DesignFile.findByPk(source.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!lockedSource || lockedSource.isDeleted) throw new AppError('模板不存在', 404);
      if (lockedSource.parseStatus === 'failed') throw new AppError('该模板解析失败，请先手动重新解析或重新上传', 409);
      source = lockedSource;
      shouldQueueLazyParse = Boolean(getCurrentParserVersion(source.fileType)
        && (await isStaleParsedContent(source) || isParseInFlight(source)));
      const created = await DesignFile.create({
        name: source.name,
        originalFilename: source.originalFilename,
        fileType: source.fileType,
        filePath: source.filePath,
        thumbnailPath: source.thumbnailPath,
        fileSize: source.fileSize,
        width: source.width,
        height: source.height,
        libraryId: source.libraryId,
        categoryId: source.categoryId,
        sourceFileId: source.id,
        isPersonalCopy: true,
        uploadedBy: req.user!.id,
        parseStatus: shouldQueueLazyParse ? 'pending' : source.parseStatus,
        parseResult: source.parseResult,
        editorState: null,
      }, { transaction });

      const tags = await FileTag.findAll({ where: { fileId: source.id }, transaction });
      await Promise.all(tags.map((tag) => FileTag.findOrCreate({
        where: { fileId: created.id, tagId: tag.tagId },
        transaction,
      })));
      const categoryAssignments = await FileCategory.findAll({ where: { fileId: source.id }, transaction });
      await Promise.all(categoryAssignments.map((assignment) => FileCategory.findOrCreate({
        where: { fileId: created.id, categoryId: assignment.categoryId },
        transaction,
      })));
      if (!shouldQueueLazyParse || (source.parseResult && (!source.parseResult.error || source.parseResult.hasRetainedResult === true))) {
        await cloneParsedLayers(source.id, created.id, transaction);
      }
      return created;
    });

    if (shouldQueueLazyParse) {
      await queueSourceParseForPersonalCopy(source, personalCopy);
    }

    const result = await DesignFile.findByPk(personalCopy.id, { include: fileIncludes() });
    res.status(201).json({ code: 201, message: '已创建个人副本', data: result });
  } catch (err) {
    next(err);
  }
}

export async function listTrash(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    await purgeExpiredTrash();
    const rows = await DesignFile.findAll({
      where: { isDeleted: true },
      include: fileIncludes(),
      attributes: { exclude: ['editorState', 'parseResult'] },
      order: [['updated_at', 'DESC']],
      limit: 100,
    });

    res.json({ code: 200, message: '获取成功', data: rows });
  } catch (err) {
    next(err);
  }
}

async function reconcileParsedContent(file: DesignFile): Promise<{
  sourceParseStatus?: DesignFile['parseStatus']; sourceParseError?: string; autoParseBlocked: boolean;
}> {
  const source = file.isPersonalCopy && file.sourceFileId ? await DesignFile.findByPk(file.sourceFileId) : null;
  const validSource = source && !source.isDeleted && source.fileType === file.fileType ? source : null;
  const state = {
    ...(validSource ? { sourceParseStatus: validSource.parseStatus,
      ...(validSource.parseStatus === 'failed' ? { sourceParseError: String(validSource.parseResult?.error || '源文件解析失败') } : {}) } : {}),
    autoParseBlocked: file.parseStatus === 'failed' || validSource?.parseStatus === 'failed',
  };
  if (file.parseStatus === 'failed') return state;
  if (validSource) {
    await queueSourceParseForPersonalCopy(validSource, file);
    await validSource.reload();
    state.sourceParseStatus = validSource.parseStatus;
  } else if (await isStaleParsedContent(file) || isParseInFlight(file)
      || getParseQueuePhase(file.id) === 'queued' || getParseQueuePhase(file.id) === 'parsing') {
    await queueStandaloneParse(file);
  }
  await file.reload();
  return state;
}

async function readParsedSnapshot(id: number, options: {
  include?: boolean; layers?: boolean; expectedParseRevision?: unknown;
} = {}) {
  if (options.expectedParseRevision !== undefined && typeof options.expectedParseRevision !== 'string') {
    throw new AppError('解析版本参数无效', 400);
  }
  return sequelize.transaction(async (transaction) => {
    // Learn the relationship without taking the copy lock before its source.
    const initial = await DesignFile.findByPk(id, { transaction });
    if (!initial || initial.isDeleted) throw new AppError('文件不存在', 404);
    const sourceId = initial.isPersonalCopy ? initial.sourceFileId : null;
    const source = sourceId && sourceId !== id
      ? await DesignFile.findByPk(sourceId, { transaction, lock: transaction.LOCK.UPDATE }) : null;
    const file = await DesignFile.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!file || file.isDeleted) throw new AppError('文件不存在', 404);
    if ((file.isPersonalCopy ? file.sourceFileId : null) !== sourceId || file.fileType !== initial.fileType) {
      throw new AppError('文件来源已变化，请重新打开', 409);
    }
    const validSource = source && !source.isDeleted && source.fileType === file.fileType ? source : null;
    const current = getCurrentParserVersion(file.fileType);
    const canonical = validSource || file;
    const freshness = current ? deriveParseFreshness({
      file, source: validSource, versionKey: current.key, requiredVersion: current.version,
      canonicalHealthy: canonical.parseStatus === 'completed' && !await isStaleParsedContent(canonical),
      ownHealthy: file.parseStatus === 'completed' && !await isStaleParsedContent(file),
      queuePhase: getParseQueuePhase(canonical.id),
    }) : undefined;
    const included = options.include ? await DesignFile.findByPk(id, { transaction, include: fileIncludes() }) : null;
    // A nonlocking association query can see the transaction's earlier snapshot.
    // Always use the locked current row for every file/result/editor field.
    const fileData = { ...(included?.toJSON() || {}), ...file.toJSON(),
      ...(freshness ? { parseFreshness: freshness, parseStatus: effectiveParseStatus(freshness) } : {}),
      ...(validSource ? { sourceParseStatus: validSource.parseStatus,
        ...(validSource.parseStatus === 'failed' ? { sourceParseError: String(validSource.parseResult?.error || '源文件解析失败') } : {}) } : {}),
      autoParseBlocked: file.parseStatus === 'failed' || validSource?.parseStatus === 'failed',
    };
    const ready = freshness ? freshness.state === 'ready'
      : file.parseStatus === 'completed' || file.parseStatus === 'failed' && file.parseResult?.hasRetainedResult === true;
    const revisionMatches = options.expectedParseRevision === undefined
      || options.expectedParseRevision === freshness?.revision;
    const layers = options.layers && ready && revisionMatches ? await ParsedLayer.findAll({
      where: { fileId: id }, order: [['sort_order', 'ASC']], transaction, lock: transaction.LOCK.UPDATE,
    }) : [];
    return { fileData, freshness, layers };
  });
}

export async function getById(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    const rawFile = await DesignFile.findByPk(id);
    if (!rawFile || rawFile.isDeleted) throw new AppError('File not found', 404);

    await reconcileParsedContent(rawFile);
    const { fileData } = await readParsedSnapshot(id, { include: true });
    res.json({ code: 200, message: '获取成功', data: fileData });
  } catch (err) {
    next(err);
  }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    const file = await DesignFile.findByPk(id);
    if (!file || file.isDeleted) throw new AppError('文件不存在', 404);

    const { name, categoryId, tagIds, categoryTagIds } = req.body;

    if (name !== undefined) await file.update({ name });

    if (categoryTagIds !== undefined) {
      const parsedCategoryIds = parseIdList(categoryTagIds);
      const nextPrimaryCategoryId = categoryId !== undefined
        ? (categoryId === null ? null : Number(categoryId))
        : (parsedCategoryIds[0] || null);
      const assignedCategoryIds = parsedCategoryIds.length > 0
        ? parsedCategoryIds
        : (nextPrimaryCategoryId ? [nextPrimaryCategoryId] : []);

      await ensureCategoriesInLibrary(file.libraryId, Array.from(new Set([nextPrimaryCategoryId, ...assignedCategoryIds].filter(Boolean) as number[])));
      await file.update({ categoryId: nextPrimaryCategoryId });
      await syncCategoryTags(id, assignedCategoryIds, file.libraryId);
    } else if (categoryId !== undefined) {
      await ensureCategoriesInLibrary(file.libraryId, categoryId === null ? [] : [Number(categoryId)]);
      await file.update({ categoryId });
      await syncFileCategoryAssignments(id, categoryId === null ? [] : [Number(categoryId)], file.libraryId);
    }

    if (tagIds !== undefined && categoryTagIds === undefined) {
      await FileTag.destroy({ where: { fileId: id } });
      for (const tagId of parseIdList(tagIds)) {
        await FileTag.create({ fileId: id, tagId });
      }
    }

    const result = await DesignFile.findByPk(id, { include: fileIncludes() });
    res.json({ code: 200, message: '更新成功', data: result });
  } catch (err) {
    next(err);
  }
}

export async function updateMyMeta(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    const file = await DesignFile.findByPk(id);
    if (!file || file.isDeleted) throw new AppError('文件不存在', 404);
    if (!file.isPersonalCopy || file.uploadedBy !== req.user!.id) {
      throw new AppError('只能更新自己的模板副本', 403);
    }

    const nextData: Partial<{
      isFavorite: boolean;
      isDraft: boolean;
      isShared: boolean;
      isPublished: boolean;
    }> = {};

    ['isFavorite', 'isDraft', 'isShared', 'isPublished'].forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        nextData[key as keyof typeof nextData] = Boolean(req.body[key]);
      }
    });

    await file.update(nextData);
    const result = await DesignFile.findByPk(id, { include: fileIncludes() });
    res.json({ code: 200, message: '更新成功', data: result });
  } catch (err) {
    next(err);
  }
}

export async function remove(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    const file = await DesignFile.findByPk(id);
    if (!file || file.isDeleted) throw new AppError('文件不存在', 404);

    if (!canManageFileTrash(req, file)) {
      throw new AppError('权限不足', 403);
    }

    await file.update({ isDeleted: true });
    logger.info(
      { scope: 'audit', action: 'file.trash', userId: req.user?.id, fileId: file.id, name: file.name },
      'audit: file moved to trash'
    );
    res.json({ code: 200, message: '删除成功', data: null });
  } catch (err) {
    next(err);
  }
}

export async function batchRemove(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ids = getBatchFileIds(req.body?.ids);
    const files = await DesignFile.findAll({
      where: { id: { [Op.in]: ids }, isDeleted: false },
    });

    if (files.length === 0) throw new AppError('No files found', 404);
    assertCanManageFiles(req, files);

    const fileIds = files.map((file) => file.id);
    await DesignFile.update(
      { isDeleted: true },
      { where: { id: { [Op.in]: fileIds } } },
    );

    logger.info(
      { scope: 'audit', action: 'file.trash.batch', userId: req.user?.id, fileIds, count: fileIds.length },
      'audit: files moved to trash (batch)'
    );
    res.json({ code: 200, message: 'Moved to trash', data: { count: fileIds.length } });
  } catch (err) {
    next(err);
  }
}

export async function restore(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    const file = await DesignFile.findByPk(id);
    if (!file) throw new AppError('文件不存在', 404);

    if (!file.isDeleted) throw new AppError('File is not in trash', 400);
    if (file.updatedAt < getTrashExpireBefore()) {
      await destroyFileRecord(file);
      throw new AppError('File trash retention expired', 404);
    }

    if (!canManageFileTrash(req, file)) {
      throw new AppError('权限不足', 403);
    }

    await file.update({ isDeleted: false });
    logger.info(
      { scope: 'audit', action: 'file.restore', userId: req.user?.id, fileId: file.id, name: file.name },
      'audit: file restored from trash'
    );
    res.json({ code: 200, message: '恢复成功', data: file });
  } catch (err) {
    next(err);
  }
}

export async function batchRestore(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ids = getBatchFileIds(req.body?.ids);
    const files = await DesignFile.findAll({
      where: { id: { [Op.in]: ids }, isDeleted: true },
    });

    if (files.length === 0) throw new AppError('No files found', 404);
    assertCanManageFiles(req, files);

    const restoreIds: number[] = [];
    for (const file of files) {
      if (file.updatedAt < getTrashExpireBefore()) {
        await destroyFileRecord(file);
      } else {
        restoreIds.push(file.id);
      }
    }

    if (restoreIds.length > 0) {
      await DesignFile.update(
        { isDeleted: false },
        { where: { id: { [Op.in]: restoreIds } } },
      );
    }

    logger.info(
      {
        scope: 'audit',
        action: 'file.restore.batch',
        userId: req.user?.id,
        fileIds: restoreIds,
        count: restoreIds.length,
      },
      'audit: files restored from trash (batch)'
    );
    res.json({ code: 200, message: 'Restored', data: { count: restoreIds.length } });
  } catch (err) {
    next(err);
  }
}

export async function permanentRemove(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    const file = await DesignFile.findByPk(id);
    if (!file) throw new AppError('File not found', 404);
    if (!file.isDeleted) throw new AppError('Move the file to trash first', 400);

    if (!canManageFileTrash(req, file)) {
      throw new AppError('Permission denied', 403);
    }

    const snapshot = { id: file.id, name: file.name, originalFilename: file.originalFilename };
    await destroyFileRecord(file);
    logger.warn(
      {
        scope: 'audit',
        action: 'file.purge',
        userId: req.user?.id,
        fileId: snapshot.id,
        name: snapshot.name,
        originalFilename: snapshot.originalFilename,
      },
      'audit: file permanently deleted'
    );
    res.json({ code: 200, message: 'Permanently deleted', data: null });
  } catch (err) {
    next(err);
  }
}

export async function batchPermanentRemove(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const ids = getBatchFileIds(req.body?.ids);
    const files = await DesignFile.findAll({
      where: { id: { [Op.in]: ids }, isDeleted: true },
    });

    if (files.length === 0) throw new AppError('No files found', 404);
    assertCanManageFiles(req, files);

    const snapshot = files.map((file) => ({ id: file.id, name: file.name }));
    for (const file of files) {
      await destroyFileRecord(file);
    }

    logger.warn(
      {
        scope: 'audit',
        action: 'file.purge.batch',
        userId: req.user?.id,
        files: snapshot,
        count: snapshot.length,
      },
      'audit: files permanently deleted (batch)'
    );
    res.json({ code: 200, message: 'Permanently deleted', data: { count: files.length } });
  } catch (err) {
    next(err);
  }
}

export async function download(req: Request, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    const file = await DesignFile.findByPk(id);
    if (!file || file.isDeleted) throw new AppError('文件不存在', 404);

    await file.update({ downloadCount: file.downloadCount + 1 });

    const filePath = file.filePath.replace(/\\/g, '/');
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat?.isFile()) throw new AppError('文件已丢失', 404);

    logger.info(
      {
        scope: 'audit',
        action: 'file.download',
        userId: (req as AuthRequest).user?.id,
        fileId: file.id,
        name: file.name,
      },
      'audit: file downloaded'
    );

    const range = parseRangeHeader(req.headers.range, stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Content-Type', getFileMimeType(file.fileType));
    res.setHeader('Content-Disposition', getContentDisposition(getDownloadFilename(file)));
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (range === 'invalid') {
      res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
      return;
    }

    const streamOptions = range ? { start: range.start, end: range.end } : undefined;
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
    } else {
      res.setHeader('Content-Length', String(stat.size));
    }

    await pipeline(fs.createReadStream(filePath, streamOptions), res);
  } catch (err) {
    if (res.headersSent) {
      logger.warn(
        {
          err,
          action: 'file.download.stream',
          fileId: req.params.id,
        },
        'download stream interrupted'
      );
      res.destroy(err instanceof Error ? err : undefined);
      return;
    }
    next(err);
  }
}

export async function preview(req: Request, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    const file = await DesignFile.findByPk(id);
    if (!file || file.isDeleted) throw new AppError('文件不存在', 404);

    const filePath = file.filePath.replace(/\\/g, '/');
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat?.isFile()) throw new AppError('文件已丢失', 404);

    res.setHeader('Content-Type', getFileMimeType(file.fileType));
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    await pipeline(fs.createReadStream(filePath), res);
  } catch (err) {
    if (res.headersSent) {
      logger.warn(
        {
          err,
          action: 'file.preview.stream',
          fileId: req.params.id,
        },
        'preview stream interrupted'
      );
      res.destroy(err instanceof Error ? err : undefined);
      return;
    }
    next(err);
  }
}

function editorStateRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try { return editorStateRecord(JSON.parse(value)); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as Record<string, unknown>).objects)
    ? value as Record<string, unknown> : null;
}

function stateBelongsToPage(state: Record<string, unknown> | null, file: DesignFile, page: number): boolean {
  if (!state || Number(state.__editorStateOwnerVersion) < 1 || !Number.isFinite(Number(state.__editorStateOwnerVersion))) return false;
  return Number(state.__fileId) === file.id
    && (state.__sourceFileId === null || state.__sourceFileId === undefined ? null : Number(state.__sourceFileId)) === (file.sourceFileId || null)
    && Number(state.__pageNumber) === page;
}

function withoutPageStates(state: Record<string, unknown>): Record<string, unknown> {
  const { __pageStates: _ignored, ...pageState } = state;
  return pageState;
}

export async function saveEditorState(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    await sequelize.transaction(async (transaction) => {
    const file = await DesignFile.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!file || file.isDeleted) throw new AppError('文件不存在', 404);
    if (!file.isPersonalCopy || file.uploadedBy !== req.user!.id) {
      throw new AppError('只能保存自己的模板副本', 403);
    }

    const rawEditorState = req.body.editorState;
    let editorState = rawEditorState;
    if (typeof rawEditorState === 'string') {
      try {
        editorState = JSON.parse(rawEditorState);
      } catch {
        editorState = rawEditorState;
      }
    }
    if (editorState && typeof editorState === 'object') {
      const owner = editorState as Record<string, unknown>;
      const ownerVersion = Number(owner.__editorStateOwnerVersion);
      if (Number.isFinite(ownerVersion) && ownerVersion >= 1) {
        const stateFileId = Number(owner.__fileId);
        const stateSourceFileId = owner.__sourceFileId === null || owner.__sourceFileId === undefined
          ? null
          : Number(owner.__sourceFileId);
        const expectedSourceFileId = file.sourceFileId || null;
        const statePageNumber = Number(owner.__pageNumber);
        if (
          stateFileId !== file.id
          || stateSourceFileId !== expectedSourceFileId
          || !Number.isInteger(statePageNumber)
          || statePageNumber < 1
        ) {
          throw new AppError('编辑状态与当前文件不匹配，已拒绝保存', 409);
        }
      }
    }

    let persistedState = rawEditorState;
    const parseResult = file.parseResult as Record<string, unknown> | null;
    const pages = Array.isArray(parseResult?.pages) ? parseResult.pages : [];
    const documentPageNumbers = pages.flatMap((page, index) => {
      if (!page || typeof page !== 'object') return [];
      const record = page as Record<string, unknown>;
      const number = Number(record.page ?? record.index ?? index + 1);
      return Number.isSafeInteger(number) && number > 0 ? [number] : [];
    });
    const previous = editorStateRecord(file.editorState);
    const previousMap = previous?.__pageStates;
    // A parser result can temporarily publish only part of its page manifest.
    // Keep owned server snapshots even when the new manifest omits their page;
    // the incoming page map never supplies additional trusted page identities.
    const retainedMapPages = previousMap && typeof previousMap === 'object' && !Array.isArray(previousMap)
      ? Object.keys(previousMap).map(Number).filter((page) => Number.isSafeInteger(page) && page > 0
        && stateBelongsToPage(editorStateRecord((previousMap as Record<string, unknown>)[String(page)]), file, page))
      : [];
    const previousPage = Number(previous?.__pageNumber);
    const retainedRootPages = Number.isSafeInteger(previousPage) && previousPage > 0 && stateBelongsToPage(previous, file, previousPage)
      ? [previousPage] : [];
    const savedPageNumbers = [...new Set([...documentPageNumbers, ...retainedMapPages, ...retainedRootPages])];
    if (['pdf', 'ai'].includes(file.fileType) && (pages.length > 1 || savedPageNumbers.length > 1 || retainedMapPages.length > 0 || Number(parseResult?.pageCount) > 1)) {
      const incoming = editorStateRecord(editorState);
      const pageNumber = Number(incoming?.__pageNumber);
      const validPage = savedPageNumbers.includes(pageNumber);
      if (!Number.isInteger(pageNumber) || !validPage || !stateBelongsToPage(incoming, file, pageNumber)) {
        throw new AppError('编辑状态与当前 PDF 页不匹配，已拒绝保存', 409);
      }
      const pageStates: Record<string, Record<string, unknown>> = {};
      for (const number of savedPageNumbers) {
        if (!Number.isInteger(number) || number < 1) continue;
        const stored = previousMap && typeof previousMap === 'object' && !Array.isArray(previousMap)
          ? editorStateRecord((previousMap as Record<string, unknown>)[String(number)]) : null;
        if (stateBelongsToPage(stored, file, number)) pageStates[String(number)] = withoutPageStates(stored!);
        if (stateBelongsToPage(previous, file, number)) pageStates[String(number)] = withoutPageStates(previous!);
      }
      const current = withoutPageStates(incoming!);
      pageStates[String(pageNumber)] = current;
      persistedState = { ...current, __pageStates: pageStates };
    }
    await file.update({ editorState: persistedState, isDraft: true }, { transaction });
    });
    res.json({ code: 200, message: '保存成功', data: null });
  } catch (err) {
    next(err);
  }
}

export async function getEditorState(req: Request, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    const file = await DesignFile.findByPk(id);
    if (!file || file.isDeleted) throw new AppError('文件不存在', 404);

    res.json({
      code: 200,
      message: '获取成功',
      data: { editorState: file.editorState || null, width: file.width, height: file.height },
    });
  } catch (err) {
    next(err);
  }
}

export async function getParseStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    const file = await DesignFile.findByPk(id);
    if (!file || file.isDeleted) throw new AppError('文件不存在', 404);
    await reconcileParsedContent(file);
    const { fileData } = await readParsedSnapshot(id);
    const { parseStatus, parseResult, parseFreshness, sourceParseStatus, sourceParseError, autoParseBlocked } = fileData;

    res.json({
      code: 200,
      message: '获取成功',
      data: { parseStatus, parseResult, parseFreshness, sourceParseStatus, sourceParseError, autoParseBlocked },
    });
  } catch (err) {
    next(err);
  }
}

export async function getLayers(req: Request, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    const file = await DesignFile.findByPk(id);
    if (!file || file.isDeleted) throw new AppError('文件不存在', 404);
    await reconcileParsedContent(file);
    const { freshness, layers } = await readParsedSnapshot(id, {
      layers: true, expectedParseRevision: req.query?.expectedParseRevision,
    });

    const buildTree = (parentId: number | null): unknown[] => layers
      .filter((layer) => layer.parentLayerId === parentId)
      .map((layer) => ({
        ...layer.toJSON(),
        children: buildTree(layer.id),
      }));

    res.json({ code: 200, message: '获取成功', ...(freshness ? { parseFreshness: freshness } : {}), data: buildTree(null) });
  } catch (err) {
    next(err);
  }
}

export async function submitParseAssist(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    const file = await DesignFile.findByPk(id);
    if (!file || file.isDeleted) throw new AppError('File not found', 404);
    if (file.isPersonalCopy && file.uploadedBy !== req.user!.id) {
      throw new AppError('鏃犳潈鎻愪氦姝ゆ枃浠剁殑瑙ｆ瀽杈呭姪淇℃伅', 403);
    }

    const normalized = normalizeClientParseAssistFromBody(req.body, {
      fileType: file.fileType,
      fileName: file.originalFilename,
    });
    const clientAssistSnapshot = await materializeClientParseAssistPreview(file.id, normalized);
    const queued = await submitParseAssistForFile(file, req.user!.id, clientAssistSnapshot);

    res.json({ code: 200, message: 'OK', data: { queued } });
  } catch (err) {
    next(err);
  }
}

export async function triggerParse(req: Request, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    const file = await DesignFile.findByPk(id);
    if (!file) throw new AppError('文件不存在', 404);

    const source = file.isPersonalCopy && file.sourceFileId
      ? await DesignFile.findByPk(file.sourceFileId)
      : null;
    if (source && !source.isDeleted) {
      await queueSourceParseForPersonalCopy(source, file, { force: true });
    } else {
      await queueStandaloneParse(file);
    }

    res.json({ code: 200, message: '已加入解析队列', data: null });
  } catch (err) {
    next(err);
  }
}
