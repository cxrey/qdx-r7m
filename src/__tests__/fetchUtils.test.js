import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withTimeout, TIMEOUT_DATA_API, TIMEOUT_GAMMA_PAGE } from '../fetchUtils';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('withTimeout', () => {
  it('returns an AbortSignal', () => {
    const signal = withTimeout(null, 5000);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('signal aborts after ms', () => {
    const signal = withTimeout(null, 5000);
    vi.advanceTimersByTime(5000);
    expect(signal.aborted).toBe(true);
  });

  it('signal NOT aborted before ms', () => {
    const signal = withTimeout(null, 5000);
    vi.advanceTimersByTime(4999);
    expect(signal.aborted).toBe(false);
  });

  it('aborts immediately if callerSignal already aborted', () => {
    const controller = new AbortController();
    controller.abort();
    const signal = withTimeout(controller.signal, 5000);
    expect(signal.aborted).toBe(true);
  });

  it('aborts when callerSignal aborts before timeout', () => {
    const controller = new AbortController();
    const signal = withTimeout(controller.signal, 5000);
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it('clears timeout when callerSignal aborts', () => {
    const controller = new AbortController();
    const signal = withTimeout(controller.signal, 5000);
    controller.abort(); // should clear the 5s timer
    // Advancing past timeout should not cause issues (timer was cleared)
    vi.advanceTimersByTime(10000);
    expect(signal.aborted).toBe(true); // already aborted by caller
  });

  it('abort event fires only once (no timer leak)', () => {
    const signal = withTimeout(null, 5000);
    const listener = vi.fn();
    signal.addEventListener('abort', listener);
    vi.advanceTimersByTime(5000);
    expect(listener).toHaveBeenCalledTimes(1);
    // No further abort events after advancing more time
    vi.advanceTimersByTime(10000);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('works with callerSignal = null', () => {
    const signal = withTimeout(null, 3000);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(3000);
    expect(signal.aborted).toBe(true);
  });

  it('works with callerSignal = undefined', () => {
    const signal = withTimeout(undefined, 3000);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(3000);
    expect(signal.aborted).toBe(true);
  });

  it('timeout of 0ms aborts on next tick', () => {
    const signal = withTimeout(null, 0);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(0);
    expect(signal.aborted).toBe(true);
  });

  it('two concurrent withTimeout calls do not interfere', () => {
    const sig1 = withTimeout(null, 3000);
    const sig2 = withTimeout(null, 5000);
    vi.advanceTimersByTime(3000);
    expect(sig1.aborted).toBe(true);
    expect(sig2.aborted).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(sig2.aborted).toBe(true);
  });
});

describe('constants', () => {
  it('TIMEOUT_DATA_API is 8000', () => {
    expect(TIMEOUT_DATA_API).toBe(8000);
  });

  it('TIMEOUT_GAMMA_PAGE is 10000', () => {
    expect(TIMEOUT_GAMMA_PAGE).toBe(10000);
  });
});
