import { Settings } from 'lucide-react';

export default function AdminPlaceholder({ title }: { title: string }) {
  return (
    <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--fg-3)' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{
          width: 56, height: 56, borderRadius: 10, background: 'var(--brand-teal-50)',
          display: 'grid', placeItems: 'center', margin: '0 auto 14px', color: 'var(--brand-teal-500)',
        }}>
          <Settings size={22} />
        </div>
        <div style={{ font: '600 16px var(--font-sans)', color: 'var(--fg-1)', marginBottom: 4 }}>{title}</div>
        <div style={{ font: 'var(--type-body)' }}>功能开发中</div>
      </div>
    </div>
  );
}
