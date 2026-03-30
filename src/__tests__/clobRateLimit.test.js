import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  isClobRateLimited,
  triggerClobRateLimit,
  clearClobRateLimit,
  onClobRateLimitChange,
  getClobRecoverySeconds,
} from '../clobRateLimit';
import { getClobConcurrencyStats, resetClobConcurrency, resetBackoff } from '../ApiHealthManager';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  clearClobRateLimit();
  resetClobConcurrency();
  resetBackoff();
});

afterEach(() => { vi.useRealTimers(); });

describe('clobRateLimit', () => {
  it('starts not rate limited', () => {
    expect(isClobRateLimited()).toBe(false);
  });

  it('triggerClobRateLimit sets rate limited flag', () => {
    triggerClobRateLimit();
    expect(isClobRateLimited()).toBe(true);
  });

  it('trigger is idempotent — double trigger does not reset timer', () => {
    const listener = vi.fn();
    onClobRateLimitChange(listener);

    triggerClobRateLimit();
    triggerClobRateLimit(); // second call should be no-op

    // listener called only once with true
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(true);
  });

  it('auto-recovers after 60 seconds', () => {
    triggerClobRateLimit();
    expect(isClobRateLimited()).toBe(true);

    vi.advanceTimersByTime(59_999);
    expect(isClobRateLimited()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(isClobRateLimited()).toBe(false);
  });

  it('clearClobRateLimit resets immediately and cancels timer', () => {
    triggerClobRateLimit();
    expect(isClobRateLimited()).toBe(true);

    clearClobRateLimit();
    expect(isClobRateLimited()).toBe(false);

    // Advancing past recovery time should NOT call listeners again
    const listener = vi.fn();
    onClobRateLimitChange(listener);
    vi.advanceTimersByTime(60_000);
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies listeners on trigger and recovery', () => {
    const listener = vi.fn();
    onClobRateLimitChange(listener);

    triggerClobRateLimit();
    expect(listener).toHaveBeenCalledWith(true);

    vi.advanceTimersByTime(60_000);
    expect(listener).toHaveBeenCalledWith(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('notifies listeners on clear', () => {
    const listener = vi.fn();
    onClobRateLimitChange(listener);

    triggerClobRateLimit();
    clearClobRateLimit();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(false);
  });

  it('unsubscribe removes listener', () => {
    const listener = vi.fn();
    const unsub = onClobRateLimitChange(listener);

    unsub();
    triggerClobRateLimit();

    expect(listener).not.toHaveBeenCalled();
  });

  it('multiple listeners all notified', () => {
    const a = vi.fn();
    const b = vi.fn();
    onClobRateLimitChange(a);
    onClobRateLimitChange(b);

    triggerClobRateLimit();

    expect(a).toHaveBeenCalledWith(true);
    expect(b).toHaveBeenCalledWith(true);
  });

  // ── 403 behavior and getClobRecoverySeconds ──

  it('403 triggers 5-minute (300s) recovery', () => {
    triggerClobRateLimit(403);
    expect(isClobRateLimited()).toBe(true);

    vi.advanceTimersByTime(299_999);
    expect(isClobRateLimited()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(isClobRateLimited()).toBe(false);
  });

  it('403 upgrades existing 429 timer', () => {
    const listener = vi.fn();
    onClobRateLimitChange(listener);

    triggerClobRateLimit(429); // 60s recovery
    vi.advanceTimersByTime(30_000); // 30s in
    expect(isClobRateLimited()).toBe(true);

    triggerClobRateLimit(403); // upgrades to 300s from now
    expect(listener).toHaveBeenCalledTimes(2); // initial 429 + 403 upgrade

    // Original 60s mark — should still be limited (403 reset the timer)
    vi.advanceTimersByTime(30_000);
    expect(isClobRateLimited()).toBe(true);

    // 300s from the 403 trigger
    vi.advanceTimersByTime(270_000);
    expect(isClobRateLimited()).toBe(false);
  });

  it('duplicate 403 resets timer and re-notifies listeners', () => {
    const listener = vi.fn();
    onClobRateLimitChange(listener);

    triggerClobRateLimit(403);
    triggerClobRateLimit(403); // resets timer, re-notifies

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledWith(true);

    // Timer was reset — full 300s from the second trigger
    vi.advanceTimersByTime(299_999);
    expect(isClobRateLimited()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isClobRateLimited()).toBe(false);
  });

  it('getClobRecoverySeconds returns 300 on 403', () => {
    triggerClobRateLimit(403);
    expect(getClobRecoverySeconds()).toBe(300);
  });

  it('getClobRecoverySeconds returns 0 after recovery', () => {
    triggerClobRateLimit();
    vi.advanceTimersByTime(60_000);
    expect(getClobRecoverySeconds()).toBe(0);
  });

  it('getClobRecoverySeconds returns 0 after clear', () => {
    triggerClobRateLimit();
    expect(getClobRecoverySeconds()).toBe(60);
    clearClobRateLimit();
    expect(getClobRecoverySeconds()).toBe(0);
  });

  // ── Concurrency limiter integration (via ApiHealthManager) ──

  it('drops concurrency to floor on trigger', () => {
    triggerClobRateLimit(429);
    const stats = getClobConcurrencyStats();
    expect(stats.maxConcurrent).toBe(stats.floor);
  });

  it('drops concurrency on 403 upgrade', () => {
    triggerClobRateLimit(429);
    triggerClobRateLimit(403);
    const stats = getClobConcurrencyStats();
    expect(stats.maxConcurrent).toBe(stats.floor);
  });

  it('duplicate 429 is idempotent — still at floor', () => {
    triggerClobRateLimit(429);
    triggerClobRateLimit(429); // duplicate — should be no-op
    const stats = getClobConcurrencyStats();
    expect(stats.maxConcurrent).toBe(stats.floor);
    // Circuit breaker stays tripped
    expect(isClobRateLimited()).toBe(true);
  });
});
