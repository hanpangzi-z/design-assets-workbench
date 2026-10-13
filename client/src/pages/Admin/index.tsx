import { useNavigate, Outlet, useLocation } from 'react-router-dom';
import {
  ArrowLeft,
  ChevronDown,
  Database,
  FolderOpen,
  Library,
  Users2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import ImpersonationBanner from '@/components/ImpersonationBanner';
import useAuthStore from '@/store/authStore';

type NavItem = {
  key: string;
  label: string;
  Icon: LucideIcon;
};

const CONTENT_NAV: NavItem[] = [
  { key: 'resources', label: '企业资源管理', Icon: Database },
  { key: 'libraries', label: '资源库管理', Icon: Library },
];

const MEMBER_NAV: NavItem[] = [
  { key: 'members', label: '成员管理', Icon: Users2 },
];

export default function AdminPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const permissions = useAuthStore((s) => s.permissions);
  const currentKey = getCurrentKey(location.pathname);
  const canManageUsers = permissions?.manage_users === true;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <ImpersonationBanner />
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden', background: '#fff' }}>
      <aside style={siderStyle}>
        <div style={logoWrapStyle}>
          <button type="button" onClick={() => navigate('/')} style={logoStyle} title="返回首页">
            <img src="/benlai-logo.jpg" alt="本来生活" style={logoImageStyle} />
          </button>
        </div>

        <nav style={navStyle}>
          {canManageUsers && (
            <NavGroup title="成员管理" Icon={Users2} open>
              {MEMBER_NAV.map((item) => (
                <SubNavButton
                  key={item.key}
                  item={item}
                  active={currentKey === item.key}
                  onClick={() => navigate(`/admin/${item.key}`)}
                />
              ))}
            </NavGroup>
          )}

          <NavGroup title="内容管理" Icon={FolderOpen} open>
            {CONTENT_NAV.map((item) => (
              <SubNavButton
                key={item.key}
                item={item}
                active={currentKey === item.key}
                onClick={() => navigate(`/admin/${item.key}`)}
              />
            ))}
          </NavGroup>
        </nav>

        <button type="button" onClick={() => navigate('/')} style={exitButtonStyle}>
          <ArrowLeft size={14} />
          退出管理与设置
        </button>
      </aside>

      <main style={contentStyle}>
        <Outlet />
      </main>
      </div>
    </div>
  );
}

function NavGroup({ title, Icon, open, children }: { title: string; Icon: LucideIcon; open?: boolean; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={groupHeaderStyle}>
        <Icon size={17} />
        <span style={{ flex: 1 }}>{title}</span>
        <ChevronDown size={14} style={{ color: 'var(--fg-4)', transform: open ? 'none' : 'rotate(-90deg)' }} />
      </div>
      {open && <div style={{ paddingTop: 5 }}>{children}</div>}
    </div>
  );
}

function SubNavButton({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={subNavStyle(active)}>
      <span>{item.label}</span>
    </button>
  );
}

function getCurrentKey(pathname: string) {
  const parts = pathname.split('/').filter(Boolean);
  const key = parts[1] || 'resources';
  if (key === 'users') return 'members';
  return key;
}

const pageStyle: CSSProperties = {
  display: 'flex',
  width: '100%',
  height: '100vh',
  overflow: 'hidden',
  background: '#fff',
};

const siderStyle: CSSProperties = {
  width: 238,
  flexShrink: 0,
  background: '#fff',
  borderRight: '1px solid #ededed',
  display: 'flex',
  flexDirection: 'column',
};

const logoWrapStyle: CSSProperties = {
  height: 72,
  padding: '18px 20px',
  display: 'flex',
  alignItems: 'center',
};

const logoStyle: CSSProperties = {
  width: 38,
  height: 38,
  border: 0,
  borderRadius: 6,
  background: '#fff',
  display: 'grid',
  placeItems: 'center',
  padding: 0,
  overflow: 'hidden',
  cursor: 'pointer',
};

const logoImageStyle: CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'contain',
  display: 'block',
};

const navStyle: CSSProperties = {
  flex: 1,
  padding: '6px 16px 16px',
  overflowY: 'auto',
};

const groupHeaderStyle: CSSProperties = {
  height: 34,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  color: '#1f2326',
  font: '600 14px var(--font-sans)',
};

function subNavStyle(active: boolean): CSSProperties {
  return {
    width: '100%',
    height: 34,
    border: 0,
    borderRadius: 8,
    background: active ? '#f0f1ee' : 'transparent',
    color: active ? '#111827' : '#747b82',
    display: 'flex',
    alignItems: 'center',
    padding: '0 14px 0 44px',
    cursor: 'pointer',
    textAlign: 'left',
    font: active ? '700 13px var(--font-sans)' : '500 13px var(--font-sans)',
  };
}

const exitButtonStyle: CSSProperties = {
  height: 40,
  margin: '0 16px 18px',
  borderRadius: 7,
  border: '1px solid #e6e6e3',
  background: '#fff',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  font: '600 13px var(--font-sans)',
  color: '#4b5563',
  cursor: 'pointer',
};

const contentStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: '#fff',
};
