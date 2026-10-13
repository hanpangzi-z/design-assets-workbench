import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import bcrypt from 'bcryptjs';
import { sequelize, Role, User } from '../models';

async function createAdmin() {
  const username = process.env.INITIAL_ADMIN_USERNAME?.trim();
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!username || username.length > 100 || !password || password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('Set INITIAL_ADMIN_USERNAME and a 12+ character password (at most 72 UTF-8 bytes) in your local .env.');
  }
  await sequelize.authenticate();
  const role = await Role.findOne({ where: { name: 'super_admin' } });
  if (!role) throw new Error('Run db:sync and db:seed before creating the administrator.');
  if (await User.findOne({ where: { username } })) throw new Error('Username already exists; no account was changed.');
  await User.create({ username, displayName: username, passwordHash: await bcrypt.hash(password, 12), roleId: role.id, isActive: true });
  console.log('Administrator created. Remove INITIAL_ADMIN_PASSWORD from .env after setup.');
}

createAdmin().catch(() => {
  console.error('Administrator creation failed. Check local configuration, seeded roles and username availability.');
  process.exitCode = 1;
}).finally(() => sequelize.close());
