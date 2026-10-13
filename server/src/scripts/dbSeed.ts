import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { Op } from 'sequelize';
import { sequelize, Role, User, Library, Category, DesignFile, FileVersion } from '../models';
import { BUILT_IN_ROLES } from '../constants/roles';
import { LEGACY_SEED_USERNAMES } from '../constants/users';
import { logger } from '../utils/logger';
import { cleanupDuplicateUniqueIndexes } from '../utils/uniqueIndexes';

const LIBRARIES = ['设计素材', '品牌素材', '模板', 'AIGC提示词', '字体'];

async function seed() {
  try {
    await sequelize.authenticate();
    logger.info('Database connected');
    await cleanupDuplicateUniqueIndexes(sequelize);
    await sequelize.sync({ alter: true });
    logger.info('Database schema synced');

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
    logger.info('Roles seeded');

    await removeLegacySeedUsers();

    for (const name of LIBRARIES) {
      const existing = await Library.findOne({ where: { name } });
      if (!existing) await Library.create({ name, ownerId: null });
    }
    logger.info('Libraries seeded');

    process.exit(0);
  } catch (err) {
    logger.fatal({ err }, 'Seed failed');
    process.exit(1);
  }
}

async function removeLegacySeedUsers() {
  if (LEGACY_SEED_USERNAMES.length === 0) return;
  const users = await User.findAll({ where: { username: { [Op.in]: LEGACY_SEED_USERNAMES } } });
  const ids = users.map((user) => user.id);
  if (ids.length === 0) {
    logger.info('No legacy seed users found');
    return;
  }

  await Library.update({ ownerId: null }, { where: { ownerId: { [Op.in]: ids } } });
  await Category.update({ createdBy: null }, { where: { createdBy: { [Op.in]: ids } } });

  const uploadedFileCount = await DesignFile.count({ where: { uploadedBy: { [Op.in]: ids } } });
  const versionCount = await FileVersion.count({ where: { createdBy: { [Op.in]: ids } } });
  if (uploadedFileCount > 0 || versionCount > 0) {
    await User.update({ isActive: false }, { where: { id: { [Op.in]: ids } } });
    logger.warn(
      { usernames: LEGACY_SEED_USERNAMES, uploadedFileCount, versionCount },
      'Legacy seed users are still referenced by files; disabled and hidden instead of hard-deleting'
    );
    return;
  }

  const deletedCount = await User.destroy({ where: { id: { [Op.in]: ids } } });
  logger.info({ usernames: LEGACY_SEED_USERNAMES, deletedCount }, 'Legacy seed users deleted');
}

seed();
