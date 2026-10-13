import { AsyncLocalStorage } from 'async_hooks';
import path from 'path';
import fs from 'fs/promises';
import sharp from 'sharp';
import type { Transaction } from 'sequelize';
import sequelize from '../../config/database';
import { DesignFile, ParsedLayer } from '../../models';
import { STORAGE } from '../../config/storage';

type ParserFilePatch = {
  parseStatus?: 'parsing' | 'completed' | 'failed';
  parseResult?: Record<string, unknown> | null;
  thumbnailPath?: string | null;
  width?: number | null;
  height?: number | null;
};

export type ParserFinalPatch = {
  parseStatus: 'completed';
  parseResult: Record<string, unknown>;
  thumbnailPath?: string | null;
  width?: number | null;
  height?: number | null;
  /** Internal worker manifest; never persisted as file metadata. */
  layers?: StagedParserLayer[];
};

export type StagedParserLayer = Record<string, unknown> & {
  id: number;
  fileId: number;
  parentLayerId: number | null;
};

type ParserExecutionContext = {
  fileId: number;
  transaction?: Transaction;
  patch: ParserFilePatch;
  layers?: StagedParserLayer[];
  artifactDirectory?: string;
};

const executionContext = new AsyncLocalStorage<ParserExecutionContext>();

export function isIsolatedParser(): boolean {
  return Boolean(executionContext.getStore());
}

export function getParserLayerTransaction(): Transaction | undefined {
  return executionContext.getStore()?.transaction;
}

export function getParserArtifactDirectory(fileId: number): string | undefined {
  const context = executionContext.getStore();
  if (context && context.fileId !== fileId) throw new Error('Parser attempted to access another file');
  return context?.artifactDirectory;
}

export function getParserOutputDirectory(fileId: number): string {
  return path.join(STORAGE.base, getParserArtifactDirectory(fileId) || `parsed/${fileId}`);
}

export function getParserRelativeOutputPath(fileId: number, filename: string): string {
  return `${getParserArtifactDirectory(fileId) || `parsed/${fileId}`}/${path.basename(filename)}`;
}

export function getParserThumbnailPath(fileId: number): string {
  return getParserArtifactDirectory(fileId)
    ? getParserRelativeOutputPath(fileId, 'thumbnail.png')
    : `thumbnails/${fileId}_thumb.png`;
}

function stageLayer(values: Record<string, unknown>): StagedParserLayer | undefined {
  const context = executionContext.getStore();
  if (!context?.layers) return undefined;
  if (values.fileId !== context.fileId) throw new Error('Parser attempted to create another file layer');
  const layer = { ...values, id: -(context.layers.length + 1), fileId: context.fileId,
    parentLayerId: (values.parentLayerId as number | null | undefined) ?? null };
  context.layers.push(layer);
  return layer;
}

/** Parsers use the same store for direct calls and candidate-only worker calls. */
export const ParserLayerStore = {
  async create(values: Record<string, unknown>, options?: object) {
    return stageLayer(values) || ParsedLayer.create(values as any, options);
  },
  async bulkCreate(values: Record<string, unknown>[], options?: object) {
    if (executionContext.getStore()?.layers) return values.map(value => stageLayer(value)!);
    return ParsedLayer.bulkCreate(values as any[], options);
  },
  async destroy(options: { where: { fileId: number }; transaction?: Transaction }) {
    const context = executionContext.getStore();
    if (context?.layers) {
      if (options.where.fileId !== context.fileId) throw new Error('Parser attempted to destroy another file layers');
      context.layers.length = 0;
      return 0;
    }
    return ParsedLayer.destroy(options);
  },
};

/** No live rows are changed before a successful child exit and publication. */
export async function runStagedParser(fileId: number, artifactDirectory: string,
  operation: () => Promise<void>): Promise<ParserFinalPatch> {
  const context: ParserExecutionContext = { fileId, patch: {}, layers: [], artifactDirectory };
  return executionContext.run(context, async () => {
    await operation();
    if (context.patch.parseStatus !== 'completed' || !context.patch.parseResult) {
      throw new Error(String(context.patch.parseResult?.error || 'Parser did not produce a completed result'));
    }
    const result = context.patch.parseResult;
    result.artifactDirectory = artifactDirectory;
    if (!Array.isArray(result.diagnostics)) {
      result.diagnostics = typeof result.warning === 'string' && result.warning
        ? [{ code: 'conversion-warning', severity: 'warning', message: result.warning }]
        : [];
    }
    return { ...context.patch, layers: context.layers } as ParserFinalPatch;
  });
}

export async function publishParserResult(file: DesignFile, result: ParserFinalPatch): Promise<void> {
  const { layers, ...patch } = result;
  if (!layers) { await file.update(patch); return; }
  const seen = new Set<number>();
  for (const layer of layers) {
    if (!Number.isInteger(layer.id) || layer.id >= 0 || seen.has(layer.id) || layer.fileId !== file.id) {
      throw new Error('解析候选图层标识无效');
    }
    seen.add(layer.id);
  }
  for (const layer of layers) {
    if (layer.parentLayerId !== null && !seen.has(layer.parentLayerId)) throw new Error('解析候选图层父子关系无效');
  }
  await sequelize.transaction(async transaction => {
    const locked = await DesignFile.findByPk(file.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!locked || locked.isDeleted) throw new Error('待发布文件已删除');
    await ParsedLayer.destroy({ where: { fileId: file.id }, transaction });
    const pending = [...layers];
    const ids = new Map<number, number>();
    while (pending.length) {
      let progressed = false;
      for (let i = 0; i < pending.length;) {
        const layer = pending[i];
        if (layer.parentLayerId !== null && !ids.has(layer.parentLayerId)) { i++; continue; }
        const { id, ...values } = layer;
        const created = await ParsedLayer.create({ ...values, fileId: file.id,
          parentLayerId: layer.parentLayerId === null ? null : ids.get(layer.parentLayerId)! } as any, { transaction });
        ids.set(id, created.id);
        pending.splice(i, 1);
        progressed = true;
      }
      if (!progressed) throw new Error('解析候选图层包含循环关系');
    }
    await locked.update(patch, { transaction });
  });
  file.set(patch);
}

/** Validate candidate assets before entering the publication transaction. */
export async function validateParserCandidate(fileId: number, artifactDirectory: string,
  result: ParserFinalPatch): Promise<void> {
  const directory = path.resolve(STORAGE.base, artifactDirectory);
  if (path.dirname(directory) !== path.resolve(STORAGE.base, 'parsed', String(fileId))
      || result.parseResult.artifactDirectory !== artifactDirectory || !Array.isArray(result.layers)) {
    throw new Error('解析候选资源目录或图层清单无效');
  }
  const prefix = `${artifactDirectory}/`;
  const assets = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && value.startsWith(prefix)) assets.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(result.parseResult);
  collect(result.layers);
  if (result.thumbnailPath) {
    if (!result.thumbnailPath.startsWith(prefix)) throw new Error('解析缩略图不属于本次候选结果');
    assets.add(result.thumbnailPath);
  }
  for (const layer of result.layers) {
    if (layer.imagePath && (typeof layer.imagePath !== 'string' || !layer.imagePath.startsWith(prefix))) {
      throw new Error('解析图层资源不属于本次候选结果');
    }
  }
  // Decode sequentially without allocating another complete image buffer.
  for (const relative of assets) {
    const absolute = path.resolve(STORAGE.base, relative);
    const within = path.relative(directory, absolute);
    if (!within || within.startsWith('..') || path.isAbsolute(within)) throw new Error('解析资源路径超出候选目录');
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size === 0) throw new Error(`解析资源为空：${relative}`);
    if (/\.(png|jpe?g|webp)$/i.test(relative)) {
      try { await sharp(absolute, { failOn: 'warning' }).stats(); }
      catch { throw new Error(`解析图片无效：${relative}`); }
    }
  }
}

export async function updateParserFile(file: DesignFile, patch: ParserFilePatch): Promise<void> {
  const context = executionContext.getStore();
  if (!context) {
    await file.update(patch);
    return;
  }
  if (context.fileId !== file.id) throw new Error('Parser attempted to update another file');
  // The HTTP process owns status and result commits, including the initial parsing status.
  if (patch.parseStatus === 'parsing') return;
  Object.assign(context.patch, patch);
  file.set(patch);
}

export async function runIsolatedParser(
  fileId: number,
  operation: () => Promise<void>,
): Promise<ParserFinalPatch> {
  return sequelize.transaction(async (transaction) => {
    const context: ParserExecutionContext = { fileId, transaction, patch: {} };
    return executionContext.run(context, async () => {
      await operation();
      if (context.patch.parseStatus !== 'completed' || !context.patch.parseResult) {
        const error = context.patch.parseResult?.error;
        throw new Error(typeof error === 'string' ? error : 'Parser did not produce a completed result');
      }
      return context.patch as ParserFinalPatch;
    });
  });
}
