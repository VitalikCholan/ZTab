import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePolling } from '../../src/hooks/usePolling.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('usePolling', () => {
  it('calls fn immediately and then every interval', async () => {
    const fn = vi.fn(async () => {});
    renderHook(() => usePolling(fn, 1000, true));
    expect(fn).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(fn).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('stops when disabled and on unmount', async () => {
    const fn = vi.fn(async () => {});
    const { rerender, unmount } = renderHook(({ on }) => usePolling(fn, 1000, on), { initialProps: { on: true } });
    rerender({ on: false });
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(fn).toHaveBeenCalledTimes(1);
    rerender({ on: true });
    expect(fn).toHaveBeenCalledTimes(2);
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('ignores a tick while the previous call is pending', async () => {
    let release!: () => void;
    const fn = vi.fn(() => new Promise<void>((r) => (release = r)));
    renderHook(() => usePolling(fn, 1000, true));
    await act(() => vi.advanceTimersByTimeAsync(3500));
    expect(fn).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('applies a changed interval to the next wait', async () => {
    const fn = vi.fn(async () => {});
    const { rerender } = renderHook(({ ms }) => usePolling(fn, ms, true), { initialProps: { ms: 1000 } });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(fn).toHaveBeenCalledTimes(2);
    rerender({ ms: 5000 });
    await act(() => vi.advanceTimersByTimeAsync(1000)); // wait already scheduled at 1000
    expect(fn).toHaveBeenCalledTimes(3);
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(fn).toHaveBeenCalledTimes(3);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(fn).toHaveBeenCalledTimes(4);
  });
});
