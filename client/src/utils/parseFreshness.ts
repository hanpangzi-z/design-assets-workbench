import type { DesignFile, ParseFreshness } from 'shared/types';

export function shouldWaitForParseFreshness(file: DesignFile): boolean {
  if (file.parseFreshness) return !['ready', 'failed'].includes(file.parseFreshness.state);
  if (file.autoParseBlocked || file.sourceParseStatus === 'failed' || file.parseStatus === 'failed') return false;
  return [file.parseStatus, file.sourceParseStatus].some(status => status === 'pending' || status === 'parsing');
}

export function parseFreshnessMatches(expected: ParseFreshness | undefined, actual: ParseFreshness | undefined): boolean {
  if (!expected && !actual) return true;
  return Boolean(expected && actual && ['ready', 'failed'].includes(expected.state)
    && expected.state === actual.state && expected.requiredVersion === actual.requiredVersion
    && expected.resultVersion === actual.resultVersion && expected.revision === actual.revision);
}

export function getParseAssetRevision(file: DesignFile): string {
  return file.parseFreshness?.revision || String(file.updatedAt || file.id);
}

export function withUploadAssetRevision(src: string, revision: string | null, origin: string): string {
  if (!revision || !src || /^(?:data:|blob:)/i.test(src)) return src;
  try {
    const relative = src.replace(/^uploads\//, '/uploads/');
    const url = new URL(relative, origin);
    if (url.origin !== new URL(origin).origin || !url.pathname.startsWith('/uploads/')) return src;
    url.searchParams.set('v', revision);
    return /^(?:https?:)?\/\//i.test(src) ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
  } catch { return src; }
}

/** Refresh only this owned page's generated parser assets; never mutate saved work. */
export function refreshOwnedSavedAssetRevisions(
  state: Record<string, unknown>, file: DesignFile, origin: string,
): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  if (Number(state.__fileId) !== file.id || Number(state.__sourceFileId || 0) !== Number(file.sourceFileId || 0)) return cloned;
  const allowedIds = new Set([file.id, file.sourceFileId].filter(id => Number.isSafeInteger(id) && Number(id) > 0));
  const revision = getParseAssetRevision(file);
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const object = value as Record<string, unknown>;
    if (typeof object.src === 'string' && !/^(?:data:|blob:)/i.test(object.src)) {
      try {
        const url = new URL(object.src.replace(/^uploads\//, '/uploads/'), origin);
        const match = /^\/uploads\/parsed\/(\d+)\//.exec(url.pathname);
        if (url.origin === new URL(origin).origin && match && allowedIds.has(Number(match[1]))) {
          object.src = withUploadAssetRevision(object.src, revision, origin);
        }
      } catch { /* Keep malformed or external user sources unchanged. */ }
    }
    visit(object.objects);
    visit(object.clipPath);
  };
  visit(cloned.objects);
  visit(cloned.clipPath);
  return cloned;
}
