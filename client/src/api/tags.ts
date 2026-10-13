import api from './index';
import type { Tag } from 'shared/types';

export async function getTags() {
  const res = await api.get<{ code: number; data: Tag[] }>('/tags');
  return res.data.data;
}

export async function getPopularTags() {
  const res = await api.get<{ code: number; data: Tag[] }>('/tags/popular');
  return res.data.data;
}

export async function createTag(data: { name: string; color?: string }) {
  const res = await api.post<{ code: number; data: Tag }>('/tags', data);
  return res.data.data;
}

export async function updateTag(id: number, data: Partial<{ name: string; color: string }>) {
  const res = await api.put<{ code: number; data: Tag }>(`/tags/${id}`, data);
  return res.data.data;
}

export async function deleteTag(id: number) {
  await api.delete(`/tags/${id}`);
}
