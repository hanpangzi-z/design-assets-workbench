import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import pinoHttp from 'pino-http';
import { DataTypes, Op, QueryTypes } from 'sequelize';
import { sequelize, Library, DesignFile, Category, Role, User } from './models';
import { errorHandler } from './middleware/errorHandler';
import { BUILT_IN_ROLES } from './constants/roles';
import authRoutes from './routes/auth';
import categoryRoutes from './routes/categories';
import tagRoutes from './routes/tags';
import fileRoutes from './routes/files';
import userRoutes from './routes/users';
import libraryRoutes from './routes/libraries';
import fontRoutes from './routes/fonts';
import transferRoutes from './routes/transfer';
import uploadThumbnailRoutes from './routes/uploadThumbnails';
import { STORAGE } from './config/storage';
import { enqueueParse, shutdownParseQueue } from './services/parser/parseOrchestrator';
import { AI_PARSER_VERSION, PDF_PARSER_VERSION, PSD_PARSER_VERSION } from './services/parser/parserVersions';
import { resolveParserFilePath } from './services/parser/resolveParserFilePath';
import { recoverReadyMerges } from './controllers/transferController';
import { logger } from './utils/logger';
import { getSuperAdminIdentifiers, getSuperAdminUserWhere } from './utils/superAdmin';
import fs from 'fs';
import type { Server } from 'http';

const app = express();
const PORT = parseInt(process.env.PORT || '3088', 10);
const HOST = process.env.HOST?.trim();
let server: Server | undefined;
let shuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = 5_000;
app.disable('etag');

Object.values(STORAGE).forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use(
  pinoHttp({
    logger,
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    serializers: {
      req: (req) => ({ method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  })
);

app.use('/uploads', uploadThumbnailRoutes);
app.use('/uploads', express.static(STORAGE.base, {
  maxAge: '30d',
  setHeaders: (res, filePath) => {
    const filename = path.basename(filePath);
    if (filename.startsWith('_')) {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      return;
    }

    const relativePath = path.relative(STORAGE.base, filePath).replace(/\\/g, '/');
    if (relativePath.startsWith('thumbnails/')) {
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
      return;
    }

    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  },
}));

app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/categories', categoryRoutes);
app.use('/api/v1/tags', tagRoutes);
app.use('/api/v1/files', fileRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/libraries', libraryRoutes);
app.use('/api/v1/fonts', fontRoutes);
app.use('/api/v1/transfer', transferRoutes);
app.use('/api/v1/upload-thumbnails', uploadThumbnailRoutes);
app.use('/apis/transfer', transferRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ code: 200, message: 'OK', data: { timestamp: new Date().toISOString() } });
});

app.use(errorHandler);

function normalizeTableName(table: unknown) {
  if (typeof table === 'string') return table;
  if (table && typeof table === 'object') {
    const value = table as { tableName?: string; name?: string };
    return value.tableName || value.name || '';
  }
  return '';
}

async function tableExists(name: string) {
  const qi = sequelize.getQueryInterface();
  const tables = await qi.showAllTables();
  return tables.some((table) => normalizeTableName(table).toLowerCase() === name.toLowerCase());
}

type IndexDefinition = {
  name: string;
  fields: string[];
  unique?: boolean;
};

type ExistingIndex = {
  name?: string;
  Name?: string;
};

type DuplicateIndexValue = {
  value: string;
  count: number | string;
};

async function ensureIndex(tableName: string, definition: IndexDefinition) {
  const qi = sequelize.getQueryInterface();
  const indexes = (await qi.showIndex(tableName)) as ExistingIndex[];
  const exists = indexes.some((index) => (index.name || index.Name) === definition.name);
  if (exists) return;

  await qi.addIndex(tableName, definition.fields, {
    name: definition.name,
    unique: definition.unique,
  });
  logger.info({ tableName, indexName: definition.name }, 'created missing database index');
}

async function ensureUniqueIndexIfNoDuplicates(tableName: string, definition: IndexDefinition) {
  const [columnName] = definition.fields;
  const duplicates = await sequelize.query<DuplicateIndexValue>(
    `
      SELECT ${quoteIdentifier(columnName)} AS value, COUNT(*) AS count
      FROM ${quoteIdentifier(tableName)}
      WHERE ${quoteIdentifier(columnName)} IS NOT NULL AND ${quoteIdentifier(columnName)} <> ''
      GROUP BY ${quoteIdentifier(columnName)}
      HAVING COUNT(*) > 1
      LIMIT 5
    `,
    { type: QueryTypes.SELECT },
  );

  if (duplicates.length > 0) {
    logger.warn(
      { tableName, indexName: definition.name, duplicates },
      'skipped unique index because duplicate values exist',
    );
    return;
  }

  await ensureIndex(tableName, { ...definition, unique: true });
}

async function ensurePerformanceIndexes() {
  if (await tableExists('users')) {
    await ensureUniqueIndexIfNoDuplicates('users', {
      name: 'users_employee_no_unique',
      fields: ['employee_no'],
      unique: true,
    });
  }

  if (await tableExists('design_files')) {
    await ensureIndex('design_files', {
      name: 'idx_design_files_library_listing',
      fields: ['is_deleted', 'is_personal_copy', 'library_id', 'created_at'],
    });
    await ensureIndex('design_files', {
      name: 'idx_design_files_my_listing',
      fields: ['uploaded_by', 'is_personal_copy', 'is_deleted', 'updated_at'],
    });
    await ensureIndex('design_files', {
      name: 'idx_design_files_parse_recovery',
      fields: ['parse_status', 'file_type'],
    });
  }

  if (await tableExists('file_tags')) {
    await ensureIndex('file_tags', {
      name: 'idx_file_tags_tag_id',
      fields: ['tag_id'],
    });
  }

  if (await tableExists('categories')) {
    await ensureIndex('categories', {
      name: 'idx_categories_library_name',
      fields: ['library_id', 'name'],
    });
    await ensureIndex('categories', {
      name: 'idx_categories_library_dimension_sort',
      fields: ['library_id', 'dimension', 'parent_id', 'sort_order'],
    });
  }
}

function quoteIdentifier(value: string) {
  return `\`${value.replace(/`/g, '``')}\``;
}

async function ensureUserProfileColumns() {
  if (!(await tableExists('users'))) return;

  const qi = sequelize.getQueryInterface();
  const users = await qi.describeTable('users');
  if (!users.auth_subject) {
    await qi.addColumn('users', 'auth_subject', {
      type: DataTypes.STRING(255),
      allowNull: true,
    });
  }
  if (!users.department_ids) {
    await qi.addColumn('users', 'department_ids', {
      type: DataTypes.JSON,
      allowNull: true,
    });
  }
  if (!users.department_levels) {
    await qi.addColumn('users', 'department_levels', {
      type: DataTypes.JSON,
      allowNull: true,
    });
  }
  if (!users.department_path) {
    await qi.addColumn('users', 'department_path', {
      type: DataTypes.STRING(500),
      allowNull: true,
    });
  }
  if (!users.employee_no) {
    await qi.addColumn('users', 'employee_no', {
      type: DataTypes.STRING(100),
      allowNull: true,
    });
  }
  if (!users.extattr) {
    await qi.addColumn('users', 'extattr', {
      type: DataTypes.JSON,
      allowNull: true,
    });
  }
}

async function ensureSchema() {
  const qi = sequelize.getQueryInterface();
  await ensureUserProfileColumns();

  const hasDesignFiles = await tableExists('design_files');
  const hasLibraries = await tableExists('libraries');
  const hasCategories = await tableExists('categories');

  if (hasLibraries) {
    const libraries = await qi.describeTable('libraries');
    if (!libraries.is_pinned) {
      await qi.addColumn('libraries', 'is_pinned', {
        type: DataTypes.TINYINT,
        allowNull: false,
        defaultValue: 0,
      });
    }
    if (!libraries.pinned_at) {
      await qi.addColumn('libraries', 'pinned_at', {
        type: DataTypes.DATE,
        allowNull: true,
      });
    }
  }

  if (!hasDesignFiles || !hasLibraries) return;

  const designFiles = await qi.describeTable('design_files');
  if (String(designFiles.file_type?.type || '').toLowerCase().includes('enum')) {
    await qi.changeColumn('design_files', 'file_type', {
      type: DataTypes.STRING(30),
      allowNull: false,
    });
  }
  if (!designFiles.library_id) {
    await qi.addColumn('design_files', 'library_id', {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'libraries', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
  }
  if (!designFiles.source_file_id) {
    await qi.addColumn('design_files', 'source_file_id', {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'design_files', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
  }
  if (!designFiles.storage_platform) {
    await qi.addColumn('design_files', 'storage_platform', {
      type: DataTypes.STRING(50),
      allowNull: false,
      defaultValue: 'local',
    });
  }
  if (!designFiles.content_md5) {
    await qi.addColumn('design_files', 'content_md5', {
      type: DataTypes.STRING(32),
      allowNull: true,
    });
  }
  if (!designFiles.relative_path) {
    await qi.addColumn('design_files', 'relative_path', {
      type: DataTypes.STRING(1000),
      allowNull: true,
    });
  }
  if (!designFiles.is_personal_copy) {
    await qi.addColumn('design_files', 'is_personal_copy', {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    });
  }
  if (!designFiles.is_favorite) {
    await qi.addColumn('design_files', 'is_favorite', {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    });
  }
  if (!designFiles.is_draft) {
    await qi.addColumn('design_files', 'is_draft', {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    });
  }
  if (!designFiles.is_shared) {
    await qi.addColumn('design_files', 'is_shared', {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    });
  }
  if (!designFiles.is_published) {
    await qi.addColumn('design_files', 'is_published', {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    });
  }

  const firstLibrary = await Library.findOne({ where: { isDeleted: false }, order: [['id', 'ASC']] });
  if (firstLibrary) {
    await sequelize.query(
      'UPDATE design_files SET library_id = ? WHERE library_id IS NULL AND is_deleted = 0',
      { replacements: [firstLibrary.id] }
    );
  }

  if (hasCategories) {
    const categories = await qi.describeTable('categories');
    if (!categories.library_id) {
      await qi.addColumn('categories', 'library_id', {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'libraries', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      });
    }

    await sequelize.query(`
      UPDATE categories c
      JOIN (
        SELECT category_id, MIN(library_id) AS library_id
        FROM design_files
        WHERE category_id IS NOT NULL AND library_id IS NOT NULL
        GROUP BY category_id
      ) f ON f.category_id = c.id
      SET c.library_id = f.library_id
      WHERE c.library_id IS NULL
    `);

    if (firstLibrary) {
      await Category.update(
        { libraryId: firstLibrary.id },
        { where: { libraryId: null } }
      );
    }
  }
}

async function ensureFileCategoryAssignments() {
  if (
    !(await tableExists('file_categories')) ||
    !(await tableExists('design_files')) ||
    !(await tableExists('categories')) ||
    !(await tableExists('file_tags')) ||
    !(await tableExists('tags'))
  ) {
    return;
  }

  await sequelize.query(`
    INSERT IGNORE INTO file_categories (file_id, category_id)
    SELECT id, category_id
    FROM design_files
    WHERE category_id IS NOT NULL
  `);

  await sequelize.query(`
    INSERT IGNORE INTO file_categories (file_id, category_id)
    SELECT DISTINCT ft_child.file_id, child.id
    FROM file_tags ft_child
    JOIN tags tag_child ON tag_child.id = ft_child.tag_id
    JOIN design_files df ON df.id = ft_child.file_id
    JOIN categories child
      ON child.name = tag_child.name
      AND child.dimension IS NOT NULL
      AND child.library_id <=> df.library_id
    JOIN categories parent ON parent.id = child.parent_id
    JOIN tags tag_parent ON tag_parent.name = parent.name
    JOIN file_tags ft_parent
      ON ft_parent.file_id = ft_child.file_id
      AND ft_parent.tag_id = tag_parent.id
  `);

  await sequelize.query(`
    INSERT IGNORE INTO file_categories (file_id, category_id)
    SELECT DISTINCT ft.file_id, unique_categories.id
    FROM file_tags ft
    JOIN tags t ON t.id = ft.tag_id
    JOIN design_files df ON df.id = ft.file_id
    JOIN (
      SELECT MIN(id) AS id, library_id, name
      FROM categories
      WHERE dimension IS NOT NULL
      GROUP BY library_id, name
      HAVING COUNT(*) = 1
    ) unique_categories
      ON unique_categories.name = t.name
      AND unique_categories.library_id <=> df.library_id
  `);
}

async function ensureBuiltInRoles() {
  for (const roleData of BUILT_IN_ROLES) {
    const existing = await Role.findOne({ where: { name: roleData.name } });
    if (existing) {
      await existing.update({
        displayName: roleData.displayName,
        permissions: roleData.permissions,
      });
    } else {
      await Role.create(roleData);
    }
  }
}

/**
 * 启动时根据 SUPER_ADMIN_EMPLOYEE_NOS 环境变量自动把对应员工提升为 super_admin。
 * - 逗号分隔，可以一次配多个
 * - 幂等：已经是超管的不动；账号还不存在的只 warn 一行（首次 AuthHub 登录后由 authController 兜底）
 * - 只升级、不降级：不在列表里的现有超管不会被动手脚
 */
async function ensureSuperAdminFromEnv() {
  const identifiers = getSuperAdminIdentifiers();
  if (identifiers.length === 0) return;

  const role = await Role.findOne({ where: { name: 'super_admin' } });
  if (!role) {
    logger.warn({ scope: 'bootstrap' }, 'super_admin role missing, skipping env auto-grant');
    return;
  }

  for (const identifier of identifiers) {
    const user = await User.findOne({ where: getSuperAdminUserWhere(identifier) });
    if (!user) {
      logger.warn(
        { scope: 'bootstrap', identifier },
        'super admin candidate not found yet (will retry on next login)'
      );
      continue;
    }
    if (user.roleId !== role.id) {
      await user.update({ roleId: role.id });
      logger.info(
        { scope: 'bootstrap', identifier, username: user.username, employeeNo: user.employeeNo, userId: user.id },
        'auto-granted super_admin from SUPER_ADMIN_EMPLOYEE_NOS'
      );
    }
  }
}

async function enqueuePendingParses() {
  if (['1', 'true', 'yes'].includes(String(process.env.DISABLE_BOOTSTRAP_PARSE || '').toLowerCase())) {
    logger.warn({ scope: 'bootstrap' }, 'Bootstrap: pending parse scan skipped by DISABLE_BOOTSTRAP_PARSE');
    return;
  }

  // 'parsing' 也算挂起 —— 服务在解析中崩溃时文件会卡在该状态，启动后必须重排。
  // 'failed' 是终态，不在启动时反复重试，避免永久性 native/parser 问题导致 PM2 重启后循环触发。
  const pendingFiles = await DesignFile.findAll({
    where: { parseStatus: ['pending', 'parsing'], fileType: ['psd', 'ai', 'pdf'], isDeleted: false },
    attributes: ['id', 'fileType', 'filePath', 'parseStatus'],
  });

  logger.info({ count: pendingFiles.length }, 'Bootstrap: scanning pending parse jobs');
  for (const file of pendingFiles) {
    if (shuttingDown) return;
    if (!fs.existsSync(resolveParserFilePath(file.filePath))) {
      await markMissingSourceParseFailed(file);
      continue;
    }
    enqueueParse(file.id);
  }
}

function getCurrentImportedFileParserVersion(fileType: string): { key: string; version: number } | null {
  if (fileType === 'ai') return { key: 'aiParserVersion', version: AI_PARSER_VERSION };
  if (fileType === 'pdf') return { key: 'pdfParserVersion', version: PDF_PARSER_VERSION };
  return null;
}

function readImportedFileParserVersion(parseResult: unknown, key: string): number {
  if (!parseResult || typeof parseResult !== 'object') return 0;
  const value = Number((parseResult as Record<string, unknown>)[key]);
  return Number.isFinite(value) ? value : 0;
}

function missingSourceParseResult(fileType: string, filePath: string): Record<string, unknown> {
  const result: Record<string, unknown> = {
    error: `Source file missing: ${filePath}`,
  };
  const current = getCurrentImportedFileParserVersion(fileType);
  if (current) result[current.key] = current.version;
  if (fileType === 'psd') result.psdParserVersion = PSD_PARSER_VERSION;
  return result;
}

async function markMissingSourceParseFailed(file: DesignFile) {
  const resolved = resolveParserFilePath(file.filePath);
  const changed = await sequelize.transaction(async (transaction) => {
    const current = await DesignFile.findByPk(file.id, { transaction, lock: transaction.LOCK.UPDATE });
    // A publication or source restoration after the scan must not be undone by bootstrap recovery.
    if (!current || current.isDeleted || current.parseStatus !== file.parseStatus
      || current.filePath !== file.filePath || fs.existsSync(resolveParserFilePath(current.filePath))) return false;
    const failure = missingSourceParseResult(current.fileType, resolved);
    const previous = current.parseResult;
    const retained = previous && (!previous.error || previous.hasRetainedResult === true) ? previous : null;
    await current.update({
      parseStatus: 'failed',
      parseResult: { ...failure, ...(retained || {}), error: failure.error,
        ...(retained ? { hasRetainedResult: true, lastParseAttempt: failure } : {}) },
    }, { transaction });
    return true;
  });
  if (!changed) return;
  logger.warn(
    { scope: 'bootstrap', fileId: file.id, filePath: file.filePath, resolved },
    'Bootstrap: parser source file is missing; marked failed'
  );
}

async function enqueueStaleImportedFileParses() {
  const enabled = ['1', 'true', 'yes'].includes(String(process.env.ENABLE_BOOTSTRAP_STALE_PARSE || '').toLowerCase());
  if (!enabled) {
    logger.info({ scope: 'bootstrap' }, 'Bootstrap: stale imported parse scan disabled; stale files reparse lazily on open');
    return;
  }
  if (['1', 'true', 'yes'].includes(String(process.env.DISABLE_BOOTSTRAP_STALE_PARSE || '').toLowerCase())) {
    logger.warn({ scope: 'bootstrap' }, 'Bootstrap: stale imported parse scan skipped by DISABLE_BOOTSTRAP_STALE_PARSE');
    return;
  }

  const importedFiles = await DesignFile.findAll({
    where: {
      parseStatus: 'completed',
      fileType: { [Op.in]: ['ai', 'pdf'] },
      isDeleted: false,
    },
    attributes: ['id', 'fileType', 'sourceFileId', 'parseResult'],
    order: [['id', 'ASC']],
  });

  const sourceIds = new Set<number>();
  for (const file of importedFiles) {
    if (shuttingDown) return;
    const current = getCurrentImportedFileParserVersion(file.fileType);
    if (!current) continue;
    if (readImportedFileParserVersion(file.parseResult, current.key) >= current.version) continue;
    sourceIds.add(file.sourceFileId || file.id);
  }

  if (sourceIds.size === 0) {
    logger.info({ scope: 'bootstrap' }, 'Bootstrap: no stale imported parses found');
    return;
  }

  const sources = await DesignFile.findAll({
    where: {
      id: { [Op.in]: Array.from(sourceIds) },
      fileType: { [Op.in]: ['ai', 'pdf'] },
      parseStatus: 'completed',
      isDeleted: false,
    },
    attributes: ['id', 'fileType', 'name', 'filePath', 'parseStatus'],
    order: [['id', 'ASC']],
  });

  logger.info(
    { scope: 'bootstrap', staleFiles: sourceIds.size, queuedSources: sources.length },
    'Bootstrap: queueing stale imported parses'
  );

  for (const source of sources) {
    if (shuttingDown) return;
    if (!fs.existsSync(resolveParserFilePath(source.filePath))) {
      await markMissingSourceParseFailed(source);
      continue;
    }
    enqueueParse(source.id, { syncAllPersonalCopies: true });
  }
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Server shutdown started');

  const deadline = setTimeout(() => {
    logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Server shutdown timed out');
    server?.closeAllConnections();
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  let failed = false;
  try {
    const closeHttp = new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      server.close((err) => err ? reject(err) : resolve());
    });
    const results = await Promise.allSettled([shutdownParseQueue(), closeHttp]);
    for (const result of results) {
      if (result.status === 'rejected') {
        failed = true;
        logger.error({ err: result.reason }, 'Server shutdown cleanup failed');
      }
    }
  } catch (err) {
    failed = true;
    logger.error({ err }, 'Server shutdown failed');
  } finally {
    try {
      await sequelize.close();
    } catch (err) {
      failed = true;
      logger.error({ err }, 'Server shutdown database close failed');
    }
    clearTimeout(deadline);
    process.exit(failed ? 1 : 0);
  }
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

async function start() {
  try {
    await sequelize.authenticate();
    logger.info('Database connected');

    await ensureSchema();
    await sequelize.sync();
    await ensureBuiltInRoles();
    await ensureSchema();
    await ensurePerformanceIndexes();
    await ensureFileCategoryAssignments();
    await ensureSuperAdminFromEnv();
    logger.info('Database schema ready');

    if (shuttingDown) return;
    const onListening = () => {
      if (shuttingDown) return;
      logger.info({ port: PORT, host: HOST }, 'Server listening');
      void (async () => {
        await enqueuePendingParses();
        if (shuttingDown) return;
        await enqueueStaleImportedFileParses();
        if (shuttingDown) return;
        if (['1', 'true', 'yes'].includes(String(process.env.DISABLE_BOOTSTRAP_TRANSFER_RECOVERY || '').toLowerCase())) {
          logger.warn({ scope: 'bootstrap' }, 'Bootstrap: upload merge recovery skipped by DISABLE_BOOTSTRAP_TRANSFER_RECOVERY');
        } else {
          await recoverReadyMerges();
        }
      })().catch((err) => {
        if (!shuttingDown) logger.error({ err }, 'Bootstrap: background recovery failed');
      });
    };
    server = HOST ? app.listen(PORT, HOST, onListening) : app.listen(PORT, onListening);
    server.on('error', (err) => {
      logger.fatal({ err }, 'HTTP server failed');
      void shutdown('SIGTERM');
    });
  } catch (err) {
    if (shuttingDown) return;
    logger.fatal({ err }, 'Server failed to start');
    process.exit(1);
  }
}

start();
