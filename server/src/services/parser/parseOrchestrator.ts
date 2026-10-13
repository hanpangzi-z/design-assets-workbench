import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Transaction } from 'sequelize';
import sequelize from '../../config/database';
import { STORAGE } from '../../config/storage';
import { DesignFile, ParsedLayer } from '../../models';
import { logger } from '../../utils/logger';
import { warmUploadThumbnailVariants } from '../uploadThumbnailVariants';
import { AI_PARSER_VERSION, PDF_PARSER_VERSION, PSD_PARSER_VERSION } from './parserVersions';
import { startParserWorker, type ParserWorkerRun } from './parserWorkerSupervisor';
import type { ClientParseAssistSnapshot } from './clientParseAssist';
import { publishParserResult, validateParserCandidate } from './parserExecution';

export type ParsePriority = 'interactive' | 'background';
type EnqueueParseOptions = {
  priority?: ParsePriority;
  syncPersonalCopyIds?: number[];
  syncAllPersonalCopies?: boolean;
  clientAssistSnapshot?: ClientParseAssistSnapshot | null;
  allowClientAssistWait?: boolean;
  resetSource?: boolean;
  preserveEditorState?: boolean;
};
type ParseQueueJob = {
  fileId: number;
  priority: ParsePriority;
  syncPersonalCopyIds: Set<number>;
  syncAllPersonalCopies: boolean;
  clientAssistSnapshot?: ClientParseAssistSnapshot | null;
  allowClientAssistWait: boolean;
  preparation: Promise<void>;
  phase: 'queued' | 'parsing' | 'finishing';
  worker?: ParserWorkerRun;
  completion?: Promise<void>;
  sourceCommitted: boolean;
};
const queues: Record<ParsePriority, ParseQueueJob[]> = { interactive: [], background: [] };
const jobs = new Map<number, ParseQueueJob>();
let activeCount = 0;
let stopping = false;
const configuredConcurrency = Number(process.env.PARSE_MAX_CONCURRENT || 1);
const MAX_CONCURRENT = Number.isInteger(configuredConcurrency) && configuredConcurrency > 0 ? configuredConcurrency : 1;

export function getParseQueuePhase(fileId: number): ParseQueueJob['phase'] | null {
  return jobs.get(fileId)?.phase || null;
}

function failureParseResult(fileType: string, error: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = { error: (error as Error)?.message || '解析失败' };
  if (fileType === 'psd') result.psdParserVersion = PSD_PARSER_VERSION;
  if (fileType === 'ai') result.aiParserVersion = AI_PARSER_VERSION;
  if (fileType === 'pdf') result.pdfParserVersion = PDF_PARSER_VERSION;
  return result;
}

function retainedFailure(file: DesignFile, error: unknown): Record<string, unknown> {
  const previous = file.parseResult;
  const retained = previous && (!previous.error || previous.hasRetainedResult === true) ? previous : null;
  const failure = failureParseResult(file.fileType, error);
  return { ...failure, ...(retained || {}), error: failure.error,
    ...(retained ? { hasRetainedResult: true, lastParseAttempt: failure } : {}) };
}

async function cloneLayers(sourceId: number, copyId: number, transaction: Transaction): Promise<void> {
  const layers = await ParsedLayer.findAll({ where: { fileId: sourceId }, order: [['sort_order', 'ASC'], ['id', 'ASC']], transaction });
  const pending = [...layers];
  const ids = new Map<number, number>();
  while (pending.length) {
    let progressed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const layer = pending[i];
      const sourceLayerId = layer.id;
      const sourceParentId = layer.parentLayerId;
      if (sourceParentId && !ids.has(sourceParentId)) continue;
      // Associations expose snake_case aliases that can overwrite these SQL fields.
      const copy = await ParsedLayer.create({
        fileId: copyId,
        layerName: layer.layerName,
        layerType: layer.layerType,
        parentLayerId: sourceParentId ? ids.get(sourceParentId) : null,
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
      ids.set(sourceLayerId, copy.id);
      pending.splice(i, 1); progressed = true;
    }
    if (!progressed) throw new Error('源图层包含无效父子关系');
  }
}

async function syncTargets(job: ParseQueueJob): Promise<void> {
  const source = await DesignFile.findByPk(job.fileId);
  if (!source || source.isPersonalCopy) return;
  const synced = new Set<number>();
  let loadedAll = false;
  while (true) {
    if (job.syncAllPersonalCopies && !loadedAll) {
      const copies = await DesignFile.findAll({ where: { sourceFileId: source.id, isPersonalCopy: true, isDeleted: false }, attributes: ['id'] });
      for (const copy of copies) job.syncPersonalCopyIds.add(copy.id);
      loadedAll = true;
    }
    const copyId = [...job.syncPersonalCopyIds].find(id => !synced.has(id));
    if (copyId === undefined) break;
    synced.add(copyId);
    const copy = await DesignFile.findByPk(copyId);
    if (!copy || copy.isDeleted || !copy.isPersonalCopy || copy.sourceFileId !== source.id || copy.fileType !== source.fileType) continue;
    try {
      await sequelize.transaction(async transaction => {
        const lockedSource = await DesignFile.findByPk(source.id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!lockedSource || lockedSource.isDeleted) return;
        const lockedCopy = await DesignFile.findByPk(copy.id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!lockedCopy || lockedCopy.isDeleted) return;
        if (lockedSource.parseStatus === 'completed') {
          await ParsedLayer.destroy({ where: { fileId: copy.id }, transaction });
          await cloneLayers(lockedSource.id, copy.id, transaction);
        }
        if (lockedSource.parseStatus === 'completed') {
          await lockedCopy.update({ thumbnailPath: lockedSource.thumbnailPath, width: lockedSource.width, height: lockedSource.height,
            parseStatus: lockedSource.parseStatus, parseResult: lockedSource.parseResult }, { transaction });
        } else if (lockedSource.parseStatus === 'failed') {
          // A failed source attempt must not attach its resource pointers to a different copy snapshot.
          await lockedCopy.update({ parseStatus: 'failed', parseResult: retainedFailure(lockedCopy,
            new Error(String(lockedSource.parseResult?.error || '源文件解析失败'))) }, { transaction });
        }
      });
    } catch (error) {
      logger.error({ scope: 'parser', fileId: source.id, copyId, err: error }, 'Parser: copy sync failed');
      const retainedCopy = await DesignFile.findByPk(copy.id);
      if (retainedCopy && !retainedCopy.isDeleted) await retainedCopy.update({ parseStatus: 'failed',
        parseResult: retainedFailure(retainedCopy, new Error('解析结果同步失败，请手动重试')) });
    }
  }
}

function mergeOptions(job: ParseQueueJob, options: EnqueueParseOptions): void {
  if (options.priority === 'interactive' && job.priority === 'background') {
    job.priority = 'interactive';
    // Promote only a waiting job. An occupied parser slot is never preempted.
    const index = queues.background.indexOf(job);
    if (job.phase === 'queued' && index !== -1) {
      queues.background.splice(index, 1);
      queues.interactive.push(job);
    }
  }
  const addedCopies: number[] = [];
  for (const id of options.syncPersonalCopyIds || []) {
    if (Number.isInteger(id) && id > 0 && !job.syncPersonalCopyIds.has(id)) {
      job.syncPersonalCopyIds.add(id); addedCopies.push(id);
    }
  }
  if (options.syncAllPersonalCopies) job.syncAllPersonalCopies = true;
  if (options.clientAssistSnapshot) job.clientAssistSnapshot = options.clientAssistSnapshot;
  if (options.allowClientAssistWait) job.allowClientAssistWait = true;
  if (addedCopies.length && job.phase !== 'finishing') {
    job.preparation = job.preparation.then(async () => {
      for (const id of addedCopies) {
        await DesignFile.update({ parseStatus: 'pending' }, {
          where: { id, sourceFileId: job.fileId, isPersonalCopy: true, isDeleted: false },
        });
      }
    });
  }
  job.worker?.updateAssist(job.clientAssistSnapshot, job.allowClientAssistWait);
}

export async function enqueueParse(fileId: number, options: EnqueueParseOptions = {}): Promise<void> {
  if (stopping) throw new Error('服务正在停止，请稍后重试');
  const existing = jobs.get(fileId);
  if (existing) {
    mergeOptions(existing, options);
    await existing.preparation;
    return;
  }
  const job: ParseQueueJob = { fileId, priority: options.priority === 'interactive' ? 'interactive' : 'background',
    syncPersonalCopyIds: new Set(), syncAllPersonalCopies: false,
    allowClientAssistWait: false, preparation: Promise.resolve(), phase: 'queued', sourceCommitted: false };
  // Claim the attempt before asynchronous writes: duplicates only merge.
  jobs.set(fileId, job);
  if (options.resetSource) {
    job.preparation = job.preparation.then(async () => {
      // Keep historical editor state and layers until the new layer transaction commits.
      await DesignFile.update({ parseStatus: 'pending' }, { where: { id: fileId, isDeleted: false } });
    });
  }
  mergeOptions(job, options);
  queues[job.priority].push(job);
  processQueue();
  await job.preparation;
}

function processQueue(): void {
  while (!stopping && activeCount < MAX_CONCURRENT && (queues.interactive.length || queues.background.length)) {
    const job = (queues.interactive.shift() || queues.background.shift())!;
    activeCount++;
    job.completion = executeJob(job).finally(() => {
      if (jobs.get(job.fileId) === job) jobs.delete(job.fileId);
      activeCount--;
      setImmediate(processQueue);
    });
  }
}

async function executeJob(job: ParseQueueJob): Promise<void> {
  let file: DesignFile | null = null;
  const resultDirectory = path.join(STORAGE.base, '_parser_jobs', randomUUID());
  const artifactDirectory = `parsed/${job.fileId}/${randomUUID()}`;
  const artifactPath = path.resolve(STORAGE.base, artifactDirectory);
  try {
    await job.preparation;
    if (stopping) throw new Error('服务重启，解析任务已中止，请手动重试');
    file = await DesignFile.findByPk(job.fileId);
    if (!file || file.isDeleted) return;
    job.phase = 'parsing';
    await file.update({ parseStatus: 'parsing' });
    logger.info({ scope: 'parser', fileId: file.id, name: file.name, type: file.fileType }, 'Parser: start');
    if (['psd', 'ai', 'pdf'].includes(file.fileType)) {
      await fs.mkdir(resultDirectory, { recursive: true });
      job.worker = startParserWorker({ fileId: file.id, resultPath: path.join(resultDirectory, 'result.json'),
        artifactDirectory,
        clientAssistSnapshot: job.clientAssistSnapshot, allowClientAssistWait: job.allowClientAssistWait });
      if (stopping) await job.worker.cancel('服务重启，解析任务已中止，请手动重试');
      const patch = await job.worker.result;
      if (stopping) throw new Error('服务重启，解析任务已中止，请手动重试');
      job.phase = 'finishing';
      await job.preparation;
      await validateParserCandidate(file.id, artifactDirectory, patch);
      patch.parseResult = { ...patch.parseResult, parseRevision: randomUUID() };
      await publishParserResult(file, patch);
      job.sourceCommitted = true;
      if (patch.thumbnailPath) warmUploadThumbnailVariants(patch.thumbnailPath);
    } else {
      job.phase = 'finishing';
      await file.update({ parseStatus: 'completed' });
      job.sourceCommitted = true;
    }
    await syncTargets(job);
    logger.info({ scope: 'parser', fileId: file.id }, 'Parser: completed');
  } catch (error) {
    logger.error({ scope: 'parser', fileId: job.fileId, err: error }, 'Parser: failed');
    if (!job.sourceCommitted) {
      job.phase = 'finishing';
      try { await job.preparation; } catch { /* Persist preparation failure as a terminal result. */ }
      try {
        file = file || await DesignFile.findByPk(job.fileId);
        if (file && !file.isDeleted) {
          await file.update({ parseStatus: 'failed', parseResult: retainedFailure(file, error) });
          await syncTargets(job);
        }
      } catch (updateError) {
        logger.error({ scope: 'parser', fileId: job.fileId, err: updateError }, 'Parser: failed to persist terminal state');
      }
    }
  } finally {
    // The directory is constructed here, never accepted from a worker or request.
    const expectedParent = path.resolve(STORAGE.base, 'parsed', String(job.fileId));
    if (!job.sourceCommitted && path.dirname(artifactPath) === expectedParent) {
      await fs.rm(artifactPath, { recursive: true, force: true }).catch(error => {
        logger.warn({ scope: 'parser', fileId: job.fileId, err: error }, 'Parser: candidate cleanup failed');
      });
    }
    // Close the merge window synchronously before asynchronous artifact cleanup.
    if (jobs.get(job.fileId) === job) jobs.delete(job.fileId);
    if (path.dirname(path.resolve(resultDirectory)) === path.resolve(STORAGE.base, '_parser_jobs')) await fs.rm(resultDirectory, { recursive: true, force: true }).catch(error => {
      logger.warn({ scope: 'parser', fileId: job.fileId, err: error }, 'Parser: result cleanup failed');
    });
  }
}

export async function shutdownParseQueue(): Promise<void> {
  stopping = true;
  const reason = '服务重启，解析任务已中止，请手动重试';
  const queued = [...queues.interactive.splice(0), ...queues.background.splice(0)];
  await Promise.all([...jobs.values()].map(async job => {
    if (job.worker) await job.worker.cancel(reason);
  }));
  await Promise.all(queued.map(async job => {
    try { await job.preparation; } catch { /* Mark interrupted queued jobs as well. */ }
    const file = await DesignFile.findByPk(job.fileId);
    job.phase = 'finishing';
    if (file && !file.isDeleted) {
      await file.update({ parseStatus: 'failed', parseResult: retainedFailure(file, new Error(reason)) });
      await syncTargets(job);
    }
    jobs.delete(job.fileId);
  }));
  await Promise.all([...jobs.values()].map(job => job.completion));
}
