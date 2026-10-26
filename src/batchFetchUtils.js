/**
 * Shared batch fetch utilities for background fetching: order books (CLOB)
 * and trade flow (Data API, with its own rate-limit pause).
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
import { isDataApiRateLimited } from './dataApi';
import { CACHE_TTL_5M } from './engineConfig';
import { SPREAD_FETCH_DELAY, FLOW_FETCH_DELAY } from './uiConfig';

// ── "Nothing there" memory ───────────────────────────────────────
// A fetch that succeeds but finds nothing to show (a one-sided order book,
// a market with no trades in 24h) used to leave the market "missing", so it
// was refetched on every pass — and, being first in the visible list, it took
// the gap filler's few slots every 5s, so rows after it were never filled.
// Such markets are now skipped for a while. Failures are NOT remembered.
//   - Books: 60s. Real spreads, once found, are kept without expiry, so this
//     is fresher than the cache's normal policy.
//   - Trades: 5 min, the same lifetime as cached flow analyses.
const EMPTY_BOOK_TTL = 60_000;
const EMPTY_FLOW_TTL = CACHE_TTL_5M;
const emptyBooks = new Map(); // marketId → expiry ms
const emptyFlows = new Map();

function markEmpty(map, id, ttl) { map.set(id, Date.now() + ttl); }
function isRecentlyEmpty(map, id) {
  const until = map.get(id);
  if (until == null) return false;
  if (Date.now() < until) return true;
  map.delete(id);
  return false;
}

/** Whether a market still needs its order-book spread fetched. */
export function needsSpread(market, spreadHas) {
  return Boolean(market.clobTokenIds?.[0]) && !spreadHas(market.id) && !isRecentlyEmpty(emptyBooks, market.id);
}

/** Whether a market still needs its trade flow fetched. */
export function needsFlow(market) {
  return Boolean(market.conditionId) && !peekCachedTradeFlow(market.id) && !isRecentlyEmpty(emptyFlows, market.id);
}

/** Forget remembered empty results (tests). */
export function resetEmptyResults() {
  emptyBooks.clear();
  emptyFlows.clear();
}

// Trade flow comes from the Data API, not the CLOB: it waits on the Data
// API's own pause, takes no CLOB concurrency slot, and a 429/403 stops the
// batch (dataApiGet has already started the Data API pause) without
// tripping the CLOB breaker.
const isDataApiLimitError = (err) => err?.status === 429 || err?.status === 403;

async function fetchFlowTrades(market) {
  const trades = await fetchMarketTrades(market.conditionId);
  if (trades && trades.length === 0) markEmpty(emptyFlows, market.id, EMPTY_FLOW_TTL);
  // A cut-short window (a later page failed) would be cached for 5 min as the
  // market's 24h flow: treat it as a failure and retry on a later pass
  return trades && trades.length > 0 && !trades.incomplete ? trades : null;
}

function storeSpread(cache, market, book) {
  const spread = calculateSpread(book);
  if (spread) { cache.set(market.id, spread.absoluteSpread); return true; }
  markEmpty(emptyBooks, market.id, EMPTY_BOOK_TTL); // one-sided or empty book
  return false;
}

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
    .filter((m) => needsSpread(m, (id) => cache.has(id)))
    .slice(0, maxItems);

  if (toFetch.length === 0 || isRL()) return { fetched: 0 };

  return runBatchSequential(toFetch, {
    fetchOne: (market) => fetchOrderBook(market.clobTokenIds[0]),
    processOne: (market, data) => storeSpread(cache, market, data),
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
 * @param {function} [opts.isRateLimited] — default: the Data API pause
 * @param {function} [opts.onError]       — default: stop on a Data API 429/403
 *   (no CLOB slot is taken: opts.acquireSlot is ignored)
 * @param {number}   [opts.maxItems=10]
 * @returns {{ fetched: number }}
 */
export async function runFlowBatch(markets, opts = {}) {
  const {
    cache, signal, cancelled,
    isRateLimited: isRL = isDataApiRateLimited, onError = isDataApiLimitError, maxItems = 10,
  } = opts;
  // (opts.acquireSlot is ignored: CLOB slots aren't for Data API requests)

  const toFetch = markets
    .filter((m) => needsFlow(m) && !cache.has(m.id))
    .slice(0, maxItems);

  if (toFetch.length === 0 || isRL()) return { fetched: 0 };

  const lbIndex = getLeaderboardIndex();
  return runBatchSequential(toFetch, {
    fetchOne: fetchFlowTrades,
    processOne: (market, trades) => {
      const analysis = analyzeTradeFlow(trades, null, lbIndex, market, null);
      setCachedTradeFlow(market.id, analysis);
      cache.set(market.id, analysis);
    },
    signal,
    cancelled,
    delayMs: FLOW_FETCH_DELAY,
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
 * @param {function} [opts.acquireSlot]   — spread half only (CLOB slot)
 * @param {function} [opts.isRateLimited] — spread half only (default: CLOB breaker)
 * @param {function} [opts.isFlowRateLimited] — flow half (default: the Data API pause)
 * @param {function} [opts.onError]       — spread half only (flow stops on a Data API 429/403)
 * @param {function} [opts.cancelled] — () => boolean
 * @returns {{ spreadFetched: number, flowFetched: number }}
 */
export async function runGapFill(markets, opts = {}) {
  const {
    spreadCache, flowCache, acquireSlot,
    isRateLimited: isRL = isClobRateLimited,
    isFlowRateLimited = isDataApiRateLimited,
    onError = handleClobError,
    cancelled = () => false,
  } = opts;

  // Each half is gated by its own API's rate limit: a CLOB pause no longer
  // stops trade flow, and a Data API pause no longer stops spreads.
  const spreadMissing = isRL() ? [] : markets
    .filter((m) => needsSpread(m, (id) => spreadCache.has(id)))
    .slice(0, 3);
  const flowMissing = isFlowRateLimited() ? [] : markets
    .filter((m) => needsFlow(m) && !flowCache.has(m.id))
    .slice(0, 2);

  if (spreadMissing.length === 0 && flowMissing.length === 0) {
    return { spreadFetched: 0, flowFetched: 0 };
  }

  // Spread gap fill (no delay) — CLOB
  const spreadResult = await runBatchSequential(spreadMissing, {
    fetchOne: (market) => fetchOrderBook(market.clobTokenIds[0]),
    processOne: (market, data) => storeSpread(spreadCache, market, data),
    cancelled,
    acquireSlot,
    isRateLimited: isRL,
    onError,
  });

  // Flow gap fill (no delay) — Data API: no CLOB slot, no CLOB breaker
  let flowResult = { fetched: 0 };
  if (!cancelled()) {
    const lbIndex = getLeaderboardIndex();
    flowResult = await runBatchSequential(flowMissing, {
      fetchOne: fetchFlowTrades,
      processOne: (market, trades) => {
        const analysis = analyzeTradeFlow(trades, null, lbIndex, market, null);
        setCachedTradeFlow(market.id, analysis);
        flowCache.set(market.id, analysis);
      },
      cancelled,
      isRateLimited: isFlowRateLimited,
      onError: isDataApiLimitError,
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
