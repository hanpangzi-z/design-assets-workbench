import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import useAuthStore from '@/store/authStore';
import { getAuthHubConfigApi } from '@/api/auth';

const AUTH_HUB_APP_ID = import.meta.env.VITE_AUTH_HUB_APP_ID || 'benlai-design';
const AUTH_HUB_LOGIN_URL = import.meta.env.VITE_AUTH_HUB_LOGIN_URL || '';
const AUTH_HUB_CALLBACK_URL = import.meta.env.VITE_AUTH_HUB_CALLBACK_URL || '';
const AUTH_HUB_RETURN_TO_KEY = 'benlai_auth_hub_return_to';

function getSafeInAppReturnTo(value: string | null | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  if (value === '/login' || value.startsWith('/login?') || value.startsWith('/login/callback')) return null;
  return value;
}

function rememberAuthHubReturnTo(value: string) {
  try {
    window.sessionStorage.setItem(AUTH_HUB_RETURN_TO_KEY, value);
  } catch {
    // sessionStorage can be blocked; login still falls back to the homepage.
  }
}

function consumeAuthHubReturnTo() {
  try {
    const value = window.sessionStorage.getItem(AUTH_HUB_RETURN_TO_KEY);
    window.sessionStorage.removeItem(AUTH_HUB_RETURN_TO_KEY);
    return getSafeInAppReturnTo(value);
  } catch {
    return null;
  }
}

function buildAuthHubTarget(
  loginUrl: string,
  appId: string,
  params: URLSearchParams,
  configuredCallbackUrl?: string,
) {
  const target = new URL(loginUrl, window.location.origin);
  const current = new URL(window.location.href);
  if (target.origin === current.origin && target.pathname === current.pathname) return null;

  const appReturnTo = getSafeInAppReturnTo(params.get('return_to')) || '/';
  const callbackUrl = configuredCallbackUrl?.trim() || new URL('/login/callback', current.origin).toString();
  rememberAuthHubReturnTo(appReturnTo);
  target.searchParams.set('app_id', params.get('app_id') || appId);
  target.searchParams.set('redirect_uri', callbackUrl);
  target.searchParams.set('return_to', appReturnTo);
  return target;
}

function getAuthErrorMessage(err: unknown) {
  const message = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
  if (message === 'invalid_ticket') return '登录凭证已失效，请重新使用企业微信登录';
  if (message === 'invalid_app_secret') return '统一登录密钥配置错误，请联系管理员';
  return message || '统一登录失败，请重新尝试';
}

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const loginWithAuthHubTicket = useAuthStore((s) => s.loginWithAuthHubTicket);
  const loginWithDesignOpsSso = useAuthStore((s) => s.loginWithDesignOpsSso);
  const login = useAuthStore((s) => s.login);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [ssoLoading, setSsoLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const processingTicketRef = useRef<string | null>(null);
  const processingPlatformSsoRef = useRef<string | null>(null);
  const platformSsoFailedRef = useRef(false);
  const [authHubConfig, setAuthHubConfig] = useState({
    appId: AUTH_HUB_APP_ID,
    loginUrl: AUTH_HUB_LOGIN_URL,
    callbackUrl: AUTH_HUB_CALLBACK_URL,
  });

  useEffect(() => {
    if (AUTH_HUB_LOGIN_URL) return;
    getAuthHubConfigApi()
      .then((config) => {
        setAuthHubConfig((prev) => ({
          appId: config.appId || prev.appId,
          loginUrl: config.loginUrl || prev.loginUrl,
          callbackUrl: config.callbackUrl || prev.callbackUrl,
        }));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const authError = params.get('auth_error');
    const platformSsoToken = params.get('platform_sso_token');
    const ticket = params.get('ticket');
    const appId = params.get('app_id') || authHubConfig.appId || AUTH_HUB_APP_ID;
    const redirectToAuthHub = () => {
      if (params.has('app_id') && authHubConfig.loginUrl) {
        const target = buildAuthHubTarget(authHubConfig.loginUrl, appId, params, authHubConfig.callbackUrl);
        if (target) {
          setSsoLoading(true);
          window.location.replace(target.toString());
          return true;
        }
      }
      return false;
    };

    if (platformSsoToken) {
      if (processingPlatformSsoRef.current === platformSsoToken) return;
      processingPlatformSsoRef.current = platformSsoToken;
      platformSsoFailedRef.current = false;

      const returnTo = getSafeInAppReturnTo(params.get('return_to')) || '/';
      const cleanParams = new URLSearchParams(location.search);
      cleanParams.delete('platform_sso_token');
      const cleanSearch = cleanParams.toString();
      window.history.replaceState(window.history.state, '', `/login${cleanSearch ? `?${cleanSearch}` : ''}`);

      setNotice('');
      setSsoLoading(true);
      loginWithDesignOpsSso(platformSsoToken)
        .then(() => {
          navigate(returnTo, { replace: true });
        })
        .catch(() => {
          processingPlatformSsoRef.current = null;
          platformSsoFailedRef.current = true;
          setNotice('平台免登录失败，请重新从设计运营平台进入');
          navigate(`/login${cleanSearch ? `?${cleanSearch}` : ''}`, { replace: true });
        })
        .finally(() => {
          setSsoLoading(false);
        });
      return;
    }

    if (authError) {
      setNotice(`统一登录失败：${authError}`);
      const cleanParams = new URLSearchParams(location.search);
      cleanParams.delete('auth_error');
      cleanParams.delete('app_id');
      const cleanSearch = cleanParams.toString();
      window.history.replaceState(window.history.state, '', `/login${cleanSearch ? `?${cleanSearch}` : ''}`);
      return;
    }

    if (!ticket) {
      if (platformSsoFailedRef.current) {
        setSsoLoading(false);
        return;
      }
      redirectToAuthHub();
      return;
    }

    const requestKey = `${appId}:${ticket}`;
    if (processingTicketRef.current === requestKey) return;
    processingTicketRef.current = requestKey;

    const returnTo =
      getSafeInAppReturnTo(params.get('return_to')) ||
      getSafeInAppReturnTo(params.get('state')) ||
      consumeAuthHubReturnTo() ||
      '/';
    const cleanParams = new URLSearchParams(location.search);
    cleanParams.delete('ticket');
    cleanParams.delete('app_id');
    const cleanSearch = cleanParams.toString();
    window.history.replaceState(window.history.state, '', `/login${cleanSearch ? `?${cleanSearch}` : ''}`);

    setNotice('');
    setSsoLoading(true);
    loginWithAuthHubTicket(ticket, appId)
      .then(() => {
        navigate(returnTo, { replace: true });
      })
      .catch((err: unknown) => {
        processingTicketRef.current = null;
        setNotice(getAuthErrorMessage(err));
        navigate(`/login${cleanSearch ? `?${cleanSearch}` : ''}`, { replace: true });
      })
      .finally(() => {
        setSsoLoading(false);
      });
  }, [
    authHubConfig.appId,
    authHubConfig.callbackUrl,
    authHubConfig.loginUrl,
    location.search,
    loginWithAuthHubTicket,
    loginWithDesignOpsSso,
    navigate,
  ]);

  const handleAuthHubLogin = async () => {
    let loginUrl = authHubConfig.loginUrl;
    let appId = authHubConfig.appId;
    let callbackUrl = authHubConfig.callbackUrl;

    setNotice('');
    if (!loginUrl) {
      try {
        const config = await getAuthHubConfigApi();
        loginUrl = config.loginUrl;
        appId = config.appId || appId;
        callbackUrl = config.callbackUrl || callbackUrl;
        setAuthHubConfig({ appId, loginUrl, callbackUrl });
      } catch {
        // Keep the message below focused on the actual user-visible problem.
      }
    }

    if (!loginUrl) {
      setNotice('未配置统一登录入口，请联系管理员检查 AUTH_HUB_LOGIN_URL 或 AUTH_HUB_BASE_URL');
      return;
    }

    const target = buildAuthHubTarget(loginUrl, appId, new URLSearchParams(location.search), callbackUrl);
    if (!target) {
      setNotice('统一登录入口不能指向当前登录页，请检查配置');
      return;
    }

    setSsoLoading(true);
    window.location.assign(target.toString());
    window.setTimeout(() => {
      if (document.visibilityState === 'visible') {
        setSsoLoading(false);
        setNotice('未能打开企业微信登录页，请检查浏览器是否拦截跳转后重试');
      }
    }, 5000);
  };

  return (
    <div className="public-login-layout" style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', height: '100vh', background: '#fff' }}>
      <style>{`@media (max-width: 760px) {
        .public-login-layout { grid-template-columns: 1fr !important; height: auto !important; min-height: 100dvh; }
        .public-login-brand { display: none !important; }
        .public-login-form { padding: 32px 24px !important; min-width: 0; }
      }`}</style>
      <div className="public-login-brand" style={{
        background: 'linear-gradient(160deg, #FAF1DF 0%, #F5E6C8 50%, #EDD9B5 100%)',
        display: 'flex',
        flexDirection: 'column',
        padding: '40px 48px',
        position: 'relative',
        overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 36,
            height: 36,
            borderRadius: 6,
            background: '#C84335',
            color: '#fff',
            display: 'grid',
            placeItems: 'center',
            fontFamily: 'var(--font-serif)',
            fontWeight: 700,
            fontSize: 20,
          }}>D</div>
          <div>
            <div style={{ font: '600 15px var(--font-sans)', color: 'var(--fg-1)' }}>Design Assets</div>
            <div style={{ font: '400 11px var(--font-sans)', color: 'var(--fg-3)' }}>WORKBENCH</div>
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', maxWidth: 440 }}>
          <h1 style={{
            fontFamily: 'var(--font-serif)',
            fontWeight: 700,
            fontSize: 48,
            lineHeight: 1.3,
            color: 'var(--n-900)',
            margin: 0,
          }}>
            一处安放<br />
            企业设计资产的地方
          </h1>
          <p style={{
            font: 'var(--type-body-lg)',
            color: 'var(--fg-2)',
            marginTop: 20,
            lineHeight: 1.7,
          }}>
            统一管理模板、素材、品牌规范与版权，<br />
            让每一份设计都能被准确复用、被认真对待。
          </p>
        </div>

        <div style={{
          position: 'absolute',
          bottom: 60,
          left: 48,
          transform: 'rotate(-6deg)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}>
          <div style={{
            width: 52,
            height: 52,
            borderRadius: 6,
            background: '#C84335',
            color: '#fff',
            display: 'grid',
            placeItems: 'center',
            fontFamily: 'var(--font-serif)',
            fontWeight: 700,
            fontSize: 28,
          }}>D</div>
          <div>
            <div style={{ font: '500 13px var(--font-sans)', color: 'var(--n-700)' }}>Design Assets</div>
            <div style={{ font: '400 11px var(--font-sans)', color: 'var(--n-500)', marginTop: 2 }}>WORKBENCH</div>
          </div>
        </div>

        <div style={{
          position: 'absolute',
          bottom: -80,
          right: -80,
          width: 280,
          height: 280,
          borderRadius: '50%',
          border: '1.5px solid rgba(200, 67, 53, 0.15)',
        }} />
      </div>

      <div className="public-login-form" style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 48px',
      }}>
        <div style={{ width: '100%', maxWidth: 360 }}>
          <h2 style={{ font: 'var(--type-h1)', color: 'var(--fg-1)', marginBottom: 8 }}>欢迎回来</h2>
          <p style={{ font: 'var(--type-body)', color: 'var(--fg-3)', marginBottom: 28 }}>登录设计资产工作台</p>

          {notice && (
            <div style={{
              padding: '12px 14px',
              marginBottom: 16,
              borderRadius: 8,
              background: '#fff5f3',
              border: '1px solid #ffd6cc',
              color: '#b42318',
              font: 'var(--type-caption)',
              lineHeight: 1.6,
            }}>
              {notice}
            </div>
          )}

          <form onSubmit={async (event) => {
            event.preventDefault();
            if (passwordLoading || ssoLoading) return;
            setNotice('');
            setPasswordLoading(true);
            try {
              await login(username.trim(), password);
              setPassword('');
              const params = new URLSearchParams(location.search);
              navigate(getSafeInAppReturnTo(params.get('return_to')) || '/', { replace: true });
            } catch (error) {
              const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
              setNotice(message || '登录失败，请检查账号和密码');
            } finally {
              setPasswordLoading(false);
            }
          }}>
            <label htmlFor="local-username" style={{ display: 'block', marginBottom: 6 }}>账号</label>
            <input id="local-username" name="username" autoComplete="username" required maxLength={100}
              value={username} onChange={(event) => setUsername(event.target.value)}
              disabled={passwordLoading || ssoLoading}
              style={{ width: '100%', height: 44, boxSizing: 'border-box', padding: '0 12px', marginBottom: 16, border: '1px solid var(--n-300)', borderRadius: 6 }} />
            <label htmlFor="local-password" style={{ display: 'block', marginBottom: 6 }}>密码</label>
            <input id="local-password" name="password" type="password" autoComplete="current-password" required maxLength={72}
              value={password} onChange={(event) => setPassword(event.target.value)}
              disabled={passwordLoading || ssoLoading}
              style={{ width: '100%', height: 44, boxSizing: 'border-box', padding: '0 12px', marginBottom: 20, border: '1px solid var(--n-300)', borderRadius: 6 }} />
            <button type="submit" disabled={passwordLoading || ssoLoading}
              style={{ width: '100%', height: 44, border: 'none', borderRadius: 6, background: 'var(--brand-teal-500)', color: '#fff', font: '500 15px var(--font-sans)' }}>
              {passwordLoading ? '登录中...' : '登录'}
            </button>
          </form>

          {authHubConfig.loginUrl && <button
            type="button"
            onClick={handleAuthHubLogin}
            disabled={ssoLoading || passwordLoading}
            style={{
              width: '100%',
              height: 44,
              marginTop: 12,
              borderRadius: 8,
              background: ssoLoading ? 'var(--brand-teal-300)' : 'var(--brand-teal-500)',
              color: '#fff',
              border: 'none',
              cursor: ssoLoading ? 'not-allowed' : 'pointer',
              font: '500 15px var(--font-sans)',
              transition: 'background .12s',
            }}
            onMouseEnter={(event) => {
              if (!ssoLoading) event.currentTarget.style.background = 'var(--brand-teal-600)';
            }}
            onMouseLeave={(event) => {
              if (!ssoLoading) event.currentTarget.style.background = 'var(--brand-teal-500)';
            }}
          >
            {ssoLoading ? '企业微信登录中...' : '企业微信登录'}
          </button>}

          <p style={{ font: 'var(--type-caption)', color: 'var(--fg-4)', textAlign: 'center', marginTop: 24 }}>
            登录即代表您已阅读并同意《用户协议》与《隐私政策》
          </p>
        </div>
      </div>
    </div>
  );
}
