import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createHmac, timingSafeEqual } from 'crypto';
import { User, Role } from '../models';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import { requireEnv } from '../utils/env';
import { findMatchingSuperAdminIdentifier, getSuperAdminIdentifiers } from '../utils/superAdmin';

const JWT_SECRET = requireEnv('JWT_SECRET');
const JWT_REFRESH_SECRET = requireEnv('JWT_REFRESH_SECRET');
const AUTH_HUB_APP_ID = process.env.AUTH_HUB_APP_ID || 'benlai-design';
const AUTH_HUB_DEFAULT_ROLE = process.env.AUTH_HUB_DEFAULT_ROLE || 'user';
const DEFAULT_AUTH_HUB_BASE_URL = '';
const BENLAI_SSO_API_ROOT = (process.env.BENLAI_SSO_API_ROOT || '').replace(/\/+$/, '');
const BENLAI_UUK_COOKIE = process.env.BENLAI_UUK_COOKIE || 'uuk';
const BENLAI_NOT_LOGGED_IN_CODE = 2023042622;
const DESIGNOPS_SSO_SECRET = process.env.DESIGN_LIBRARY_SSO_SECRET?.trim() || '';
const DESIGNOPS_SSO_ISSUER = 'designops-platform';
const DESIGNOPS_SSO_AUDIENCE = 'benlai-design-library';

interface AuthHubClaims {
  name?: string;
  avatar?: string;
  avatarUrl?: string;
  avatar_url?: string;
  email?: string;
  department?: Array<string | number>;
  department_codes?: Array<string | number>;
  departmentCodes?: Array<string | number>;
  department_path?: string;
  department_levels?: Record<string, { id?: string | number; name?: string }>;
  departmentLevels?: Record<string, { id?: string | number; name?: string }>;
  employee_no?: string;
  employeeNo?: string;
  org_path?: string | string[];
  orgPath?: string | string[];
  extattr?: {
    attrs?: Array<{
      name?: string;
      value?: string;
      text?: { value?: string };
    }>;
  };
}

interface AuthHubExchangeResponse {
  success: boolean;
  app_id?: string;
  subject?: string;
  claims?: AuthHubClaims;
  error?: string;
}

interface BenlaiUser {
  user: {
    id: number;
    name: string;
    avatar?: string;
  };
  tenant?: {
    id?: number;
    name?: string;
  };
}

interface BenlaiResponse<T> {
  code?: number;
  value?: T;
  data?: T;
  msg?: string;
  message?: string;
  traceId?: string;
}

interface DesignOpsSsoClaims {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  name?: string;
  email?: string;
  employee_no?: string;
  stable_id?: string;
  auth_user_id?: string;
  wecom_user_id?: string;
  avatar_url?: string;
}

function generateTokens(userId: number, impersonatorId?: number) {
  const payload = impersonatorId ? { userId, impersonatorId } : { userId };
  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '2h' });
  const refreshToken = jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: '7d' });
  return { accessToken, refreshToken };
}

function getAuthHubExchangeUrl() {
  const explicitUrl = process.env.AUTH_HUB_EXCHANGE_URL?.trim();
  if (explicitUrl) return explicitUrl;

  const baseUrl = (process.env.AUTH_HUB_BASE_URL?.trim() || DEFAULT_AUTH_HUB_BASE_URL).replace(/\/+$/, '');
  if (baseUrl) return `${baseUrl}/api/auth/exchange`;

  return '';
}

function getAuthHubLoginUrl() {
  const explicitUrl = process.env.AUTH_HUB_LOGIN_URL?.trim();
  if (explicitUrl) return explicitUrl;

  const baseUrl = (process.env.AUTH_HUB_BASE_URL?.trim() || DEFAULT_AUTH_HUB_BASE_URL).replace(/\/+$/, '');
  if (baseUrl) return `${baseUrl}/login`;

  const exchangeUrl = process.env.AUTH_HUB_EXCHANGE_URL?.trim();
  if (!exchangeUrl) return '';

  try {
    const parsed = new URL(exchangeUrl);
    return `${parsed.origin}/login`;
  } catch {
    return '';
  }
}

function getAuthHubCallbackUrl() {
  return process.env.AUTH_HUB_CALLBACK_URL?.trim() || '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function readCookie(req: Request, name: string) {
  const header = req.headers.cookie;
  if (!header) return '';

  for (const part of header.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey !== name) continue;
    try {
      return decodeURIComponent(rawValue.join('='));
    } catch {
      return rawValue.join('=');
    }
  }

  return '';
}

function unwrapBenlaiResponse<T>(raw: unknown) {
  let current = (isRecord(raw) ? raw : {}) as Partial<BenlaiResponse<unknown>>;
  let depth = 0;

  while (
    depth < 2 &&
    isRecord(current.value) &&
    typeof (current.value as Record<string, unknown>).code === 'number'
  ) {
    current = current.value as Partial<BenlaiResponse<unknown>>;
    depth += 1;
  }

  const value = (current.value ?? current.data ?? null) as T | null;
  return {
    code: typeof current.code === 'number' ? current.code : null,
    value,
    message:
      (typeof current.message === 'string' && current.message) ||
      (typeof current.msg === 'string' && current.msg) ||
      (isRecord(value) ? readString(value, 'message') : undefined) ||
      null,
    traceId: typeof current.traceId === 'string' ? current.traceId : null,
  };
}

function isBenlaiUser(value: unknown): value is BenlaiUser {
  if (!isRecord(value)) return false;
  const user = value.user;
  if (!isRecord(user)) return false;
  return typeof user.id === 'number' && typeof user.name === 'string';
}

function signDesignOpsSsoInput(input: string) {
  return createHmac('sha256', DESIGNOPS_SSO_SECRET).update(input).digest('base64url');
}

function verifyDesignOpsSsoToken(token: string): DesignOpsSsoClaims {
  if (!DESIGNOPS_SSO_SECRET) {
    throw new AppError('Platform SSO is not configured', 503);
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AppError('平台免登录票据格式无效', 401);
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const input = `${encodedHeader}.${encodedPayload}`;
  const expected = signDesignOpsSsoInput(input);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    throw new AppError('平台免登录票据签名无效', 401);
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    throw new AppError('平台免登录票据内容无效', 401);
  }

  if (!isRecord(rawPayload)) {
    throw new AppError('平台免登录票据内容无效', 401);
  }

  const claims: DesignOpsSsoClaims = {
    iss: readString(rawPayload, 'iss') || '',
    aud: readString(rawPayload, 'aud') || '',
    sub: readString(rawPayload, 'sub') || '',
    iat: readNumber(rawPayload, 'iat') || 0,
    exp: readNumber(rawPayload, 'exp') || 0,
    name: readString(rawPayload, 'name'),
    email: readString(rawPayload, 'email'),
    employee_no: readString(rawPayload, 'employee_no'),
    stable_id: readString(rawPayload, 'stable_id'),
    auth_user_id: readString(rawPayload, 'auth_user_id'),
    wecom_user_id: readString(rawPayload, 'wecom_user_id'),
    avatar_url: readString(rawPayload, 'avatar_url'),
  };

  if (claims.iss !== DESIGNOPS_SSO_ISSUER || claims.aud !== DESIGNOPS_SSO_AUDIENCE || !claims.sub) {
    throw new AppError('平台免登录票据来源无效', 401);
  }
  if (claims.exp < Math.floor(Date.now() / 1000)) {
    throw new AppError('平台免登录票据已过期', 401);
  }

  return claims;
}

function uniqueStrings(values: Array<string | undefined | null>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function normalizeEmployeeNo(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function normalizeDesignOpsSubject(subject: string) {
  return subject.replace(/^authhub:/, '').replace(/^wecom:/, '').trim();
}

async function fetchBenlaiLoginUserInfo(uuk: string) {
  if (!BENLAI_SSO_API_ROOT) throw new AppError('Enterprise SSO is not configured', 503);
  const requestUrl = `${BENLAI_SSO_API_ROOT}/user/getLoginUserInfo`;
  const cookieHeader = `${BENLAI_UUK_COOKIE}=${encodeURIComponent(uuk)}`;

  let response = await fetch(requestUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader,
    },
    body: JSON.stringify({ [BENLAI_UUK_COOKIE]: uuk }),
  });
  let raw = await response.json().catch(() => null);
  let unwrapped = unwrapBenlaiResponse<BenlaiUser>(raw);

  if (response.ok && unwrapped.code === BENLAI_NOT_LOGGED_IN_CODE) {
    response = await fetch(requestUrl, {
      method: 'GET',
      headers: { Cookie: cookieHeader },
    });
    raw = await response.json().catch(() => null);
    unwrapped = unwrapBenlaiResponse<BenlaiUser>(raw);
  }

  if (!response.ok) {
    logger.warn(
      { scope: 'benlaiSso', status: response.status, code: unwrapped.code, traceId: unwrapped.traceId },
      'Benlai SSO: login user request failed'
    );
    throw new AppError('本来 SSO 校验失败', 502);
  }
  if (unwrapped.code === BENLAI_NOT_LOGGED_IN_CODE || !unwrapped.value) {
    throw new AppError('本来 SSO 未登录', 401);
  }
  if (unwrapped.code !== 0 && unwrapped.code !== 200) {
    logger.warn(
      { scope: 'benlaiSso', code: unwrapped.code, message: unwrapped.message, traceId: unwrapped.traceId },
      'Benlai SSO: login user rejected'
    );
    throw new AppError(unwrapped.message || '本来 SSO 返回失败', 401);
  }
  if (!isBenlaiUser(unwrapped.value)) {
    throw new AppError('本来 SSO 返回结构异常', 502);
  }

  return unwrapped.value;
}

async function exchangeTicketWithAuthHub(ticket: string, appId: string) {
  const exchangeUrl = getAuthHubExchangeUrl();
  const appSecret = process.env.AUTH_HUB_APP_SECRET;

  if (!exchangeUrl) {
    throw new AppError('Auth Hub exchange URL is not configured', 500);
  }
  if (!appSecret) {
    throw new AppError('Auth Hub app secret is not configured', 500);
  }

  let response: globalThis.Response;
  try {
    response = await fetch(exchangeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: appId,
        app_secret: appSecret,
        ticket,
      }),
    });
  } catch (err) {
    logger.error(
      { scope: 'authHub', exchangeUrl, err },
      'AuthHub: exchange request failed'
    );
    throw new AppError('Auth Hub exchange request failed', 502);
  }

  const payload = (await response.json().catch(() => null)) as AuthHubExchangeResponse | null;
  if (payload && !payload.success) {
    const status = payload.error === 'invalid_app_secret' ? 500 : 401;
    logger.error(
      { scope: 'authHub', exchangeUrl, status: response.status, error: payload.error },
      'AuthHub: exchange rejected'
    );
    throw new AppError(payload.error || 'invalid_ticket', status);
  }

  if (!response.ok || !payload) {
    logger.error(
      {
        scope: 'authHub',
        exchangeUrl,
        status: response.status,
        contentType: response.headers.get('content-type'),
        error: payload?.error,
      },
      'AuthHub: exchange failed'
    );
    throw new AppError(`Auth Hub exchange failed (${response.status})`, 502);
  }

  return payload;
}

async function resolveDefaultRoleId() {
  const role =
    (await Role.findOne({ where: { name: AUTH_HUB_DEFAULT_ROLE } })) ||
    (await Role.findOne({ where: { name: 'user' } })) ||
    (await Role.findOne({ where: { name: 'designer' } })) ||
    (await Role.findOne({ where: { name: 'admin' } }));

  if (!role) {
    throw new AppError('No role is available for Auth Hub user provisioning', 500);
  }

  return role.id;
}

function getDepartmentLevels(claims: AuthHubClaims) {
  return claims.department_levels || claims.departmentLevels || null;
}

function getDepartmentPath(claims: AuthHubClaims) {
  const directPath = claims.department_path || claims.org_path || claims.orgPath;
  if (Array.isArray(directPath)) {
    const names = directPath.map((item) => String(item || '').trim()).filter(Boolean);
    if (names.length) return names.join(' / ');
  }
  if (typeof directPath === 'string' && directPath.trim()) return directPath.trim();

  const levels = getDepartmentLevels(claims);
  if (!levels) return undefined;

  const names = Object.entries(levels)
    .sort(([a], [b]) => {
      const aLevel = Number(a.replace(/\D/g, '')) || 0;
      const bLevel = Number(b.replace(/\D/g, '')) || 0;
      return aLevel - bLevel;
    })
    .map(([, level]) => level?.name?.trim())
    .filter(Boolean);

  return names.length ? names.join(' / ') : undefined;
}

function getEmployeeNo(claims: AuthHubClaims) {
  const directEmployeeNo = normalizeEmployeeNo(claims.employee_no || claims.employeeNo);
  if (directEmployeeNo) return directEmployeeNo;

  const attrs = claims.extattr?.attrs || [];
  const employeeAttr = attrs.find((attr) => attr.name === '工号' || attr.name?.toLowerCase() === 'employee_no');
  return normalizeEmployeeNo(employeeAttr?.value || employeeAttr?.text?.value) || undefined;
}

function buildAuthHubUserProfile(claims: AuthHubClaims, subject: string) {
  const avatarUrl = claims.avatarUrl || claims.avatar_url || claims.avatar;
  const departmentIds = claims.department_codes || claims.departmentCodes || claims.department;
  const departmentLevels = getDepartmentLevels(claims);
  const departmentPath = getDepartmentPath(claims);
  const employeeNo = getEmployeeNo(claims);

  return {
    ...(claims.email && { email: claims.email }),
    ...(avatarUrl && { avatarUrl }),
    authSubject: subject,
    ...(departmentIds && { departmentIds }),
    ...(departmentLevels && { departmentLevels }),
    ...(departmentPath && { departmentPath }),
    ...(employeeNo && { employeeNo }),
    ...(claims.extattr && { extattr: claims.extattr }),
  };
}

async function findOrCreateAuthHubUser(payload: AuthHubExchangeResponse) {
  const claims = payload.claims || {};
  const employeeNo = getEmployeeNo(claims);

  if (!employeeNo) {
    throw new AppError('Auth Hub response missing employee_no', 502);
  }

  const subject = payload.subject || `employee:${employeeNo}`;
  const username = employeeNo;
  const displayName = claims.name || username;
  const authSubject = subject || username;
  const profile = buildAuthHubUserProfile({ ...claims, name: displayName }, authSubject);
  const existing =
    (await User.findOne({
      where: { employeeNo },
      include: [{ model: Role, as: 'role' }],
    })) ||
    (authSubject
      ? await User.findOne({
          where: { authSubject },
          include: [{ model: Role, as: 'role' }],
        })
      : null) ||
    (await User.findOne({
      where: { username },
      include: [{ model: Role, as: 'role' }],
    }));

  if (existing) {
    await existing.update({
      username,
      displayName,
      ...profile,
      employeeNo,
      lastLoginAt: new Date(),
    });
    return User.findByPk(existing.id, { include: [{ model: Role, as: 'role' }] });
  }

  const passwordHash = await bcrypt.hash(`auth-hub:${authSubject}:${Date.now()}`, 10);
  const roleId = await resolveDefaultRoleId();
  const user = await User.create({
    username,
    displayName,
    ...profile,
    passwordHash,
    roleId,
    lastLoginAt: new Date(),
  });

  return User.findByPk(user.id, { include: [{ model: Role, as: 'role' }] });
}

async function findOrCreateBenlaiSsoUser(benlaiUser: BenlaiUser) {
  const benlaiUserId = String(benlaiUser.user.id);
  const authSubject = `benlai:${benlaiUserId}`;
  const username = benlaiUserId;
  const displayName = benlaiUser.user.name || username;
  const tenantName = benlaiUser.tenant?.name?.trim();
  const profile = {
    authSubject,
    employeeNo: benlaiUserId,
    avatarUrl: benlaiUser.user.avatar || undefined,
    departmentIds: benlaiUser.tenant?.id ? [benlaiUser.tenant.id] : undefined,
    departmentPath: tenantName || undefined,
    extattr: {
      benlaiUserId,
      tenantId: benlaiUser.tenant?.id,
      tenantName: benlaiUser.tenant?.name,
    },
  };
  const existing =
    (await User.findOne({
      where: { authSubject },
      include: [{ model: Role, as: 'role' }],
    })) ||
    (await User.findOne({
      where: { username },
      include: [{ model: Role, as: 'role' }],
    })) ||
    (await User.findOne({
      where: { employeeNo: benlaiUserId },
      include: [{ model: Role, as: 'role' }],
    }));

  if (existing) {
    // SSO only unifies identity. Role/permissions stay owned by this app.
    await existing.update({
      displayName,
      ...profile,
      lastLoginAt: new Date(),
    });
    return User.findByPk(existing.id, { include: [{ model: Role, as: 'role' }] });
  }

  const passwordHash = await bcrypt.hash(`benlai-sso:${authSubject}:${Date.now()}`, 10);
  const roleId = await resolveDefaultRoleId();
  const user = await User.create({
    username,
    displayName,
    ...profile,
    passwordHash,
    roleId,
    lastLoginAt: new Date(),
  });

  return User.findByPk(user.id, { include: [{ model: Role, as: 'role' }] });
}

async function findOrCreateDesignOpsSsoUser(claims: DesignOpsSsoClaims) {
  const subject = claims.sub.trim();
  const normalizedSubject = normalizeDesignOpsSubject(subject);
  const employeeNo =
    claims.employee_no ||
    (claims.stable_id && !claims.stable_id.startsWith('authhub:') ? claims.stable_id : undefined);
  const username = employeeNo || claims.wecom_user_id || claims.auth_user_id || normalizedSubject || subject;
  const displayName = claims.name || username;
  const authSubject = `designops:${subject}`;
  const usernameCandidates = uniqueStrings([
    username,
    claims.employee_no,
    claims.stable_id,
    claims.wecom_user_id,
    claims.auth_user_id,
    normalizedSubject,
    subject,
  ]);
  const employeeNoCandidates = uniqueStrings([claims.employee_no, claims.stable_id]);
  const profile = {
    authSubject,
    ...(claims.email && { email: claims.email }),
    ...(claims.avatar_url && { avatarUrl: claims.avatar_url }),
    ...(employeeNo && { employeeNo }),
    extattr: {
      designOpsSso: {
        sub: subject,
        employeeNo: claims.employee_no,
        stableId: claims.stable_id,
        authUserId: claims.auth_user_id,
        wecomUserId: claims.wecom_user_id,
      },
    },
  };

  let existing = await User.findOne({
    where: { authSubject },
    include: [{ model: Role, as: 'role' }],
  });
  for (const candidate of usernameCandidates) {
    if (existing) break;
    existing = await User.findOne({
      where: { username: candidate },
      include: [{ model: Role, as: 'role' }],
    });
  }
  for (const candidate of employeeNoCandidates) {
    if (existing) break;
    existing = await User.findOne({
      where: { employeeNo: candidate },
      include: [{ model: Role, as: 'role' }],
    });
  }

  if (existing) {
    // Platform SSO only proves identity. Design-library role/permissions stay local.
    await existing.update({
      displayName,
      ...profile,
      lastLoginAt: new Date(),
    });
    return User.findByPk(existing.id, { include: [{ model: Role, as: 'role' }] });
  }

  const passwordHash = await bcrypt.hash(`designops-sso:${authSubject}:${Date.now()}`, 10);
  const roleId = await resolveDefaultRoleId();
  const user = await User.create({
    username,
    displayName,
    ...profile,
    passwordHash,
    roleId,
    lastLoginAt: new Date(),
  });

  return User.findByPk(user.id, { include: [{ model: Role, as: 'role' }] });
}

function getAuthLogSummary(user: InstanceType<typeof User>, source: string, extra: Record<string, unknown> = {}) {
  const role = user.get('role') as InstanceType<typeof Role> | undefined;
  const permissions = role?.permissions || {};

  return {
    source,
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    role: role ? `${role.name}(${role.displayName})` : undefined,
    activePermissions: Object.entries(permissions)
      .filter(([, enabled]) => enabled === true)
      .map(([key]) => key),
    authSubject: user.authSubject,
    employeeNo: user.employeeNo,
    departmentPath: user.departmentPath,
    ...extra,
  };
}

function logAuthSuccess(user: InstanceType<typeof User>, source: string, extra: Record<string, unknown> = {}) {
  logger.info({ scope: 'auth', ...getAuthLogSummary(user, source, extra) }, 'Auth: login success');
}

/**
 * 登录成功后兜底：如果当前员工工号在 SUPER_ADMIN_EMPLOYEE_NOS 列表里且尚未拥有 super_admin 角色，
 * 直接提升。覆盖"启动时账号还不存在（如 AuthHub 首次登录新建用户）"这种情况。
 * 提升后重新查一次 user 让 role 关联也是新的，下游 logAuthSuccess / 返回给前端的都对得上。
 */
async function maybeAutoPromoteSuperAdmin(
  user: InstanceType<typeof User>,
): Promise<InstanceType<typeof User>> {
  const matchedIdentifier = findMatchingSuperAdminIdentifier(user, getSuperAdminIdentifiers());
  if (!matchedIdentifier) return user;

  const currentRole = user.get('role') as InstanceType<typeof Role> | undefined;
  if (currentRole?.name === 'super_admin') return user;

  const superAdminRole = await Role.findOne({ where: { name: 'super_admin' } });
  if (!superAdminRole) return user;

  await user.update({ roleId: superAdminRole.id });
  logger.info(
    { scope: 'auth', matchedIdentifier, username: user.username, employeeNo: user.employeeNo, userId: user.id },
    'auto-promoted to super_admin from SUPER_ADMIN_EMPLOYEE_NOS'
  );

  const reloaded = await User.findByPk(user.id, {
    include: [{ model: Role, as: 'role' }],
  });
  return reloaded || user;
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      throw new AppError('用户名和密码不能为空', 400);
    }

    const user = await User.findOne({
      where: { username },
      include: [{ model: Role, as: 'role' }],
    });

    if (!user) {
      logger.warn(
        { scope: 'auth', reason: 'user_not_found', username, ip: req.ip },
        'Auth: login failed'
      );
      throw new AppError('用户名或密码错误', 401);
    }

    if (!user.isActive) {
      logger.warn(
        { scope: 'auth', reason: 'account_disabled', username, userId: user.id, ip: req.ip },
        'Auth: login failed'
      );
      throw new AppError('账号已被停用', 403);
    }

    const isValid = await user.validatePassword(password);
    if (!isValid) {
      logger.warn(
        { scope: 'auth', reason: 'wrong_password', username, userId: user.id, ip: req.ip },
        'Auth: login failed'
      );
      throw new AppError('用户名或密码错误', 401);
    }

    // 更新最后登录时间
    await user.update({ lastLoginAt: new Date() });

    const promoted = await maybeAutoPromoteSuperAdmin(user);
    const tokens = generateTokens(promoted.id);
    logAuthSuccess(promoted, 'password');

    res.json({
      code: 200,
      message: '登录成功',
      data: {
        ...tokens,
        user: promoted.toSafeJSON(),
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function authHubExchange(req: Request, res: Response, next: NextFunction) {
  try {
    const { ticket, app_id: appIdFromBody, appId } = req.body as {
      ticket?: string;
      app_id?: string;
      appId?: string;
    };
    const nextAppId = appIdFromBody || appId || AUTH_HUB_APP_ID;

    if (!ticket) {
      throw new AppError('ticket is required', 400);
    }

    const authHubPayload = await exchangeTicketWithAuthHub(ticket, nextAppId);
    const user = await findOrCreateAuthHubUser(authHubPayload);
    if (!user || !user.isActive) {
      throw new AppError('User is unavailable', 401);
    }

    const promoted = await maybeAutoPromoteSuperAdmin(user);
    const tokens = generateTokens(promoted.id);
    logAuthSuccess(promoted, 'auth_hub', {
      appId: nextAppId,
      subject: authHubPayload.subject,
    });

    res.json({
      code: 200,
      message: '登录成功',
      data: {
        ...tokens,
        user: promoted.toSafeJSON(),
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function benlaiSsoLogin(req: Request, res: Response, next: NextFunction) {
  try {
    const uuk = readCookie(req, BENLAI_UUK_COOKIE);
    if (!uuk) {
      throw new AppError('缺少本来 SSO 登录态', 401);
    }

    const benlaiUser = await fetchBenlaiLoginUserInfo(uuk);
    const user = await findOrCreateBenlaiSsoUser(benlaiUser);
    if (!user || !user.isActive) {
      throw new AppError('User is unavailable', 401);
    }

    const promoted = await maybeAutoPromoteSuperAdmin(user);
    const tokens = generateTokens(promoted.id);
    logAuthSuccess(promoted, 'benlai_sso', {
      benlaiUserId: benlaiUser.user.id,
      tenantId: benlaiUser.tenant?.id,
    });

    res.json({
      code: 200,
      message: '登录成功',
      data: {
        ...tokens,
        user: promoted.toSafeJSON(),
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function designOpsSsoExchange(req: Request, res: Response, next: NextFunction) {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token) {
      throw new AppError('缺少平台免登录票据', 400);
    }

    const claims = verifyDesignOpsSsoToken(token);
    const user = await findOrCreateDesignOpsSsoUser(claims);
    if (!user || !user.isActive) {
      throw new AppError('User is unavailable', 401);
    }

    const promoted = await maybeAutoPromoteSuperAdmin(user);
    const tokens = generateTokens(promoted.id);
    logAuthSuccess(promoted, 'designops_sso', {
      designOpsSubject: claims.sub,
      employeeNo: claims.employee_no,
    });

    res.json({
      code: 200,
      message: '登录成功',
      data: {
        ...tokens,
        user: promoted.toSafeJSON(),
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function authHubConfig(_req: Request, res: Response) {
  const loginUrl = getAuthHubLoginUrl();
  const callbackUrl = getAuthHubCallbackUrl();
  res.json({
    code: 200,
    message: '获取成功',
    data: {
      appId: AUTH_HUB_APP_ID,
      loginUrl,
      callbackUrl,
      configured: Boolean(loginUrl),
    },
  });
}

export async function logout(_req: Request, res: Response) {
  res.json({
    code: 200,
    message: '登出成功',
    data: null,
  });
}

export async function impersonate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const actor = req.user!;
    const actorRole = actor.get('role') as InstanceType<typeof Role> | undefined;
    if (req.impersonatorId || actorRole?.name !== 'super_admin') {
      throw new AppError('仅超级管理员可使用模拟登录', 403);
    }
    const targetId = Number((req.body as { userId?: number }).userId);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      throw new AppError('请选择要模拟的用户', 400);
    }
    if (targetId === actor.id) {
      throw new AppError('不能模拟自己', 400);
    }
    const target = await User.findByPk(targetId, { include: [{ model: Role, as: 'role' }] });
    if (!target || !target.isActive) {
      throw new AppError('目标用户不存在或已被停用', 404);
    }
    const tokens = generateTokens(target.id, actor.id);
    logger.info(
      {
        scope: 'auth',
        action: 'impersonate.start',
        impersonatorId: actor.id,
        impersonatorName: actor.username,
        targetId: target.id,
        targetName: target.username,
      },
      'Auth: impersonation started'
    );
    res.json({
      code: 200,
      message: '已进入模拟登录',
      data: {
        ...tokens,
        user: target.toSafeJSON(),
        impersonator: { id: actor.id, displayName: actor.displayName },
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function stopImpersonate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!req.impersonatorId) {
      throw new AppError('当前不是模拟登录状态', 400);
    }
    const actor = await User.findByPk(req.impersonatorId, { include: [{ model: Role, as: 'role' }] });
    if (!actor || !actor.isActive) {
      throw new AppError('原账号不可用，请重新登录', 401);
    }
    const tokens = generateTokens(actor.id);
    logger.info(
      {
        scope: 'auth',
        action: 'impersonate.stop',
        impersonatorId: actor.id,
        impersonatedId: req.user?.id,
      },
      'Auth: impersonation stopped'
    );
    res.json({
      code: 200,
      message: '已退出模拟登录',
      data: { ...tokens, user: actor.toSafeJSON() },
    });
  } catch (err) {
    next(err);
  }
}

export async function me(req: AuthRequest, res: Response) {
  const user = req.user!;
  let impersonator: { id: number; displayName: string } | null = null;
  if (req.impersonatorId) {
    const actor = await User.findByPk(req.impersonatorId);
    if (actor) impersonator = { id: actor.id, displayName: actor.displayName };
  }
  res.json({
    code: 200,
    message: '获取成功',
    data: { user: user.toSafeJSON(), impersonator },
  });
}

export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      throw new AppError('未提供刷新令牌', 400);
    }

    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as { userId: number; impersonatorId?: number };
    const user = await User.findByPk(decoded.userId);

    if (!user || !user.isActive) {
      throw new AppError('用户不存在或已被停用', 401);
    }

    const tokens = generateTokens(user.id, decoded.impersonatorId);

    res.json({
      code: 200,
      message: '刷新成功',
      data: tokens,
    });
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) {
      return next(new AppError('刷新令牌无效或已过期', 401));
    }
    next(err);
  }
}
