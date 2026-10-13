import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { User, Role } from '../models';
import { AppError } from './errorHandler';
import { requireEnv } from '../utils/env';
import { canUseLocalDevelopmentAuth } from './localDevelopmentAuth';

export interface AuthRequest extends Request {
  user?: InstanceType<typeof User>;
  userPermissions?: Record<string, boolean>;
  impersonatorId?: number;
}

const JWT_SECRET = requireEnv('JWT_SECRET');

function getDownloadToken(req: Request) {
  if (!req.path.endsWith('/download')) return null;
  const token = req.query.downloadToken;
  return typeof token === 'string' && token ? token : null;
}

async function authenticateLocalAdmin(req: AuthRequest, next: NextFunction) {
  try {
    const include = [{ model: Role, as: 'role', required: true, where: { name: ['super_admin', 'admin'] } }];
    const user = await User.findOne({ where: { username: 'admin', isActive: true }, include })
      || await User.findOne({ where: { isActive: true }, include, order: [['id', 'ASC']] });
    const role = user?.get('role') as InstanceType<typeof Role> | undefined;
    if (!user || !user.isActive || !role || (role.name !== 'admin' && role.name !== 'super_admin')) {
      return next(new AppError('本地开发免登录没有可用的启用管理员', 401));
    }
    req.user = user;
    req.userPermissions = role.permissions || {};
    req.impersonatorId = undefined;
    next();
  } catch (error) {
    next(error);
  }
}

export function authMiddleware(req: AuthRequest, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : getDownloadToken(req);
  if (!token) {
    const hasProvidedCredentials = authHeader !== undefined
      || (req.path.endsWith('/download') && req.query.downloadToken !== undefined);
    if (!hasProvidedCredentials && canUseLocalDevelopmentAuth(req)) return authenticateLocalAdmin(req, next);
    return next(new AppError('未提供认证令牌', 401));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: number; impersonatorId?: number };
    User.findByPk(decoded.userId, { include: [{ model: Role, as: 'role' }] })
      .then((user) => {
        if (!user || !user.isActive) {
          return next(new AppError('用户不存在或已被停用', 401));
        }
        req.user = user;
        req.impersonatorId = decoded.impersonatorId;
        const role = user.get('role') as InstanceType<typeof Role> | undefined;
        req.userPermissions = role?.permissions || {};
        next();
      })
      .catch(next);
  } catch {
    return next(new AppError('认证令牌无效或已过期', 401));
  }
}
