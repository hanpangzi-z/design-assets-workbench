import { create } from 'zustand';
import type { User, Permissions } from 'shared/types';
import {
  authHubExchangeApi,
  benlaiSsoLoginApi,
  designOpsSsoExchangeApi,
  impersonateApi,
  loginApi,
  logoutApi,
  getMeApi,
  stopImpersonateApi,
} from '@/api/auth';
import type { Impersonator } from '@/api/auth';
import type { LoginResponse } from 'shared/types';
import { isLocalDevNoLogin } from '@/utils/localDevAuth';

export type LocalSessionRecovery = {
  identityChanged: boolean;
  userId: number;
  sessionGeneration: number;
  accessToken: string | null;
};

interface AuthState {
  user: User | null;
  permissions: Permissions | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  hydratedFromCache: boolean;
  impersonator: Impersonator | null;
  localAuthError: string | null;

  login: (username: string, password: string) => Promise<void>;
  loginWithAuthHubTicket: (ticket: string, appId?: string) => Promise<void>;
  loginWithBenlaiSso: () => Promise<void>;
  loginWithDesignOpsSso: (token: string) => Promise<void>;
  impersonate: (userId: number) => Promise<void>;
  stopImpersonate: () => Promise<void>;
  logout: () => Promise<void>;
  fetchMe: (options?: { force?: boolean }) => Promise<void>;
  recoverLocalSession: (expectedToken: string) => Promise<LocalSessionRecovery>;
  getSessionGeneration: () => number;
  reset: () => void;
}

function persistSession(
  data: LoginResponse,
  set: (state: Partial<AuthState>) => void,
  impersonator: Impersonator | null = null,
) {
  authGeneration += 1;
  localStorage.setItem('accessToken', data.accessToken);
  localStorage.setItem('refreshToken', data.refreshToken);
  set({
    user: data.user,
    permissions: data.user.role?.permissions || null,
    isAuthenticated: true,
    isLoading: false,
    hydratedFromCache: false,
    impersonator,
    localAuthError: null,
  });
  writeAuthSnapshot(data.user, impersonator);
}

function clearSession(set: (state: Partial<AuthState>) => void, extra: Partial<AuthState> = {}) {
  authGeneration += 1;
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem(AUTH_SNAPSHOT_KEY);
  set({ user: null, permissions: null, isAuthenticated: false, isLoading: false, hydratedFromCache: false, impersonator: null, localAuthError: null, ...extra });
}

function getHttpStatus(error: unknown) {
  return (error as { response?: { status?: number } })?.response?.status;
}

const AUTH_ME_TIMEOUT_MS = 10000;
const FETCH_ME_FAILURE_COOLDOWN_MS = 1500;
const AUTH_SNAPSHOT_KEY = 'benlai.auth.snapshot';
const authHubExchangeRequests = new Map<string, Promise<void>>();
let fetchMeRequest: Promise<void> | null = null;
let authGeneration = 0;
let fetchMeRequestGeneration = -1;
let fetchMeFailedAt = 0;

type AuthSnapshot = {
  user: User;
  impersonator: Impersonator | null;
  cachedAt: number;
};

function readAuthSnapshot(): AuthSnapshot | null {
  if (!localStorage.getItem('accessToken')) return null;
  try {
    const raw = localStorage.getItem(AUTH_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthSnapshot>;
    if (!parsed.user?.id) return null;
    return {
      user: parsed.user as User,
      impersonator: parsed.impersonator || null,
      cachedAt: Number(parsed.cachedAt || 0),
    };
  } catch {
    localStorage.removeItem(AUTH_SNAPSHOT_KEY);
    return null;
  }
}

function writeAuthSnapshot(user: User, impersonator: Impersonator | null = null) {
  localStorage.setItem(AUTH_SNAPSHOT_KEY, JSON.stringify({
    user,
    impersonator,
    cachedAt: Date.now(),
  }));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => reject(new Error(message)), ms);
    promise.then(resolve, reject).finally(() => window.clearTimeout(timeoutId));
  });
}

const initialAuthSnapshot = isLocalDevNoLogin() ? null : readAuthSnapshot();

const useAuthStore = create<AuthState>((set, get) => ({
  user: initialAuthSnapshot?.user || null,
  permissions: initialAuthSnapshot?.user.role?.permissions || null,
  isAuthenticated: !isLocalDevNoLogin() && !!localStorage.getItem('accessToken'),
  isLoading: false,
  hydratedFromCache: Boolean(initialAuthSnapshot?.user),
  impersonator: initialAuthSnapshot?.impersonator || null,
  localAuthError: null,

  login: async (username, password) => {
    clearSession(set);
    const data = await loginApi({ username, password });
    persistSession(data, set);
  },

  loginWithAuthHubTicket: async (ticket, appId) => {
    const requestKey = `${appId || ''}:${ticket}`;
    const existingRequest = authHubExchangeRequests.get(requestKey);
    if (existingRequest) {
      return existingRequest;
    }

    const request = (async () => {
      const data = await authHubExchangeApi({ ticket, appId });
      persistSession(data, set);
    })();

    authHubExchangeRequests.set(requestKey, request);
    try {
      await request;
    } finally {
      authHubExchangeRequests.delete(requestKey);
    }
  },

  loginWithBenlaiSso: async () => {
    const data = await benlaiSsoLoginApi();
    persistSession(data, set);
  },

  loginWithDesignOpsSso: async (token) => {
    const data = await designOpsSsoExchangeApi(token);
    persistSession(data, set);
  },

  impersonate: async (userId) => {
    const data = await impersonateApi(userId);
    persistSession(data, set, data.impersonator);
  },

  stopImpersonate: async () => {
    const data = await stopImpersonateApi();
    persistSession(data, set, null);
  },

  logout: async () => {
    try {
      await logoutApi();
    } catch {
      // 忽略登出失败
    }
    clearSession(set);
  },

  fetchMe: async (options = {}) => {
    if (fetchMeRequest && fetchMeRequestGeneration === authGeneration) return fetchMeRequest;
    const requestGeneration = authGeneration;
    fetchMeRequestGeneration = requestGeneration;

    fetchMeRequest = (async () => {
      const localNoLogin = isLocalDevNoLogin();
      if (!localStorage.getItem('accessToken') && !localNoLogin) {
        clearSession(set, { isLoading: false });
        return;
      }

      if (!localNoLogin && !options.force && !get().user && fetchMeFailedAt && Date.now() - fetchMeFailedAt < FETCH_ME_FAILURE_COOLDOWN_MS) {
        clearSession(set, { isLoading: false });
        return;
      }

      set({ isLoading: true, localAuthError: null });
      let acceptingResponse = true;
      const requestToken = localStorage.getItem('accessToken');
      try {
        const me = await withTimeout((async () => {
          try {
            return await getMeApi();
          } catch (error) {
            if (localNoLogin && acceptingResponse && authGeneration === requestGeneration
              && getHttpStatus(error) === 401 && requestToken
              && localStorage.getItem('accessToken') === requestToken) {
              localStorage.removeItem('accessToken');
              localStorage.removeItem('refreshToken');
              return getMeApi();
            }
            throw error;
          }
        })(), AUTH_ME_TIMEOUT_MS, 'auth_me_timeout');
        if (authGeneration !== requestGeneration) return;
        fetchMeFailedAt = 0;
        set({
          user: me.user,
          permissions: me.user.role?.permissions || null,
          impersonator: me.impersonator,
          isAuthenticated: true,
          isLoading: false,
          hydratedFromCache: false,
          localAuthError: null,
        });
        writeAuthSnapshot(me.user, me.impersonator);
      } catch (error) {
        if (authGeneration !== requestGeneration) return;
        const status = getHttpStatus(error);
        if (localNoLogin) {
          const serverMessage = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
          const reason = serverMessage || ((error as Error)?.message === 'auth_me_timeout'
            ? '后台响应超时' : '无法连接后台或本地用户不可用');
          clearSession(set, { localAuthError: `本地用户确认失败：${reason}` });
          throw error;
        }
        if (status === 401) {
          fetchMeFailedAt = Date.now();
          clearSession(set, { isLoading: false });
          return;
        }

        const current = get();
        if (!current.user) {
          fetchMeFailedAt = Date.now();
          console.warn('[Auth] fetchMe failed before a user was loaded; clearing stale session', { status });
          clearSession(set, { isLoading: false });
          return;
        }

        console.warn('[Auth] fetchMe failed; keeping current session', { status });
        set({
          isLoading: false,
          isAuthenticated: current.isAuthenticated || Boolean(localStorage.getItem('accessToken')),
          hydratedFromCache: false,
        });
        throw error;
      } finally {
        acceptingResponse = false;
        if (fetchMeRequestGeneration === requestGeneration) fetchMeRequest = null;
      }
    })();

    return fetchMeRequest;
  },

  recoverLocalSession: async (expectedToken) => {
    const previousUserId = get().user?.id;
    const replacedToken = localStorage.getItem('accessToken') !== expectedToken;
    if (!replacedToken) clearSession(set, { isLoading: true });
    if (!replacedToken || !get().user || !get().isAuthenticated) await get().fetchMe({ force: true });
    const current = get();
    if (!current.user || !current.isAuthenticated) throw new Error(current.localAuthError || '本地用户确认失败，请重试');
    return { identityChanged: replacedToken || previousUserId !== current.user.id,
      userId: current.user.id, sessionGeneration: authGeneration, accessToken: localStorage.getItem('accessToken') };
  },

  getSessionGeneration: () => authGeneration,

  reset: () => {
    clearSession(set);
  },
}));

export default useAuthStore;
