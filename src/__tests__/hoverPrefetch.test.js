/**
 * IMPORTANT: createHoverPrefetcher() replicates the handleRowHover algorithm
 * from ResultsTable.jsx lines 453-497 (verified 2026-03-29).
 *
 * TODO(TD-1): Extract hover prefetch logic from ResultsTable.jsx into its
 * own module, then replace this replication with a direct import.
 * Tracked in deferred plan: .claude/plans/snappy-marinating-walrus.md
 *
 * If that logic changes, update this copy to match until extraction happens.
 *
 * Intentionally excluded from replica: hasClobSlotAvailable() and acquireClobSlot()
 * concurrency gating. Those are tested independently in clobConcurrency.test.js.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchOrderBook, fetchPriceHistory } from '../api';
import { isClobRateLimited, triggerClobRateLimit } from '../clobRateLimit';
import { HOVER_DEBOUNCE_DELAY, PREFETCH_CACHE_TTL, PREFETCH_LRU_CAP } from '../uiConfig';

vi.mock('../api', () => ({
  fetchOrderBook: vi.fn(),
  fetchPriceHistory: vi.fn(),
}));

vi.mock('../clobRateLimit', () => ({
  isClobRateLimited: vi.fn(() => false),
  triggerClobRateLimit: vi.fn(),
}));

/**
 * Standalone replication of ResultsTable handleRowHover algorithm.
 * Tests the pattern without React rendering.
 *
 * Source: ResultsTable.jsx lines 453-497
 */
function createHoverPrefetcher(spreadCache = {}) {
  const cache = new Map(); // prefetchCache
  let controller = null;   // prefetchController

  function hover(marketId, market) {
    const cached = cache.get(marketId);
    if (cached && Date.now() - cached.timestamp < PREFETCH_CACHE_TTL) return;

    if (controller) controller.abort();

    // LRU eviction
    if (cache.size >= PREFETCH_LRU_CAP) {
      let oldestKey = null, oldestTime = Infinity;
      for (const [key, val] of cache) {
        if (val.timestamp < oldestTime) { oldestTime = val.timestamp; oldestKey = key; }
      }
      if (oldestKey) cache.delete(oldestKey);
    }

    controller = new AbortController();
    const signal = controller.signal;

    const timer = setTimeout(async () => {
      if (signal.aborted) return;
      if (isClobRateLimited()) return;
      const yesTokenId = market.clobTokenIds?.[0];
      if (!yesTokenId) return;

      // Skip order book fetch if spread effect already cached it
      const hasSpread = spreadCache[marketId] != null;

      try {
        const [bookData, priceHistory] = await Promise.all([
          hasSpread
            ? Promise.resolve(null)
            : fetchOrderBook(yesTokenId).catch((err) => {
                if (err?.status === 429 || err?.status === 403) triggerClobRateLimit(err.status);
                return null;
              }),
          fetchPriceHistory(yesTokenId, '1d', null, null, null, signal).catch((err) => {
            if (err?.status === 429 || err?.status === 403) triggerClobRateLimit(err.status);
            return null;
          }),
        ]);
        if (!signal.aborted) {
          cache.set(marketId, { bookData, priceHistory, timestamp: Date.now() });
        }
      } catch (e) { /* ignore */ }
    }, HOVER_DEBOUNCE_DELAY);

    signal.addEventListener('abort', () => clearTimeout(timer));
  }

  function hoverEnd() {
    if (controller) { controller.abort(); controller = null; }
  }

  return { hover, hoverEnd, cache };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  fetchOrderBook.mockResolvedValue({ bids: [], asks: [] });
  fetchPriceHistory.mockResolvedValue({ history: [] });
});

afterEach(() => { vi.useRealTimers(); });

// ── Hover prefetch tests ───────────────────────────────────────────

describe('hover prefetch', () => {
  it('HOVER_DEBOUNCE_DELAY before any fetch fires', async () => {
    const { hover } = createHoverPrefetcher();
    hover('m1', { clobTokenIds: ['tok1'] });
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY - 1);
    expect(fetchOrderBook).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchOrderBook).toHaveBeenCalledTimes(1);
  });

  it('hoverEnd cancels pending fetch even after full debounce advance', async () => {
    const { hover, hoverEnd } = createHoverPrefetcher();
    hover('m1', { clobTokenIds: ['tok1'] });
    hoverEnd();
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY + 100);
    expect(fetchOrderBook).not.toHaveBeenCalled();
  });

  it('moving to new row within debounce window aborts previous', async () => {
    const { hover } = createHoverPrefetcher();
    hover('m1', { clobTokenIds: ['tok1'] });
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY / 2);
    hover('m2', { clobTokenIds: ['tok2'] });
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY);
    expect(fetchOrderBook).toHaveBeenCalledTimes(1);
    expect(fetchOrderBook).toHaveBeenCalledWith('tok2');
  });

  it('rapid 10-row scan generates 0 completed fetches until settling', async () => {
    const { hover } = createHoverPrefetcher();
    for (let i = 0; i < 10; i++) {
      hover(`m${i}`, { clobTokenIds: [`tok${i}`] });
      await vi.advanceTimersByTimeAsync(100); // 100ms < HOVER_DEBOUNCE_DELAY
    }
    expect(fetchOrderBook).not.toHaveBeenCalled();
    // After settling on last row
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY);
    expect(fetchOrderBook).toHaveBeenCalledTimes(1);
    expect(fetchOrderBook).toHaveBeenCalledWith('tok9');
  });

  it('settling past debounce triggers exactly 2 requests (orderBook + priceHistory)', async () => {
    const { hover } = createHoverPrefetcher();
    hover('m1', { clobTokenIds: ['tok1'] });
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY);
    expect(fetchOrderBook).toHaveBeenCalledTimes(1);
    expect(fetchPriceHistory).toHaveBeenCalledTimes(1);
  });

  it('cache hit within PREFETCH_CACHE_TTL skips fetch entirely', async () => {
    const { hover, cache } = createHoverPrefetcher();
    cache.set('m1', { bookData: {}, priceHistory: {}, timestamp: Date.now() });
    hover('m1', { clobTokenIds: ['tok1'] });
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchOrderBook).not.toHaveBeenCalled();
  });

  it(`cache evicts oldest at ${PREFETCH_LRU_CAP}-entry cap`, () => {
    const { hover, cache } = createHoverPrefetcher();
    for (let i = 0; i < PREFETCH_LRU_CAP; i++) {
      cache.set(`old-${i}`, { timestamp: Date.now() - (PREFETCH_LRU_CAP - i) * 1000 });
    }
    expect(cache.size).toBe(PREFETCH_LRU_CAP);
    // Hover on a new market triggers eviction before adding controller
    hover('new-market', { clobTokenIds: ['tok-new'] });
    expect(cache.has('old-0')).toBe(false); // oldest evicted
    expect(cache.size).toBe(PREFETCH_LRU_CAP - 1); // evicted 1, new entry added async after fetch
  });

  it('cache miss after TTL expiry re-fetches', async () => {
    const { hover, cache } = createHoverPrefetcher();
    cache.set('m1', { timestamp: Date.now() - PREFETCH_CACHE_TTL - 1000 }); // expired
    hover('m1', { clobTokenIds: ['tok1'] });
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY);
    expect(fetchOrderBook).toHaveBeenCalledTimes(1);
  });

  it('prefetch stores result only in its own cache, not external state', async () => {
    const { hover, cache } = createHoverPrefetcher();
    hover('m1', { clobTokenIds: ['tok1'] });
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY);
    // Only the internal prefetch cache has the data
    expect(cache.has('m1')).toBe(true);
    expect(cache.get('m1').bookData).toEqual({ bids: [], asks: [] });
  });

  it('skips order book fetch when spread cache already has data', async () => {
    // Spread effect already cached market m1's spread
    const { hover } = createHoverPrefetcher({ m1: 0.02 });
    hover('m1', { clobTokenIds: ['tok1'] });
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY);
    // Order book skipped, only price history fetched
    expect(fetchOrderBook).not.toHaveBeenCalled();
    expect(fetchPriceHistory).toHaveBeenCalledTimes(1);
  });

  it('fetches order book when spread cache has no entry', async () => {
    const { hover } = createHoverPrefetcher({}); // empty spread cache
    hover('m1', { clobTokenIds: ['tok1'] });
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY);
    expect(fetchOrderBook).toHaveBeenCalledTimes(1);
    expect(fetchPriceHistory).toHaveBeenCalledTimes(1);
  });

  it('429 from prefetch triggers triggerClobRateLimit', async () => {
    const err = new Error('Rate limited');
    err.status = 429;
    fetchOrderBook.mockRejectedValue(err);
    const { hover } = createHoverPrefetcher();
    hover('m1', { clobTokenIds: ['tok1'] });
    await vi.advanceTimersByTimeAsync(HOVER_DEBOUNCE_DELAY);
    expect(triggerClobRateLimit).toHaveBeenCalledWith(429);
  });
});
