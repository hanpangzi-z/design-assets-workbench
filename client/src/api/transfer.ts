import api from './index';
import type { DesignFile } from 'shared/types';
import { clearFileListCache } from '@/api/files';
import { generateClientUploadPreview, type ClientUploadPreview } from '@/utils/clientUploadPreview';
import { stripClientParseAssistPreview } from '@/utils/clientParseAssist';
import { calculateFileMd5 } from '@/utils/fileMd5';

export const FALLBACK_TRANSFER_CHUNK_SIZE = 4 * 1024 * 1024;

export interface TransferConfig {
  chunkSize: number;
  uploadConcurrency: number;
  maxBatchFiles: number;
  maxFileSize: number;
  maxTotalSize: number;
}

export interface TransferMetadata {
  libraryId?: number;
  categoryId?: number;
  categoryTagIds?: number[];
  tagIds?: number[];
  storageScope?: 'my';
  relativePath?: string;
  clientPreview?: ClientUploadPreview | null;
}

type TransferProgressPhase = 'hashing' | 'uploading' | 'merging' | 'done';

export interface TransferProgress {
  phase: TransferProgressPhase;
  percent: number;
}

interface InitUploadResult {
  taskId: string;
  chunkSize: number;
  totalChunks: number;
  uploadConcurrency: number;
}

interface UploadedChunk {
  chunkIndex: number;
  etag: string;
  size: number;
}

interface CheckUploadResult {
  completed: boolean;
  instant: boolean;
  file?: DesignFile;
  uploadedChunks?: UploadedChunk[];
  missingChunks?: number[];
}

interface TransferStatusResult {
  taskId: string;
  status: 'initialized' | 'uploading' | 'merging' | 'completed' | 'error' | 'canceled';
  progress: number;
  fileId?: number | null;
  file?: DesignFile | null;
  errorMessage?: string | null;
}

let transferConfigPromise: Promise<TransferConfig> | null = null;

export async function getTransferConfig() {
  if (!transferConfigPromise) {
    transferConfigPromise = api
      .get<{ code: number; data: TransferConfig }>('/transfer/config')
      .then((res) => res.data.data)
      .catch((error) => {
        transferConfigPromise = null;
        throw error;
      });
  }
  return transferConfigPromise;
}

export async function initUpload(file: File, metadata: TransferMetadata, config: TransferConfig) {
  const res = await api.post<{ code: number; data: InitUploadResult }>('/transfer/init', {
    filename: file.name,
    fileSize: file.size,
    chunkSize: config.chunkSize,
    libraryId: metadata.libraryId,
    categoryId: metadata.categoryId,
    categoryTagIds: metadata.categoryTagIds,
    tagIds: metadata.tagIds,
    storageScope: metadata.storageScope,
    relativePath: metadata.relativePath,
    clientThumbnailDataUrl: metadata.clientPreview?.dataUrl,
    clientPreviewWidth: metadata.clientPreview?.width,
    clientPreviewHeight: metadata.clientPreview?.height,
    clientPreviewSource: metadata.clientPreview?.source,
    clientParseAssist: metadata.clientPreview?.parseAssist
      ? JSON.stringify(stripClientParseAssistPreview(metadata.clientPreview.parseAssist))
      : undefined,
  });
  return res.data.data;
}

export async function checkUpload(taskId: string, fileMd5: string) {
  const res = await api.post<{ code: number; data: CheckUploadResult }>('/transfer/check', { taskId, fileMd5 });
  return res.data.data;
}

export async function getUploadedChunks(taskId: string) {
  const res = await api.get<{ code: number; data: UploadedChunk[] }>(`/transfer/chunks/${taskId}`);
  return res.data.data;
}

export async function uploadChunk(taskId: string, chunkIndex: number, chunk: Blob) {
  const formData = new FormData();
  formData.append('chunkIndex', String(chunkIndex));
  formData.append('chunk', chunk, `${taskId}-${chunkIndex}.part`);
  const res = await api.post(`/transfer/chunk/${taskId}`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data.data;
}

export async function getTransferStatus(taskId: string) {
  const res = await api.get<{ code: number; data: TransferStatusResult }>(`/transfer/status/${taskId}`);
  return res.data.data;
}

export async function cancelTransferUpload(taskId: string) {
  await api.delete(`/transfer/${taskId}`);
}

export async function uploadFileByTransfer(
  file: File,
  metadata: TransferMetadata,
  onProgress?: (progress: TransferProgress) => void,
) {
  const config = await getTransferConfig();
  if (file.size > config.maxFileSize) {
    throw new Error(`${file.name} 超过 ${formatLimit(config.maxFileSize)}`);
  }

  onProgress?.({ phase: 'hashing', percent: 1 });

  const clientPreview = metadata.clientPreview === undefined
    ? await generateClientUploadPreview(file)
    : metadata.clientPreview;
  const init = await initUpload(file, { ...metadata, clientPreview }, config);

  const fileMd5 = await calculateFileMd5(file, (percent) => {
    onProgress?.({ phase: 'hashing', percent: Math.min(10, Math.max(1, Math.round(percent * 0.1))) });
  });

  const checked = await checkUpload(init.taskId, fileMd5);
  if (checked.completed && checked.file) {
    onProgress?.({ phase: 'done', percent: 100 });
    clearFileListCache();
    return checked.file;
  }

  const uploadedChunks = await getUploadedChunks(init.taskId);
  const uploadedSet = new Set(uploadedChunks.map((chunk) => chunk.chunkIndex));
  const missingChunks = (checked.missingChunks && checked.missingChunks.length > 0)
    ? checked.missingChunks
    : Array.from({ length: init.totalChunks }, (_, index) => index).filter((index) => !uploadedSet.has(index));

  let completedChunks = init.totalChunks - missingChunks.length;
  const reportUploadProgress = () => {
    const uploadPercent = init.totalChunks === 0 ? 85 : Math.round((completedChunks / init.totalChunks) * 85);
    onProgress?.({ phase: 'uploading', percent: Math.min(95, 10 + uploadPercent) });
  };
  reportUploadProgress();

  await runQueue(missingChunks, Math.max(1, init.uploadConcurrency || config.uploadConcurrency), async (chunkIndex) => {
    const start = chunkIndex * init.chunkSize;
    const end = Math.min(start + init.chunkSize, file.size);
    await uploadChunk(init.taskId, chunkIndex, file.slice(start, end));
    completedChunks += 1;
    reportUploadProgress();
  });

  onProgress?.({ phase: 'merging', percent: 95 });
  const status = await waitForTransferDone(init.taskId, (percent) => {
    onProgress?.({ phase: 'merging', percent });
  });
  if (!status.file) throw new Error('上传完成但未返回文件信息');
  onProgress?.({ phase: 'done', percent: 100 });
  clearFileListCache();
  return status.file;
}

async function waitForTransferDone(taskId: string, onProgress?: (percent: number) => void) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const status = await getTransferStatus(taskId);
    if (status.status === 'completed') return status;
    if (status.status === 'error') throw new Error(status.errorMessage || '上传合并失败');
    if (status.status === 'canceled') throw new Error('上传已取消');
    onProgress?.(Math.max(95, status.progress || 95));
    await wait(1000);
  }
  throw new Error('等待上传合并超时');
}

async function runQueue<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatLimit(bytes: number) {
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}
