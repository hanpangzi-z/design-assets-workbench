import { QueryTypes, Sequelize } from 'sequelize';
import { logger } from './logger';

type IndexTarget = {
  table: string;
  column: string;
  indexName: string;
};

type IndexRow = {
  Key_name: string;
  Non_unique: number;
  Seq_in_index: number;
  Column_name: string;
};

type TableRow = {
  TABLE_NAME: string;
};

const UNIQUE_INDEX_TARGETS: IndexTarget[] = [
  { table: 'roles', column: 'name', indexName: 'roles_name_unique' },
  { table: 'tags', column: 'name', indexName: 'tags_name_unique' },
  { table: 'users', column: 'username', indexName: 'users_username_unique' },
  { table: 'users', column: 'employee_no', indexName: 'users_employee_no_unique' },
];

export async function cleanupDuplicateUniqueIndexes(sequelize: Sequelize) {
  if (sequelize.getDialect() !== 'mysql') return;

  for (const target of UNIQUE_INDEX_TARGETS) {
    if (!(await tableExists(sequelize, target.table))) continue;
    await cleanupDuplicateUniqueIndex(sequelize, target);
  }
}

async function cleanupDuplicateUniqueIndex(sequelize: Sequelize, target: IndexTarget) {
  const rows = await sequelize.query<IndexRow>(
    `SHOW INDEX FROM ${quoteIdentifier(target.table)}`,
    { type: QueryTypes.SELECT },
  );
  const singleColumnUniqueIndexes = getSingleColumnUniqueIndexNames(rows, target.column);
  const preferredExists = singleColumnUniqueIndexes.includes(target.indexName);
  const indexesToDrop = preferredExists
    ? singleColumnUniqueIndexes.filter((name) => name !== target.indexName)
    : singleColumnUniqueIndexes;

  for (const indexName of indexesToDrop) {
    await sequelize.query(
      `ALTER TABLE ${quoteIdentifier(target.table)} DROP INDEX ${quoteIdentifier(indexName)}`,
    );
  }

  if (indexesToDrop.length > 0) {
    logger.warn(
      { table: target.table, column: target.column, indexes: indexesToDrop, count: indexesToDrop.length },
      'Removed duplicate unique indexes before schema sync',
    );
  }
}

async function tableExists(sequelize: Sequelize, table: string) {
  const rows = await sequelize.query<TableRow>(
    'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table LIMIT 1',
    { replacements: { table }, type: QueryTypes.SELECT },
  );
  return rows.length > 0;
}

function getSingleColumnUniqueIndexNames(rows: IndexRow[], column: string) {
  const byName = new Map<string, IndexRow[]>();
  rows.forEach((row) => {
    if (Number(row.Non_unique) !== 0 || row.Key_name === 'PRIMARY') return;
    const group = byName.get(row.Key_name) || [];
    group.push(row);
    byName.set(row.Key_name, group);
  });

  return Array.from(byName.entries())
    .filter(([, indexRows]) => indexRows.length === 1 && indexRows[0].Column_name === column)
    .map(([name]) => name);
}

function quoteIdentifier(value: string) {
  return `\`${value.replace(/`/g, '``')}\``;
}
