'use client';

import { useEffect, useState } from 'react';

type Clock = {
  /** Current time in ms, or null before mount. */
  now: number | null;
  /** When this view mounted (stands in for the last data sync until the API exists). */
  startedAt: number | null;
};

/**
 * Ticks every `intervalMs`. Null until mounted, so server and first client render
 * match and no clock is read during prerender (Cache Components).
 */
export function useClock(intervalMs = 1000): Clock {
  const [clock, setClock] = useState<Clock>({ now: null, startedAt: null });

  useEffect(() => {
    const tick = () =>
      setClock((prev) => {
        const t = Date.now();
        return { now: t, startedAt: prev.startedAt ?? t };
      });
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return clock;
}
