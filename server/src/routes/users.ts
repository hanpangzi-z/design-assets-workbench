import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { rbacMiddleware } from '../middleware/rbac';
import * as ctrl from '../controllers/userController';

const router = Router();

router.get('/roles', authMiddleware, rbacMiddleware('manage_users'), ctrl.listRoles);
router.get('/', authMiddleware, rbacMiddleware('manage_users'), ctrl.list);
router.post('/', authMiddleware, rbacMiddleware('manage_users'), ctrl.create);
router.put('/:id', authMiddleware, rbacMiddleware('manage_users'), ctrl.update);
router.delete('/:id', authMiddleware, rbacMiddleware('manage_users'), ctrl.remove);

export default router;
