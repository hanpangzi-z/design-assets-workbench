import api from './index';
import type { Category } from 'shared/types';

type CategoryTreeOptions = {
  dimension?: string;
  libraryId?: number;
  includePersonal?: boolean;
};

const CATEGORY_TREE_CACHE_MS = 60 * 1000;
const categoryTreeCache = new Map<string, { expiresAt: number; data: Category[] }>();

function normalizeTreeOptions(dimensionOrOptions?: string | CategoryTreeOptions, libraryId?: number): CategoryTreeOptions {
  if (typeof dimensionOrOptions === 'string') return { dimension: dimensionOrOptions, libraryId };
  return dimensionOrOptions || (libraryId ? { libraryId } : {});
}

function getCategoryTreeCacheKey(params: CategoryTreeOptions) {
  return JSON.stringify({
    dimension: params.dimension || '',
    libraryId: params.libraryId ?? '',
    includePersonal: params.includePersonal === true,
  });
}

function clearCategoryTreeCache() {
  categoryTreeCache.clear();
}

export async function getCategoryTree(dimensionOrOptions?: string | CategoryTreeOptions, libraryId?: number) {
  const params = normalizeTreeOptions(dimensionOrOptions, libraryId);
  const cacheKey = getCategoryTreeCacheKey(params);
  const cached = categoryTreeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const res = await api.get<{ code: number; data: Category[] }>('/categories/tree', { params });
  const data = res.data.data;
  categoryTreeCache.set(cacheKey, { data, expiresAt: Date.now() + CATEGORY_TREE_CACHE_MS });
  return data;
}

export async function getCategoryById(id: number) {
  const res = await api.get<{ code: number; data: Category }>(`/categories/${id}`);
  return res.data.data;
}

export async function createCategory(data: { name: string; parentId?: number | null; description?: string; icon?: string; dimension?: string; sortOrder?: number; libraryId?: number }) {
  const res = await api.post<{ code: number; data: Category }>('/categories', data);
  clearCategoryTreeCache();
  return res.data.data;
}

export async function updateCategory(id: number, data: Partial<{ name: string; parentId: number | null; description: string; icon: string; dimension: string; sortOrder: number }>) {
  const res = await api.put<{ code: number; data: Category }>(`/categories/${id}`, data);
  clearCategoryTreeCache();
  return res.data.data;
}

export async function deleteCategory(id: number) {
  await api.delete(`/categories/${id}`);
  clearCategoryTreeCache();
}

export async function batchUpdateSort(items: Array<{ id: number; sortOrder: number; parentId?: number | null }>) {
  await api.put('/categories/batch-sort', { items });
  clearCategoryTreeCache();
}
