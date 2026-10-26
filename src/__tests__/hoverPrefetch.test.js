/**
 * Tests for the hover prefetch utility (hoverPrefetchUtils.js).
 * Uses the real createHoverPrefetcher factory — no replica needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchOrderBook, fetchPriceHistory } from '../api';
import { triggerClobRateLimit } from '../clobRateLimit';
import { HOVER_DEBOUNCE_DELAY } from '../uiConfig';
import { createHoverPrefetcher } from '../hoverPrefetchUtils';
import { cacheGet, cacheSet } from '../hooks/useFetchWithCache';
import { DEFAULT_TIMEFRAME, priceCacheKey, bookCacheKey, PRICE_CACHE_TTL, BOOK_CACHE_TTL, PREFETCHED_BOOK_TTL } from '../detailPanelData';
import { makePlainObjectCache } from '../batchFetchUtils';

vi.mock('../api', () => ({
  fetchOrderBook: vi.fn(),
  fetchPriceHistory: vi.fn(),
}));

vi.mock('../clobRateLimit', () => ({
  isClobRateLimited: vi.fn(() => false),
  triggerClobRateLimit: vi.fn(),
}));

vi.mock('../clobErrorHandler', async () => {
  const { triggerClobRateLimit: trigger } = await import('../clobRateLimit');
  return {
    handleClobError: vi.fn((err) => {
      if (err?.status === 429 || err?.status === 403) {
        trigger(err.status);
        return true;
      }
      return false;
    }),
    rateLimitMessage: vi.fn(() => 'rate limited'),
  };
});

// The panel cache is module-level; use a fresh token per test to stay isolated
let n = 0;
const tok = () => `tok-${++n}`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  fetchOrderBook.mockResolvedValue({ bids: [], asks: [] });
  fetchPriceHistory.mockResolvedValue({ history: [{ t: 1, p: 0.5 }] });
});

afterEach(() => { vi.useRealTimers(); });

describe('hover prefetch', () => {
  it('HOVER_DEBOUNCE_DELAY before any fetch fires', async () => {
    const t = tok();
    const { hover } = createHoverPrefetcher();
    hover('m1', { clobTokenIds: [t] });
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY - 1);
    expect(fetchOrderBook).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchOrderBook).toHaveBeenCalledTimes(1);
  });

  it('hoverEnd cancels pending fetch even after full debounce advance', async () => {
    const { hover, hoverEnd } = createHoverPrefetcher();
    hover('m1', { clobTokenIds: [tok()] });
    hoverEnd();
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY + 100);
    expect(fetchOrderBook).not.toHaveBeenCalled();
    expect(fetchPriceHistory).not.toHaveBeenCalled();
  });

  it('moving to new row within debounce window aborts previous', async () => {
    const t1 = tok();
    const t2 = tok();
    const { hover } = createHoverPrefetcher();
    hover('m1', { clobTokenIds: [t1] });
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY / 2);
    hover('m2', { clobTokenIds: [t2] });
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY);
    expect(fetchOrderBook).toHaveBeenCalledTimes(1);
    expect(fetchOrderBook).toHaveBeenCalledWith(t2);
  });

  it('rapid 10-row scan generates 0 completed fetches until settling', async () => {
    const { hover } = createHoverPrefetcher();
    let last;
    for (let i = 0; i < 10; i++) {
      last = tok();
      hover(`m${i}`, { clobTokenIds: [last] });
      await vi.advanceTimersByTimeAsync(100); // 100ms < HOVER_DEBOUNCE_DELAY
    }
    expect(fetchOrderBook).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY);
    expect(fetchOrderBook).toHaveBeenCalledTimes(1);
    expect(fetchOrderBook).toHaveBeenCalledWith(last);
  });

  it("warms the detail panel's own cache with exactly the panel's default requests", async () => {
    const t = tok();
    const { hover } = createHoverPrefetcher();
    hover('m1', { clobTokenIds: [t] });
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY);
    // Same request the panel makes for its default (30D) view
    expect(fetchPriceHistory).toHaveBeenCalledWith(t, DEFAULT_TIMEFRAME.interval, DEFAULT_TIMEFRAME.fidelity, null, null, expect.anything());
    // …stored under the keys the panel reads
    expect(cacheGet(bookCacheKey(t))).toEqual({ bids: [], asks: [] });
    expect(cacheGet(priceCacheKey(t, DEFAULT_TIMEFRAME))).toEqual({ history: [{ t: 1, p: 0.5 }] });
  });

  it('keeps a prefetched order book only briefly (books age fast); the history keeps its normal TTL', async () => {
    const t = tok();
    const { hover } = createHoverPrefetcher();
    hover('m1', { clobTokenIds: [t] });
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY);
    expect(cacheGet(bookCacheKey(t))).not.toBeNull();
    await vi.advanceTimersByTimeAsync(PREFETCHED_BOOK_TTL + 1);
    expect(cacheGet(bookCacheKey(t))).toBeNull();
    expect(cacheGet(priceCacheKey(t, DEFAULT_TIMEFRAME))).not.toBeNull(); // 60s TTL
  });

  it('skips what the panel cache already holds', async () => {
    const t = tok();
    cacheSet(bookCacheKey(t), { bids: [], asks: [] }, BOOK_CACHE_TTL);
    cacheSet(priceCacheKey(t, DEFAULT_TIMEFRAME), { history: [] }, PRICE_CACHE_TTL);
    const { hover } = createHoverPrefetcher();
    hover('m1', { clobTokenIds: [t] });
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY + 100);
    expect(fetchOrderBook).not.toHaveBeenCalled();
    expect(fetchPriceHistory).not.toHaveBeenCalled();
  });

  it('skips the order book (a CLOB request) when the spread is already cached, as before', async () => {
    const { hover } = createHoverPrefetcher({ spreadCache: makePlainObjectCache({ m1: 0.02 }) });
    hover('m1', { clobTokenIds: [tok()] });
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY);
    expect(fetchOrderBook).not.toHaveBeenCalled();
    expect(fetchPriceHistory).toHaveBeenCalledTimes(1);
  });

  it('a 429 on the order book opens the CLOB breaker', async () => {
    const err = Object.assign(new Error('Rate limited'), { status: 429 });
    fetchOrderBook.mockRejectedValue(err);
    const { hover } = createHoverPrefetcher();
    hover('m1', { clobTokenIds: [tok()] });
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY);
    expect(triggerClobRateLimit).toHaveBeenCalledWith(429);
  });

  it('a 429 on price history (Data API) does NOT open the CLOB breaker', async () => {
    fetchPriceHistory.mockRejectedValue(Object.assign(new Error('Rate limited'), { status: 429 }));
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { hover } = createHoverPrefetcher();
    hover('m1', { clobTokenIds: [tok()] });
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY);
    expect(triggerClobRateLimit).not.toHaveBeenCalled();
  });

  it('price history is still prefetched while the CLOB breaker is open (it is not a CLOB request)', async () => {
    const { hover } = createHoverPrefetcher({ isRateLimited: () => true });
    hover('m1', { clobTokenIds: [tok()] });
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY);
    expect(fetchOrderBook).not.toHaveBeenCalled();
    expect(fetchPriceHistory).toHaveBeenCalledTimes(1);
  });
});
