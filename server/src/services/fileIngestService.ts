import fs from 'fs';
import path from 'path';
import { Op, type Transaction } from 'sequelize';
import sequelize from '../config/database';
import { Category, DesignFile, FileTag, FileCategory, Library, ParsedLayer, Tag, User } from '../models';
import { AppError } from '../middleware/errorHandler';
import { STORAGE } from '../config/storage';
import { enqueueParse } from './parser/parseOrchestrator';
import { isFontFileType, registerResourceFont } from './fontRegistry';
import { warmUploadThumbnailVariants } from './uploadThumbnailVariants';
import { applyClientUploadPreviewToFile } from './clientUploadPreview';
import {
  materializeClientParseAssistPreview,
  type ClientParseAssistSnapshot,
} from './parser/clientParseAssist';

export interface StoredFileInput {
  userId: number;
  originalName: string;
  storedPath: string;
  fileSize: number;
  libraryId: number | null;
  categoryId?: number | null;
  categoryTagIds?: number[];
  tagIds?: number[];
  storageScope?: string | null;
  contentMd5?: string | null;
  relativePath?: string | null;
  parseEmptyAsCompleted?: boolean;
  clientThumbnailPath?: string | null;
  clientParseAssist?: ClientParseAssistSnapshot | null;
}

export interface ExistingObjectCloneInput {
  userId: number;
  sourceFile: DesignFile;
  originalName: string;
  libraryId: number | null;
  categoryId?: number | null;
  categoryTagIds?: number[];
  tagIds?: number[];
  storageScope?: string | null;
  contentMd5?: string | null;
  relativePath?: string | null;
  clientParseAssist?: ClientParseAssistSnapshot | null;
}

export function getFileType(filename: string): string {
  const ext = path.extname(filename).toLowerCase().slice(1);
  const map: Record<string, string> = { jpeg: 'jpg', ppt: 'pptx', psb: 'psd' };
  return map[ext] || ext;
}

export function fileIncludes() {
  return [
    { model: User, as: 'uploader', attributes: ['id', 'displayName'] },
    { model: Library, as: 'library', attributes: ['id', 'name'] },
    { model: Category, as: 'category' },
    { model: Category, as: 'categoryAssignments', attributes: ['id', 'name', 'parentId', 'dimension', 'libraryId'], through: { attributes: [] } },
    { model: Tag, as: 'tags', through: { attributes: [] } },
  ];
}

export async function ensureCategoriesInLibrary(libraryId: number | null, categoryIds: number[]) {
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

export async function syncFileCategoryAssignments(
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

export async function syncCategoryTags(fileId: number, categoryIds: number[], libraryId: number | null) {
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

export async function cloneParsedLayers(sourceFileId: number, targetFileId: number, transaction?: Transaction) {
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

export async function createDesignFileFromStoredFile(input: StoredFileInput) {
  const originalName = path.basename(input.originalName);
  const fileType = getFileType(originalName);
  const name = path.basename(originalName, path.extname(originalName));
  const isPersonalUpload = !input.libraryId && input.storageScope === 'my';
  const categoryTagIds = input.categoryTagIds || [];
  const primaryCategoryId = input.categoryId ?? categoryTagIds[0] ?? null;
  const assignedCategoryIds = categoryTagIds.length > 0
    ? categoryTagIds
    : (primaryCategoryId ? [primaryCategoryId] : []);

  if (input.libraryId) {
    const library = await Library.findByPk(input.libraryId);
    if (!library || library.isDeleted) throw new AppError('资源库不存在', 400);
  }

  await ensureCategoriesInLibrary(
    input.libraryId,
    Array.from(new Set([primaryCategoryId, ...assignedCategoryIds].filter(Boolean) as number[])),
  );

  const fontMeta = isFontFileType(fileType) && input.fileSize > 0
    ? registerResourceFont({
        path: input.storedPath,
        originalname: originalName,
        filename: path.basename(input.storedPath),
        size: input.fileSize,
      } as Express.Multer.File)
    : null;

  const designFile = await DesignFile.create({
    name,
    originalFilename: originalName,
    fileType,
    filePath: input.storedPath.replace(/\\/g, '/'),
    storagePlatform: 'local',
    contentMd5: input.contentMd5 || null,
    relativePath: input.relativePath || null,
    fileSize: input.fileSize,
    libraryId: input.libraryId,
    categoryId: primaryCategoryId,
    isPersonalCopy: isPersonalUpload,
    uploadedBy: input.userId,
    parseStatus: fontMeta || (input.parseEmptyAsCompleted && input.fileSize === 0) ? 'completed' : 'pending',
    parseResult: fontMeta ? { type: 'font', font: fontMeta } : null,
  });

  for (const tagId of input.tagIds || []) {
    await FileTag.findOrCreate({ where: { fileId: designFile.id, tagId } });
  }

  await syncCategoryTags(designFile.id, assignedCategoryIds, input.libraryId);

  const clientThumbnailApplied = await applyClientUploadPreviewToFile(designFile, input.clientThumbnailPath);
  const clientAssistSnapshot = await materializeClientParseAssistPreview(
    designFile.id,
    input.clientParseAssist,
    input.clientThumbnailPath,
  );

  if (input.fileSize > 0 && ['png', 'jpg', 'svg', 'gif', 'webp'].includes(fileType)) {
    try {
      const sharp = require('sharp');
      const thumbFilename = `${designFile.id}_thumb.png`;
      if (!clientThumbnailApplied) {
        const thumbPath = path.join(STORAGE.thumbnails, thumbFilename);

        await sharp(input.storedPath)
          .resize(400, 300, { fit: 'inside', withoutEnlargement: true })
          .png()
          .toFile(thumbPath);
      }

      const meta = await sharp(input.storedPath).metadata();
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

  if (input.fileSize > 0 && ['psd', 'ai', 'pdf'].includes(fileType)) {
    enqueueParse(designFile.id, { clientAssistSnapshot });
  }

  return DesignFile.findByPk(designFile.id, { include: fileIncludes() });
}

export async function cloneDesignFileObject(input: ExistingObjectCloneInput) {
  let source = input.sourceFile;
  const originalName = path.basename(input.originalName);
  const name = path.basename(originalName, path.extname(originalName));
  const isPersonalUpload = !input.libraryId && input.storageScope === 'my';
  const categoryTagIds = input.categoryTagIds || [];
  const primaryCategoryId = input.categoryId ?? categoryTagIds[0] ?? null;
  const assignedCategoryIds = categoryTagIds.length > 0
    ? categoryTagIds
    : (primaryCategoryId ? [primaryCategoryId] : []);

  if (!fs.existsSync(source.filePath.replace(/\\/g, '/'))) {
    throw new AppError('源文件已丢失，无法秒传', 404);
  }

  if (input.libraryId) {
    const library = await Library.findByPk(input.libraryId);
    if (!library || library.isDeleted) throw new AppError('资源库不存在', 400);
  }

  await ensureCategoriesInLibrary(
    input.libraryId,
    Array.from(new Set([primaryCategoryId, ...assignedCategoryIds].filter(Boolean) as number[])),
  );

  const next = await sequelize.transaction(async (transaction) => {
    const lockedSource = await DesignFile.findByPk(source.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!lockedSource || lockedSource.isDeleted) throw new AppError('源文件不存在，无法秒传', 404);
    source = lockedSource;
    const created = await DesignFile.create({
    name,
    originalFilename: originalName,
    fileType: getFileType(originalName),
    filePath: source.filePath,
    storagePlatform: source.storagePlatform || 'local',
    contentMd5: input.contentMd5 || source.contentMd5 || null,
    relativePath: input.relativePath || null,
    thumbnailPath: source.thumbnailPath,
    fileSize: source.fileSize,
    width: source.width,
    height: source.height,
    libraryId: input.libraryId,
    categoryId: primaryCategoryId,
    isPersonalCopy: isPersonalUpload,
    uploadedBy: input.userId,
    parseStatus: source.parseStatus,
    parseResult: source.parseResult,
    editorState: null,
    }, { transaction });
    if (source.parseStatus === 'completed' || (source.parseResult
        && (!source.parseResult.error || source.parseResult.hasRetainedResult === true))) {
      await cloneParsedLayers(source.id, created.id, transaction);
    }
    return created;
  });

  for (const tagId of input.tagIds || []) {
    await FileTag.findOrCreate({ where: { fileId: next.id, tagId } });
  }
  await syncCategoryTags(next.id, assignedCategoryIds, input.libraryId);

  if (source.parseStatus !== 'completed' && ['psd', 'ai', 'pdf'].includes(next.fileType)) {
    const clientAssistSnapshot = await materializeClientParseAssistPreview(next.id, input.clientParseAssist);
    enqueueParse(next.id, { clientAssistSnapshot });
  }

  return DesignFile.findByPk(next.id, { include: fileIncludes() });
}
