import { create } from 'zustand';
import type { DesignFile } from 'shared/types';
import { getFiles, type FileListParams } from '@/api/files';

interface FileState {
  files: DesignFile[];
  total: number;
  page: number;
  pageSize: number;
  isLoading: boolean;
  hasLoaded: boolean;
  loadError: string | null;
  loadMoreExhausted: boolean;
  filters: FileListParams;

  setFilters: (filters: Partial<FileListParams>) => void;
  fetchFiles: (params?: FileListParams, options?: { append?: boolean; preserveLoadedPage?: boolean }) => Promise<void>;
  setPage: (page: number) => void;
}

function mergeFiles(current: DesignFile[], next: DesignFile[]) {
  const seenIds = new Set<number>();
  const merged: DesignFile[] = [];
  [...current, ...next].forEach((file) => {
    if (seenIds.has(file.id)) return;
    seenIds.add(file.id);
    merged.push(file);
  });
  return merged;
}

let latestRequestId = 0;

function compactParams(params: FileListParams): FileListParams {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '')
  ) as FileListParams;
}

function paramsKey(params: FileListParams): string {
  return JSON.stringify(
    Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

const useFileStore = create<FileState>((set, get) => ({
  files: [],
  total: 0,
  page: 1,
  pageSize: 40,
  isLoading: false,
  hasLoaded: false,
  loadError: null,
  loadMoreExhausted: false,
  filters: {},

  setFilters: (filters) => {
    const nextFilters = compactParams(filters);
    const state = get();
    if (paramsKey(nextFilters) === paramsKey(state.filters)) {
      if (state.files.length === 0 && !state.isLoading) {
        void get().fetchFiles({ page: 1 });
      }
      return;
    }
    latestRequestId += 1;
    set(() => ({
      filters: nextFilters,
      files: [],
      total: 0,
      page: 1,
      hasLoaded: false,
      loadError: null,
      loadMoreExhausted: false,
    }));
    get().fetchFiles();
  },

  fetchFiles: async (params, options) => {
    const requestId = ++latestRequestId;
    set({ isLoading: true, loadError: null });
    try {
      const state = get();
      const queryParams = compactParams({
        page: state.page,
        pageSize: state.pageSize,
        ...state.filters,
        ...params,
      });
      const data = await getFiles(queryParams);
      if (requestId !== latestRequestId) return;
      set((current) => {
        if (requestId !== latestRequestId) return current;
        const nextFiles = options?.append ? mergeFiles(current.files, data.list) : data.list;
        const loadedPage = Math.max(1, Math.ceil(nextFiles.length / state.pageSize));
        const requestedPageSize = Number(queryParams.pageSize || state.pageSize) || state.pageSize;
        const requestedPage = Number(queryParams.page || state.page) || state.page;
        const lastPage = Math.max(1, Math.ceil(data.pagination.total / requestedPageSize));
        const appendedNothing = options?.append === true && nextFiles.length === current.files.length;
        const loadMoreExhausted = nextFiles.length >= data.pagination.total
          || data.list.length === 0
          || data.list.length < requestedPageSize
          || requestedPage >= lastPage
          || appendedNothing;
        return {
          files: nextFiles,
          total: data.pagination.total,
          page: options?.preserveLoadedPage ? Math.max(data.pagination.page, loadedPage) : data.pagination.page,
          isLoading: false,
          hasLoaded: true,
          loadError: null,
          loadMoreExhausted,
        };
      });
    } catch {
      if (requestId === latestRequestId) set({ isLoading: false, loadError: '模板列表加载失败，请检查服务连接后重试。' });
    }
  },

  setPage: (page) => {
    set({ page, loadMoreExhausted: false });
    get().fetchFiles();
  },
}));

export default useFileStore;
