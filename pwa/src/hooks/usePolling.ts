import { useEffect, useRef } from 'react';

/**
 * Calls `fn` at once when `enabled`, then `intervalMs` after each call settles (never overlapping).
 * A changed `intervalMs` applies from the next wait; if `fn` resolves to a number, that is the next
 * wait instead (back-off).
 */
export function usePolling(fn: () => Promise<number | void>, intervalMs: number, enabled: boolean): void {
  const fnRef = useRef(fn);
  const msRef = useRef(intervalMs);
  fnRef.current = fn;
  msRef.current = intervalMs;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // The next tick is scheduled when the current call settles, so a slow call never overlaps
    // itself and an interval (or a failure-driven back-off) set meanwhile applies to the next wait.
    const loop = async () => {
      let wait = msRef.current;
      try {
        const next = await fnRef.current();
        if (typeof next === 'number') wait = next;
      } catch {
        // fn reports its own failures; the loop must survive them.
      }
      if (!cancelled) timer = setTimeout(() => void loop(), wait);
    };
    void loop();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled]);
}
