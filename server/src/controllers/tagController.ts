import { Request, Response, NextFunction } from 'express';
import { Tag } from '../models';
import { AppError } from '../middleware/errorHandler';

// 标签列表
export async function list(_req: Request, res: Response, next: NextFunction) {
  try {
    const tags = await Tag.findAll({
      order: [['created_at', 'DESC']],
    });

    res.json({
      code: 200,
      message: '获取成功',
      data: tags,
    });
  } catch (err) {
    next(err);
  }
}

// 创建标签
export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, color } = req.body;
    if (!name) throw new AppError('标签名称不能为空', 400);

    const existing = await Tag.findOne({ where: { name } });
    if (existing) throw new AppError('标签已存在', 409);

    const tag = await Tag.create({ name, color });

    res.status(201).json({
      code: 201,
      message: '创建成功',
      data: tag,
    });
  } catch (err) {
    next(err);
  }
}

// 更新标签
export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id as string, 10);
    const tag = await Tag.findByPk(id);
    if (!tag) throw new AppError('标签不存在', 404);

    const { name, color } = req.body;
    if (name) {
      const existing = await Tag.findOne({ where: { name } });
      if (existing && existing.id !== tag.id) throw new AppError('标签名已存在', 409);
    }

    await tag.update({
      ...(name !== undefined && { name }),
      ...(color !== undefined && { color }),
    });

    res.json({
      code: 200,
      message: '更新成功',
      data: tag,
    });
  } catch (err) {
    next(err);
  }
}

// 删除标签
export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const id = parseInt(req.params.id as string, 10);
    const tag = await Tag.findByPk(id);
    if (!tag) throw new AppError('标签不存在', 404);

    await tag.destroy();

    res.json({
      code: 200,
      message: '删除成功',
      data: null,
    });
  } catch (err) {
    next(err);
  }
}

// 热门标签
export async function popular(_req: Request, res: Response, next: NextFunction) {
  try {
    const tags = await Tag.findAll({
      order: [['created_at', 'DESC']],
      limit: 20,
    });

    res.json({
      code: 200,
      message: '获取成功',
      data: tags,
    });
  } catch (err) {
    next(err);
  }
}
