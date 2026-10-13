import api from './index';
import type { LoginRequest, LoginResponse, User } from 'shared/types';

export interface Impersonator {
  id: number;
  displayName: string;
}

export async function loginApi(data: LoginRequest) {
  const res = await api.post<{ code: number; message: string; data: LoginResponse }>('/auth/login', data);
  return res.data.data;
}

export async function authHubExchangeApi(data: { ticket: string; appId?: string }) {
  const res = await api.post<{ code: number; message: string; data: LoginResponse }>('/auth/auth-hub/exchange', {
    ticket: data.ticket,
    app_id: data.appId,
  });
  return res.data.data;
}

export async function benlaiSsoLoginApi() {
  const res = await api.post<{ code: number; message: string; data: LoginResponse }>('/auth/benlai-sso/login', {});
  return res.data.data;
}

export async function designOpsSsoExchangeApi(token: string) {
  const res = await api.post<{ code: number; message: string; data: LoginResponse }>('/auth/designops-sso/exchange', {
    token,
  });
  return res.data.data;
}

export async function getAuthHubConfigApi() {
  const res = await api.get<{
    code: number;
    message: string;
    data: { appId: string; loginUrl: string; callbackUrl?: string; configured: boolean };
  }>('/auth/auth-hub/config');
  return res.data.data;
}

export async function logoutApi() {
  await api.post('/auth/logout');
}

export async function getMeApi() {
  const res = await api.get<{
    code: number;
    message: string;
    data: { user: User; impersonator: Impersonator | null };
  }>('/auth/me', { skipAuthRefresh: true } as any);
  return res.data.data;
}

export async function impersonateApi(userId: number) {
  const res = await api.post<{
    code: number;
    message: string;
    data: LoginResponse & { impersonator: Impersonator };
  }>('/auth/impersonate', { userId });
  return res.data.data;
}

export async function stopImpersonateApi() {
  const res = await api.post<{ code: number; message: string; data: LoginResponse }>(
    '/auth/stop-impersonate',
    {},
  );
  return res.data.data;
}

export async function refreshTokenApi(refreshToken: string) {
  const res = await api.post('/auth/refresh', { refreshToken });
  return res.data.data;
}
