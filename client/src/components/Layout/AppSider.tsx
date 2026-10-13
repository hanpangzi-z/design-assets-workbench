import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ChevronDown,
  Database,
  FolderOpen,
  Home,
  Plus,
  UserCog,
  UserRound,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import useAuthStore from '@/store/authStore';
import type { Permissions } from 'shared/types';

interface SiderProps {
  onCreateCanvas?: () => void;
}

type NavItem = {
  key: string;
  label: string;
  icon: LucideIcon;
  permission?: keyof Permissions;
  anyPermission?: Array<keyof Permissions>;
};

const RESOURCE_ADMIN_PERMISSIONS: Array<keyof Permissions> = [
  'upload',
  'edit',
  'delete_files',
  'manage_categories',
  'manage_tags',
];

const MAIN_NAV: NavItem[] = [
  { key: '/', label: '首页', icon: Home },
  { key: '/my', label: '我的', icon: UserRound },
];

const ADMIN_NAV: NavItem[] = [
  { key: '/admin/resources', label: '企业资源管理', icon: Database, anyPermission: RESOURCE_ADMIN_PERMISSIONS },
  { key: '/admin/members', label: '成员管理', icon: UserCog, permission: 'manage_users' },
];

export default function AppSider({ onCreateCanvas }: SiderProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const permissions = useAuthStore((s) => s.permissions);

  const isActive = (key: string) => {
    if (key === '/') return location.pathname === '/';
    return location.pathname.startsWith(key);
  };

  const canShow = (item: NavItem) => {
    if (item.anyPermission) return item.anyPermission.some((key) => permissions?.[key] === true);
    if (!item.permission) return true;
    return permissions?.[item.permission] === true;
  };

  return (
    <aside style={siderStyle}>
      <div style={logoWrapStyle}>
        <button type="button" onClick={() => navigate('/')} style={logoStyle} title="本来设计">
          <img src="/benlai-logo.jpg" alt="本来生活" style={logoImageStyle} />
        </button>
      </div>

      <nav style={navStyle}>
        <div style={groupBlockStyle}>
          {MAIN_NAV.map((item) => (
            <NavButton
              key={item.key}
              item={item}
              active={isActive(item.key)}
              onClick={() => navigate(item.key)}
            />
          ))}

          <div>
            <button type="button" onClick={() => onCreateCanvas?.()} style={createNavStyle}>
              <Plus size={16} />
              <span style={{ flex: 1, textAlign: 'left' }}>创建</span>
            </button>
          </div>
        </div>

        {ADMIN_NAV.some(canShow) && (
          <div style={groupBlockStyle}>
            <div style={groupHeaderStyle}>
              <FolderOpen size={17} />
              <span style={{ flex: 1 }}>内容管理</span>
              <ChevronDown size={14} style={{ color: '#8b949e' }} />
            </div>
            {ADMIN_NAV.filter(canShow).map((item) => (
              <NavButton
                key={item.key}
                item={item}
                active={isActive(item.key)}
                onClick={() => navigate(item.key)}
                indent
              />
            ))}
          </div>
        )}
      </nav>

      <div style={platformReturnWrapStyle}>
        <a href="https://platform.866685.xyz/requests/new" style={platformReturnButtonStyle}>
          <ArrowLeft size={16} />
          <span>返回接单平台</span>
        </a>
      </div>
    </aside>
  );
}

function NavButton({
  item,
  active,
  onClick,
  indent = false,
}: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
  indent?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} style={navButtonStyle(active, indent)}>
      {!indent && <item.icon size={16} />}
      <span style={{ flex: 1, textAlign: 'left' }}>{item.label}</span>
    </button>
  );
}

const siderStyle: React.CSSProperties = {
  width: 238,
  background: '#fff',
  borderRight: '1px solid #ededed',
  display: 'flex',
  flexDirection: 'column',
  minHeight: '100vh',
  flexShrink: 0,
};

const logoWrapStyle: React.CSSProperties = {
  height: 72,
  padding: '18px 20px',
  display: 'flex',
  alignItems: 'center',
};

const logoStyle: React.CSSProperties = {
  width: 38,
  height: 38,
  border: 0,
  borderRadius: 6,
  background: '#fff',
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
  padding: 0,
  overflow: 'hidden',
};

const logoImageStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'contain',
  display: 'block',
};

const navStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '6px 16px 18px',
};

const platformReturnWrapStyle: React.CSSProperties = {
  padding: '12px 16px 18px',
  borderTop: '1px solid #f1f1f1',
  background: '#fff',
};

const platformReturnButtonStyle: React.CSSProperties = {
  width: '100%',
  height: 36,
  borderRadius: 8,
  border: '1px solid #e5e7eb',
  background: '#fff',
  color: '#374151',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  textDecoration: 'none',
  cursor: 'pointer',
  font: '700 13px var(--font-sans)',
};

const groupBlockStyle: React.CSSProperties = {
  marginBottom: 14,
};

const groupHeaderStyle: React.CSSProperties = {
  height: 34,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  color: '#1f2326',
  font: '600 14px var(--font-sans)',
};

function navButtonStyle(active: boolean, indent: boolean): React.CSSProperties {
  return {
    width: '100%',
    height: 34,
    border: 0,
    borderRadius: 8,
    background: active ? '#f0f1ee' : 'transparent',
    color: active ? '#111827' : '#59616a',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: indent ? '0 14px 0 44px' : '0 10px',
    cursor: 'pointer',
    font: active ? '700 13px var(--font-sans)' : '600 13px var(--font-sans)',
    marginBottom: 3,
  };
}

const createNavStyle: React.CSSProperties = {
  width: '100%',
  height: 34,
  border: 0,
  borderRadius: 8,
  background: 'transparent',
  color: '#59616a',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '0 10px',
  cursor: 'pointer',
  font: '600 13px var(--font-sans)',
  marginTop: 3,
  marginBottom: 3,
};
