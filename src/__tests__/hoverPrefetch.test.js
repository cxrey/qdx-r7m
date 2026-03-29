/**
 * IMPORTANT: createHoverPrefetcher() replicates the handleRowHover algorithm
 * from ResultsTable.jsx lines 453-497 (verified 2026-03-29).
 *
 * TODO(TD-1): Extract hover prefetch logic from ResultsTable.jsx into its
 * own module, then replace this replication with a direct import.
 * Tracked in deferred plan: .claude/plans/snappy-marinating-walrus.md
 *
 * If that logic changes, update this copy to match until extraction happens.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchOrderBook, fetchPriceHistory } from '../api';
import { isClobRateLimited, triggerClobRateLimit } from '../clobRateLimit';

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
function createHoverPrefetcher() {
  const cache = new Map(); // prefetchCache
  let controller = null;   // prefetchController

  function hover(marketId, market) {
    const cached = cache.get(marketId);
    if (cached && Date.now() - cached.timestamp < 30000) return;

    if (controller) controller.abort();

    // LRU eviction
    if (cache.size >= 20) {
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
      try {
        const [bookData, priceHistory] = await Promise.all([
          fetchOrderBook(yesTokenId).catch((err) => {
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
    }, 150);

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
  it('150ms delay before any fetch fires', async () => {
    const { hover } = createHoverPrefetcher();
    hover('m1', { clobTokenIds: ['tok1'] });
    await vi.advanceTimersByTimeAsync(149);
    expect(fetchOrderBook).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchOrderBook).toHaveBeenCalledTimes(1);
  });

  it('hoverEnd cancels pending fetch even after full 150ms advance', async () => {
    const { hover, hoverEnd } = createHoverPrefetcher();
    hover('m1', { clobTokenIds: ['tok1'] });
    hoverEnd();
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchOrderBook).not.toHaveBeenCalled();
  });

  it('moving to new row within 150ms aborts previous', async () => {
    const { hover } = createHoverPrefetcher();
    hover('m1', { clobTokenIds: ['tok1'] });
    await vi.advanceTimersByTimeAsync(100);
    hover('m2', { clobTokenIds: ['tok2'] });
    await vi.advanceTimersByTimeAsync(150);
    expect(fetchOrderBook).toHaveBeenCalledTimes(1);
    expect(fetchOrderBook).toHaveBeenCalledWith('tok2');
  });

  it('rapid 10-row scan generates 0 completed fetches until settling', async () => {
    const { hover } = createHoverPrefetcher();
    for (let i = 0; i < 10; i++) {
      hover(`m${i}`, { clobTokenIds: [`tok${i}`] });
      await vi.advanceTimersByTimeAsync(50); // 50ms < 150ms debounce
    }
    expect(fetchOrderBook).not.toHaveBeenCalled();
    // After settling 150ms on last row
    await vi.advanceTimersByTimeAsync(150);
    expect(fetchOrderBook).toHaveBeenCalledTimes(1);
    expect(fetchOrderBook).toHaveBeenCalledWith('tok9');
  });

  it('settling >150ms triggers exactly 2 requests (orderBook + priceHistory)', async () => {
    const { hover } = createHoverPrefetcher();
    hover('m1', { clobTokenIds: ['tok1'] });
    await vi.advanceTimersByTimeAsync(150);
    expect(fetchOrderBook).toHaveBeenCalledTimes(1);
    expect(fetchPriceHistory).toHaveBeenCalledTimes(1);
  });

  it('cache hit within 30s TTL skips fetch entirely', async () => {
    const { hover, cache } = createHoverPrefetcher();
    cache.set('m1', { bookData: {}, priceHistory: {}, timestamp: Date.now() });
    hover('m1', { clobTokenIds: ['tok1'] });
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchOrderBook).not.toHaveBeenCalled();
  });

  it('cache evicts oldest at 20-entry cap', () => {
    const { hover, cache } = createHoverPrefetcher();
    // Fill cache with 20 entries, timestamps 1000ms apart
    for (let i = 0; i < 20; i++) {
      cache.set(`old-${i}`, { timestamp: Date.now() - (20 - i) * 1000 });
    }
    expect(cache.size).toBe(20);
    // Hover on a new market triggers eviction before adding controller
    hover('new-market', { clobTokenIds: ['tok-new'] });
    expect(cache.has('old-0')).toBe(false); // oldest evicted
    expect(cache.size).toBe(19); // evicted 1, new entry added async after fetch
  });

  it('cache miss after 30s TTL re-fetches', async () => {
    const { hover, cache } = createHoverPrefetcher();
    cache.set('m1', { timestamp: Date.now() - 31000 }); // 31s ago — expired
    hover('m1', { clobTokenIds: ['tok1'] });
    await vi.advanceTimersByTimeAsync(150);
    expect(fetchOrderBook).toHaveBeenCalledTimes(1);
  });

  it('prefetch stores result only in its own cache, not external state', async () => {
    const { hover, cache } = createHoverPrefetcher();
    hover('m1', { clobTokenIds: ['tok1'] });
    await vi.advanceTimersByTimeAsync(150);
    // Only the internal prefetch cache has the data
    expect(cache.has('m1')).toBe(true);
    expect(cache.get('m1').bookData).toEqual({ bids: [], asks: [] });
  });

  it('prefetch and spread batch can fetch same tokenId independently', async () => {
    const { hover } = createHoverPrefetcher();
    // Simulate spread batch calling fetchOrderBook for same token
    await fetchOrderBook('tok1'); // spread batch call
    fetchOrderBook.mockClear();
    // Hover prefetch also calls it — no dedup with spread cache
    hover('m1', { clobTokenIds: ['tok1'] });
    await vi.advanceTimersByTimeAsync(150);
    expect(fetchOrderBook).toHaveBeenCalledWith('tok1');
  });

  it('429 from prefetch triggers triggerClobRateLimit', async () => {
    const err = new Error('Rate limited');
    err.status = 429;
    fetchOrderBook.mockRejectedValue(err);
    const { hover } = createHoverPrefetcher();
    hover('m1', { clobTokenIds: ['tok1'] });
    await vi.advanceTimersByTimeAsync(150);
    expect(triggerClobRateLimit).toHaveBeenCalledWith(429);
  });
});
