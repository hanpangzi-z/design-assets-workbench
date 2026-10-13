import { useEffect, useRef, type RefObject } from 'react';
import { scrollRoot, scrollToTop, viewport } from '../components/ResourceWaterfall/scroll';

interface Options {
  containerRef: RefObject<HTMLElement>;
  sentinelRef: RefObject<HTMLElement>;
  boundaryRef: RefObject<HTMLElement>;
  resetKey: string;
  enabled: boolean;
  loading: boolean;
  revision: number;
  onLoad: () => void;
}

export function useResourceLoadMore(options: Options) {
  const latest = useRef(options); latest.current = options;
  useEffect(() => {
    const element = options.containerRef.current;
    if (element) scrollToTop(scrollRoot(element));
  }, [options.resetKey, options.containerRef]);
  useEffect(() => {
    const element = options.containerRef.current;
    if (!element || !options.enabled) return;
    const root = scrollRoot(element); let frame = 0;
    const check = () => {
      frame = 0;
      const value = latest.current;
      if (!value.enabled || value.loading) return;
      const boundary = value.boundaryRef.current || value.sentinelRef.current;
      if (!boundary) return;
      const view = viewport(root);
      if (boundary.getBoundingClientRect().top <= view.top + view.height + 800) value.onLoad();
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(check); };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    root.addEventListener('scroll', schedule, { passive: true }); window.addEventListener('resize', schedule);
    element.addEventListener('resource-layout', schedule);
    schedule();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); root.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); element.removeEventListener('resource-layout', schedule); };
  }, [options.enabled, options.loading, options.revision, options.resetKey, options.containerRef]);
}
