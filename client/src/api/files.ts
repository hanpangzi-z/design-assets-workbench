import api from './index';
import type { DesignFile, PaginatedData } from 'shared/types';
import type { ClientParseAssist } from '@/utils/clientParseAssist';

export interface FileListParams {
  page?: number;
  pageSize?: number;
  keyword?: string;
  libraryId?: number;
  categoryId?: number;
  categoryIds?: string;
  includeChildren?: boolean;
  uncategorized?: boolean;
  fileType?: string;
  tagIds?: string;
  scope?: 'my';
  myView?: 'space' | 'recent' | 'favorites' | 'drafts' | 'trash' | 'shares' | 'publish';
  includePersonal?: boolean;
  sortBy?: string;
  sortOrder?: string;
}

type FileListData = PaginatedData<DesignFile>;

const FILE_LIST_CACHE_TTL_MS = 1200;
const MAX_FILE_LIST_CACHE_ENTRIES = 20;

const fileListCache = new Map<string, { data: FileListData; cachedAt: number }>();
const pendingFileListRequests = new Map<string, Promise<FileListData>>();

function getFileListCacheKey(params: FileListParams) {
  return JSON.stringify(
    Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function rememberFileList(key: string, data: FileListData) {
  if (fileListCache.size >= MAX_FILE_LIST_CACHE_ENTRIES) {
    const oldestKey = fileListCache.keys().next().value;
    if (oldestKey) fileListCache.delete(oldestKey);
  }
  fileListCache.set(key, { data, cachedAt: Date.now() });
}

export function clearFileListCache() {
  fileListCache.clear();
  pendingFileListRequests.clear();
}

export async function getFiles(params: FileListParams = {}, options: { force?: boolean } = {}) {
  const cacheKey = getFileListCacheKey(params);
  const cached = fileListCache.get(cacheKey);
  if (!options.force && cached && Date.now() - cached.cachedAt < FILE_LIST_CACHE_TTL_MS) {
    return cached.data;
  }
  if (!options.force) {
    const pending = pendingFileListRequests.get(cacheKey);
    if (pending) return pending;
  }

  const requestParams = { _t: `${Date.now()}-${Math.random().toString(36).slice(2)}`, ...params };
  const request = api.get<{ code: number; data: PaginatedData<DesignFile> }>('/files', {
    params: requestParams,
    headers: {
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  })
    .then((res) => {
      const data = res.data.data;
      rememberFileList(cacheKey, data);
      return data;
    });

  if (!options.force) pendingFileListRequests.set(cacheKey, request);
  try {
    return await request;
  } finally {
    pendingFileListRequests.delete(cacheKey);
  }
}

export async function getFileById(id: number) {
  const res = await api.get<{ code: number; data: DesignFile }>(`/files/${id}`);
  return res.data.data;
}

export async function useTemplate(id: number) {
  const res = await api.post<{ code: number; data: DesignFile }>(`/files/${id}/use-template`);
  clearFileListCache();
  return res.data.data;
}

export async function uploadFile(formData: FormData, onProgress?: (percent: number) => void) {
  const res = await api.post<{ code: number; data: DesignFile }>('/files/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: (e) => {
      if (onProgress && e.total) {
        onProgress(Math.round((e.loaded * 100) / e.total));
      }
    },
  });
  clearFileListCache();
  return res.data.data;
}

export async function updateFile(id: number, data: Partial<{ name: string; categoryId: number | null; categoryTagIds: number[]; tagIds: number[] }>) {
  const res = await api.put<{ code: number; data: DesignFile }>(`/files/${id}`, data);
  clearFileListCache();
  return res.data.data;
}

export async function updateMyFileMeta(id: number, data: Partial<Pick<DesignFile, 'isFavorite' | 'isDraft' | 'isShared' | 'isPublished'>>) {
  const res = await api.patch<{ code: number; data: DesignFile }>(`/files/${id}/my-meta`, data);
  clearFileListCache();
  return res.data.data;
}

export async function deleteFile(id: number) {
  await api.delete(`/files/${id}`);
  clearFileListCache();
}

export async function deleteFiles(ids: number[]) {
  const res = await api.post<{ code: number; data: { count: number } }>('/files/batch/delete', { ids });
  clearFileListCache();
  return res.data.data;
}

export async function restoreFile(id: number) {
  const res = await api.patch<{ code: number; data: DesignFile }>(`/files/${id}/restore`);
  clearFileListCache();
  return res.data.data;
}

export async function restoreFiles(ids: number[]) {
  const res = await api.post<{ code: number; data: { count: number } }>('/files/batch/restore', { ids });
  clearFileListCache();
  return res.data.data;
}

export async function deleteFilePermanently(id: number) {
  await api.delete(`/files/${id}/permanent`);
  clearFileListCache();
}

export async function deleteFilesPermanently(ids: number[]) {
  const res = await api.delete<{ code: number; data: { count: number } }>('/files/batch/permanent', { data: { ids } });
  clearFileListCache();
  return res.data.data;
}

export async function downloadFile(id: number) {
  const res = await api.get(`/files/${id}/download`, { responseType: 'blob', timeout: 120000 });
  return res.data;
}

export async function downloadFileBlob(id: number) {
  const res = await api.get<Blob>(`/files/${id}/download`, { responseType: 'blob', timeout: 120000 });
  return res.data;
}

export async function submitClientParseAssist(id: number, assist: ClientParseAssist) {
  const res = await api.post<{ code: number; data: { queued: boolean } }>(`/files/${id}/parse-assist`, {
    clientParseAssist: assist,
  });
  return res.data.data;
}

export function buildFileDownloadUrl(id: number) {
  const params = new URLSearchParams({
    _t: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  });
  const token = localStorage.getItem('accessToken');
  if (token) params.set('downloadToken', token);
  return `/api/v1/files/${id}/download?${params.toString()}`;
}

export function triggerFileDownload(id: number, filename?: string) {
  const link = document.createElement('a');
  link.href = buildFileDownloadUrl(id);
  if (filename) link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export async function getParseStatus(id: number) {
  const res = await api.get<{ code: number; data: { parseStatus: string; parseResult: unknown } }>(`/files/${id}/parse-status`);
  return res.data.data;
}

export async function saveEditorState(id: number, editorState: unknown) {
  await api.put(`/files/${id}/editor-state`, { editorState });
  clearFileListCache();
}

export async function getEditorState(id: number) {
  const res = await api.get<{ code: number; data: { editorState: unknown; width: number; height: number } }>(`/files/${id}/editor-state`);
  return res.data.data;
}
