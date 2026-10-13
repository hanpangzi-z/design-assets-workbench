import { lazy, Suspense, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import AppSider from './AppSider';
import AppHeader from './AppHeader';
import ImpersonationBanner from '@/components/ImpersonationBanner';
import useFileStore from '@/store/fileStore';
import useAuthStore from '@/store/authStore';

const CreateModal = lazy(() => import('@/components/CreateModal'));
const UploadModal = lazy(() => import('@/components/Upload/UploadModal'));

const PATH_LABELS: Record<string, string[]> = {
  '/': ['本来设计', '首页'],
  '/my': ['本来设计', '我的'],
  '/assets': ['资源库', '来福商城'],
  '/discover': ['本来设计', '发现'],
  '/enterprise': ['本来设计', '企业资源'],
  '/team': ['本来设计', '团队空间'],
  '/settings': ['管理', '设置'],
};

export default function AppLayout() {
  const location = useLocation();
  const [createOpen, setCreateOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const { fetchFiles } = useFileStore();
  const permissions = useAuthStore((s) => s.permissions);

  const isHome = location.pathname === '/' || location.pathname === '/my';
  const showUpload = permissions?.upload === true && (location.pathname === '/assets' || location.pathname === '/enterprise');
  const path = PATH_LABELS[location.pathname] || ['本来设计'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <ImpersonationBanner />
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '238px minmax(0, 1fr)', alignItems: 'stretch', minHeight: 0 }}>
        <AppSider
          onCreateCanvas={() => setCreateOpen(true)}
        />
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
          {!isHome && (
            <AppHeader
              path={path}
              showUpload={showUpload}
              onUpload={() => setUploadOpen(true)}
            />
          )}
          <main style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto', background: isHome ? '#fff' : 'var(--bg-app)' }}>
            <Outlet context={{ openUpload: () => setUploadOpen(true), openCreate: () => setCreateOpen(true) }} />
          </main>
        </div>
      </div>

      {createOpen && (
        <Suspense fallback={null}>
          <CreateModal open={createOpen} onClose={() => setCreateOpen(false)} />
        </Suspense>
      )}
      {uploadOpen && (
        <Suspense fallback={null}>
          <UploadModal
            open={uploadOpen}
            onClose={() => setUploadOpen(false)}
            onSuccess={() => fetchFiles()}
          />
        </Suspense>
      )}
    </div>
  );
}
