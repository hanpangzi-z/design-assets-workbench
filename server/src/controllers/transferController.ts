import { Response, NextFunction } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { Op } from 'sequelize';
import { DesignFile, FileTransferChunk, FileTransferTask } from '../models';
import type { FileTransferStatus } from '../models/FileTransferTask';
import { AuthRequest } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { STORAGE } from '../config/storage';
import { TRANSFER } from '../config/transfer';
import {
  cloneDesignFileObject,
  createDesignFileFromStoredFile,
  getFileType,
} from '../services/fileIngestService';
import { saveClientUploadPreviewTempFromBody } from '../services/clientUploadPreview';
import {
  readClientParseAssistTemp,
  saveClientParseAssistTempFromBody,
} from '../services/parser/clientParseAssist';
import { logger } from '../utils/logger';

const SUPPORTED_EXTENSIONS = new Set([
  'psd', 'ai', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'pptx', 'ppt',
  'ttf', 'otf', 'ttc', 'woff', 'woff2',
]);

const MY_FILES_LIMIT = 200;
const MY_FILES_LIMIT_MESSAGE = `「我的」文件已达上限 ${MY_FILES_LIMIT} 个，请先删除部分文件后再继续`;
const mergeLocks = new Set<string>();
const sseClients = new Map<string, Set<Response>>();

type TransferEvent = {
  type: 'status' | 'progress' | 'completed' | 'error' | 'canceled';
  status: FileTransferStatus;
  progress: number;
  fileId?: number | null;
  message?: string | null;
};

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

function toPositiveInt(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function toNullablePositiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizeFilename(value: unknown) {
  const filename = path.basename(String(value || '').trim());
  if (!filename) throw new AppError('文件名不能为空', 400);
  return filename.slice(0, 500);
}

function normalizeMd5(value: unknown) {
  const md5 = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(md5)) throw new AppError('文件 MD5 无效', 400);
  return md5;
}

function normalizeRelativePath(value: unknown, filename: string) {
  const raw = String(value || '').replace(/\\/g, '/').trim();
  if (!raw) return null;
  const segments = raw
    .split('/')
    .map((item) => item.trim())
    .filter((item) => item && item !== '.' && item !== '..' && !item.includes(':'));
  if (segments.length === 0) return null;
  if (segments[segments.length - 1] !== filename) segments.push(filename);
  return segments.join('/').slice(0, 1000);
}

function getRelativeDirSegments(relativePath: string | null) {
  if (!relativePath) return [];
  const segments = relativePath.split('/').filter(Boolean);
  return segments.slice(0, -1);
}

function multipartDir(taskId: string) {
  return path.join(STORAGE.base, '_multipart', taskId);
}

function partPath(taskId: string, chunkIndex: number) {
  return path.join(multipartDir(taskId), `${chunkIndex}.part`);
}

function clientPreviewTempPath(taskId: string) {
  return path.join(multipartDir(taskId), 'client-upload-preview.png');
}

function clientParseAssistTempPath(taskId: string) {
  return path.join(multipartDir(taskId), 'client-parse-assist.json');
}

async function ensureMyFileLimit(userId: number, libraryId: number | null, storageScope?: string | null) {
  if (libraryId || storageScope !== 'my') return;
  const count = await DesignFile.count({
    where: { uploadedBy: userId, isPersonalCopy: true, isDeleted: false },
  });
  if (count >= MY_FILES_LIMIT) throw new AppError(MY_FILES_LIMIT_MESSAGE, 409);
}

async function getOwnedTask(taskId: string, userId: number) {
  const task = await FileTransferTask.findOne({ where: { id: taskId, userId } });
  if (!task) throw new AppError('上传任务不存在', 404);
  return task;
}

function taskProgress(task: FileTransferTask) {
  if (task.status === 'completed') return 100;
  if (task.status === 'merging') return 95;
  if (task.totalChunks <= 0) return task.status === 'error' ? 0 : 90;
  return Math.min(90, Math.round((task.uploadedChunks / task.totalChunks) * 90));
}

function emitTaskEvent(task: FileTransferTask, event?: Partial<TransferEvent>) {
  const payload: TransferEvent = {
    type: event?.type || (task.status === 'completed' ? 'completed' : 'status'),
    status: task.status,
    progress: event?.progress ?? taskProgress(task),
    fileId: event?.fileId ?? task.fileId,
    message: event?.message ?? task.errorMessage,
  };
  const clients = sseClients.get(task.id);
  if (!clients) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.write(data);
}

function submitMergeTask(taskId: string) {
  if (mergeLocks.has(taskId)) return;
  setImmediate(() => {
    mergeReadyTask(taskId).catch((err) => {
      logger.error({ err, taskId }, 'transfer merge task failed');
    });
  });
}

function buildFinalPath(task: FileTransferTask) {
  const ext = path.extname(task.originalFilename);
  const dir = path.join(STORAGE.originals, ...getRelativeDirSegments(task.relativePath));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${uuid()}${ext}`);
}

async function hashFile(filePath: string) {
  const hash = crypto.createHash('md5');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function cleanupMultipart(taskId: string) {
  await fs.promises.rm(multipartDir(taskId), { recursive: true, force: true }).catch(() => {});
}

async function finalizeTaskFromPath(task: FileTransferTask, finalPath: string) {
  await ensureMyFileLimit(task.userId, task.libraryId, task.storageScope);
  const file = await createDesignFileFromStoredFile({
    userId: task.userId,
    originalName: task.originalFilename,
    storedPath: finalPath,
    fileSize: task.fileSize,
    libraryId: task.libraryId,
    categoryId: task.categoryId,
    categoryTagIds: task.categoryTagIds || [],
    tagIds: task.tagIds || [],
    storageScope: task.storageScope,
    contentMd5: task.fileMd5,
    relativePath: task.relativePath,
    parseEmptyAsCompleted: true,
    clientThumbnailPath: clientPreviewTempPath(task.id),
    clientParseAssist: await readClientParseAssistTemp(clientParseAssistTempPath(task.id), clientPreviewTempPath(task.id)),
  });
  if (!file) throw new AppError('文件落库失败', 500);

  await task.update({
    status: 'completed',
    fileId: file.id,
    objectKey: finalPath.replace(/\\/g, '/'),
    uploadedChunks: task.totalChunks,
    errorMessage: null,
  });
  await cleanupMultipart(task.id);
  emitTaskEvent(task, { type: 'completed', progress: 100, fileId: file.id });
  return file;
}

async function mergeReadyTask(taskId: string) {
  if (mergeLocks.has(taskId)) return;
  mergeLocks.add(taskId);
  let task: FileTransferTask | null = null;
  let finalPath = '';

  try {
    task = await FileTransferTask.findByPk(taskId);
    if (!task || task.status === 'completed' || task.status === 'canceled') return;
    if (task.totalChunks <= 0) return;

    const uploadedCount = await FileTransferChunk.count({ where: { taskId } });
    if (uploadedCount < task.totalChunks) return;

    await task.update({ status: 'merging', uploadedChunks: uploadedCount });
    emitTaskEvent(task, { type: 'status', progress: 95 });

    finalPath = buildFinalPath(task);
    await fs.promises.writeFile(finalPath, Buffer.alloc(0));

    for (let index = 0; index < task.totalChunks; index += 1) {
      const source = partPath(taskId, index);
      if (!fs.existsSync(source)) throw new AppError(`分片 ${index} 缺失`, 500);
      const buffer = await fs.promises.readFile(source);
      await fs.promises.appendFile(finalPath, buffer);
    }

    if (task.fileMd5) {
      const mergedMd5 = await hashFile(finalPath);
      if (mergedMd5 !== task.fileMd5) throw new AppError('文件 MD5 校验失败', 500);
    }

    await finalizeTaskFromPath(task, finalPath);
  } catch (err) {
    if (finalPath) await fs.promises.unlink(finalPath).catch(() => {});
    if (task) {
      await task.update({
        status: 'error',
        errorMessage: err instanceof Error ? err.message : '合并失败',
      });
      emitTaskEvent(task, { type: 'error', progress: taskProgress(task), message: task.errorMessage });
    }
    throw err;
  } finally {
    mergeLocks.delete(taskId);
  }
}

export async function recoverReadyMerges() {
  const tasks = await FileTransferTask.findAll({
    where: {
      status: { [Op.in]: ['uploading', 'merging'] },
    },
    limit: 200,
  });

  for (const task of tasks) {
    const uploadedCount = await FileTransferChunk.count({ where: { taskId: task.id } });
    if (task.totalChunks > 0 && uploadedCount >= task.totalChunks) {
      submitMergeTask(task.id);
    }
  }
}

export function config(_req: AuthRequest, res: Response) {
  res.json({
    code: 200,
    message: 'OK',
    data: {
      chunkSize: TRANSFER.chunkSize,
      uploadConcurrency: TRANSFER.uploadConcurrency,
      maxBatchFiles: TRANSFER.maxBatchFiles,
      maxFileSize: TRANSFER.maxFileSize,
      maxTotalSize: TRANSFER.maxTotalSize,
    },
  });
}

export async function init(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const originalFilename = normalizeFilename(req.body.filename || req.body.originalFilename);
    const fileSize = Number(req.body.fileSize);
    if (!Number.isFinite(fileSize) || fileSize < 0) throw new AppError('文件大小无效', 400);
    if (fileSize > TRANSFER.maxFileSize) throw new AppError(`文件超过上传上限 ${Math.round(TRANSFER.maxFileSize / 1024 / 1024)}MB`, 413);

    const fileType = getFileType(originalFilename);
    if (!SUPPORTED_EXTENSIONS.has(fileType)) throw new AppError(`不支持的文件格式: ${fileType}`, 400);

    const requestedChunkSize = toPositiveInt(req.body.chunkSize, TRANSFER.chunkSize);
    const chunkSize = Math.min(Math.max(requestedChunkSize, 1024 * 1024), TRANSFER.maxChunkSize);
    const totalChunks = fileSize === 0 ? 0 : Math.ceil(fileSize / chunkSize);
    const libraryId = toNullablePositiveInt(req.body.libraryId);
    const categoryTagIds = parseIdList(req.body.categoryTagIds);
    const categoryId = toNullablePositiveInt(req.body.categoryId) || categoryTagIds[0] || null;
    const tagIds = parseIdList(req.body.tagIds);
    const relativePath = normalizeRelativePath(req.body.relativePath, originalFilename);

    const task = await FileTransferTask.create({
      userId: req.user!.id,
      storagePlatform: 'local',
      status: 'initialized',
      originalFilename,
      fileType,
      fileSize,
      chunkSize,
      totalChunks,
      uploadedChunks: 0,
      libraryId,
      categoryId,
      categoryTagIds,
      tagIds,
      storageScope: req.body.storageScope || null,
      relativePath,
      uploadId: uuid(),
    });

    await fs.promises.mkdir(multipartDir(task.id), { recursive: true });
    await saveClientUploadPreviewTempFromBody(req.body, clientPreviewTempPath(task.id));
    await saveClientParseAssistTempFromBody(req.body, clientParseAssistTempPath(task.id), {
      fileType,
      fileName: originalFilename,
    });

    res.status(201).json({
      code: 201,
      message: '初始化成功',
      data: {
        taskId: task.id,
        chunkSize: task.chunkSize,
        totalChunks: task.totalChunks,
        uploadConcurrency: TRANSFER.uploadConcurrency,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function check(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const task = await getOwnedTask(String(req.body.taskId || req.params.taskId || ''), req.user!.id);
    if (task.status === 'canceled') throw new AppError('上传任务已取消', 409);
    const fileMd5 = normalizeMd5(req.body.fileMd5 || req.body.md5);
    await task.update({ fileMd5 });

    const existing = await DesignFile.findOne({
      where: {
        uploadedBy: req.user!.id,
        storagePlatform: 'local',
        contentMd5: fileMd5,
        isDeleted: false,
      },
      order: [['updated_at', 'DESC']],
    });

    if (existing && fs.existsSync(existing.filePath.replace(/\\/g, '/'))) {
      await ensureMyFileLimit(task.userId, task.libraryId, task.storageScope);
      const file = await cloneDesignFileObject({
        userId: task.userId,
        sourceFile: existing,
        originalName: task.originalFilename,
        libraryId: task.libraryId,
        categoryId: task.categoryId,
        categoryTagIds: task.categoryTagIds || [],
        tagIds: task.tagIds || [],
        storageScope: task.storageScope,
        contentMd5: fileMd5,
        relativePath: task.relativePath,
        clientParseAssist: await readClientParseAssistTemp(clientParseAssistTempPath(task.id), clientPreviewTempPath(task.id)),
      });
      if (!file) throw new AppError('秒传落库失败', 500);
      await task.update({
        status: 'completed',
        fileId: file.id,
        objectKey: existing.filePath,
        uploadedChunks: task.totalChunks,
        errorMessage: null,
      });
      await cleanupMultipart(task.id);
      emitTaskEvent(task, { type: 'completed', progress: 100, fileId: file.id });
      res.json({ code: 200, message: '秒传成功', data: { completed: true, instant: true, file, missingChunks: [] } });
      return;
    }

    if (task.fileSize === 0) {
      const finalPath = buildFinalPath(task);
      await fs.promises.writeFile(finalPath, Buffer.alloc(0));
      const file = await finalizeTaskFromPath(task, finalPath);
      res.json({ code: 200, message: '空文件已创建', data: { completed: true, instant: false, file, missingChunks: [] } });
      return;
    }

    const chunks = await FileTransferChunk.findAll({ where: { taskId: task.id }, order: [['chunk_index', 'ASC']] });
    const uploaded = new Set(chunks.map((chunk) => chunk.chunkIndex));
    const missingChunks = Array.from({ length: task.totalChunks }, (_, index) => index).filter((index) => !uploaded.has(index));
    await task.update({ status: 'uploading', uploadedChunks: chunks.length });
    emitTaskEvent(task, { type: 'status', progress: taskProgress(task) });

    res.json({
      code: 200,
      message: '需要上传分片',
      data: {
        completed: false,
        instant: false,
        uploadedChunks: chunks.map((chunk) => ({ chunkIndex: chunk.chunkIndex, etag: chunk.etag, size: chunk.size })),
        missingChunks,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function chunks(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const task = await getOwnedTask(String(req.params.taskId), req.user!.id);
    const uploadedChunks = await FileTransferChunk.findAll({
      where: { taskId: task.id },
      order: [['chunk_index', 'ASC']],
    });

    res.json({
      code: 200,
      message: 'OK',
      data: uploadedChunks.map((chunk) => ({ chunkIndex: chunk.chunkIndex, etag: chunk.etag, size: chunk.size })),
    });
  } catch (err) {
    next(err);
  }
}

export async function uploadChunk(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const task = await getOwnedTask(String(req.params.taskId), req.user!.id);
    if (['completed', 'canceled', 'error'].includes(task.status)) throw new AppError('上传任务状态不可继续上传', 409);
    if (!req.file) throw new AppError('未上传分片', 400);

    const chunkIndex = Number(req.body.chunkIndex);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= task.totalChunks) {
      throw new AppError('分片序号无效', 400);
    }
    const expectedSize = Math.min(task.chunkSize, task.fileSize - chunkIndex * task.chunkSize);
    if (req.file.size !== expectedSize) throw new AppError('分片大小无效', 400);

    await fs.promises.mkdir(multipartDir(task.id), { recursive: true });
    const etag = crypto.createHash('md5').update(req.file.buffer).digest('hex');
    await fs.promises.writeFile(partPath(task.id, chunkIndex), req.file.buffer);

    const [row, created] = await FileTransferChunk.findOrCreate({
      where: { taskId: task.id, chunkIndex },
      defaults: { taskId: task.id, chunkIndex, etag, size: req.file.size },
    });
    if (!created) await row.update({ etag, size: req.file.size });

    const uploadedChunks = await FileTransferChunk.count({ where: { taskId: task.id } });
    await task.update({ status: 'uploading', uploadedChunks });
    emitTaskEvent(task, { type: 'progress', progress: taskProgress(task) });

    if (uploadedChunks >= task.totalChunks) submitMergeTask(task.id);

    res.json({
      code: 200,
      message: '分片上传成功',
      data: {
        taskId: task.id,
        chunkIndex,
        etag,
        uploadedChunks,
        totalChunks: task.totalChunks,
        status: uploadedChunks >= task.totalChunks ? 'merging' : task.status,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function merge(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const task = await getOwnedTask(String(req.params.taskId), req.user!.id);
    const uploadedChunks = await FileTransferChunk.count({ where: { taskId: task.id } });
    if (uploadedChunks < task.totalChunks) throw new AppError('分片尚未上传完成', 409);
    submitMergeTask(task.id);
    res.json({ code: 200, message: '已提交合并任务', data: { taskId: task.id, status: 'merging' } });
  } catch (err) {
    next(err);
  }
}

export async function status(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const task = await getOwnedTask(String(req.params.taskId), req.user!.id);
    const file = task.fileId ? await DesignFile.findByPk(task.fileId) : null;
    res.json({
      code: 200,
      message: 'OK',
      data: {
        taskId: task.id,
        status: task.status,
        progress: taskProgress(task),
        fileId: task.fileId,
        file,
        errorMessage: task.errorMessage,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function events(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const task = await getOwnedTask(String(req.params.taskId), req.user!.id);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    if (!sseClients.has(task.id)) sseClients.set(task.id, new Set());
    sseClients.get(task.id)!.add(res);
    emitTaskEvent(task, { type: 'status' });

    req.on('close', () => {
      const clients = sseClients.get(task.id);
      clients?.delete(res);
      if (clients?.size === 0) sseClients.delete(task.id);
    });
  } catch (err) {
    next(err);
  }
}

export async function cancel(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const task = await getOwnedTask(String(req.params.taskId), req.user!.id);
    if (task.status === 'completed') throw new AppError('已完成任务不能取消', 409);
    await task.update({ status: 'canceled', errorMessage: '用户取消上传' });
    await FileTransferChunk.destroy({ where: { taskId: task.id } });
    await cleanupMultipart(task.id);
    emitTaskEvent(task, { type: 'canceled', progress: taskProgress(task), message: task.errorMessage });
    res.json({ code: 200, message: '已取消上传任务', data: { taskId: task.id } });
  } catch (err) {
    next(err);
  }
}
