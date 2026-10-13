import api from './index';

export interface LibrarySummary {
  id: number;
  name: string;
  description?: string | null;
  templateCount?: number;
  materialCount?: number;
  owner?: { id: number; displayName: string };
  isPinned?: boolean | number | string | null;
  pinnedAt?: string | Date | null;
}

const LIBRARIES_CACHE_TTL_MS = 60_000;

let cachedLibraries: LibrarySummary[] | null = null;
let cachedAt = 0;
let pendingRequest: Promise<LibrarySummary[]> | null = null;

export async function getLibraries<T extends LibrarySummary = LibrarySummary>(options: { force?: boolean } = {}): Promise<T[]> {
  const now = Date.now();
  if (!options.force && cachedLibraries && now - cachedAt < LIBRARIES_CACHE_TTL_MS) {
    return cachedLibraries as T[];
  }
  if (!options.force && pendingRequest) return pendingRequest as Promise<T[]>;

  pendingRequest = api.get<{ code: number; data: LibrarySummary[] }>('/libraries')
    .then((res) => {
      cachedLibraries = res.data?.data || [];
      cachedAt = Date.now();
      return cachedLibraries;
    })
    .finally(() => {
      pendingRequest = null;
    });

  return pendingRequest as Promise<T[]>;
}

export function clearLibrariesCache() {
  cachedLibraries = null;
  cachedAt = 0;
  pendingRequest = null;
}
