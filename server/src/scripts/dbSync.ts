import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { sequelize } from '../models';
import { logger } from '../utils/logger';
import { cleanupDuplicateUniqueIndexes } from '../utils/uniqueIndexes';

async function sync() {
  try {
    // 先确保数据库存在
    const { Sequelize } = require('sequelize');
    const tempSeq = new Sequelize('', process.env.DB_USER || 'root', process.env.DB_PASS || '', {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306', 10),
      dialect: 'mysql',
      logging: false,
    });
    await tempSeq.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME || 'benlai_gaoding'}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    await tempSeq.close();

    // 同步表结构
    await cleanupDuplicateUniqueIndexes(sequelize);
    await sequelize.sync({ alter: true });
    logger.info('Database schema synced');
    process.exit(0);
  } catch (err) {
    logger.fatal({ err }, 'Database sync failed');
    process.exit(1);
  }
}

sync();
