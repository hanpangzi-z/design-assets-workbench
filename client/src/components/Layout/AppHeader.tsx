import React from 'react';
import { Search, Bell, Upload } from 'lucide-react';
import useAuthStore from '@/store/authStore';
import PermissionGate from '@/components/common/PermissionGate';

interface Props {
  path?: string[];
  showSearch?: boolean;
  onUpload?: () => void;
  showUpload?: boolean;
}

export default function AppHeader({ path = [], showSearch = true, onUpload, showUpload = false }: Props) {
  const user = useAuthStore((s) => s.user);
  const [query, setQuery] = React.useState('');
  const userSubline = user?.departmentPath || user?.role?.displayName || '';

  return (
    <header style={headerStyle}>
      <div style={crumbStyle}>
        {path.map((part, index) => (
          <React.Fragment key={`${part}-${index}`}>
            {index > 0 && <span style={{ color: 'var(--fg-4)' }}>/</span>}
            <span style={{
              color: index === path.length - 1 ? 'var(--fg-1)' : 'var(--fg-3)',
              fontWeight: index === path.length - 1 ? 700 : 500,
            }}>
              {part}
            </span>
          </React.Fragment>
        ))}
      </div>

      {showSearch ? (
        <div style={searchWrapStyle}>
          <Search size={14} style={{ color: 'var(--fg-3)', flexShrink: 0 }} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索你想要的创意模板、素材与作品..."
            style={searchInputStyle}
          />
          <span style={kbdStyle}>Ctrl K</span>
        </div>
      ) : (
        <div style={{ flex: 1 }} />
      )}

      <button type="button" className="ui-icon-btn" aria-label="通知" style={{ position: 'relative', border: 0 }}>
        <Bell size={18} />
        <span style={noticeDotStyle} />
      </button>

      {showUpload && (
        <PermissionGate permission="upload">
          <button type="button" className="ui-btn ui-btn-primary" onClick={onUpload}>
            <Upload size={14} />
            上传
          </button>
        </PermissionGate>
      )}

      {user && (
        <div style={userInfoStyle}>
          <div style={userNameStyle}>{user.displayName || user.username}</div>
          {userSubline && <div style={userMetaStyle}>{userSubline}</div>}
        </div>
      )}

      <div style={avatarStyle}>
        {user?.displayName?.slice(0, 1) || user?.username?.slice(0, 1) || '?'}
      </div>
    </header>
  );
}

const headerStyle: React.CSSProperties = {
  height: 56,
  padding: '0 22px',
  background: '#fff',
  borderBottom: '1px solid var(--border-2)',
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  flexShrink: 0,
};

const crumbStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  minWidth: 180,
  font: '500 13px var(--font-sans)',
};

const searchWrapStyle: React.CSSProperties = {
  flex: 1,
  maxWidth: 520,
  marginLeft: 'auto',
  height: 34,
  border: '1px solid var(--border-1)',
  borderRadius: 7,
  background: 'var(--n-50)',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '0 8px 0 11px',
};

const searchInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: 0,
  outline: 'none',
  background: 'transparent',
  color: 'var(--fg-1)',
  font: 'var(--type-body)',
};

const kbdStyle: React.CSSProperties = {
  border: '1px solid var(--border-1)',
  borderRadius: 4,
  padding: '1px 5px',
  color: 'var(--fg-4)',
  font: 'var(--type-caption)',
  background: '#fff',
};

const noticeDotStyle: React.CSSProperties = {
  position: 'absolute',
  top: 6,
  right: 6,
  width: 7,
  height: 7,
  background: 'var(--brand-vermilion-500)',
  borderRadius: '50%',
  border: '1.5px solid #fff',
};

const userInfoStyle: React.CSSProperties = {
  minWidth: 0,
  maxWidth: 180,
  textAlign: 'right',
  lineHeight: 1.25,
};

const userNameStyle: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--fg-1)',
  font: '700 13px var(--font-sans)',
};

const userMetaStyle: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--fg-3)',
  font: '500 11px var(--font-sans)',
  marginTop: 1,
};

const avatarStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: '50%',
  background: 'var(--brand-teal-500)',
  color: '#fff',
  display: 'grid',
  placeItems: 'center',
  font: '700 13px var(--font-sans)',
  flexShrink: 0,
};
