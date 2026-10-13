import React from 'react';
import Thumb from './Thumb';
import { Trash2, UserRound } from 'lucide-react';
import type { DesignFile } from 'shared/types';

interface Props {
  file: DesignFile;
  selected?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  canDelete?: boolean;
  onDelete?: () => void;
  primaryActionLabel?: string;
  onPrimaryAction?: () => void;
}

export default function FileCard({
  file,
  selected,
  onClick,
  onDoubleClick,
  canDelete = false,
  onDelete,
  primaryActionLabel,
  onPrimaryAction,
}: Props) {
  const uploaderName = file.uploader?.displayName || '未知设计师';
  const categoryName = file.category?.name;
  const tags = file.tags || [];

  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      style={{
        borderRadius: 8,
        background: '#fff',
        border: `1px solid ${selected ? 'var(--brand-teal-500)' : 'var(--border-2)'}`,
        overflow: 'hidden',
        cursor: 'pointer',
        transition: 'all .12s',
        boxShadow: selected ? '0 0 0 3px rgba(26,107,107,0.14)' : '0 1px 2px rgba(20,20,19,0.04)',
        position: 'relative',
      }}
    >
      {canDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete?.();
          }}
          title="删除"
          style={{
            position: 'absolute', top: 8, right: 8, zIndex: 2,
            width: 28, height: 28, display: 'grid', placeItems: 'center',
            borderRadius: 6, border: '1px solid var(--border-1)',
            background: 'rgba(255,255,255,.92)', color: 'var(--color-danger-fg)',
            cursor: 'pointer', boxShadow: 'var(--shadow-xs)',
          }}
        >
          <Trash2 size={14} />
        </button>
      )}
      <Thumb
        thumbnailUrl={file.thumbnailPath}
        fileType={file.fileType}
        label={file.name?.charAt(0)}
        height={240}
        file={file}
        name={file.name}
      />
      <div style={{ padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            flex: 1, minWidth: 0,
            font: '600 13px var(--font-sans)', color: 'var(--fg-1)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {file.name}
          </div>
          <span style={{
            flexShrink: 0, padding: '1px 5px', borderRadius: 4,
            background: 'var(--n-100)', color: 'var(--fg-3)',
            font: '600 10px var(--font-sans)', textTransform: 'uppercase',
          }}>
            {file.fileType}
          </span>
        </div>
        {primaryActionLabel && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPrimaryAction?.();
            }}
            style={{
              width: '100%', height: 30, marginTop: 8, borderRadius: 6,
              border: '1px solid var(--border-1)', background: '#fff',
              color: 'var(--fg-1)', font: '500 12px var(--font-sans)',
              cursor: 'pointer',
            }}
          >
            {primaryActionLabel}
          </button>
        )}
        {(categoryName || tags.length > 0) && (
          <div style={{
            display: 'flex', gap: 5, flexWrap: 'wrap',
            minHeight: 20, marginTop: 8, overflow: 'hidden',
          }}>
            {categoryName && <MetaChip>{categoryName}</MetaChip>}
            {tags.slice(0, 2).map((tag) => (
              <MetaChip key={tag.id}>{tag.name}</MetaChip>
            ))}
            {tags.length > 2 && <MetaChip>+{tags.length - 2}</MetaChip>}
          </div>
        )}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 8, marginTop: 8,
        }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            minWidth: 0, font: 'var(--type-caption)', color: 'var(--fg-3)',
          }}>
            <UserRound size={12} style={{ flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {uploaderName}
            </span>
          </span>
          <span style={{ flexShrink: 0, font: 'var(--type-caption)', color: 'var(--fg-4)' }}>
            {formatFileSize(file.fileSize)}
          </span>
        </div>
      </div>
    </div>
  );
}

function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      maxWidth: '100%',
      padding: '2px 6px',
      borderRadius: 4,
      background: 'var(--brand-teal-50)',
      color: 'var(--brand-teal-600)',
      font: '500 11px var(--font-sans)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
