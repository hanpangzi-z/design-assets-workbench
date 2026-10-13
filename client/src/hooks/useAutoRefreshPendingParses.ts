import { useEffect, useRef } from 'react';
import type { DesignFile } from 'shared/types';

const REFRESH_DELAYS_MS = [1500, 3000, 5000, 8000, 13000, 21000];

export function useAutoRefreshPendingParses(
  files: DesignFile[],
  refresh: () => void | Promise<void>,
) {
  const stateRef = useRef({ signature: '', attempts: 0 });

  useEffect(() => {
    const signature = files
      .filter((file) => file.parseStatus === 'pending' || file.parseStatus === 'parsing')
      .map((file) => `${file.id}:${file.parseStatus}:${file.updatedAt || ''}`)
      .sort()
      .join('|');

    if (!signature) {
      stateRef.current = { signature: '', attempts: 0 };
      return;
    }

    if (stateRef.current.signature !== signature) {
      stateRef.current = { signature, attempts: 0 };
    }

    const attempt = stateRef.current.attempts;
    if (attempt >= REFRESH_DELAYS_MS.length) return;

    if (document.hidden) {
      const refreshWhenVisible = () => {
        if (!document.hidden) void refresh();
      };
      document.addEventListener('visibilitychange', refreshWhenVisible, { once: true });
      return () => document.removeEventListener('visibilitychange', refreshWhenVisible);
    }

    const timer = window.setTimeout(() => {
      stateRef.current.attempts += 1;
      void refresh();
    }, REFRESH_DELAYS_MS[attempt]);

    return () => window.clearTimeout(timer);
  }, [files, refresh]);
}
