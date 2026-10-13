import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { rbacMiddleware } from '../middleware/rbac';
import transferChunkUpload from '../middleware/transferChunkUpload';
import * as ctrl from '../controllers/transferController';

const router = Router();

router.get('/config', authMiddleware, ctrl.config);
router.post('/init', authMiddleware, rbacMiddleware('upload'), ctrl.init);
router.post('/check', authMiddleware, rbacMiddleware('upload'), ctrl.check);
router.get('/chunks/:taskId', authMiddleware, rbacMiddleware('upload'), ctrl.chunks);
router.post('/chunk/:taskId', authMiddleware, rbacMiddleware('upload'), transferChunkUpload.single('chunk'), ctrl.uploadChunk);
router.post('/merge/:taskId', authMiddleware, rbacMiddleware('upload'), ctrl.merge);
router.get('/status/:taskId', authMiddleware, rbacMiddleware('upload'), ctrl.status);
router.get('/events/:taskId', authMiddleware, rbacMiddleware('upload'), ctrl.events);
router.delete('/:taskId', authMiddleware, rbacMiddleware('upload'), ctrl.cancel);

export default router;
