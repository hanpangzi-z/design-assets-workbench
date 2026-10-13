import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { rbacMiddleware } from '../middleware/rbac';
import * as ctrl from '../controllers/categoryController';

const router = Router();

// 公开接口
router.get('/tree', authMiddleware, ctrl.getTree);
router.get('/:id', authMiddleware, ctrl.getById);

// 需要权限
router.post('/', authMiddleware, rbacMiddleware('manage_categories'), ctrl.create);
router.put('/batch-sort', authMiddleware, rbacMiddleware('manage_categories'), ctrl.batchUpdateSort);
router.put('/:id', authMiddleware, rbacMiddleware('manage_categories'), ctrl.update);
router.put('/:id/sort', authMiddleware, rbacMiddleware('manage_categories'), ctrl.updateSort);
router.delete('/:id', authMiddleware, rbacMiddleware('manage_categories'), ctrl.remove);

export default router;
