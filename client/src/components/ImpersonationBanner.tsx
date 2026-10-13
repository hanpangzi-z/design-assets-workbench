import type { CSSProperties } from 'react';
import useAuthStore from '@/store/authStore';

export default function ImpersonationBanner() {
  const impersonator = useAuthStore((s) => s.impersonator);
  const user = useAuthStore((s) => s.user);
  const stopImpersonate = useAuthStore((s) => s.stopImpersonate);

  if (!impersonator) return null;

  const handleExit = async () => {
    try {
      await stopImpersonate();
    } catch {
      // 忽略退出失败，仍返回管理页
    }
    window.location.replace('/admin/members');
  };

  return (
    <div style={barStyle}>
      <span>
        正在以「{user?.displayName || user?.username || '未知用户'}」的身份浏览（模拟登录）
      </span>
      <button type="button" onClick={handleExit} style={exitStyle}>
        退出模拟，返回 {impersonator.displayName}
      </button>
    </div>
  );
}

const barStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 16,
  height: 36,
  flexShrink: 0,
  background: '#FF8A3D',
  color: '#fff',
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  fontWeight: 600,
};

const exitStyle: CSSProperties = {
  height: 24,
  padding: '0 12px',
  borderRadius: 12,
  border: '1px solid rgba(255, 255, 255, 0.6)',
  background: 'rgba(255, 255, 255, 0.18)',
  color: '#fff',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
};
