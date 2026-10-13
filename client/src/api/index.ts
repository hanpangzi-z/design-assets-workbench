import axios from 'axios';
import type { InternalAxiosRequestConfig } from 'axios';
import { isLocalDevNoLogin } from '@/utils/localDevAuth';
import type { LocalSessionRecovery } from '@/store/authStore';

type RetriableRequestConfig = InternalAxiosRequestConfig & {
  _retry?: boolean;
  skipAuthRefresh?: boolean;
  _localAuthRecovery?: LocalSessionRecovery;
};

const api = axios.create({
  baseURL: '/api/v1',
  timeout: 30000,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

function isAuthEndpoint(url?: string) {
  return Boolean(
    url?.includes('/auth/login') ||
    url?.includes('/auth/refresh') ||
    url?.includes('/auth/auth-hub/exchange') ||
    url?.includes('/auth/designops-sso/exchange') ||
    url?.includes('/auth/benlai-sso/login')
  );
}

// 请求拦截器：自动附加 JWT
api.interceptors.request.use(async (config) => {
  let recovered = (config as RetriableRequestConfig)._localAuthRecovery;
  if (isLocalDevNoLogin() && localAuthRecovery && !config.url?.includes('/auth/')) {
    recovered = await localAuthRecovery;
  }
  if (isLocalDevNoLogin() && recovered && !config.url?.includes('/auth/')) {
    const { default: store } = await import('@/store/authStore');
    const current = store.getState();
    if (!current.user || !current.isAuthenticated) throw new Error(current.localAuthError || '本地用户确认失败，请重试');
    if (isMutatingRequest(config) && (recovered.identityChanged || recovered.userId !== current.user.id
      || recovered.sessionGeneration !== current.getSessionGeneration()
      || recovered.accessToken !== localStorage.getItem('accessToken'))) throw localIdentityChangedError();
  }
  const token = localStorage.getItem('accessToken');
  if (token && !isAuthEndpoint(config.url)) {
    config.headers.Authorization = `Bearer ${token}`;
  } else if (isLocalDevNoLogin() && !token) {
    delete config.headers.Authorization;
    delete config.headers.authorization;
  }
  return config;
});

// 响应拦截器：处理 401 自动刷新
let isRefreshing = false;
let failedQueue: Array<{
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}> = [];
let loginRedirectPending = false;
const REFRESH_TIMEOUT_MS = 10000;
let localAuthRecovery: Promise<LocalSessionRecovery> | null = null;
let lastLocalAuthRecovery: { token: string; result: LocalSessionRecovery } | null = null;

function isMutatingRequest(config: InternalAxiosRequestConfig) {
  return !['get', 'head', 'options'].includes((config.method || 'get').toLowerCase());
}

function localIdentityChangedError() {
  return new Error('本地用户已切换，请重新操作');
}

function recoverLocalAuth(token: string): Promise<LocalSessionRecovery> {
  if (localAuthRecovery) return localAuthRecovery;
  const recovery = import('@/store/authStore')
    .then(({ default: store }) => store.getState().recoverLocalSession(token))
    .then((result) => { lastLocalAuthRecovery = { token, result }; return result; });
  const tracked = recovery.finally(() => { if (localAuthRecovery === tracked) localAuthRecovery = null; });
  localAuthRecovery = tracked;
  return tracked;
}

function redirectToLoginOnce() {
  if (loginRedirectPending) return;
  loginRedirectPending = true;
  if (window.location.pathname !== '/login') {
    window.location.replace('/login');
  }
}

function processQueue(error: unknown, token: string | null = null) {
  failedQueue.forEach((p) => {
    if (error) {
      p.reject(error);
    } else {
      p.resolve(token);
    }
  });
  failedQueue = [];
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config as RetriableRequestConfig | undefined;
    if (isLocalDevNoLogin() && error.response?.status === 401) {
      if (!originalRequest || originalRequest._retry || originalRequest.skipAuthRefresh || isAuthEndpoint(originalRequest.url)) {
        return Promise.reject(error);
      }
      const authorization = String(originalRequest.headers?.Authorization || originalRequest.headers?.authorization || '');
      const requestToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
      const recovery = localAuthRecovery
        || (requestToken && localStorage.getItem('accessToken') ? recoverLocalAuth(requestToken) : null)
        || (requestToken && lastLocalAuthRecovery?.token === requestToken ? Promise.resolve(lastLocalAuthRecovery.result) : null);
      if (!recovery) return Promise.reject(error);
      originalRequest._retry = true;
      const recovered = await recovery;
      if (isMutatingRequest(originalRequest) && recovered.identityChanged) throw localIdentityChangedError();
      originalRequest._localAuthRecovery = recovered;
      delete originalRequest.headers.Authorization;
      delete originalRequest.headers.authorization;
      return api(originalRequest);
    }

    if (
      error.response?.status === 401 &&
      originalRequest &&
      !originalRequest._retry &&
      !originalRequest.skipAuthRefresh &&
      !isAuthEndpoint(originalRequest?.url)
    ) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          const timeoutId = window.setTimeout(() => {
            reject(new Error('refresh_timeout'));
          }, REFRESH_TIMEOUT_MS);
          failedQueue.push({
            resolve: (value) => {
              window.clearTimeout(timeoutId);
              resolve(value);
            },
            reject: (reason) => {
              window.clearTimeout(timeoutId);
              reject(reason);
            },
          });
        }).then((token) => {
          originalRequest.headers.Authorization = `Bearer ${token}`;
          return api(originalRequest);
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      const refreshToken = localStorage.getItem('refreshToken');
      if (!refreshToken) {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        redirectToLoginOnce();
        return Promise.reject(error);
      }

      try {
        const { data } = await axios.post('/api/v1/auth/refresh', { refreshToken }, { timeout: REFRESH_TIMEOUT_MS });
        const newToken = data.data.accessToken;
        localStorage.setItem('accessToken', newToken);
        localStorage.setItem('refreshToken', data.data.refreshToken);
        processQueue(null, newToken);
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError, null);
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        redirectToLoginOnce();
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

export default api;
