/**
 * Hover-to-prefetch utility.
 * Extracted from ResultsTable.jsx to eliminate test replica drift.
 *
 * Warms the detail panel's own cache (useFetchWithCache) with exactly the
 * requests the panel makes when it opens — the YES order book and the
 * default-timeframe price history — so opening a hovered row is instant.
 * (It used to fetch into a private cache nothing read.)
 */

import { fetchOrderBook } from './api';
import { isClobRateLimited } from './clobRateLimit';
import { handleClobError } from './clobErrorHandler';
import { cacheGet, cacheSet } from './hooks/useFetchWithCache';
import {
  DEFAULT_TIMEFRAME, fetchTimeframeHistory,
  priceCacheKey, bookCacheKey, PRICE_CACHE_TTL, BOOK_CACHE_TTL,
} from './detailPanelData';
import { HOVER_DEBOUNCE_DELAY } from './uiConfig';

/**
 * Create a hover prefetcher with debounce and abort support.
 *
 * @param {object} opts
 * @param {{ has: function }} [opts.spreadCache] - spread cache adapter with has(id); a row
 *   whose spread is already known skips the order-book prefetch (keeps CLOB load as it was)
 * @param {function} [opts.acquireSlot]      - async (signal) => release fn (CLOB concurrency gating)
 * @param {function} [opts.hasSlotAvailable] - () => boolean (non-blocking CLOB slot check)
 * @param {function} [opts.isRateLimited]    - () => boolean (CLOB breaker)
 * @param {function} [opts.onError]          - (err) => void, for order-book (CLOB) failures
 * @returns {{ hover: function, hoverEnd: function }}
 */
export function createHoverPrefetcher(opts = {}) {
  const {
    spreadCache = { has: () => false },
    acquireSlot,
    hasSlotAvailable,
    isRateLimited = isClobRateLimited,
    onError = handleClobError,
  } = opts;

  let controller = null;

  function hover(marketId, market) {
    const yesTokenId = market?.clobTokenIds?.[0];
    if (!yesTokenId) return;
    const bookKey = bookCacheKey(yesTokenId);
    const priceKey = priceCacheKey(yesTokenId, DEFAULT_TIMEFRAME);
    const wantBook = !spreadCache.has(marketId) && !cacheGet(bookKey);
    const wantPrice = !cacheGet(priceKey);
    if (!wantBook && !wantPrice) return; // the panel already has what it needs

    if (controller) controller.abort();
    controller = new AbortController();
    const signal = controller.signal;

    const timer = setTimeout(async () => {
      if (signal.aborted) return;
      const tasks = [];

      // Price history comes from the Data API: no CLOB slot, and its errors
      // must not open the CLOB rate-limit breaker
      if (wantPrice) {
        tasks.push(fetchTimeframeHistory(yesTokenId, DEFAULT_TIMEFRAME, signal)
          .then((data) => { if (data) cacheSet(priceKey, data, PRICE_CACHE_TTL); })
          .catch((err) => { if (err?.name !== 'AbortError') console.debug('[Prefetch] price history failed:', err?.message); }));
      }

      // Order book is a CLOB request: respect the breaker and the slot pool,
      // and skip it rather than queue if every slot is busy
      if (wantBook && !isRateLimited() && (!hasSlotAvailable || hasSlotAvailable())) {
        tasks.push((async () => {
          let release;
          try {
            if (acquireSlot) {
              release = await acquireSlot(signal);
              if (signal.aborted) return;
            }
            const data = await fetchOrderBook(yesTokenId);
            if (data) cacheSet(bookKey, data, BOOK_CACHE_TTL);
          } catch (err) {
            if (err?.name !== 'AbortError') onError(err);
          } finally {
            if (release) release();
          }
        })());
      }

      await Promise.all(tasks);
    }, HOVER_DEBOUNCE_DELAY);

    signal.addEventListener('abort', () => clearTimeout(timer));
  }

  function hoverEnd() {
    if (controller) {
      controller.abort();
      controller = null;
    }
  }

  return { hover, hoverEnd };
}
