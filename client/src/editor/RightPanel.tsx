import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  ImagePlus, Upload, ChevronDown, Bold, Italic, Underline, Strikethrough,
  AlignLeft, AlignCenter, AlignRight, AlignJustify, Link2, Eye, EyeOff, Plus, Minus,
  Crop, Check, X, Copy, Trash2,
} from 'lucide-react';
import { message } from 'antd';
import * as fabric from 'fabric';
import { copyPsdSourceMetadata, getPsdEditableSourceTextOptions, markPsdNativeEffectOverride } from './psdImportState';
import useEditorStore from '@/store/editorStore';
import type { EditorObject, EditorObjectPatch } from '@/editor/engine/types';
import api from '@/api/index';
import FontSizeCombo from './FontSizeCombo';
import { DEFAULT_CN_EDIT_FONT_FAMILY } from './fontDefaults';
import { beginImageCrop, cancelImageCrop, confirmImageCrop, isImageCropping } from './cropImage';
import {
  extractPsdRunFillColor,
  getDominantPsdRunFillColor,
  sampleFabricImageDominantOpaqueColor,
} from './utils/psdTextColor';

const ImageFiltersPanel = React.lazy(() => import('./ImageFiltersPanel'));

type FontOption = {
  id: string;
  name: string;
  family: string;
  aliases?: string[];
};

function normalizePanelFontWeight(value: unknown): 'normal' | 'bold' {
  const raw = String(value || '').toLowerCase();
  const numeric = Number(raw);
  return raw === 'bold' || (Number.isFinite(numeric) && numeric >= 600) ? 'bold' : 'normal';
}

// ---- 通用小组件 ----

function Section({ label, children, border = true }: { label?: string; children: React.ReactNode; border?: boolean }) {
  return (
    <div style={{ padding: '10px 0', borderBottom: border ? '1px solid var(--border-2)' : 'none' }}>
      {label && <div style={{ font: '500 11px var(--font-sans)', color: 'var(--fg-4)', marginBottom: 8, letterSpacing: '.02em' }}>{label}</div>}
      {children}
    </div>
  );
}

function Row({ children, gap = 8 }: { children: React.ReactNode; gap?: number }) {
  return <div style={{ display: 'flex', gap, alignItems: 'center' }}>{children}</div>;
}

function NumInput({ label, value, onChange, unit, width }: {
  label?: string; value: number; onChange: (n: number) => void; unit?: string; width?: number;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: width ? undefined : 1, width }}>
      {label && <span style={{ font: '500 11px var(--font-sans)', color: 'var(--fg-4)', minWidth: 14 }}>{label}</span>}
      <div style={{ flex: 1, position: 'relative' }}>
        <input
          value={draft}
          onChange={(e) => {
            const raw = e.target.value;
            setDraft(raw);
            if (raw.trim() === '') return;
            const n = parseFloat(raw);
            if (!isNaN(n)) onChange(n);
          }}
          onBlur={() => {
            if (draft.trim() === '') setDraft(String(value));
          }}
          style={{ width: '100%', height: 28, padding: '0 6px', paddingRight: unit ? 22 : 6, border: '1px solid var(--border-2)', borderRadius: 5, font: '12px var(--font-sans)', color: 'var(--fg-1)', outline: 'none', background: 'var(--n-50)' }} />
        {unit && <span style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', font: '10px var(--font-sans)', color: 'var(--fg-4)' }}>{unit}</span>}
      </div>
    </div>
  );
}

const LINE_HEIGHT_PRESETS = [10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96, 120, 160];
const CHAR_SPACING_PRESETS = [-4, -2, -1, 0, 1, 2, 4, 8, 12, 16, 24];

function MetricCombo({
  label,
  value,
  onChange,
  presets,
  min,
  max,
  precision = 0,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  presets: number[];
  min: number;
  max: number;
  precision?: number;
}) {
  const [draft, setDraft] = useState(formatMetricValue(value, precision));
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(formatMetricValue(value, precision));
  }, [value, precision]);

  const commitValue = (raw: string) => {
    if (raw.trim() === '' || raw === '-' || raw === '.' || raw === '-.') return;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    const next = clampMetricValue(parsed, min, max, precision);
    onChange(next);
  };

  const pickValue = (next: number) => {
    const formatted = formatMetricValue(next, precision);
    setDraft(formatted);
    onChange(next);
    setOpen(false);
    inputRef.current?.focus();
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
      <span style={{ font: '500 11px var(--font-sans)', color: 'var(--fg-4)', minWidth: 26 }}>{label}</span>
      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        <input
          ref={inputRef}
          inputMode="decimal"
          value={draft}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            const raw = event.target.value;
            if (!/^-?\d*\.?\d*$/.test(raw)) return;
            setDraft(raw);
            commitValue(raw);
          }}
          onBlur={() => {
            if (draft.trim() === '' || draft === '-' || draft === '.' || draft === '-.') {
              setDraft(formatMetricValue(value, precision));
            }
            window.setTimeout(() => setOpen(false), 80);
          }}
          style={{
            width: '100%',
            height: 28,
            padding: '0 28px 0 6px',
            border: '1px solid var(--border-2)',
            borderRadius: 5,
            font: '12px var(--font-sans)',
            color: 'var(--fg-1)',
            outline: 'none',
            background: 'var(--n-50)',
          }}
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
            width: 20,
            height: 'calc(100% - 8px)',
            border: 0,
            borderLeft: '1px solid #e5e7eb',
            background: 'transparent',
            color: '#6b7280',
            cursor: 'pointer',
            font: '700 10px var(--font-sans)',
            lineHeight: 1,
          }}
        >
          ▾
        </button>
        {open && (
          <div style={metricMenuStyle}>
            {presets.map((item) => (
              <button
                key={item}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  pickValue(item);
                }}
                style={metricMenuItemStyle(Math.abs(item - value) < (precision > 0 ? 0.05 : 0.5))}
              >
                {formatMetricValue(item, precision)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function clampMetricValue(value: number, min: number, max: number, precision: number) {
  const clamped = Math.max(min, Math.min(max, value));
  const factor = 10 ** precision;
  return Math.round(clamped * factor) / factor;
}

function formatMetricValue(value: number, precision: number) {
  const safeValue = Number.isFinite(value) ? value : 0;
  return precision > 0
    ? String(clampMetricValue(safeValue, -Infinity, Infinity, precision))
    : String(Math.round(safeValue));
}

function fabricCharSpacingToPx(charSpacing: number, fontSize: number) {
  const safeFontSize = Math.max(1, Number(fontSize) || 1);
  return clampMetricValue((Number(charSpacing) || 0) * safeFontSize / 1000, -999, 999, 1);
}

function charSpacingPxToFabric(px: number, fontSize: number) {
  const safeFontSize = Math.max(1, Number(fontSize) || 1);
  return Math.round((Number(px) || 0) * 1000 / safeFontSize);
}

function fabricLineHeightToPx(lineHeight: number, fontSize: number) {
  const safeFontSize = Math.max(1, Number(fontSize) || 1);
  return clampMetricValue((Number(lineHeight) || 1.2) * safeFontSize, 1, 999, 0);
}

function lineHeightPxToFabric(px: number, fontSize: number) {
  const safeFontSize = Math.max(1, Number(fontSize) || 1);
  return clampMetricValue((Number(px) || safeFontSize * 1.2) / safeFontSize, 0.1, 10, 3);
}

function IconBtn({ active, onClick, children, title }: { active?: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <span onClick={onClick} title={title} style={{
      width: 30, height: 28, display: 'inline-grid', placeItems: 'center', borderRadius: 4, cursor: 'pointer',
      background: active ? 'var(--brand-teal-50)' : 'transparent', color: active ? 'var(--brand-teal-600)' : 'var(--fg-3)',
      border: active ? '1px solid var(--brand-teal-200)' : '1px solid transparent',
    }}>{children}</span>
  );
}

function ColorInput({ value, onChange, label }: { value: string; onChange: (c: string) => void; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
      <input type="color" value={value.startsWith('#') ? value : '#000000'} onChange={(e) => onChange(e.target.value)}
        style={{ width: 24, height: 24, border: '1px solid var(--border-2)', borderRadius: 4, padding: 0, cursor: 'pointer', background: 'transparent' }} />
      <span style={{ font: '12px var(--font-sans)', color: 'var(--fg-2)' }}>{label}</span>
    </div>
  );
}

function NativeRightPanel({
  object,
  onUpdate,
  onDuplicate,
  onDelete,
}: {
  object: EditorObject | null;
  onUpdate: (patch: EditorObjectPatch) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const props = getNativePanelProps(object);
  const isText = object?.type === 'text';
  const canFill = object?.type === 'text' || object?.type === 'rect' || object?.type === 'ellipse' || object?.type === 'triangle';
  const canStroke = object?.type !== 'image' && object?.type !== 'group';

  return (
    <div style={{ width: 300, background: '#fff', borderLeft: '1px solid var(--border-1)', overflowY: 'auto', overflowX: 'hidden', flexShrink: 0 }}>
      {!object ? (
        <div style={{ padding: '48px 20px', textAlign: 'center', font: '13px var(--font-sans)', color: 'var(--fg-4)', lineHeight: 1.6 }}>
          选择画布上的元素<br />查看和编辑属性
        </div>
      ) : (
        <div style={{ padding: '4px 14px' }}>
          <Section>
            <Row>
              <span style={{ padding: '2px 8px', borderRadius: 4, font: '500 11px var(--font-sans)', background: 'var(--brand-teal-50)', color: 'var(--brand-teal-600)' }}>
                {getNativeObjectTypeLabel(object)}
              </span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: '500 13px var(--font-sans)', color: 'var(--fg-1)' }}>
                {object.name || object.id}
              </span>
            </Row>
          </Section>

          {isText && (
            <Section label="文字">
              <input
                value={(object as Extract<EditorObject, { type: 'text' }>).text}
                onChange={(event) => onUpdate({ text: event.target.value })}
                style={{ width: '100%', height: 32, padding: '0 8px', border: '1px solid var(--border-2)', borderRadius: 5, font: '12px var(--font-sans)', color: 'var(--fg-1)', outline: 'none', background: 'var(--n-50)' }}
              />
              <div style={{ height: 8 }} />
              <Row>
                <NumInput value={Math.round((object as Extract<EditorObject, { type: 'text' }>).fontSize || 28)} onChange={(n) => onUpdate({ fontSize: Math.max(1, Math.round(n)) })} label="" unit="字号" />
              </Row>
            </Section>
          )}

          {canFill && (
            <Section label={isText ? '文字色' : '填充'}>
              <ColorInput value={props.fill} onChange={(fill) => onUpdate({ fill })} label={isText ? '文字色' : '填充色'} />
            </Section>
          )}

          {canStroke && (
            <Section label="描边">
              <Row>
                <NumInput label="" value={props.strokeWidth} onChange={(strokeWidth) => onUpdate({ strokeWidth: Math.max(0, Math.round(strokeWidth)) })} width={60} />
                <input
                  type="color"
                  value={props.stroke}
                  onChange={(event) => onUpdate({ stroke: event.target.value, strokeWidth: props.strokeWidth || 1 })}
                  style={{ width: 24, height: 24, border: '1px solid var(--border-2)', borderRadius: 4, padding: 0, cursor: 'pointer' }}
                />
                <span style={{ flex: 1, font: '12px var(--font-sans)', color: 'var(--fg-2)' }}>{props.strokeWidth > 0 ? props.stroke : '无'}</span>
              </Row>
            </Section>
          )}

          <Section label="不透明度">
            <Row>
              <input
                type="range"
                min={0}
                max={100}
                value={props.opacity}
                onChange={(event) => onUpdate({ opacity: Number(event.target.value) / 100 })}
                style={{ flex: 1, accentColor: 'var(--brand-teal-500)' }}
              />
              <span style={{ font: '12px var(--font-sans)', color: 'var(--fg-1)', width: 32, textAlign: 'right' }}>{props.opacity}</span>
            </Row>
          </Section>

          <Section label="尺寸">
            <Row>
              <Link2 size={12} style={{ color: 'var(--fg-4)' }} />
              <NumInput value={props.width} onChange={(width) => onUpdate({ width: Math.max(1, Math.round(width)) })} label="" unit="宽" />
              <NumInput value={props.height} onChange={(height) => onUpdate({ height: Math.max(1, Math.round(height)) })} label="" unit="高" />
            </Row>
          </Section>

          <Section label="位置">
            <Row>
              <NumInput value={props.left} onChange={(left) => onUpdate({ left: Math.round(left) })} label="" unit="X" />
              <NumInput value={props.top} onChange={(top) => onUpdate({ top: Math.round(top) })} label="" unit="Y" />
            </Row>
            <div style={{ height: 8 }} />
            <Row>
              <NumInput label="" value={props.rotation} onChange={(rotation) => onUpdate({ rotation: Math.round(rotation) })} unit="°" />
            </Row>
          </Section>

          <Section border={false}>
            <Row>
              <button type="button" onClick={onDuplicate} style={nativeActionButtonStyle} title="复制">
                <Copy size={14} /> 复制
              </button>
              <button type="button" onClick={onDelete} style={{ ...nativeActionButtonStyle, color: '#b42318' }} title="删除">
                <Trash2 size={14} /> 删除
              </button>
            </Row>
          </Section>
        </div>
      )}
    </div>
  );
}

function getNativePanelProps(object: EditorObject | null) {
  return {
    left: Math.round(object?.left || 0),
    top: Math.round(object?.top || 0),
    width: Math.round((object?.width || 0) * (object?.scaleX || 1)),
    height: Math.round((object?.height || 0) * (object?.scaleY || 1)),
    rotation: Math.round(object?.rotation || 0),
    opacity: Math.round((object?.opacity ?? 1) * 100),
    fill: toHex((object as { fill?: string } | null)?.fill || '#000000'),
    stroke: toHex((object as { stroke?: string } | null)?.stroke || '#000000'),
    strokeWidth: Math.round((object as { strokeWidth?: number } | null)?.strokeWidth || 0),
  };
}

function getNativeObjectTypeLabel(object: EditorObject) {
  if (object.type === 'text') return '文字';
  if (object.type === 'image') return '图片';
  if (object.type === 'rect') return '矩形';
  if (object.type === 'ellipse') return '椭圆';
  if (object.type === 'triangle') return '三角形';
  if (object.type === 'line') return '线条';
  return '组合';
}

function getFabricPanelObjectTypeLabel(
  object: fabric.FabricObject | null,
  flags: { isText: boolean; isImage: boolean },
) {
  if (!object) return '';
  if (flags.isText) return '文字';
  if (flags.isImage) return '图片';
  const role = String((object as fabric.FabricObject & { _svgObjectRole?: unknown })._svgObjectRole || '');
  if (role === 'decoration-vector' || role === 'svg-decoration-group') return '组合';
  const type = String(object.type || '').toLowerCase();
  if (type.includes('group')) return '组合';
  if (type.includes('path') || type.includes('rect') || type.includes('circle') || type.includes('polygon') || type.includes('line')) {
    return '形状';
  }
  return '元素';
}

const nativeActionButtonStyle: React.CSSProperties = {
  flex: 1,
  height: 34,
  borderRadius: 8,
  border: '1px solid var(--border-2)',
  background: '#fff',
  color: 'var(--fg-2)',
  cursor: 'pointer',
  font: '700 13px var(--font-sans)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
};

// ---- 主面板 ----

// 任意颜色值转 #hex
function toHex(color: unknown): string {
  if (!color || typeof color !== 'string') return '#000000';
  if (color.startsWith('#')) return color.length === 4
    ? '#' + color[1]+color[1] + color[2]+color[2] + color[3]+color[3]
    : color;
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) return '#' + [m[1],m[2],m[3]].map(v => parseInt(v).toString(16).padStart(2,'0')).join('');
  // fabric 可能返回颜色名
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d')!; ctx.fillStyle = color; ctx.fillRect(0,0,1,1);
  const [r,g,b] = ctx.getImageData(0,0,1,1).data;
  return '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
}

function mergeFonts(current: FontOption[], incoming: FontOption[]) {
  const byId = new Map(current.map((font) => [font.id, font]));
  incoming.forEach((font) => byId.set(font.id, font));
  return Array.from(byId.values());
}

const MISSING_PSD_TEXT_EDIT_FONT_FAMILY = DEFAULT_CN_EDIT_FONT_FAMILY;
const TEXT_LAYOUT_PROP_KEYS = new Set(['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'charSpacing', 'lineHeight']);

function reloadCustomFontsStylesheet(): Promise<void> {
  return new Promise((resolve) => {
    let link = document.getElementById('custom-fonts-css') as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement('link');
      link.id = 'custom-fonts-css';
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    const finish = () => resolve();
    link.onload = finish;
    link.onerror = finish;
    link.href = `/api/v1/fonts/css?t=${Date.now()}`;
    window.setTimeout(finish, 1200);
  });
}

async function waitForUploadedFonts(fonts: FontOption[]) {
  if (!document.fonts) return;
  const families = fonts.flatMap(getFontAliases).slice(0, 12);
  await Promise.allSettled(families.map((family) => document.fonts.load(`16px "${family.replace(/"/g, '\\"')}"`)));
  await document.fonts.ready;
}

async function applyUploadedFontToActiveText(canvas: fabric.Canvas | null | undefined, fonts: FontOption[]) {
  if (!canvas) return false;
  const active = canvas.getActiveObject() as (fabric.FabricObject & { _psdFontName?: string; fontFamily?: unknown }) | null;
  if (!active || !isTextLayerObject(active)) return false;
  const sourceName = active._psdFontName || String(active.fontFamily || '');
  const matched = fonts.find((font) => getFontAliases(font).some((alias) => fontNameMatches(alias, sourceName)));
  if (!matched) return false;
  const family = pickBestFontAlias(matched, sourceName);
  const fontFamily = quoteFontFamilyList([family, 'Source Han Sans CN', 'Noto Sans SC', 'sans-serif']);
  if (isPsdTextPreviewObject(active)) {
    await convertPsdTextPreviewToEditableText(canvas, active, fontFamily);
  } else {
    const anchorBounds = getStoredPixelBounds(active) || await measureObjectPixelBounds(canvas, active);
    active.set('fontFamily', fontFamily);
    applyFontFamilyToTextStyles(active, fontFamily);
    await waitForTextObjectFont(active);
    resetTextObjectDimensions(active);
    if (anchorBounds) {
      await alignObjectToTargetPixelBounds(canvas, active, anchorBounds);
    }
  }
  // 触发右侧面板的 textProps 重新从 active 拉取（fabric 的 obj.set 程序化改属性
  // 不会自动 fire object:modified，所以右栏的字体名一直停在旧值）。
  const refreshed = canvas.getActiveObject();
  if (refreshed) {
    canvas.fire('object:modified', { target: refreshed });
  }
  canvas.requestRenderAll();
  return true;
}

function isTextLayerObject(object: fabric.FabricObject) {
  return object instanceof fabric.IText
    || object instanceof fabric.Textbox
    || isPsdTextPreviewObject(object)
    || object.type === 'i-text'
    || object.type === 'textbox'
    || object.type === 'text';
}

function getFontAliases(font: FontOption) {
  return [font.family, font.name, ...(font.aliases || [])].filter(Boolean);
}

function pickBestFontAlias(font: FontOption, sourceName: string) {
  return getFontAliases(font).find((alias) => fontNameMatches(alias, sourceName)) || font.family || font.name;
}

function fontNameMatches(left: string, right: string) {
  const a = normalizeFontName(left);
  const b = normalizeFontName(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function normalizeFontName(value: string) {
  return value.toLowerCase().replace(/[\s"'_-]/g, '');
}

/**
 * 从 fabric 对象的 fontFamily（CSS 链，比如 `"FZLTZHK--GBK1-0", "FZLanTingHei-DB-GBK", ..., sans-serif`）
 * 反向计算右侧 select 应该高亮哪个 option。
 *
 * 优先级：
 *   1) 用 active._psdFontName（PSD 解析时存进来的真实字体名）跟字体库做规范化匹配
 *   2) 用 fontFamily 链里的第一个 family 跟字体库匹配
 *   3) 兜底匹配几个预设（思源黑/宋、Arial、DIN Pro）
 *   4) 都不命中 → 'sans-serif'（"默认"）
 *
 * 命中时返回的字符串必须跟 select 里 `<option value=...>` 的字面量**完全一致**，
 * 否则浏览器还是会 fallback 到第一个 option。
 */
function resolveSelectValueForFont(
  cssFontFamily: string,
  psdFontName: string | undefined,
  uploadedFonts: FontOption[],
): string {
  const candidates = [cssFontFamily || '', psdFontName || '']
    .flatMap((s) => parseFontFamilyList(s))
    .filter(Boolean);
  const lower = (cssFontFamily || '').toLowerCase();
  if (lower.includes('alibaba puhuiti') || lower.includes('alibabapuhuiti')) {
    return DEFAULT_CN_EDIT_FONT_FAMILY;
  }
  if (lower.includes('microsoft yahei') || lower.includes('微软雅黑')) {
    return DEFAULT_CN_EDIT_FONT_FAMILY;
  }

  // 1+2) 跟字体库逐个匹配
  for (const cand of candidates) {
    const matched = uploadedFonts.find((f) =>
      getFontAliases(f).some((alias) => fontNameMatches(alias, cand)),
    );
    if (matched) {
      // select 里 option 的 value 是 `"${f.family}",sans-serif`，必须严格一致
      return `"${matched.family}",sans-serif`;
    }
  }

  // 3) 预设字体兜底
  if (lower.includes('source han sans') || lower.includes('notosanssc') || lower.includes('noto sans sc')) {
    return '"Microsoft YaHei","Source Han Sans CN","Noto Sans SC",sans-serif';
  }
  if (lower.includes('source han serif') || lower.includes('noto serif')) {
    return '"Source Han Serif CN","Noto Serif SC",serif';
  }
  if (lower.includes('din pro')) return '"DIN Pro","Arial Black",sans-serif';
  if (lower.includes('arial')) return 'Arial,sans-serif';

  // 4) 兜底
  return 'sans-serif';
}

/** 把 `"FamilyA", "FamilyB", sans-serif` 这种 CSS family 链拆成单个 family 名（去引号、去空白） */
function parseFontFamilyList(cssValue: string): string[] {
  if (!cssValue) return [];
  return cssValue
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter((s) => s && !/^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(s));
}

function quoteFontFamilyList(families: string[]) {
  return families
    .filter(Boolean)
    .map((family) => /^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(family)
      ? family
      : `"${family.replace(/"/g, '\\"')}"`)
    .join(', ');
}

function applyFontFamilyToTextStyles(obj: fabric.FabricObject, fontFamily: string) {
  const text = obj as fabric.IText & {
    styles?: Record<string, Record<string, Record<string, unknown>>>;
    _psdFontName?: string;
    _psdMissingFont?: boolean;
  };
  text._psdFontName = parseFontFamilyList(fontFamily)[0] || fontFamily;
  text._psdMissingFont = false;
  text.set?.('editable', true);
  if (!text.styles) return;
  Object.values(text.styles).forEach((lineStyles) => {
    Object.values(lineStyles || {}).forEach((charStyle) => {
      charStyle.fontFamily = fontFamily;
    });
  });
}

function isPsdTextPreviewObject(obj: fabric.FabricObject | null): obj is fabric.FabricImage & {
  _psdTextPreview: true;
  _psdTextContent?: string;
  _psdTextIsAreaText?: boolean;
  _psdTextOrientation?: string;
  _psdTextOptions?: Record<string, unknown>;
  _psdLayerBounds?: PsdLayerBounds;
  _psdPreviewVisualBounds?: PixelBounds;
  _psdFontName?: string;
  _psdMissingFont?: boolean;
  _psdInvisibleHitArea?: boolean;
  _psdImportedTextPreview?: boolean;
  _psdIgnorePreviewColor?: boolean;
} {
  return Boolean(obj && (obj as { _psdTextPreview?: unknown })._psdTextPreview === true);
}

function getPsdPreviewEditableFontFamily(requested?: unknown, fallback?: unknown) {
  if (typeof requested === 'string' && requested.trim()) return requested;
  if (typeof fallback === 'string' && fallback.trim()) return fallback;
  return MISSING_PSD_TEXT_EDIT_FONT_FAMILY;
}

function isPsdVerticalTextOptions(options: Record<string, unknown>, fallback?: unknown): boolean {
  const raw = options.textOrientation ?? options.orientation ?? options.Ornt ?? fallback ?? '';
  const orientation = String(raw || '').toLowerCase();
  return orientation.includes('vertical') || orientation.includes('vrtc');
}

function formatPsdVerticalTextContent(content: string): string {
  const compact = String(content || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+/g, '')
    .trim();
  return Array.from(compact).join('\n');
}

function getPsdVerticalLineHeight(
  content: string,
  fontSize: number,
  targetHeight: number,
  fallback: number,
  tracking = 0,
): number {
  const count = Array.from(String(content || '').replace(/\s+/g, '')).length;
  const trackingLineHeight = getPsdVerticalTrackingLineHeight(tracking);
  if (count <= 1 || fontSize <= 0 || targetHeight <= fontSize) return trackingLineHeight ?? fallback;
  const fabricLineBoxMultiplier = 1.13;
  const fitted = ((targetHeight / (fontSize * fabricLineBoxMultiplier)) - 1) / (count - 1);
  if (!Number.isFinite(fitted) || fitted <= 0) return trackingLineHeight ?? fallback;
  return clampMetricValue(fitted, 0.45, 1.6, 3);
}

function getPsdVerticalTrackingLineHeight(tracking: number): number | null {
  const trackingRatio = Number.isFinite(tracking) ? tracking / 1000 : 0;
  const lineHeight = (1 + trackingRatio) / 1.13;
  return Number.isFinite(lineHeight) && lineHeight > 0
    ? clampMetricValue(lineHeight, 0.45, 1.6, 3)
    : null;
}

function getPsdManualLineHeight(
  content: string,
  fontSize: number,
  targetHeight: number,
  fallback: number,
): number {
  const lineCount = String(content || '').split(/\r\n|\r|\n/).length;
  if (lineCount <= 1 || fontSize <= 0 || targetHeight <= 0) return fallback;
  const fabricLineBoxMultiplier = 1.13;
  const fitted = ((targetHeight / (fontSize * fabricLineBoxMultiplier)) - 1) / (lineCount - 1);
  if (!Number.isFinite(fitted) || fitted <= 0) return fallback;
  const visualLineHeight = clampMetricValue(fitted + 0.12, 1.1, 2, 3);
  return Math.min(fallback, visualLineHeight);
}

function revivePsdTextShadow(value: unknown): fabric.Shadow | undefined {
  if (!value) return undefined;
  if (value instanceof fabric.Shadow) return value;
  const source = value as Record<string, unknown>;
  const color = typeof source.color === 'string' ? source.color : '';
  if (!color) return undefined;
  return new fabric.Shadow({
    color,
    blur: Math.max(0, finiteNumber(source.blur, 0)),
    offsetX: Math.round(finiteNumber(source.offsetX, 0)),
    offsetY: Math.round(finiteNumber(source.offsetY, 0)),
    affectStroke: source.affectStroke === true,
    nonScaling: source.nonScaling === true,
  });
}

type PsdLayerBounds = {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
};

async function convertPsdTextPreviewToEditableText(
  canvas: fabric.Canvas,
  preview: fabric.FabricImage,
  fontFamily: string,
): Promise<fabric.FabricObject> {
  const source = preview as fabric.FabricImage & {
    _psdTextContent?: string;
    _psdTextIsAreaText?: boolean;
    _psdTextOrientation?: string;
    _psdTextOptions?: Record<string, unknown>;
    _psdLayerBounds?: PsdLayerBounds;
    _psdPreviewVisualBounds?: PixelBounds;
    _psdInvisibleHitArea?: boolean;
    _psdIgnorePreviewColor?: boolean;
    _layerId?: unknown;
    _layerName?: unknown;
    _layerType?: unknown;
  };
  const options = getPsdEditableSourceTextOptions(source, source._psdTextOptions || {});
  const layerBounds = getPsdPreviewTargetBounds(source);
  const previewVisualBounds = source._psdPreviewVisualBounds || await measureObjectPixelBounds(canvas, preview);
  const targetBounds = previewVisualBounds || layerBounds;
  const isVerticalText = isPsdVerticalTextOptions(options, source._psdTextOrientation);
  const content = isVerticalText
    ? formatPsdVerticalTextContent(source._psdTextContent || '')
    : source._psdTextContent || '';
  const hasManualLineBreak = /[\r\n]/.test(content);
  const previewOpacity = source._psdInvisibleHitArea === true
    ? finiteNumber(options.opacity, 1)
    : (preview.opacity ?? finiteNumber(options.opacity, 1));
  const editableFill =
    (source._psdIgnorePreviewColor === true ? null : sampleFabricImageDominantOpaqueColor(preview))
    || getDominantPsdRunFillColor(options.runs)
    || (typeof options.fill === 'string' ? options.fill : null)
    || '#141413';
  const verticalLineHeight = isVerticalText
    ? getPsdVerticalLineHeight(
        source._psdTextContent || '',
        positiveFiniteNumber(options.fontSize, 16),
        positiveFiniteNumber(targetBounds.height, layerBounds.height),
        positiveFiniteNumber(options.lineHeight, 1),
        Number(options.charSpacing) || 0,
      )
    : null;
  const manualLineHeight = !isVerticalText && hasManualLineBreak
    ? getPsdManualLineHeight(
        content,
        positiveFiniteNumber(options.fontSize, 16),
        positiveFiniteNumber(targetBounds.height, layerBounds.height),
        positiveFiniteNumber(options.lineHeight, 1.2),
      )
    : null;
  const textShadow = revivePsdTextShadow(options.shadow);
  const baseOptions = {
    ...options,
    ...(verticalLineHeight !== null ? { lineHeight: verticalLineHeight } : {}),
    ...(manualLineHeight !== null ? { lineHeight: manualLineHeight } : {}),
    ...(textShadow ? { shadow: textShadow } : { shadow: undefined }),
    left: layerBounds.left,
    top: layerBounds.top,
    angle: preview.angle || 0,
    opacity: previewOpacity,
    fontFamily,
    fill: editableFill,
    editable: true,
    objectCaching: false,
    splitByGrapheme: true,
  } as Partial<fabric.IText> & Record<string, unknown>;
  const text = source._psdTextIsAreaText && !isVerticalText && !hasManualLineBreak
    ? new fabric.Textbox(content, {
        ...baseOptions,
        width: Number(options.width) || preview.getScaledWidth(),
      } as Partial<fabric.Textbox>)
    : new fabric.IText(content, baseOptions as Partial<fabric.IText>);

  const custom = text as unknown as fabric.FabricObject & Record<string, unknown>;
  custom._layerId = source._layerId;
  custom._layerName = source._layerName;
  custom._layerType = 'text';
  custom._psdTextPreview = false;
  custom._psdMissingFont = false;
  custom._psdTextIsAreaText = source._psdTextIsAreaText && !hasManualLineBreak;
  custom._psdTextOrientation = isVerticalText ? 'vertical' : undefined;
  custom._psdTextOptions = {
    ...options,
    ...(verticalLineHeight !== null ? { lineHeight: verticalLineHeight } : {}),
    ...(manualLineHeight !== null ? { lineHeight: manualLineHeight } : {}),
  };
  custom._psdFontName = parseFontFamilyList(fontFamily)[0] || fontFamily;
  custom._psdLayerBounds = layerBounds;
  custom._psdPreviewVisualBounds = targetBounds;
  copyPsdSourceMetadata(source, custom);
  applyFontFamilyToTextStyles(text, fontFamily);

  const objects = canvas.getObjects();
  const index = objects.indexOf(preview);
  canvas.remove(preview);
  if (index >= 0 && index < objects.length - 1) {
    canvas.insertAt(index, text);
  } else {
    canvas.add(text);
  }
  canvas.setActiveObject(text);
  applyStoredPsdFillRunStyles(text, options.runs, isVerticalText, options.psdSolidFillColor);
  await waitForTextObjectFont(text);
  resetTextObjectDimensions(text);
  await alignObjectToTargetPixelBounds(canvas, text, targetBounds);
  text.setCoords();
  return text;
}

function applyStoredPsdFillRunStyles(
  text: fabric.FabricObject,
  runs: unknown,
  verticalText: boolean,
  forcedFill: unknown,
) {
  if (!Array.isArray(runs) || runs.length === 0) return;
  const target = text as fabric.IText;
  const contentLength = Array.from(String(target.text || '')).length;
  if (contentLength === 0) return;
  const forcedFillColor = typeof forcedFill === 'string' && forcedFill.trim() ? forcedFill.trim() : null;
  for (const item of runs) {
    const run = item as Record<string, unknown>;
    const fill = forcedFillColor || extractPsdRunFillColor(run);
    if (!fill) continue;
    const from = Math.max(0, Math.round(Number(run.from) || 0));
    const length = Math.max(0, Math.round(Number(run.length) || 0));
    const to = Math.min(contentLength, from + length);
    if (to <= from) continue;
    try {
      if (verticalText) {
        for (let charIndex = from; charIndex < to; charIndex += 1) {
          const displayIndex = charIndex * 2;
          target.setSelectionStyles({ fill }, displayIndex, displayIndex + 1);
        }
      } else {
        target.setSelectionStyles({ fill }, from, to);
      }
    } catch {
      // Best-effort style recovery for PSD preview text.
    }
  }
}

function getPsdPreviewTargetBounds(preview: fabric.FabricImage & { _psdLayerBounds?: PsdLayerBounds }): Required<PsdLayerBounds> {
  const bounds = preview._psdLayerBounds || {};
  return {
    left: finiteNumber(bounds.left, preview.left || 0),
    top: finiteNumber(bounds.top, preview.top || 0),
    width: positiveFiniteNumber(bounds.width, preview.getScaledWidth()),
    height: positiveFiniteNumber(bounds.height, preview.getScaledHeight()),
  };
}

function finiteNumber(value: unknown, fallback: number): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function positiveFiniteNumber(value: unknown, fallback: number): number {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : fallback;
}

function getStoredPixelBounds(object: fabric.FabricObject | null): PixelBounds | null {
  const bounds = (object as { _psdPreviewVisualBounds?: Partial<PixelBounds> } | null)?._psdPreviewVisualBounds;
  if (!bounds) return null;
  const left = Number(bounds.left);
  const top = Number(bounds.top);
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  return {
    left,
    top,
    width,
    height,
    right: Number.isFinite(Number(bounds.right)) ? Number(bounds.right) : left + width - 1,
    bottom: Number.isFinite(Number(bounds.bottom)) ? Number(bounds.bottom) : top + height - 1,
  };
}

async function waitForTextObjectFont(text: fabric.FabricObject) {
  if (typeof document === 'undefined' || !document.fonts) return;
  const target = text as fabric.IText;
  const fontFamily = String(target.fontFamily || 'sans-serif');
  const fontSize = Math.max(1, Math.round(Number(target.fontSize) || 16));
  const fontWeight = String(target.fontWeight || '400');
  try {
    await document.fonts.load(`${fontWeight} ${fontSize}px ${fontFamily}`);
    await document.fonts.ready;
  } catch {
    // Browser font loading is best-effort; alignment below still has a safe fallback.
  }
}

function resetTextObjectDimensions(text: fabric.FabricObject) {
  const target = text as fabric.IText & { initDimensions?: () => void };
  try {
    target.initDimensions?.();
  } catch {
    // Ignore Fabric dimension recalculation failures and keep the object editable.
  }
  text.setCoords();
}

async function alignObjectToTargetPixelBounds(
  canvas: fabric.Canvas,
  object: fabric.FabricObject,
  bounds: Required<PsdLayerBounds>,
) {
  canvas.requestRenderAll();
  const visualBounds = await measureObjectPixelBounds(canvas, object);
  if (!visualBounds) {
    object.set({ left: bounds.left, top: bounds.top });
    return;
  }
  const dx = bounds.left - visualBounds.left;
  const dy = bounds.top - visualBounds.top;
  if (Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2) {
    object.set({
      left: (Number(object.left) || 0) + dx,
      top: (Number(object.top) || 0) + dy,
    });
  }
  object.setCoords();
}

type PixelBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

async function measureObjectPixelBounds(
  canvas: fabric.Canvas,
  object: fabric.FabricObject,
): Promise<PixelBounds | null> {
  if (typeof document === 'undefined') return null;
  const width = Math.max(1, Math.ceil(canvas.getWidth()));
  const height = Math.max(1, Math.ceil(canvas.getHeight()));
  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;

  const clone = await object.clone() as fabric.FabricObject;
  clone.set({
    selectable: false,
    evented: false,
    objectCaching: false,
    opacity: 1,
    globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
  });

  const staticCanvas = new fabric.StaticCanvas(offscreen, {
    width,
    height,
    backgroundColor: 'rgba(0,0,0,0)',
    renderOnAddRemove: false,
  });

  try {
    staticCanvas.add(clone);
    staticCanvas.renderAll();
    const ctx = offscreen.getContext('2d');
    if (!ctx) return null;
    const data = ctx.getImageData(0, 0, width, height).data;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const alpha = data[(y * width + x) * 4 + 3];
        if (alpha > 8) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return null;
    return {
      left: minX,
      top: minY,
      right: maxX,
      bottom: maxY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    };
  } finally {
    staticCanvas.dispose();
  }
}

function getPanelObjectRect(object: fabric.FabricObject) {
  const rect = object.getBoundingRect();
  const left = Number.isFinite(rect.left) ? rect.left : Number(object.left) || 0;
  const top = Number.isFinite(rect.top) ? rect.top : Number(object.top) || 0;
  const width = Number.isFinite(rect.width) && rect.width > 0
    ? rect.width
    : (Number(object.width) || 0) * (Number(object.scaleX) || 1);
  const height = Number.isFinite(rect.height) && rect.height > 0
    ? rect.height
    : (Number(object.height) || 0) * (Number(object.scaleY) || 1);
  return { left, top, width, height };
}

function moveObjectBy(object: fabric.FabricObject, dx: number, dy: number) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  object.set({
    left: (Number(object.left) || 0) + dx,
    top: (Number(object.top) || 0) + dy,
  });
  moveAbsoluteClipPath(object.clipPath, dx, dy);
}

function moveAbsoluteClipPath(
  clipPath: { left?: unknown; top?: unknown; absolutePositioned?: boolean; set?: (values: { left: number; top: number }) => void; setCoords?: () => void } | undefined,
  dx: number,
  dy: number,
) {
  const absoluteClipPath = clipPath;
  if (!absoluteClipPath?.absolutePositioned) return;
  absoluteClipPath.set?.({
    left: (Number(absoluteClipPath.left) || 0) + dx,
    top: (Number(absoluteClipPath.top) || 0) + dy,
  });
  absoluteClipPath.setCoords?.();
}

export default function RightPanel() {
  const { engine, canvas, selectedObjectIds } = useEditorStore();
  const [activeObject, setActiveObject] = useState<fabric.FabricObject | null>(null);
  const [nativeActiveObject, setNativeActiveObject] = useState<EditorObject | null>(null);
  const [props, setProps] = useState({ x: 0, y: 0, w: 0, h: 0, angle: 0, opacity: 100, fill: '#141413', stroke: '', strokeWidth: 0, radius: 0 });
  const [textProps, setTextProps] = useState({ fontSize: 24, fontWeight: 'normal', fontStyle: 'normal', underline: false, linethrough: false, textAlign: 'left', lineHeight: 1.2, charSpacing: 0, fontFamily: '' });
  const [fonts, setFonts] = useState<FontOption[]>([]);
  const [uploadingFonts, setUploadingFonts] = useState(false);
  const [croppingImage, setCroppingImage] = useState<fabric.FabricImage | null>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { api.get('/fonts').then(r => setFonts(r.data?.data || [])).catch(() => {}); }, []);

  const refreshNativeActiveObject = useCallback(() => {
    if (canvas || !engine) {
      setNativeActiveObject(null);
      return;
    }
    setNativeActiveObject(engine.getActiveObject());
  }, [canvas, engine]);

  useEffect(() => { refreshNativeActiveObject(); }, [selectedObjectIds, refreshNativeActiveObject]);

  useEffect(() => {
    if (canvas || !engine?.on) return;
    const offSelectionChange = engine.on('selectionchange', refreshNativeActiveObject);
    const offChange = engine.on('change', refreshNativeActiveObject);
    return () => {
      offSelectionChange();
      offChange();
    };
  }, [canvas, engine, refreshNativeActiveObject]);

  const updateFromCanvas = useCallback(() => {
    if (!canvas) {
      setActiveObject(null);
      return;
    }
    const obj = canvas.getActiveObject() || null;
    setActiveObject(obj);
    if (!obj) return;
    const rect = getPanelObjectRect(obj);
    setProps({
      x: Math.round(rect.left), y: Math.round(rect.top),
      w: Math.round(rect.width), h: Math.round(rect.height),
      angle: Math.round(obj.angle || 0), opacity: Math.round((obj.opacity || 1) * 100),
      fill: toHex(obj.fill),
      stroke: obj.stroke ? toHex(obj.stroke) : '',
      strokeWidth: obj.strokeWidth || 0,
      radius: obj instanceof fabric.Rect ? Math.round(Number(obj.rx || 0)) : 0,
    });
    if (obj instanceof fabric.Textbox || obj instanceof fabric.IText || isPsdTextPreviewObject(obj)) {
      const previewOptions = isPsdTextPreviewObject(obj) ? (obj._psdTextOptions || {}) : null;
      setTextProps({
        fontSize: Math.round(Number(previewOptions?.fontSize ?? (obj as fabric.IText).fontSize ?? 24)),
        fontWeight: normalizePanelFontWeight(previewOptions?.fontWeight ?? (obj as fabric.IText).fontWeight),
        fontStyle: String(previewOptions?.fontStyle ?? (obj as fabric.IText).fontStyle ?? 'normal'),
        underline: Boolean(previewOptions?.underline ?? (obj as fabric.IText).underline ?? false),
        linethrough: Boolean(previewOptions?.linethrough ?? (obj as fabric.IText).linethrough ?? false),
        textAlign: String(previewOptions?.textAlign ?? (obj as fabric.IText).textAlign ?? 'left'),
        lineHeight: Number(previewOptions?.lineHeight ?? (obj as fabric.IText).lineHeight ?? 1.2),
        charSpacing: Number(previewOptions?.charSpacing ?? (obj as fabric.IText).charSpacing ?? 0),
        fontFamily: isPsdTextPreviewObject(obj)
          ? getPsdPreviewEditableFontFamily(previewOptions?.fontFamily)
          : String(previewOptions?.fontFamily ?? (obj as fabric.IText).fontFamily ?? ''),
      });
    }
  }, [canvas]);

  useEffect(() => { updateFromCanvas(); }, [selectedObjectIds, updateFromCanvas]);
  useEffect(() => {
    if (!canvas) return;
    const h = () => updateFromCanvas();
    canvas.on('selection:created', h); canvas.on('selection:updated', h); canvas.on('selection:cleared', h);
    canvas.on('object:modified', h); canvas.on('object:moving', h); canvas.on('object:scaling', h); canvas.on('object:rotating', h);
    return () => {
      canvas.off('selection:created', h); canvas.off('selection:updated', h); canvas.off('selection:cleared', h);
      canvas.off('object:modified', h); canvas.off('object:moving', h); canvas.off('object:scaling', h); canvas.off('object:rotating', h);
    };
  }, [canvas, updateFromCanvas]);

  const commitObjectChange = useCallback((obj: fabric.FabricObject) => {
    if (!canvas) return;
    obj.setCoords();
    canvas.fire('object:modified', { target: obj });
    canvas.requestRenderAll();
    updateFromCanvas();
  }, [canvas, updateFromCanvas]);

  const apply = (key: string, value: number) => {
    if (!canvas) return; const obj = canvas.getActiveObject(); if (!obj) return;
    const rect = getPanelObjectRect(obj);
    switch (key) {
      case 'x': moveObjectBy(obj, value - rect.left, 0); break; case 'y': moveObjectBy(obj, 0, value - rect.top); break;
      case 'w': obj.set('scaleX', (obj.scaleX || 1) * (value / (rect.width || 1))); break; case 'h': obj.set('scaleY', (obj.scaleY || 1) * (value / (rect.height || 1))); break;
      case 'angle': obj.set('angle', value); break; case 'opacity': obj.set('opacity', value / 100); break;
    }
    commitObjectChange(obj);
  };
  const setTextProp = async (key: string, value: unknown) => {
    if (!canvas) return; const obj = canvas.getActiveObject(); if (!obj) return;
    const nextValue = key === 'lineHeight'
      ? clampMetricValue(Number(value) || 1.2, 0.1, 10, 3)
      : key === 'charSpacing'
        ? Math.round(Number(value) || 0)
        : value;
    if (isPsdTextPreviewObject(obj)) {
      const editableFontFamily = getPsdPreviewEditableFontFamily(
        key === 'fontFamily' ? nextValue : undefined,
        obj._psdTextOptions?.fontFamily,
      );
      const text = await convertPsdTextPreviewToEditableText(canvas, obj, editableFontFamily);
      if (key !== 'fontFamily') {
        const previousVisualBounds = getStoredPixelBounds(text) || await measureObjectPixelBounds(canvas, text);
        (text as any).set(key, nextValue);
        if (TEXT_LAYOUT_PROP_KEYS.has(key)) {
          await waitForTextObjectFont(text);
          resetTextObjectDimensions(text);
          if (previousVisualBounds) {
            await alignObjectToTargetPixelBounds(canvas, text, previousVisualBounds);
          }
        }
      }
      commitObjectChange(text);
      return;
    }
    const previousVisualBounds =
      key === 'fontFamily' && typeof nextValue === 'string'
        ? getStoredPixelBounds(obj) || await measureObjectPixelBounds(canvas, obj)
        : null;
    (obj as any).set(key, nextValue);
    if (key === 'fontFamily' && typeof nextValue === 'string') {
      applyFontFamilyToTextStyles(obj, nextValue);
      await waitForTextObjectFont(obj);
      resetTextObjectDimensions(obj);
      if (previousVisualBounds) {
        await alignObjectToTargetPixelBounds(canvas, obj, previousVisualBounds);
      }
    }
    commitObjectChange(obj);
  };

  const hasSelection = Boolean(activeObject);
  const activeObj = activeObject;
  const isPsdTextPreview = isPsdTextPreviewObject(activeObj);
  const isPdfSourceTextActivation = Boolean(
    activeObj && (activeObj as fabric.FabricObject & { _pdfSourceTextActivation?: boolean })._pdfSourceTextActivation === true,
  );
  const isImage = activeObj instanceof fabric.FabricImage && !isPsdTextPreview;
  const isText = activeObj instanceof fabric.Textbox || activeObj instanceof fabric.IText || isPsdTextPreview;
  const isRect = activeObj instanceof fabric.Rect && !isText && !isPdfSourceTextActivation;
  const layerName = (activeObj as any)?._layerName || '';
  const selectedTypeLabel = getFabricPanelObjectTypeLabel(activeObj, {
    isText: isText || isPdfSourceTextActivation,
    isImage,
  });

  // 替换图片
  const handleReplaceImage = useCallback(async (file: File) => {
    if (!canvas) return; const obj = canvas.getActiveObject();
    if (!obj || !(obj instanceof fabric.FabricImage)) return;
    const url = URL.createObjectURL(file);
    try {
      const newImg = await fabric.FabricImage.fromURL(url, { crossOrigin: 'anonymous' });
      const scale = Math.min(((obj.width||1)*(obj.scaleX||1))/(newImg.width||1), ((obj.height||1)*(obj.scaleY||1))/(newImg.height||1));
      newImg.set({ left: obj.left, top: obj.top, scaleX: scale, scaleY: scale, opacity: obj.opacity, angle: obj.angle });
      (newImg as any)._layerId = (obj as any)._layerId; (newImg as any)._layerName = (obj as any)._layerName; (newImg as any)._layerType = (obj as any)._layerType;
      canvas.remove(obj); canvas.add(newImg); canvas.setActiveObject(newImg); canvas.renderAll();
    } finally { URL.revokeObjectURL(url); }
  }, [canvas]);

  const handleBeginCrop = useCallback(() => {
    if (!canvas) return;
    const obj = canvas.getActiveObject();
    if (!(obj instanceof fabric.FabricImage)) return;
    if (isImageCropping(obj)) return;
    if ((obj.angle || 0) % 360 !== 0) {
      message.warning('请先将图片旋转角度归零再裁切');
      return;
    }
    beginImageCrop(canvas, obj);
    setCroppingImage(obj);
  }, [canvas]);

  const handleConfirmCrop = useCallback(() => {
    if (!canvas || !croppingImage) return;
    confirmImageCrop(canvas, croppingImage);
    setCroppingImage(null);
  }, [canvas, croppingImage]);

  const handleCancelCrop = useCallback(() => {
    if (!canvas || !croppingImage) return;
    cancelImageCrop(canvas, croppingImage);
    setCroppingImage(null);
  }, [canvas, croppingImage]);

  useEffect(() => {
    if (!croppingImage || !canvas) return;
    const isOnCropAux = activeObject && (activeObject as fabric.FabricObject & { _benlaiCropAux?: boolean })._benlaiCropAux === true;
    if (!isOnCropAux) {
      cancelImageCrop(canvas, croppingImage);
      setCroppingImage(null);
    }
  }, [activeObject, croppingImage, canvas]);

  // 上传字体
  const handleUploadFonts = async (files: File[]) => {
    if (files.length === 0 || uploadingFonts) return;
    const form = new FormData();
    files.forEach((file) => form.append('files', file));
    setUploadingFonts(true);
    try {
      const res = await api.post('/fonts/batch', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      const uploaded = Array.isArray(res.data?.data) ? res.data.data : [];
      if (uploaded.length > 0) {
        setFonts(prev => mergeFonts(prev, uploaded));
        await reloadCustomFontsStylesheet();
        await waitForUploadedFonts(uploaded);
        const matched = await applyUploadedFontToActiveText(canvas, uploaded);
        canvas?.requestRenderAll();
        message.success(`已上传 ${uploaded.length} 个字体`);
      }
    } catch (error) {
      message.error(getApiMessage(error, '上传字体失败'));
    } finally {
      setUploadingFonts(false);
    }
  };

  if (croppingImage) {
    return (
      <div style={{ width: 300, background: '#fff', borderLeft: '1px solid var(--border-1)', overflowY: 'auto', overflowX: 'hidden', flexShrink: 0 }}>
        <div style={{ padding: '16px 14px' }}>
          <div style={{ font: '700 14px var(--font-sans)', color: 'var(--fg-1)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Crop size={15} /> 裁切图片
          </div>
          <div style={{ font: '500 12px var(--font-sans)', color: 'var(--fg-3)', lineHeight: 1.6, marginBottom: 14 }}>
            拖动裁切框的边或角调整范围，原图区域可保留。
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <button type="button" onClick={handleCancelCrop} style={{
              height: 34, borderRadius: 8, border: '1px solid var(--border-2)', background: '#fff',
              font: '600 13px var(--font-sans)', color: 'var(--fg-2)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
            }}><X size={14} /> 取消</button>
            <button type="button" onClick={handleConfirmCrop} style={{
              height: 34, borderRadius: 8, border: 0, background: '#2557f6', color: '#fff',
              font: '700 13px var(--font-sans)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
            }}><Check size={14} /> 完成</button>
          </div>
        </div>
      </div>
    );
  }

  if (!canvas && engine) {
    return (
      <NativeRightPanel
        object={nativeActiveObject}
        onUpdate={(patch) => {
          engine.updateActiveObject(patch);
          refreshNativeActiveObject();
        }}
        onDuplicate={() => {
          engine.duplicateActiveObject();
          refreshNativeActiveObject();
        }}
        onDelete={() => {
          engine.removeActiveObject();
          refreshNativeActiveObject();
        }}
      />
    );
  }

  return (
    <div style={{ width: 300, background: '#fff', borderLeft: '1px solid var(--border-1)', overflowY: 'auto', overflowX: 'hidden', flexShrink: 0 }}>
      {!hasSelection ? (
        <div style={{ padding: '48px 20px', textAlign: 'center', font: '13px var(--font-sans)', color: 'var(--fg-4)', lineHeight: 1.6 }}>
          选择画布上的元素<br />查看和编辑属性
        </div>
      ) : (
        <div style={{ padding: '4px 14px' }}>

          {/* 图层标题 */}
          {layerName && (
            <Section>
              <Row>
                <span style={{ padding: '2px 8px', borderRadius: 4, font: '500 11px var(--font-sans)', background: isText ? 'var(--brand-teal-50)' : 'var(--n-100)', color: isText ? 'var(--brand-teal-600)' : 'var(--fg-3)' }}>
                  {selectedTypeLabel}
                </span>
                <span style={{ font: '500 13px var(--font-sans)', color: 'var(--fg-1)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{layerName}</span>
              </Row>
            </Section>
          )}

          {/* ========== 文字 ========== */}
          {isText && activeObj && (<>
            {/* 字体选择 */}
            <Section>
              {isPsdTextPreview && (
                <div style={{ marginBottom: 8, padding: '6px 8px', borderRadius: 5, background: '#FFF8E6', color: '#8A6300', font: '500 12px var(--font-sans)', lineHeight: 1.4 }}>
                  缺少原字体，当前显示缓存预览；编辑时将使用默认中文字体
                </div>
              )}
              <div style={{ position: 'relative', marginBottom: 8 }}>
                {/*
                  textProps.fontFamily 是 fabric 对象上的完整 CSS font-family 链
                  （比如 `"FZLTZHK--GBK1-0", "FZLanTingHei-DB-GBK", ..., sans-serif`），
                  直接当 select.value 永远找不到匹配 option，浏览器只能高亮第一个「默认」。
                  这里实时反查右侧字体库，匹配到的话用对应的 option value 高亮。
                */}
                <select
                  value={resolveSelectValueForFont(
                    textProps.fontFamily,
                    (activeObj as fabric.FabricObject & { _psdFontName?: string })?._psdFontName,
                    fonts,
                  )}
                  onChange={(e) => setTextProp('fontFamily', e.target.value)}
                  style={{ width: '100%', height: 32, padding: '0 28px 0 10px', appearance: 'none', border: '1px solid var(--border-2)', borderRadius: 5, font: '500 13px var(--font-sans)', color: 'var(--fg-1)', background: '#fff', outline: 'none' }}>
                  <option value="sans-serif">默认</option>
                  <option value={DEFAULT_CN_EDIT_FONT_FAMILY}>阿里巴巴普惠体</option>
                  <option value='"Microsoft YaHei","Source Han Sans CN","Noto Sans SC",sans-serif'>微软雅黑</option>
                  <option value='"Source Han Sans CN","Noto Sans SC",sans-serif'>思源黑体</option>
                  <option value='"Source Han Serif CN","Noto Serif SC",serif'>思源宋体</option>
                  <option value="Arial,sans-serif">Arial</option>
                  <option value='"DIN Pro","Arial Black",sans-serif'>DIN Pro</option>
                  {fonts.map(f => <option key={f.id} value={`"${f.family}",sans-serif`}>{f.name}</option>)}
                </select>
                <ChevronDown size={12} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-4)', pointerEvents: 'none' }} />
              </div>
              <Row>
                <FontSizeCombo
                  value={textProps.fontSize}
                  onChange={(n) => setTextProp('fontSize', n)}
                  inputStyle={{ height: 28, padding: '0 8px', border: '1px solid var(--border-2)', borderRadius: 5, font: '12px var(--font-sans)', color: 'var(--fg-1)', background: 'var(--n-50)', outline: 'none' }}
                />
                <select value={textProps.fontWeight} onChange={(e) => setTextProp('fontWeight', e.target.value)}
                  style={{ width: 76, height: 28, padding: '0 4px', border: '1px solid var(--border-2)', borderRadius: 5, font: '12px var(--font-sans)', color: 'var(--fg-1)', background: 'var(--n-50)', outline: 'none' }}>
                  <option value="normal">常规</option>
                  <option value="bold">粗体</option>
                </select>
              </Row>
            </Section>

            {/* 文字样式 B/I/U/S */}
            <Section>
              <Row gap={4}>
                <IconBtn active={textProps.fontWeight === 'bold'} onClick={() => setTextProp('fontWeight', textProps.fontWeight === 'bold' ? 'normal' : 'bold')} title="粗体"><Bold size={14} /></IconBtn>
                <IconBtn active={textProps.fontStyle === 'italic'} onClick={() => setTextProp('fontStyle', textProps.fontStyle === 'italic' ? 'normal' : 'italic')} title="斜体"><Italic size={14} /></IconBtn>
                <IconBtn active={textProps.underline} onClick={() => setTextProp('underline', !textProps.underline)} title="下划线"><Underline size={14} /></IconBtn>
                <IconBtn active={textProps.linethrough} onClick={() => setTextProp('linethrough', !textProps.linethrough)} title="删除线"><Strikethrough size={14} /></IconBtn>
              </Row>
            </Section>

            {/* 对齐 */}
            <Section>
              <Row gap={4}>
                <IconBtn active={textProps.textAlign === 'left'} onClick={() => setTextProp('textAlign', 'left')} title="左对齐"><AlignLeft size={14} /></IconBtn>
                <IconBtn active={textProps.textAlign === 'center'} onClick={() => setTextProp('textAlign', 'center')} title="居中"><AlignCenter size={14} /></IconBtn>
                <IconBtn active={textProps.textAlign === 'right'} onClick={() => setTextProp('textAlign', 'right')} title="右对齐"><AlignRight size={14} /></IconBtn>
                <IconBtn active={textProps.textAlign === 'justify'} onClick={() => setTextProp('textAlign', 'justify')} title="两端对齐"><AlignJustify size={14} /></IconBtn>
              </Row>
            </Section>

            {/* 行高 / 字间距 */}
            <Section>
              <Row>
                <MetricCombo
                  label="行高"
                  value={fabricLineHeightToPx(textProps.lineHeight, textProps.fontSize)}
                  onChange={(n) => setTextProp('lineHeight', lineHeightPxToFabric(n, textProps.fontSize))}
                  presets={LINE_HEIGHT_PRESETS}
                  min={1}
                  max={999}
                  precision={0}
                />
                <MetricCombo
                  label="字距"
                  value={fabricCharSpacingToPx(textProps.charSpacing, textProps.fontSize)}
                  onChange={(n) => setTextProp('charSpacing', charSpacingPxToFabric(n, textProps.fontSize))}
                  presets={CHAR_SPACING_PRESETS}
                  min={-50}
                  max={200}
                  precision={1}
                />
              </Row>
            </Section>

            {/* PSD 字体 + 上传 */}
            <Section>
              <Row>
                {(activeObj as any)._psdFontName && <span style={{ font: '11px var(--font-sans)', color: 'var(--fg-4)', flex: 1 }}>源: {(activeObj as any)._psdFontName}</span>}
                <input ref={fontInputRef} type="file" accept=".ttf,.otf,.ttc,.woff,.woff2" multiple style={{ display: 'none' }}
                  onChange={(e) => { const files = Array.from(e.target.files || []); if (files.length) handleUploadFonts(files); e.target.value = ''; }} />
                <span onClick={() => fontInputRef.current?.click()} style={{ font: '11px var(--font-sans)', color: 'var(--brand-teal-500)', cursor: 'pointer' }}>
                  <Upload size={11} style={{ verticalAlign: -1, marginRight: 2 }} />{uploadingFonts ? '上传中...' : '批量上传字体'}
                </span>
              </Row>
            </Section>
          </>)}

          {/* ========== 图片 ========== */}
          {isImage && (
            <>
              <Section>
                <input ref={replaceInputRef} type="file" accept="image/*" style={{ display: 'none' }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleReplaceImage(f); e.target.value = ''; }} />
                <button onClick={() => replaceInputRef.current?.click()} style={{
                  width: '100%', height: 34, borderRadius: 8, border: 0, background: '#f0f1f3',
                  font: '700 13px var(--font-sans)', color: '#20242a', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}><ImagePlus size={14} /> 替换图片</button>
              </Section>

              <Section label="工具">
                <div style={imageToolGridStyle}>
                  <button
                    type="button"
                    onClick={handleBeginCrop}
                    style={imageToolButtonStyle(false)}
                    title="裁切"
                  >
                    <span style={imageToolIconStyle}><Crop size={16} /></span>
                    <span>裁切</span>
                  </button>
                </div>
              </Section>

              {canvas && activeObj instanceof fabric.FabricImage && (
                <Section>
                  <React.Suspense fallback={<MiniPanelLoading />}>
                    <ImageFiltersPanel image={activeObj} canvas={canvas} selectionKey={(activeObj as any)._layerId ?? activeObj} />
                  </React.Suspense>
                </Section>
              )}
            </>
          )}

          {/* ========== 填充 / 文字色 ========== */}
          {!isImage && (
            <Section label="填充">
              <Row>
                <ColorInput value={props.fill} onChange={(c) => { const obj = canvas?.getActiveObject(); if (obj && canvas) { obj.set('fill', c); canvas.renderAll(); setProps(p => ({ ...p, fill: c })); } }} label={isText ? '文字色' : '填充色'} />
                <Eye size={14} style={{ color: 'var(--fg-4)' }} />
              </Row>
            </Section>
          )}

          {isRect && (
            <Section label="圆角">
              <Row>
                <NumInput
                  label=""
                  value={props.radius}
                  onChange={(n) => {
                    const obj = canvas?.getActiveObject();
                    if (obj instanceof fabric.Rect && canvas) {
                      const radius = Math.max(0, Math.min(200, Math.round(n)));
                      obj.set({ rx: radius, ry: radius });
                      canvas.renderAll();
                      setProps(p => ({ ...p, radius }));
                    }
                  }}
                  unit="px"
                />
              </Row>
            </Section>
          )}

          {/* ========== 描边 ========== */}
          {!isImage && (
            <Section label="描边">
              <Row>
                <NumInput label="" value={props.strokeWidth} onChange={(n) => { const obj = canvas?.getActiveObject(); if (obj && canvas) { markPsdNativeEffectOverride(obj, 'stroke'); obj.set('strokeWidth', n); if (n <= 0) obj.set('stroke', undefined); commitObjectChange(obj); setProps(p => ({ ...p, strokeWidth: n, stroke: n <= 0 ? '' : p.stroke })); } }} width={60} />
                <input type="color" value={props.stroke?.startsWith('#') ? props.stroke : '#000000'}
                  onChange={(e) => { const obj = canvas?.getActiveObject(); if (obj && canvas) { markPsdNativeEffectOverride(obj, 'stroke'); obj.set('stroke', e.target.value); obj.set('strokeWidth', props.strokeWidth || 1); commitObjectChange(obj); setProps(p => ({ ...p, stroke: e.target.value, strokeWidth: p.strokeWidth || 1 })); } }}
                  style={{ width: 24, height: 24, border: '1px solid var(--border-2)', borderRadius: 4, padding: 0, cursor: 'pointer' }} />
                <span style={{ flex: 1, font: '12px var(--font-sans)', color: 'var(--fg-2)' }}>{props.stroke || '无'}</span>
                <Eye size={14} style={{ color: 'var(--fg-4)' }} />
              </Row>
            </Section>
          )}

          {/* ========== 投影 ========== */}
          <Section label="投影">
            <Row>
              <span style={{ flex: 1, font: '12px var(--font-sans)', color: 'var(--fg-3)' }}>
                {activeObj?.shadow ? '已启用' : '无'}
              </span>
              <span onClick={() => {
                if (!canvas || !activeObj) return;
                markPsdNativeEffectOverride(activeObj, 'dropShadow');
                if (activeObj.shadow) { activeObj.set('shadow', null); }
                else { activeObj.set('shadow', new fabric.Shadow({ color: 'rgba(0,0,0,0.3)', blur: 4, offsetX: 2, offsetY: 2 })); }
                commitObjectChange(activeObj);
              }} style={{ cursor: 'pointer', color: 'var(--fg-4)' }}>
                {activeObj?.shadow ? <Minus size={14} /> : <Plus size={14} />}
              </span>
            </Row>
          </Section>

          {/* ========== 不透明度 ========== */}
          <Section label="不透明度">
            <Row>
              <input type="range" min={0} max={100} value={props.opacity}
                onChange={(e) => { const v = parseInt(e.target.value); setProps(p => ({ ...p, opacity: v })); apply('opacity', v); }}
                style={{ flex: 1, accentColor: 'var(--brand-teal-500)' }} />
              <span style={{ font: '12px var(--font-sans)', color: 'var(--fg-1)', width: 32, textAlign: 'right' }}>{props.opacity}</span>
            </Row>
          </Section>

          {/* ========== 尺寸 ========== */}
          <Section label="尺寸">
            <Row>
              <Link2 size={12} style={{ color: 'var(--fg-4)' }} />
              <NumInput value={props.w} onChange={(n) => { setProps(p => ({ ...p, w: n })); apply('w', n); }} label="" unit="宽" />
              <NumInput value={props.h} onChange={(n) => { setProps(p => ({ ...p, h: n })); apply('h', n); }} label="" unit="高" />
            </Row>
          </Section>

          {/* ========== 位置 ========== */}
          <Section label="位置" border={false}>
            <Row>
              <NumInput value={props.x} onChange={(n) => { setProps(p => ({ ...p, x: n })); apply('x', n); }} label="" unit="X" />
              <NumInput value={props.y} onChange={(n) => { setProps(p => ({ ...p, y: n })); apply('y', n); }} label="" unit="Y" />
            </Row>
            <Row>
              <NumInput label="" value={props.angle} onChange={(n) => { setProps(p => ({ ...p, angle: n })); apply('angle', n); }} unit="°" />
            </Row>
          </Section>

        </div>
      )}
    </div>
  );
}

function getApiMessage(error: unknown, fallback: string) {
  const responseMessage = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
  if (responseMessage) return responseMessage;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function MiniPanelLoading() {
  return <div style={miniPanelLoadingStyle} />;
}

const imageToolGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 8,
};

function imageToolButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    minHeight: 66,
    border: 0,
    borderRadius: 9,
    background: disabled ? '#f1f3f5' : '#f4f6f8',
    color: disabled ? '#9aa1aa' : '#20242a',
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    font: '700 12px var(--font-sans)',
  };
}

const imageToolIconStyle: React.CSSProperties = {
  width: 30,
  height: 28,
  borderRadius: 8,
  background: '#ffffff',
  display: 'grid',
  placeItems: 'center',
  boxShadow: '0 1px 2px rgba(15, 23, 42, 0.06)',
};

const miniPanelLoadingStyle: React.CSSProperties = {
  minHeight: 36,
  display: 'grid',
  placeItems: 'center',
};

const metricMenuStyle: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: 'calc(100% + 4px)',
  zIndex: 60,
  maxHeight: 180,
  overflowY: 'auto',
  padding: 4,
  border: '1px solid #e5e7eb',
  borderRadius: 7,
  background: '#fff',
  boxShadow: '0 12px 28px rgba(15, 23, 42, .14)',
};

function metricMenuItemStyle(active: boolean): React.CSSProperties {
  return {
    width: '100%',
    height: 28,
    padding: '0 8px',
    border: 0,
    borderRadius: 5,
    background: active ? '#eef2ff' : 'transparent',
    color: active ? '#1d4ed8' : '#111827',
    textAlign: 'left',
    cursor: 'pointer',
    font: '700 12px var(--font-sans)',
  };
}
