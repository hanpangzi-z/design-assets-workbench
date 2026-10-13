import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import { AppError } from './errorHandler';
import { logger } from '../utils/logger';

export function rbacMiddleware(...permissions: string[]) {
  return (req: AuthRequest, _res: Response, next: NextFunction) => {
    if (!req.userPermissions) {
      logger.warn({ scope: 'rbac', required: permissions }, 'RBAC denied: not authenticated');
      return next(new AppError('未认证', 401));
    }

    const role = req.user?.get('role') as { name?: string } | undefined;
    if (role?.name === 'super_admin') {
      return next();
    }

    const hasPermission = permissions.every(
      (perm) => req.userPermissions![perm] === true
    );

    if (!hasPermission) {
      logger.warn(
        {
          scope: 'rbac',
          userId: req.user?.id,
          required: permissions,
          held: req.userPermissions,
        },
        'RBAC denied: insufficient permission'
      );
      return next(new AppError('权限不足', 403));
    }

    next();
  };
}
