import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { rbacMiddleware } from '../middleware/rbac';
import { Op, col, fn } from 'sequelize';
import { Category, DesignFile, FileCategory, Library, sequelize, User } from '../models';
import { AppError } from '../middleware/errorHandler';

const router = Router();
const TEMPLATE_TYPES = new Set(['psd', 'ai', 'pdf', 'pptx']);
const MATERIAL_TYPES = new Set(['png', 'jpg', 'svg', 'ttf', 'otf', 'ttc', 'woff', 'woff2']);
const ACTIVE_LIBRARY_ORDER: Array<[string, 'ASC' | 'DESC']> = [
  ['isPinned', 'DESC'],
  ['pinnedAt', 'DESC'],
  ['id', 'ASC'],
];

async function getLiveCountsByLibrary() {
  const rows = await DesignFile.findAll({
    where: { isDeleted: false, isPersonalCopy: false },
    attributes: ['libraryId', 'fileType', [fn('COUNT', col('id')), 'count']],
    group: ['libraryId', 'fileType'],
    raw: true,
  }) as unknown as Array<{ libraryId: number | null; fileType: string; count: number | string }>;

  const counts = new Map<number, { templateCount: number; materialCount: number }>();
  rows.forEach((row) => {
    if (!row.libraryId) return;
    const current = counts.get(row.libraryId) || { templateCount: 0, materialCount: 0 };
    const count = Number(row.count) || 0;
    if (TEMPLATE_TYPES.has(row.fileType)) current.templateCount += count;
    if (MATERIAL_TYPES.has(row.fileType)) current.materialCount += count;
    counts.set(row.libraryId, current);
  });

  return counts;
}

function withLiveCounts(lib: Library, countsByLibrary: Map<number, { templateCount: number; materialCount: number }>) {
  const counts = countsByLibrary.get(lib.id) || { templateCount: 0, materialCount: 0 };
  return {
    ...lib.toJSON(),
    templateCount: counts.templateCount,
    materialCount: counts.materialCount,
  };
}

function parsePinnedValue(value: unknown) {
  return value === true || value === 1 || value === '1';
}

router.get('/', authMiddleware, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [libs, counts] = await Promise.all([
      Library.findAll({
        where: { isDeleted: false },
        include: [{ model: User, as: 'owner', attributes: ['id', 'displayName'] }],
        order: ACTIVE_LIBRARY_ORDER,
      }),
      getLiveCountsByLibrary(),
    ]);
    res.json({ code: 200, message: '获取成功', data: libs.map((lib) => withLiveCounts(lib, counts)) });
  } catch (err) { next(err); }
});

router.get('/trash', authMiddleware, rbacMiddleware('manage_categories'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const libs = await Library.findAll({
      where: { isDeleted: true },
      include: [{ model: User, as: 'owner', attributes: ['id', 'displayName'] }],
      order: [['updatedAt', 'DESC']],
    });
    res.json({ code: 200, message: '获取成功', data: libs });
  } catch (err) { next(err); }
});

router.get('/:id', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const [lib, counts] = await Promise.all([
      Library.findByPk(id, { include: [{ model: User, as: 'owner', attributes: ['id', 'displayName'] }] }),
      getLiveCountsByLibrary(),
    ]);
    if (!lib || lib.isDeleted) throw new AppError('资源库不存在', 404);
    res.json({ code: 200, message: '获取成功', data: withLiveCounts(lib, counts) });
  } catch (err) { next(err); }
});

router.post('/', authMiddleware, rbacMiddleware('manage_categories'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name, description } = req.body;
    if (!name) throw new AppError('名称不能为空', 400);
    const lib = await Library.create({ name, description, ownerId: req.user?.id || null });
    res.status(201).json({ code: 201, message: '创建成功', data: lib });
  } catch (err) { next(err); }
});

router.put('/:id', authMiddleware, rbacMiddleware('manage_categories'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const lib = await Library.findByPk(id);
    if (!lib) throw new AppError('资源库不存在', 404);
    const { name, description, ownerId } = req.body;

    if (ownerId !== undefined && ownerId !== null) {
      const owner = await User.findByPk(Number(ownerId));
      if (!owner) throw new AppError('库主不存在', 404);
    }

    await lib.update({
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(ownerId !== undefined && { ownerId: ownerId === null ? null : Number(ownerId) }),
    });

    const updated = await Library.findByPk(id, {
      include: [{ model: User, as: 'owner', attributes: ['id', 'displayName'] }],
    });
    res.json({ code: 200, message: '更新成功', data: updated });
  } catch (err) { next(err); }
});

router.patch('/:id/pin', authMiddleware, rbacMiddleware('manage_categories'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const lib = await Library.findByPk(id);
    if (!lib || lib.isDeleted) throw new AppError('资源库不存在', 404);

    const nextPinned = req.body?.isPinned === undefined ? !lib.isPinned : parsePinnedValue(req.body.isPinned);
    await lib.update({
      isPinned: nextPinned,
      pinnedAt: nextPinned ? new Date() : null,
    });

    const [updated, counts] = await Promise.all([
      Library.findByPk(id, { include: [{ model: User, as: 'owner', attributes: ['id', 'displayName'] }] }),
      getLiveCountsByLibrary(),
    ]);

    res.json({ code: 200, message: '更新成功', data: updated ? withLiveCounts(updated, counts) : null });
  } catch (err) { next(err); }
});

router.patch('/:id/restore', authMiddleware, rbacMiddleware('manage_categories'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const lib = await Library.findByPk(id);
    if (!lib) throw new AppError('资源库不存在', 404);
    await lib.update({ isDeleted: false });
    res.json({ code: 200, message: '恢复成功', data: lib });
  } catch (err) { next(err); }
});

router.delete('/:id', authMiddleware, rbacMiddleware('manage_categories'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const lib = await Library.findByPk(id);
    if (!lib) throw new AppError('资源库不存在', 404);
    await lib.update({ isDeleted: true });
    res.json({ code: 200, message: '删除成功', data: null });
  } catch (err) { next(err); }
});

router.delete('/:id/permanent', authMiddleware, rbacMiddleware('manage_categories'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const lib = await Library.findByPk(id);
    if (!lib) throw new AppError('资源库不存在', 404);
    if (!lib.isDeleted) throw new AppError('请先将资源库移入回收站', 400);

    await sequelize.transaction(async (transaction) => {
      const categories = await Category.findAll({
        where: { libraryId: id },
        attributes: ['id'],
        transaction,
      });
      const categoryIds = categories.map((category) => category.id);

      await DesignFile.update(
        { libraryId: null, categoryId: null },
        { where: { libraryId: id }, transaction },
      );

      if (categoryIds.length > 0) {
        await FileCategory.destroy({
          where: { categoryId: { [Op.in]: categoryIds } },
          transaction,
        });
        await Category.update(
          { parentId: null },
          { where: { id: { [Op.in]: categoryIds } }, transaction },
        );
        await Category.destroy({
          where: { id: { [Op.in]: categoryIds } },
          transaction,
        });
      }

      await lib.destroy({ transaction });
    });

    res.json({ code: 200, message: '彻底删除成功', data: null });
  } catch (err) { next(err); }
});

export default router;
