import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  handleRateLimit, getBackoffMultiplier, resetBackoff, clearClobRateLimit,
  getClobRecoverySeconds, resetClobConcurrency,
} from '../ApiHealthManager';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  clearClobRateLimit();
  resetBackoff();
  resetClobConcurrency();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const FIVE_MIN = 5 * 60 * 1000;

describe('backoff multiplier recovery', () => {
  it('halves every 5 minutes all the way back to 1x (it used to halve once and stop)', async () => {
    // Three separate rate-limit episodes → 8x
    for (let i = 0; i < 3; i++) {
      handleRateLimit(429);
      await vi.advanceTimersByTimeAsync(60_001); // breaker recovers, next 429 counts
    }
    expect(getBackoffMultiplier()).toBe(8);
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(getBackoffMultiplier()).toBe(4);
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(getBackoffMultiplier()).toBe(2);
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(getBackoffMultiplier()).toBe(1);
    await vi.advanceTimersByTimeAsync(FIVE_MIN);
    expect(getBackoffMultiplier()).toBe(1);
  });
});

describe('circuit breaker recovery time', () => {
  it('a duplicate 429 during a 403 lockout keeps the 5-minute recovery time', () => {
    handleRateLimit(403);
    expect(getClobRecoverySeconds()).toBe(300);
    handleRateLimit(429); // duplicate while tripped — ignored
    expect(getClobRecoverySeconds()).toBe(300);
  });

  it('a 403 during a 429 window still upgrades to 5 minutes', () => {
    handleRateLimit(429);
    expect(getClobRecoverySeconds()).toBe(60);
    handleRateLimit(403);
    expect(getClobRecoverySeconds()).toBe(300);
  });
});
