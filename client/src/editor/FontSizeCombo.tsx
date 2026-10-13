import { useEffect, useRef, useState, type CSSProperties } from 'react';

export const FONT_SIZE_OPTIONS = [12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 56, 64, 72, 96, 120, 160, 200, 260];

interface FontSizeComboProps {
  value: number;
  onChange: (value: number) => void;
  inputStyle?: CSSProperties;
  min?: number;
  max?: number;
}

export default function FontSizeCombo({
  value,
  onChange,
  inputStyle,
  min = 1,
  max = 999,
}: FontSizeComboProps) {
  const [draft, setDraft] = useState(String(value));
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commitValue = (raw: string) => {
    const next = Number(raw);
    if (!Number.isFinite(next)) return;
    onChange(Math.max(min, Math.min(max, Math.round(next))));
  };

  const pickValue = (size: number) => {
    setDraft(String(size));
    onChange(size);
    setOpen(false);
    inputRef.current?.focus();
  };

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <input
        ref={inputRef}
        inputMode="numeric"
        value={draft}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          const raw = event.target.value;
          setDraft(raw);
          if (raw.trim() !== '') commitValue(raw);
        }}
        onBlur={() => {
          if (draft.trim() === '') setDraft(String(value));
          window.setTimeout(() => setOpen(false), 80);
        }}
        style={{ ...inputStyle, paddingRight: 30 }}
      />
      <button
        type="button"
        onMouseDown={(event) => {
          event.preventDefault();
          setOpen((current) => !current);
          inputRef.current?.focus();
        }}
        style={{
          position: 'absolute',
          right: 4,
          top: 4,
          width: 22,
          height: 'calc(100% - 8px)',
          border: 0,
          borderLeft: '1px solid #e5e7eb',
          background: 'transparent',
          color: '#6b7280',
          cursor: 'pointer',
          font: '700 11px var(--font-sans)',
          lineHeight: 1,
        }}
      >
        ▾
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 'calc(100% + 4px)',
            zIndex: 60,
            maxHeight: 190,
            overflowY: 'auto',
            padding: 4,
            border: '1px solid #e5e7eb',
            borderRadius: 7,
            background: '#fff',
            boxShadow: '0 12px 28px rgba(15, 23, 42, .14)',
          }}
        >
          {FONT_SIZE_OPTIONS.map((size) => (
            <button
              key={size}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                pickValue(size);
              }}
              style={{
                width: '100%',
                height: 28,
                padding: '0 8px',
                border: 0,
                borderRadius: 5,
                background: size === value ? '#eef2ff' : 'transparent',
                color: size === value ? '#1d4ed8' : '#111827',
                textAlign: 'left',
                cursor: 'pointer',
                font: '700 12px var(--font-sans)',
              }}
            >
              {size}px
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
