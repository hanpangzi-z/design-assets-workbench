import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { sequelize, Role, User } from '../models';
import { BUILT_IN_ROLES } from '../constants/roles';
import { logger } from '../utils/logger';

function getTarget() {
  const args = process.argv.slice(2);
  const idArg = args.find((arg) => arg.startsWith('--id='));
  const employeeNoArg = args.find((arg) => arg.startsWith('--employee-no=') || arg.startsWith('--employeeNo='));
  const usernameArg = args.find((arg) => arg.startsWith('--username=') || arg.startsWith('--user='));
  const rawTarget = args.find((arg) => !arg.startsWith('--'));
  const envId = process.env.SUPER_ADMIN_USER_ID || process.env.npm_config_id;
  const envEmployeeNo =
    process.env.SUPER_ADMIN_EMPLOYEE_NO ||
    process.env.npm_config_employee_no ||
    process.env.npm_config_employeeNo;
  const envUsername = process.env.SUPER_ADMIN_USERNAME || process.env.npm_config_username || process.env.npm_config_user;

  if (idArg) return { id: Number(idArg.slice('--id='.length)) };
  if (employeeNoArg) return { employeeNo: employeeNoArg.split('=').slice(1).join('=').trim() };
  if (usernameArg) return { username: usernameArg.split('=').slice(1).join('=').trim() };
  if (envId) return { id: Number(envId) };
  if (envEmployeeNo) return { employeeNo: envEmployeeNo.trim() };
  if (envUsername) return { username: envUsername.trim() };
  if (rawTarget) return { employeeNo: rawTarget.trim() };
  return null;
}

async function ensureSuperAdminRole() {
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

  const role = await Role.findOne({ where: { name: 'super_admin' } });
  if (!role) throw new Error('super_admin role was not created');
  return role;
}

async function main() {
  const target = getTarget();
  if (!target) {
    throw new Error('Usage: npm run grant:super-admin -- --employee-no=1023046 or npm run grant:super-admin -- --id=4');
  }

  await sequelize.authenticate();
  const superAdminRole = await ensureSuperAdminRole();
  const user = await User.findOne({ where: target });
  if (!user) {
    throw new Error(`User not found: ${JSON.stringify(target)}`);
  }

  await user.update({ roleId: superAdminRole.id });
  logger.info({ employeeNo: user.employeeNo, username: user.username, userId: user.id }, 'Granted super_admin');
}

main()
  .then(async () => {
    await sequelize.close();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.fatal({ err }, 'grant:super-admin failed');
    await sequelize.close().catch(() => undefined);
    process.exit(1);
  });
