import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { Op } from 'sequelize';
import { User, Role } from '../models';
import { AppError } from '../middleware/errorHandler';
import { ROLE_ORDER } from '../constants/roles';
import { LEGACY_SEED_USERNAMES } from '../constants/users';
import { AuthRequest } from '../middleware/auth';

type UserInstance = InstanceType<typeof User>;
type RoleInstance = InstanceType<typeof Role>;

export async function list(_req: Request, res: Response, next: NextFunction) {
  try {
    const users = await User.findAll({
      where: {
        username: { [Op.notIn]: LEGACY_SEED_USERNAMES },
      },
      include: [{ model: Role, as: 'role' }],
      order: [['id', 'ASC']],
    });
    res.json({ code: 200, message: '获取成功', data: users.map(u => u.toSafeJSON()) });
  } catch (err) { next(err); }
}

export async function listRoles(_req: Request, res: Response, next: NextFunction) {
  try {
    const roles = await Role.findAll();
    const sorted = roles.sort((a, b) => {
      const aIndex = ROLE_ORDER.indexOf(a.name);
      const bIndex = ROLE_ORDER.indexOf(b.name);
      return (aIndex === -1 ? 99 : aIndex) - (bIndex === -1 ? 99 : bIndex) || a.id - b.id;
    });
    res.json({
      code: 200,
      message: '获取成功',
      data: sorted.map((role) => ({ ...role.toJSON(), assignable: role.name !== 'super_admin' })),
    });
  } catch (err) { next(err); }
}

export async function create(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { username, employeeNo: rawEmployeeNo, displayName, password, roleId } = req.body;
    const employeeNo = normalizeEmployeeNo(rawEmployeeNo || username);
    if (!employeeNo || !displayName || !password) throw new AppError('参数不完整', 400);

    const existing = await User.findOne({
      where: {
        [Op.or]: [
          { employeeNo },
          { username: employeeNo },
        ],
      },
    });
    if (existing) throw new AppError('工号已存在', 409);
    const nextRoleId = roleId !== undefined ? await resolveAssignableRoleId(roleId) : await getDefaultUserRoleId();

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ username: employeeNo, employeeNo, displayName, passwordHash, roleId: nextRoleId });
    res.status(201).json({ code: 201, message: '创建成功', data: user.toSafeJSON() });
  } catch (err) { next(err); }
}

export async function update(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id as string, 10);
    const user = await User.findByPk(id, { include: [{ model: Role, as: 'role' }] });
    if (!user) throw new AppError('用户不存在', 404);
    ensureSuperAdminCanBeManaged(req, user);

    const { displayName, email, roleId, isActive } = req.body;
    const nextRoleId = roleId !== undefined ? await resolveAssignableRoleId(roleId) : undefined;
    await user.update({
      ...(displayName !== undefined && { displayName }),
      ...(email !== undefined && { email }),
      ...(nextRoleId !== undefined && { roleId: nextRoleId }),
      ...(isActive !== undefined && { isActive }),
    });
    res.json({ code: 200, message: '更新成功', data: user.toSafeJSON() });
  } catch (err) { next(err); }
}

export async function remove(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id as string, 10);
    const user = await User.findByPk(id, { include: [{ model: Role, as: 'role' }] });
    if (!user) throw new AppError('用户不存在', 404);
    ensureSuperAdminCanBeManaged(req, user);
    await user.update({ isActive: false });
    res.json({ code: 200, message: '已停用', data: null });
  } catch (err) { next(err); }
}

function getRoleName(user: UserInstance | undefined) {
  const role = user?.get('role') as RoleInstance | undefined;
  return role?.name;
}

function ensureSuperAdminCanBeManaged(req: AuthRequest, user: UserInstance) {
  if (getRoleName(user) === 'super_admin' && getRoleName(req.user) !== 'super_admin') {
    throw new AppError('管理员不能更改超级管理员', 403);
  }
}

async function getDefaultUserRoleId() {
  const role = await Role.findOne({ where: { name: 'user' } });
  if (!role) throw new AppError('角色不存在', 400);
  return role.id;
}

async function resolveAssignableRoleId(roleId: unknown) {
  const role = await resolveRole(roleId);
  if (role.name === 'super_admin') {
    throw new AppError('超级管理员只能由后端添加', 403);
  }
  return role.id;
}

async function resolveRole(roleId: unknown) {
  const parsedRoleId = Number(roleId);
  if (!Number.isInteger(parsedRoleId) || parsedRoleId <= 0) {
    throw new AppError('角色不存在', 400);
  }
  const role = await Role.findByPk(parsedRoleId);
  if (!role) throw new AppError('角色不存在', 400);
  return role;
}

function normalizeEmployeeNo(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}
