import { createHash } from 'crypto';

// Kept structural with shared/types; server's compiler root excludes that tree.
export interface ParseFreshness {
  state: 'ready' | 'queued' | 'parsing' | 'syncing' | 'failed';
  requiredVersion: number;
  resultVersion: number;
  revision: string | null;
}
type ParseStatus = 'pending' | 'parsing' | 'completed' | 'failed';

export type ParseQueuePhase = 'queued' | 'parsing' | 'finishing' | null;
export type FreshnessRecord = {
  parseStatus: string;
  parseResult?: Record<string, unknown> | null;
};

function stableMetadata(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableMetadata).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableMetadata(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Old successful results get a stable identity without a database migration. */
export function parseResultRevision(result: Record<string, unknown> | null | undefined): string | null {
  if (!result) return null;
  if (typeof result.parseRevision === 'string' && result.parseRevision.trim()) return result.parseRevision;
  return `legacy-${createHash('sha256').update(stableMetadata(result)).digest('hex')}`;
}

export function parsedVersion(record: FreshnessRecord, versionKey: string): number {
  const value = Number(record.parseResult?.[versionKey]);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Pure derivation: publication of other copies cannot delay this copy's ready result. */
export function deriveParseFreshness(input: {
  file: FreshnessRecord;
  source?: FreshnessRecord | null;
  versionKey: string;
  requiredVersion: number;
  canonicalHealthy: boolean;
  ownHealthy: boolean;
  queuePhase: ParseQueuePhase;
}): ParseFreshness {
  const canonical = input.source || input.file;
  const resultVersion = parsedVersion(input.file, input.versionKey);
  const revision = parseResultRevision(input.file.parseResult);
  const base = { requiredVersion: input.requiredVersion, resultVersion, revision };
  if (input.file.parseStatus === 'failed' || canonical.parseStatus === 'failed') return { ...base, state: 'failed' };
  const canonicalReady = canonical.parseStatus === 'completed'
    && parsedVersion(canonical, input.versionKey) >= input.requiredVersion && input.canonicalHealthy
    && input.queuePhase !== 'queued' && input.queuePhase !== 'parsing';
  if (canonicalReady) {
    const ownReady = input.file.parseStatus === 'completed' && resultVersion >= input.requiredVersion
      && input.ownHealthy && revision !== null && revision === parseResultRevision(canonical.parseResult);
    if (ownReady) return { ...base, state: 'ready' };
    return { ...base, state: input.source ? 'syncing' : 'queued' };
  }
  if (input.queuePhase === 'finishing') return { ...base, state: 'syncing' };
  if (input.queuePhase === 'parsing') return { ...base, state: 'parsing' };
  if (input.queuePhase === 'queued') return { ...base, state: 'queued' };
  return { ...base, state: canonical.parseStatus === 'parsing' ? 'parsing' : 'queued' };
}

export function effectiveParseStatus(freshness: ParseFreshness): ParseStatus {
  if (freshness.state === 'ready') return 'completed';
  if (freshness.state === 'failed') return 'failed';
  return freshness.state === 'parsing' ? 'parsing' : 'pending';
}
