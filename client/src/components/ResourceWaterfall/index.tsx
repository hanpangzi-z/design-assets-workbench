import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { DesignFile } from 'shared/types';
import { buildLayout, findAnchor, previewKey, visiblePlacements, type WaterfallLayout } from './layout';
import { scrollBy, scrollRoot, viewport, type ScrollRoot } from './scroll';
import './style.css';

export interface CardMetrics {
  width: number;
  previewHeight: number;
  priority: boolean;
  onIntrinsicSize: (width: number, height: number) => void;
  onMenuOpenChange: (open: boolean) => void;
}

interface Props {
  files: DesignFile[];
  resetKey: string;
  boundaryRef?: RefObject<HTMLDivElement>;
  renderItem: (file: DesignFile, metrics: CardMetrics) => ReactNode;
}

export default function ResourceWaterfall({ files, resetKey, boundaryRef, renderItem }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const root = useRef<ScrollRoot | null>(null);
  const committed = useRef<{ layout: WaterfallLayout; resetKey: string } | null>(null);
  const anchor = useRef<{ id: number; offset: number } | null>(null);
  const [metrics, setMetrics] = useState({ width: 240, top: 0, height: 800 });
  const [ratios, setRatios] = useState<Map<string, number>>(() => new Map());
  const pendingRatios = useRef(new Map<string, number>());
  const ratioFrame = useRef(0);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [menuIds, setMenuIds] = useState<Set<number>>(() => new Set());
  const layout = useMemo(() => buildLayout(files, metrics.width, ratios,
    committed.current?.resetKey === resetKey ? committed.current.layout : null), [files, metrics.width, ratios, resetKey]);

  const measure = useCallback((captureAnchor = true) => {
    const element = container.current;
    if (!element) return;
    const currentRoot = root.current || scrollRoot(element.parentElement || element);
    root.current = currentRoot;
    const box = element.getBoundingClientRect(), view = viewport(currentRoot);
    const next = { width: Math.max(1, element.clientWidth), top: view.top - box.top, height: Math.max(1, view.height) };
    if (captureAnchor && committed.current) anchor.current = findAnchor(committed.current.layout, next.top, next.height);
    setMetrics(old => old.width === next.width && Math.abs(old.top - next.top) < 0.5 && old.height === next.height ? old : next);
  }, []);

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    root.current = scrollRoot(element.parentElement || element);
    let frame = 0;
    const scheduleScroll = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => measure()); };
    const scheduleResize = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => measure(false)); };
    const observer = new ResizeObserver(scheduleResize);
    observer.observe(element);
    if (root.current !== window) observer.observe(root.current as HTMLElement);
    root.current.addEventListener('scroll', scheduleScroll, { passive: true });
    window.addEventListener('resize', scheduleResize);
    measure(false);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); root.current?.removeEventListener('scroll', scheduleScroll); window.removeEventListener('resize', scheduleResize); };
  }, [measure]);

  useLayoutEffect(() => {
    const previous = committed.current;
    const saved = previous?.resetKey === resetKey ? anchor.current : null;
    committed.current = { layout, resetKey };
    const scrollTop = root.current === window ? window.scrollY : (root.current as HTMLElement | null)?.scrollTop || 0;
    // Initial header/thumbnail hydration must never scroll a page away from its top.
    if (saved && scrollTop > 0 && root.current && container.current) {
      const position = layout.positions.find(p => p.id === saved.id);
      const view = viewport(root.current), currentTop = view.top - container.current.getBoundingClientRect().top;
      if (position) {
        const delta = position.top - saved.offset - currentTop;
        if (Math.abs(delta) > 0.5) scrollBy(root.current, delta);
      }
    }
    if (previous?.resetKey !== resetKey) { setFocusId(null); setMenuIds(new Set()); }
    measure();
    container.current?.dispatchEvent(new Event('resource-layout', { bubbles: true }));
  }, [layout, resetKey, measure]);

  useEffect(() => () => cancelAnimationFrame(ratioFrame.current), []);
  const reportSize = useCallback((key: string, width: number, height: number) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    pendingRatios.current.set(key, height / width);
    if (ratioFrame.current) return;
    ratioFrame.current = requestAnimationFrame(() => {
      ratioFrame.current = 0;
      const changes = new Map(pendingRatios.current); pendingRatios.current.clear();
      setRatios(old => {
        const next = new Map(old); let changed = false;
        for (const [key, ratio] of changes) if (Math.abs((old.get(key) || 0) - ratio) > 0.001) { next.set(key, ratio); changed = true; }
        return changed ? next : old;
      });
    });
  }, []);
  const pinned = new Set(menuIds);
  if (focusId !== null) pinned.add(focusId);
  const visible = visiblePlacements(layout, metrics.top, metrics.height, pinned);
  return <div ref={container} className="resource-waterfall" data-columns={layout.columnCount} data-total={files.length} style={{ height: layout.height }}>
    {visible.map(position => {
      const file = files[position.index];
      return <div key={file.id} data-resource-id={file.id} data-resource-index={position.index} className="resource-waterfall-item"
        style={{ width: position.width, height: position.height, transform: `translate(${position.left}px, ${position.top}px)` }}
        onFocusCapture={() => setFocusId(file.id)}
        onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusId(current => current === file.id ? null : current); }}>
        {renderItem(file, { width: position.width, previewHeight: position.previewHeight,
          priority: position.top < metrics.height && position.top + position.height > Math.max(0, metrics.top),
          onIntrinsicSize: (width, height) => reportSize(previewKey(file), width, height),
          onMenuOpenChange: open => setMenuIds(current => { const next = new Set(current); if (open) next.add(file.id); else next.delete(file.id); return next; }),
        })}
      </div>;
    })}
    <div ref={boundaryRef} aria-hidden="true" className="resource-waterfall-boundary" style={{ top: layout.shortestHeight }} />
  </div>;
}

export function ResourceCardInfo({ file, loading = false }: { file: DesignFile; loading?: boolean }) {
  const type = file.fileType.toLowerCase();
  const label = ['psd', 'ai', 'pdf', 'pptx', 'ttf', 'otf', 'ttc', 'woff', 'woff2'].includes(type) ? type.toUpperCase() : '图片';
  return <div className="resource-card-info">
    <div className="resource-card-name" title={file.name}>{file.name}</div>
    <div className="resource-card-meta"><span title={`上传者：${file.uploader?.displayName || '未知设计师'}`}>{file.uploader?.displayName || '未知设计师'}</span><span className="resource-card-type">{loading ? '打开中' : label}</span></div>
  </div>;
}
