import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { logger } from '../utils/logger';
import type { AuthRequest } from './auth';

export class AppError extends Error {
  public statusCode: number;
  public code: number;

  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.statusCode = statusCode;
    this.code = statusCode;
  }
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const message = err.code === 'LIMIT_FILE_SIZE' ? '上传分片过大' : err.message;
    return res.status(status).json({
      code: status,
      message,
      data: null,
    });
  }

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      code: err.code,
      message: err.message,
      data: null,
    });
  }

  const httpError = err as Error & { statusCode?: number; status?: number; type?: string };
  const status = httpError.statusCode || httpError.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return res.status(status).json({
      code: status,
      message: httpError.type === 'entity.too.large' ? '请求体过大' : err.message,
      data: null,
    });
  }

  logger.error(
    {
      err,
      method: req.method,
      url: req.url,
      userId: (req as AuthRequest).user?.id,
    },
    'Unhandled error'
  );
  return res.status(500).json({
    code: 500,
    message: '服务器内部错误',
    data: null,
  });
}
