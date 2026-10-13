import { Router } from 'express';
import { authHubConfig, authHubExchange, benlaiSsoLogin, designOpsSsoExchange, impersonate, login, logout, me, refresh, stopImpersonate } from '../controllers/authController';
import { authMiddleware } from '../middleware/auth';

const router = Router();

router.post('/login', login);
router.get('/auth-hub/config', authHubConfig);
router.post('/auth-hub/exchange', authHubExchange);
router.post('/benlai-sso/login', benlaiSsoLogin);
router.post('/designops-sso/exchange', designOpsSsoExchange);
router.post('/logout', authMiddleware, logout);
router.get('/me', authMiddleware, me);
router.post('/refresh', refresh);
router.post('/impersonate', authMiddleware, impersonate);
router.post('/stop-impersonate', authMiddleware, stopImpersonate);

export default router;
