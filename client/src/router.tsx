import { createBrowserRouter, Navigate, redirect } from 'react-router-dom';
import React, { useEffect, useState } from 'react';
import useAuthStore from '@/store/authStore';
import AppLayout from '@/components/Layout/AppLayout';
import LoginPage from '@/pages/Login';
import EditorPage from '@/pages/Editor';
import AdminPage from '@/pages/Admin';
import type { Permissions } from 'shared/types';
import { isLocalDevNoLogin } from '@/utils/localDevAuth';

const DashboardPage = React.lazy(() => import('@/pages/Dashboard'));
const AssetsPage = React.lazy(() => import('@/pages/Assets'));
const AdminResources = React.lazy(() => import('@/pages/Admin/Resources'));
const ResourceDetail = React.lazy(() => import('@/pages/Admin/ResourceDetail'));
const LibrariesPage = React.lazy(() => import('@/pages/Admin/Libraries'));
const LibraryDetail = React.lazy(() => import('@/pages/Admin/LibraryDetail'));
const MembersPage = React.lazy(() => import('@/pages/Admin/Members'));

function LoadingScreen() {
  return (
    <div style={{ height: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg-app)' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{
          width: 40,
          height: 40,
          borderRadius: 8,
          background: 'var(--brand-teal-500)',
          color: '#fff',
          display: 'grid',
          placeItems: 'center',
          margin: '0 auto 12px',
          fontFamily: 'var(--font-serif)',
          fontWeight: 700,
          fontSize: 22,
        }}>
          本
        </div>
        <div style={{ font: 'var(--type-body)', color: 'var(--fg-3)' }}>加载中...</div>
      </div>
    </div>
  );
}

function lazyElement(element: React.ReactNode) {
  return <React.Suspense fallback={<LoadingScreen />}>{element}</React.Suspense>;
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const fetchMe = useAuthStore((s) => s.fetchMe);
  const user = useAuthStore((s) => s.user);
  const isLoading = useAuthStore((s) => s.isLoading);
  const hydratedFromCache = useAuthStore((s) => s.hydratedFromCache);
  const localAuthError = useAuthStore((s) => s.localAuthError);
  const localNoLogin = isLocalDevNoLogin();
  const [hasHydratedAuth, setHasHydratedAuth] = useState(() => Boolean(user) || (!localNoLogin && !localStorage.getItem('accessToken')));

  useEffect(() => {
    let cancelled = false;
    const token = localStorage.getItem('accessToken');

    if (!token && !localNoLogin) {
      setHasHydratedAuth(true);
      return;
    }

    if (user) {
      setHasHydratedAuth(true);
      if (hydratedFromCache) {
        fetchMe().catch(() => undefined);
      }
      return;
    }

    setHasHydratedAuth(false);
    fetchMe()
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setHasHydratedAuth(true);
      });

    return () => {
      cancelled = true;
    };
  }, [fetchMe, hydratedFromCache, localNoLogin, user?.id]);

  if (!localNoLogin && !isAuthenticated && !localStorage.getItem('accessToken')) return <Navigate to="/login" replace />;
  if (!user && (isLoading || !hasHydratedAuth)) return <LoadingScreen />;
  if (localNoLogin && !user) return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg-app)' }}>
      <div style={{ textAlign: 'center', maxWidth: 460, padding: 24 }}>
        <p role="alert" style={{ color: 'var(--fg-1)' }}>{localAuthError || '本地用户尚未确认，请重试'}</p>
        <button type="button" onClick={() => { void fetchMe({ force: true }).catch(() => undefined); }}>
          重试连接
        </button>
      </div>
    </div>
  );
  if (!user) return <Navigate to="/login" replace />;

  return <>{children}</>;
}

const RESOURCE_ADMIN_PERMISSIONS: Array<keyof Permissions> = [
  'upload',
  'edit',
  'delete_files',
  'manage_categories',
  'manage_tags',
];

const MEMBER_ADMIN_PERMISSIONS: Array<keyof Permissions> = ['manage_users'];

function hasAnyPermission(permissions: Permissions | null, keys: Array<keyof Permissions>) {
  return keys.some((key) => permissions?.[key] === true);
}

function getAdminHomePath(permissions: Permissions | null) {
  if (hasAnyPermission(permissions, RESOURCE_ADMIN_PERMISSIONS)) return '/admin/resources';
  if (hasAnyPermission(permissions, MEMBER_ADMIN_PERMISSIONS)) return '/admin/members';
  return '/';
}

function canAccessAdmin(permissions: Permissions | null) {
  return hasAnyPermission(permissions, [
    ...RESOURCE_ADMIN_PERMISSIONS,
    ...MEMBER_ADMIN_PERMISSIONS,
  ]);
}

function AdminAccessGuard({ children }: { children: React.ReactNode }) {
  const permissions = useAuthStore((s) => s.permissions);
  if (!canAccessAdmin(permissions)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function AdminIndexRedirect() {
  const permissions = useAuthStore((s) => s.permissions);
  return <Navigate to={getAdminHomePath(permissions)} replace />;
}

function AdminPermissionGuard({
  permission,
  anyPermission,
  children,
}: {
  permission?: keyof Permissions;
  anyPermission?: Array<keyof Permissions>;
  children: React.ReactNode;
}) {
  const permissions = useAuthStore((s) => s.permissions);
  const allowed = anyPermission
    ? hasAnyPermission(permissions, anyPermission)
    : Boolean(permission && permissions?.[permission] === true);

  if (!allowed) return <Navigate to={getAdminHomePath(permissions)} replace />;
  return <>{children}</>;
}

function PlaceholderPage({ title }: { title: string }) {
  return (
    <div style={{ padding: 48, textAlign: 'center' }}>
      <h2 style={{ font: 'var(--type-h2)', color: 'var(--fg-1)', marginBottom: 8 }}>{title}</h2>
      <p style={{ font: 'var(--type-body)', color: 'var(--fg-3)' }}>此页面正在建设中</p>
    </div>
  );
}

function normalizeAuthHubCallbackPath() {
  if (typeof window === 'undefined') return;
  const { pathname, search, hash } = window.location;
  if (pathname === '/login/callback') return;
  if (pathname.replace(/^\/+/, '/') !== '/login/callback') return;
  window.history.replaceState(window.history.state, '', `/login/callback${search}${hash}`);
}

normalizeAuthHubCallbackPath();

const router = createBrowserRouter([
  { path: '/login', element: isLocalDevNoLogin() ? <AuthGuard><Navigate to="/" replace /></AuthGuard> : <LoginPage /> },
  { path: '/login/callback', element: isLocalDevNoLogin() ? <AuthGuard><Navigate to="/" replace /></AuthGuard> : <LoginPage /> },
  {
    path: '/editor/:fileId',
    element: <AuthGuard>{lazyElement(<EditorPage />)}</AuthGuard>,
  },
  {
    path: '/admin',
    element: <AuthGuard><AdminAccessGuard>{lazyElement(<AdminPage />)}</AdminAccessGuard></AuthGuard>,
    children: [
      { index: true, element: <AdminIndexRedirect /> },
      { path: 'overview', loader: () => redirect('/admin/resources') },
      { path: 'overview/*', loader: () => redirect('/admin/resources') },
      { path: 'resources', element: <AdminPermissionGuard anyPermission={RESOURCE_ADMIN_PERMISSIONS}>{lazyElement(<AdminResources />)}</AdminPermissionGuard> },
      { path: 'resources/:id', element: <AdminPermissionGuard anyPermission={RESOURCE_ADMIN_PERMISSIONS}>{lazyElement(<ResourceDetail />)}</AdminPermissionGuard> },
      { path: 'libraries', element: <AdminPermissionGuard permission="manage_categories">{lazyElement(<LibrariesPage />)}</AdminPermissionGuard> },
      { path: 'libraries/:id', element: <AdminPermissionGuard permission="manage_categories">{lazyElement(<LibraryDetail />)}</AdminPermissionGuard> },
      { path: 'design-specs', loader: () => redirect('/admin/libraries') },
      { path: 'members', element: <AdminPermissionGuard permission="manage_users">{lazyElement(<MembersPage />)}</AdminPermissionGuard> },
      { path: 'departments', loader: () => redirect('/admin/members') },
      { path: 'visitors', loader: () => redirect('/admin/members') },
      { path: 'history-members', loader: () => redirect('/admin/members') },
      { path: 'users', element: <AdminPermissionGuard permission="manage_users">{lazyElement(<MembersPage />)}</AdminPermissionGuard> },
      { path: '*', loader: () => redirect('/admin/resources') },
    ],
  },
  {
    path: '/',
    element: <AuthGuard><AppLayout /></AuthGuard>,
    children: [
      { index: true, element: lazyElement(<DashboardPage />) },
      { path: 'my', element: lazyElement(<DashboardPage />) },
      { path: 'assets', element: lazyElement(<AssetsPage />) },
      { path: 'discover', element: <PlaceholderPage title="发现" /> },
      { path: 'enterprise', element: <PlaceholderPage title="企业资源" /> },
      { path: 'team', element: <PlaceholderPage title="团队空间" /> },
      { path: 'settings', element: <PlaceholderPage title="设置" /> },
    ],
  },
]);

export default router;
