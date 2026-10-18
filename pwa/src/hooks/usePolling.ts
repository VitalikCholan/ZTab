import { useEffect, useRef } from 'react';

/**
 * Calls `fn` at once when `enabled`, then every `intervalMs`. A tick is skipped while the
 * previous call is still pending. A changed `intervalMs` applies from the next tick.
 */
export function usePolling(fn: () => Promise<unknown>, intervalMs: number, enabled: boolean): void {
  const fnRef = useRef(fn);
  const msRef = useRef(intervalMs);
  fnRef.current = fn;
  msRef.current = intervalMs;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async () => {
      if (!pending) {
        pending = true;
        try {
          await fnRef.current();
        } catch {
          // fn reports its own failures; the loop must survive them.
        } finally {
          pending = false;
        }
      }
    };
    const tick = () => {
      if (cancelled) return;
      void run();
      timer = setTimeout(tick, msRef.current);
    };
    void run();
    timer = setTimeout(tick, msRef.current);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled]);
}
