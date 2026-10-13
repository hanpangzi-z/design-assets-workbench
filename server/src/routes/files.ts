import { Router, raw } from 'express';
import { authMiddleware } from '../middleware/auth';
import { rbacMiddleware } from '../middleware/rbac';
import uploadMiddleware from '../middleware/upload';
import * as ctrl from '../controllers/fileController';

const router = Router();

router.get('/', authMiddleware, ctrl.list);
router.get('/trash', authMiddleware, ctrl.listTrash);
router.post('/export/cmyk', authMiddleware, raw({ type: 'image/png', limit: '100mb' }), ctrl.exportCmykPdf);
router.get('/:id', authMiddleware, ctrl.getById);
router.get('/:id/download', authMiddleware, ctrl.download);
router.get('/:id/preview', authMiddleware, ctrl.preview);
router.get('/:id/parse-status', authMiddleware, ctrl.getParseStatus);
router.get('/:id/editor-state', authMiddleware, ctrl.getEditorState);
router.get('/:id/layers', authMiddleware, ctrl.getLayers);

router.post('/upload', authMiddleware, uploadMiddleware.single('file'), ctrl.upload);
router.post('/batch/delete', authMiddleware, ctrl.batchRemove);
router.post('/batch/restore', authMiddleware, ctrl.batchRestore);
router.delete('/batch/permanent', authMiddleware, ctrl.batchPermanentRemove);
router.post('/:id/use-template', authMiddleware, ctrl.useTemplate);
router.post('/:id/parse-assist', authMiddleware, ctrl.submitParseAssist);
router.patch('/:id/my-meta', authMiddleware, ctrl.updateMyMeta);
router.put('/:id', authMiddleware, rbacMiddleware('edit'), ctrl.update);
router.put('/:id/editor-state', authMiddleware, ctrl.saveEditorState);
router.post('/:id/parse', authMiddleware, rbacMiddleware('edit'), ctrl.triggerParse);

router.patch('/:id/restore', authMiddleware, ctrl.restore);
router.delete('/:id/permanent', authMiddleware, ctrl.permanentRemove);
router.delete('/:id', authMiddleware, ctrl.remove);

export default router;
