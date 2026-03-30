/**
 * Shared batch fetch utilities for background CLOB data fetching.
 *
 * Extracted from ResultsTable.jsx (TD-1) to eliminate test replica drift.
 * Both production (ResultsTable) and tests import from this module.
 *
 * Three named wrappers (runSpreadBatch, runFlowBatch, runGapFill) delegate
 * to the generic runBatchSequential() core. Each wrapper encodes its
 * batch-specific constants (chunk size, delay, filter, fetcher, processor).
 */

import { fetchOrderBook } from './api';
import { calculateSpread } from './SpreadFrictionEngine';
import {
  fetchMarketTrades, analyzeTradeFlow, getLeaderboardIndex,
  peekCachedTradeFlow, setCachedTradeFlow,
} from './TradeFlowEngine';
import { isClobRateLimited } from './clobRateLimit';
import { handleClobError } from './clobErrorHandler';
import { SPREAD_FETCH_DELAY, FLOW_FETCH_DELAY } from './uiConfig';

// ── Generic batch loop ───────────────────────────────────────────

/**
 * Sequential batch fetch with abort, rate-limit, concurrency slot, and delay support.
 *
 * @param {object[]} items — pre-filtered, pre-sliced batch of items to fetch
 * @param {object} config
 * @param {function} config.fetchOne       — async (item) => data | null
 * @param {function} config.processOne     — (item, data) => boolean — called when data is truthy; return true to count as fetched
 * @param {AbortSignal} [config.signal]    — abort signal
 * @param {function} [config.cancelled]    — () => boolean, checked between steps
 * @param {number}   [config.delayMs=0]    — inter-request delay in ms
 * @param {function} [config.acquireSlot]  — async (signal) => release fn
 * @param {function} [config.isRateLimited] — () => boolean
 * @param {function} [config.onError]      — (err) => boolean (true = break loop)
 * @param {string}   [config.warnPrefix]   — prefix for console.warn on non-rate-limit errors
 * @returns {{ fetched: number }}
 */
export async function runBatchSequential(items, config) {
  const {
    fetchOne, processOne, signal,
    cancelled = () => false,
    delayMs = 0,
    acquireSlot,
    isRateLimited = isClobRateLimited,
    onError = handleClobError,
    warnPrefix,
  } = config;

  let fetched = 0;
  for (const item of items) {
    if (cancelled() || signal?.aborted || isRateLimited()) break;
    let release;
    try {
      if (acquireSlot) {
        release = await acquireSlot(signal);
        if (cancelled() || signal?.aborted) break;
      }
      const data = await fetchOne(item);
      if (cancelled() || signal?.aborted) break;
      if (data) {
        const ok = processOne(item, data);
        if (ok !== false) fetched++; // undefined/true → count; explicit false → skip
      }
    } catch (err) {
      if (err.name === 'AbortError') break;
      if (onError(err)) break;
      if (warnPrefix) console.warn(warnPrefix, err);
    } finally {
      if (release) release();
    }
    if (delayMs > 0 && !cancelled() && !signal?.aborted) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return { fetched };
}

// ── Spread batch ─────────────────────────────────────────────────

/**
 * Fetch order books for uncached markets and extract spread data.
 *
 * @param {object[]} markets — visible markets to consider
 * @param {object} opts
 * @param {{ has: function, set: function }} opts.cache — spread cache adapter
 * @param {AbortSignal} [opts.signal]
 * @param {function} [opts.cancelled]     — () => boolean
 * @param {function} [opts.acquireSlot]   — async (signal) => release fn
 * @param {function} [opts.isRateLimited]
 * @param {function} [opts.onError]
 * @param {number}   [opts.maxItems=25]
 * @returns {{ fetched: number }}
 */
export async function runSpreadBatch(markets, opts = {}) {
  const {
    cache, signal, cancelled, acquireSlot,
    isRateLimited: isRL = isClobRateLimited, onError, maxItems = 25,
  } = opts;

  const toFetch = markets
    .filter((m) => m.clobTokenIds?.[0] && !cache.has(m.id))
    .slice(0, maxItems);

  if (toFetch.length === 0 || isRL()) return { fetched: 0 };

  return runBatchSequential(toFetch, {
    fetchOne: (market) => fetchOrderBook(market.clobTokenIds[0]),
    processOne: (market, data) => {
      const spread = calculateSpread(data);
      if (spread) { cache.set(market.id, spread.absoluteSpread); return true; }
      return false;
    },
    signal,
    cancelled,
    delayMs: SPREAD_FETCH_DELAY,
    acquireSlot,
    isRateLimited: isRL,
    onError,
    warnPrefix: '[batchFetch] Order book fetch failed:',
  });
}

// ── Flow batch ───────────────────────────────────────────────────

/**
 * Fetch trade flow data for uncached markets.
 *
 * @param {object[]} markets — visible markets to consider
 * @param {object} opts
 * @param {{ has: function, set: function }} opts.cache — flow cache adapter
 * @param {AbortSignal} [opts.signal]
 * @param {function} [opts.cancelled]
 * @param {function} [opts.acquireSlot]
 * @param {function} [opts.isRateLimited]
 * @param {function} [opts.onError]
 * @param {number}   [opts.maxItems=10]
 * @returns {{ fetched: number }}
 */
export async function runFlowBatch(markets, opts = {}) {
  const {
    cache, signal, cancelled, acquireSlot,
    isRateLimited: isRL = isClobRateLimited, onError, maxItems = 10,
  } = opts;

  const toFetch = markets
    .filter((m) => m.conditionId && !cache.has(m.id) && !peekCachedTradeFlow(m.id))
    .slice(0, maxItems);

  if (toFetch.length === 0 || isRL()) return { fetched: 0 };

  const lbIndex = getLeaderboardIndex();
  return runBatchSequential(toFetch, {
    fetchOne: async (market) => {
      const trades = await fetchMarketTrades(market.conditionId);
      return (trades && trades.length > 0) ? trades : null;
    },
    processOne: (market, trades) => {
      const analysis = analyzeTradeFlow(trades, null, lbIndex, market, null);
      setCachedTradeFlow(market.id, analysis);
      cache.set(market.id, analysis);
    },
    signal,
    cancelled,
    delayMs: FLOW_FETCH_DELAY,
    acquireSlot,
    isRateLimited: isRL,
    onError,
    warnPrefix: '[batchFetch] Trade flow fetch failed:',
  });
}

// ── Gap filler ───────────────────────────────────────────────────

/**
 * Fill gaps for visible markets missing spread or flow data.
 * No inter-request delay. No abort signal. Max 3 spread + 2 flow.
 *
 * @param {object[]} markets — visible markets
 * @param {object} opts
 * @param {{ has: function, set: function }} opts.spreadCache
 * @param {{ has: function, set: function }} opts.flowCache
 * @param {function} [opts.acquireSlot]
 * @param {function} [opts.isRateLimited]
 * @param {function} [opts.onError]
 * @param {function} [opts.cancelled] — () => boolean
 * @returns {{ spreadFetched: number, flowFetched: number }}
 */
export async function runGapFill(markets, opts = {}) {
  const {
    spreadCache, flowCache, acquireSlot,
    isRateLimited: isRL = isClobRateLimited,
    onError = handleClobError,
    cancelled = () => false,
  } = opts;

  if (isRL()) return { spreadFetched: 0, flowFetched: 0 };

  const spreadMissing = markets
    .filter((m) => m.clobTokenIds?.[0] && !spreadCache.has(m.id))
    .slice(0, 3);
  const flowMissing = markets
    .filter((m) => m.conditionId && !flowCache.has(m.id) && !peekCachedTradeFlow(m.id))
    .slice(0, 2);

  if (spreadMissing.length === 0 && flowMissing.length === 0) {
    return { spreadFetched: 0, flowFetched: 0 };
  }

  // Spread gap fill (no delay)
  const spreadResult = await runBatchSequential(spreadMissing, {
    fetchOne: (market) => fetchOrderBook(market.clobTokenIds[0]),
    processOne: (market, data) => {
      const spread = calculateSpread(data);
      if (spread) { spreadCache.set(market.id, spread.absoluteSpread); return true; }
      return false;
    },
    cancelled,
    acquireSlot,
    isRateLimited: isRL,
    onError,
  });

  // Flow gap fill (no delay)
  let flowResult = { fetched: 0 };
  if (!cancelled()) {
    const lbIndex = getLeaderboardIndex();
    flowResult = await runBatchSequential(flowMissing, {
      fetchOne: async (market) => {
        const trades = await fetchMarketTrades(market.conditionId);
        return (trades && trades.length > 0) ? trades : null;
      },
      processOne: (market, trades) => {
        const analysis = analyzeTradeFlow(trades, null, lbIndex, market, null);
        setCachedTradeFlow(market.id, analysis);
        flowCache.set(market.id, analysis);
      },
      cancelled,
      acquireSlot,
      isRateLimited: isRL,
      onError,
    });
  }

  return { spreadFetched: spreadResult.fetched, flowFetched: flowResult.fetched };
}

// ── Test helper ──────────────────────────────────────────────────

/**
 * Wrap a plain object as a cache adapter for testing.
 * `has` uses `!= null` so that `0` (valid spread) is treated as cached.
 */
export function makePlainObjectCache(obj) {
  return {
    has: (id) => obj[id] != null,
    set: (id, v) => { obj[id] = v; },
  };
}
