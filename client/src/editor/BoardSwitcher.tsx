import type { CSSProperties } from 'react';
import { Layers3, Plus, X } from 'lucide-react';
import type { EditorOpenBoard } from '@/store/editorWorkspaceStore';

interface BoardSwitcherProps {
  boards: EditorOpenBoard[];
  activeKey: string | null;
  onSwitch: (board: EditorOpenBoard) => void;
  onClose: (board: EditorOpenBoard) => void;
  onCreate: () => void;
}

export default function BoardSwitcher({
  boards,
  activeKey,
  onSwitch,
  onClose,
  onCreate,
}: BoardSwitcherProps) {
  if (boards.length === 0) return null;

  const activeIndex = Math.max(0, boards.findIndex((board) => board.key === activeKey));

  return (
    <div
      style={wrapStyle}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div style={headerStyle}>
        <span style={headerIconStyle}>
          <Layers3 size={14} />
        </span>
        <span>画板 {activeIndex + 1}/{boards.length}</span>
      </div>
      <div style={stripStyle}>
        {boards.map((board, index) => {
          const active = board.key === activeKey;
          const thumbSrc = board.previewDataUrl || resolveThumbnailSrc(board.thumbnailPath, board.updatedAt);
          return (
            <span key={board.key} style={thumbItemStyle}>
              <button
                type="button"
                onClick={() => onSwitch(board)}
                style={thumbButtonStyle(active)}
                title={board.name}
                aria-label={`切换到${board.name}`}
              >
                {thumbSrc ? (
                  <span style={thumbImageStyle(thumbSrc)} />
                ) : (
                  <span style={thumbFallbackStyle}>
                    {(board.fileType || 'NEW').toUpperCase().slice(0, 4)}
                  </span>
                )}
                <span style={thumbIndexStyle(active)}>{index + 1}</span>
                <span style={thumbNameStyle}>{board.name}</span>
              </button>
              {boards.length > 1 && (
                <button
                  type="button"
                  title="关闭画板"
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose(board);
                  }}
                  style={closeStyle}
                >
                  <X size={12} />
                </button>
              )}
            </span>
          );
        })}
        <button type="button" onClick={onCreate} style={addButtonStyle} title="新建画板" aria-label="新建画板">
          <Plus size={20} />
        </button>
      </div>
    </div>
  );
}

function resolveThumbnailSrc(path?: string | null, version?: string | number | null) {
  if (!path) return null;
  const src = /^(https?:|data:|blob:|\/uploads\/)/i.test(path) ? path : `/uploads/${path}`;
  if (!version || /^(data:|blob:)/i.test(src)) return src;
  return `${src}${src.includes('?') ? '&' : '?'}v=${encodeURIComponent(String(version))}`;
}

const wrapStyle: CSSProperties = {
  position: 'absolute',
  left: 16,
  bottom: 16,
  zIndex: 100,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  pointerEvents: 'auto',
};

const headerStyle: CSSProperties = {
  height: 28,
  width: 'max-content',
  maxWidth: 210,
  padding: '0 9px',
  borderRadius: 7,
  border: '1px solid rgba(220, 224, 230, 0.92)',
  background: 'rgba(255, 255, 255, 0.94)',
  boxShadow: '0 8px 22px rgba(17, 24, 39, 0.08)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  color: '#20242a',
  font: '700 12px var(--font-sans)',
};

const headerIconStyle: CSSProperties = {
  width: 18,
  height: 18,
  display: 'grid',
  placeItems: 'center',
  color: '#4b5563',
};

const stripStyle: CSSProperties = {
  maxWidth: 'min(640px, calc(100vw - 420px))',
  minHeight: 70,
  padding: 8,
  borderRadius: 8,
  border: '1px solid rgba(223, 227, 233, 0.9)',
  background: 'rgba(255, 255, 255, 0.94)',
  boxShadow: '0 16px 42px rgba(17, 24, 39, 0.12)',
  display: 'flex',
  alignItems: 'stretch',
  gap: 8,
  overflowX: 'auto',
};

const thumbItemStyle: CSSProperties = {
  position: 'relative',
  width: 106,
  height: 58,
  flex: '0 0 auto',
};

function thumbButtonStyle(active: boolean): CSSProperties {
  return {
    position: 'relative',
    width: '100%',
    height: '100%',
    padding: 0,
    borderRadius: 7,
    border: active ? '2px solid #2D5AF0' : '1px solid #e5e8ee',
    background: '#f3f5f7',
    boxShadow: active ? '0 0 0 2px rgba(45, 90, 240, 0.16)' : 'none',
    overflow: 'hidden',
    cursor: active ? 'default' : 'pointer',
  };
}

function thumbImageStyle(src: string): CSSProperties {
  return {
    position: 'absolute',
    inset: 0,
    backgroundImage: `url("${escapeCssUrl(src)}")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'center',
    backgroundSize: 'contain',
  };
}

const thumbFallbackStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'grid',
  placeItems: 'center',
  color: '#6b7280',
  font: '800 13px var(--font-sans)',
};

function thumbIndexStyle(active: boolean): CSSProperties {
  return {
    position: 'absolute',
    left: 5,
    bottom: 4,
    minWidth: 16,
    height: 16,
    padding: '0 4px',
    borderRadius: 4,
    background: active ? '#2D5AF0' : 'rgba(17, 24, 39, 0.62)',
    color: '#fff',
    font: '800 10px var(--font-sans)',
    display: 'grid',
    placeItems: 'center',
  };
}

const thumbNameStyle: CSSProperties = {
  position: 'absolute',
  left: 25,
  right: 5,
  bottom: 4,
  height: 16,
  padding: '1px 4px 0',
  borderRadius: 4,
  background: 'rgba(255, 255, 255, 0.86)',
  color: '#111827',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  font: '700 10px var(--font-sans)',
};

const closeStyle: CSSProperties = {
  position: 'absolute',
  top: 4,
  right: 4,
  width: 18,
  height: 18,
  border: 0,
  padding: 0,
  borderRadius: 5,
  display: 'grid',
  placeItems: 'center',
  background: 'rgba(17, 24, 39, 0.58)',
  color: '#fff',
  cursor: 'pointer',
};

const addButtonStyle: CSSProperties = {
  width: 50,
  height: 58,
  flex: '0 0 auto',
  border: '1px solid #e5e8ee',
  borderRadius: 7,
  background: '#f5f6f8',
  color: '#374151',
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
};

function escapeCssUrl(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
