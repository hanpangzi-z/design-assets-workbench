import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { rbacMiddleware } from '../middleware/rbac';
import * as ctrl from '../controllers/tagController';

const router = Router();

router.get('/', authMiddleware, ctrl.list);
router.get('/popular', authMiddleware, ctrl.popular);
router.post('/', authMiddleware, rbacMiddleware('manage_tags'), ctrl.create);
router.put('/:id', authMiddleware, rbacMiddleware('manage_tags'), ctrl.update);
router.delete('/:id', authMiddleware, rbacMiddleware('manage_tags'), ctrl.remove);

export default router;
