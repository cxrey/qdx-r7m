/**
 * Hover-to-prefetch utility.
 * Extracted from ResultsTable.jsx to eliminate test replica drift.
 */

import { fetchOrderBook, fetchPriceHistory } from './api';
import { isClobRateLimited } from './clobRateLimit';
import { handleClobError } from './clobErrorHandler';
import { HOVER_DEBOUNCE_DELAY, PREFETCH_CACHE_TTL, PREFETCH_LRU_CAP } from './uiConfig';

/**
 * Create a hover prefetcher with debounce, LRU cache, and abort support.
 *
 * @param {object} opts
 * @param {{ has: function }} [opts.spreadCache] - spread cache adapter with has(id)
 * @param {function} [opts.acquireSlot]      - async (signal) => release fn (concurrency gating)
 * @param {function} [opts.hasSlotAvailable] - () => boolean (non-blocking slot check)
 * @param {function} [opts.isRateLimited]    - () => boolean
 * @param {function} [opts.onError]          - (err) => void (error handler for fetch failures)
 * @returns {{ hover: function, hoverEnd: function, cache: Map }}
 */
export function createHoverPrefetcher(opts = {}) {
  const {
    spreadCache = { has: () => false },
    acquireSlot,
    hasSlotAvailable,
    isRateLimited = isClobRateLimited,
    onError = handleClobError,
  } = opts;

  const cache = new Map();
  let controller = null;

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
      if (isRateLimited()) return;
      // Non-blocking check: skip prefetch entirely if all slots are busy.
      // acquireSlot below would block-wait; prefetch shouldn't queue up.
      if (hasSlotAvailable && !hasSlotAvailable()) return;
      const yesTokenId = market.clobTokenIds?.[0];
      if (!yesTokenId) return;

      // Skip order book fetch if spread effect already cached it
      const hasSpread = spreadCache.has(marketId);

      let release;
      try {
        if (acquireSlot) {
          release = await acquireSlot(signal);
          if (signal.aborted) return;
        }

        const [bookData, priceHistory] = await Promise.all([
          hasSpread
            ? Promise.resolve(null)  // skip — already cached by spread effect
            : fetchOrderBook(yesTokenId).catch((err) => {
                onError(err);
                return null;
              }),
          fetchPriceHistory(yesTokenId, '1d', null, null, null, signal).catch((err) => {
            onError(err);
            return null;
          }),
        ]);
        if (!signal.aborted) {
          cache.set(marketId, { bookData, priceHistory, timestamp: Date.now() });
        }
      } catch (e) {
        if (e.name !== 'AbortError') console.warn('[Prefetch] Failed:', e);
      } finally {
        if (release) release();
      }
    }, HOVER_DEBOUNCE_DELAY);

    signal.addEventListener('abort', () => clearTimeout(timer));
  }

  function hoverEnd() {
    if (controller) { controller.abort(); controller = null; }
  }

  return { hover, hoverEnd, cache };
}
