/**
 * IMPORTANT: The functions below replicate algorithms from ResultsTable.jsx.
 * They are NOT imports — they are copies of the logic for isolated testing.
 *
 * TODO(TD-1): Extract useBackgroundBatchFetch hook from ResultsTable.jsx,
 * then REPLACE these replicated functions with direct imports.
 * Tracked in deferred plan: .claude/plans/snappy-marinating-walrus.md
 * Every commit that touches ResultsTable fetch logic without updating
 * these copies creates silent test drift — treat extraction as urgent.
 *
 * Until extracted, any change to the fetch algorithms in ResultsTable.jsx
 * must be mirrored here manually.
 *
 * Source locations (verified 2026-03-29):
 *   runSpreadBatch  → ResultsTable.jsx lines 267-289
 *   runFlowBatch    → ResultsTable.jsx lines 324-346
 *   runGapFill      → ResultsTable.jsx lines 387-428
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchOrderBook } from '../api';
import { calculateSpread } from '../SpreadFrictionEngine';
import {
  fetchMarketTrades, analyzeTradeFlow, getLeaderboardIndex,
  getCachedTradeFlow, setCachedTradeFlow,
} from '../TradeFlowEngine';
import { isClobRateLimited, triggerClobRateLimit } from '../clobRateLimit';
import {
  SPREAD_FETCH_DELAY, FLOW_FETCH_DELAY,
} from '../uiConfig';
import { makeMarketList, resetCounter } from './helpers/marketFixtures';

vi.mock('../api', () => ({ fetchOrderBook: vi.fn() }));
vi.mock('../SpreadFrictionEngine', () => ({ calculateSpread: vi.fn() }));
vi.mock('../TradeFlowEngine', () => ({
  fetchMarketTrades: vi.fn(),
  analyzeTradeFlow: vi.fn(() => ({ dataAvailable: true })),
  getLeaderboardIndex: vi.fn(() => new Map()),
  getCachedTradeFlow: vi.fn(() => null),
  setCachedTradeFlow: vi.fn(),
}));
vi.mock('../clobRateLimit', () => ({
  isClobRateLimited: vi.fn(() => false),
  triggerClobRateLimit: vi.fn(),
}));

// ── Replicated algorithms from ResultsTable.jsx ────────────────────

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Spread batch algorithm (ResultsTable lines 267-289)
 */
async function runSpreadBatch(markets, spreadCache, signal) {
  const toFetch = markets
    .filter((m) => m.clobTokenIds?.[0] && spreadCache[m.id] == null)
    .slice(0, 25);
  if (toFetch.length === 0 || isClobRateLimited()) return { fetched: 0 };
  let fetched = 0;
  for (const market of toFetch) {
    if (signal?.aborted || isClobRateLimited()) break;
    try {
      const data = await fetchOrderBook(market.clobTokenIds[0]);
      fetched++;
      if (data) {
        const spread = calculateSpread(data);
        if (spread) spreadCache[market.id] = spread.absoluteSpread;
      }
    } catch (err) {
      if (err?.status === 429 || err?.status === 403) {
        triggerClobRateLimit(err.status);
        break;
      }
    }
    if (!signal?.aborted) await delay(SPREAD_FETCH_DELAY);
  }
  return { fetched };
}

/**
 * Flow batch algorithm (ResultsTable lines 324-346)
 */
async function runFlowBatch(markets, flowCache, signal) {
  const toFetch = markets
    .filter((m) => m.conditionId && !flowCache[m.id] && !getCachedTradeFlow(m.id))
    .slice(0, 10);
  if (toFetch.length === 0 || isClobRateLimited()) return { fetched: 0 };
  let fetched = 0;
  const lbIndex = getLeaderboardIndex();
  for (const market of toFetch) {
    if (signal?.aborted || isClobRateLimited()) break;
    try {
      const trades = await fetchMarketTrades(market.conditionId);
      fetched++;
      if (trades && trades.length > 0) {
        const analysis = analyzeTradeFlow(trades, null, lbIndex, market, null);
        setCachedTradeFlow(market.id, analysis);
        flowCache[market.id] = analysis;
      }
    } catch (err) {
      if (err?.status === 429 || err?.status === 403) {
        triggerClobRateLimit(err.status);
        break;
      }
    }
    if (!signal?.aborted) await delay(FLOW_FETCH_DELAY);
  }
  return { fetched };
}

/**
 * Gap filler algorithm (ResultsTable lines 387-428)
 */
async function runGapFill(markets, spreadCache, flowCache) {
  if (isClobRateLimited()) return { spreadFetched: 0, flowFetched: 0 };

  const spreadMissing = markets
    .filter((m) => m.clobTokenIds?.[0] && spreadCache[m.id] == null)
    .slice(0, 3);
  const flowMissing = markets
    .filter((m) => m.conditionId && !flowCache[m.id] && !getCachedTradeFlow(m.id))
    .slice(0, 2);

  let spreadFetched = 0, flowFetched = 0;

  for (const market of spreadMissing) {
    if (isClobRateLimited()) break;
    try {
      const data = await fetchOrderBook(market.clobTokenIds[0]);
      spreadFetched++;
      if (data) {
        const spread = calculateSpread(data);
        if (spread) spreadCache[market.id] = spread.absoluteSpread;
      }
    } catch (err) {
      if (err?.status === 429 || err?.status === 403) { triggerClobRateLimit(err.status); break; }
    }
  }

  const lbIndex = getLeaderboardIndex();
  for (const market of flowMissing) {
    if (isClobRateLimited()) break;
    try {
      const trades = await fetchMarketTrades(market.conditionId);
      flowFetched++;
      if (trades && trades.length > 0) {
        const analysis = analyzeTradeFlow(trades, null, lbIndex, market, null);
        setCachedTradeFlow(market.id, analysis);
        flowCache[market.id] = analysis;
      }
    } catch (err) {
      if (err?.status === 429 || err?.status === 403) { triggerClobRateLimit(err.status); break; }
    }
  }

  return { spreadFetched, flowFetched };
}

// ── Test setup ─────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetCounter();
  fetchOrderBook.mockResolvedValue({ bids: [{ price: '0.55' }], asks: [{ price: '0.56' }] });
  calculateSpread.mockReturnValue({ absoluteSpread: 0.01 });
  fetchMarketTrades.mockResolvedValue([{ id: 't1' }]);
  isClobRateLimited.mockReturnValue(false);
});

afterEach(() => { vi.useRealTimers(); });

// ── Spread batch tests ─────────────────────────────────────────────

describe('spread batch', () => {
  it('max 25 fetchOrderBook calls from 30 uncached markets', async () => {
    const markets = makeMarketList(30);
    const promise = runSpreadBatch(markets, {}, null);
    await vi.runAllTimersAsync();
    await promise;
    expect(fetchOrderBook).toHaveBeenCalledTimes(25);
  });

  it('respects 200ms inter-request delay', async () => {
    const markets = makeMarketList(3);
    const timestamps = [];
    fetchOrderBook.mockImplementation(async () => {
      timestamps.push(Date.now());
      return { bids: [], asks: [] };
    });
    const promise = runSpreadBatch(markets, {}, null);
    await vi.runAllTimersAsync();
    await promise;
    expect(timestamps).toHaveLength(3);
    expect(timestamps[1] - timestamps[0]).toBe(SPREAD_FETCH_DELAY);
    expect(timestamps[2] - timestamps[1]).toBe(SPREAD_FETCH_DELAY);
  });

  it('skips markets already in spreadCache', async () => {
    const markets = makeMarketList(10);
    const cache = {};
    markets.slice(0, 5).forEach((m) => { cache[m.id] = 0.02; });
    const promise = runSpreadBatch(markets, cache, null);
    await vi.runAllTimersAsync();
    await promise;
    expect(fetchOrderBook).toHaveBeenCalledTimes(5);
  });

  it('skips markets with zero spread in cache (== null is false for 0)', async () => {
    const markets = makeMarketList(3);
    const cache = { [markets[0].id]: 0 }; // zero spread — valid, should be skipped
    const promise = runSpreadBatch(markets, cache, null);
    await vi.runAllTimersAsync();
    await promise;
    expect(fetchOrderBook).toHaveBeenCalledTimes(2);
  });

  it('stops on signal abort mid-batch', async () => {
    const markets = makeMarketList(10);
    const controller = new AbortController();
    let callCount = 0;
    fetchOrderBook.mockImplementation(async () => {
      callCount++;
      if (callCount === 3) controller.abort();
      return { bids: [], asks: [] };
    });
    const promise = runSpreadBatch(markets, {}, controller.signal);
    await vi.runAllTimersAsync();
    await promise;
    // Aborted after call 3 — should not proceed much further
    expect(callCount).toBeLessThanOrEqual(4);
  });
});

// ── Flow batch tests ───────────────────────────────────────────────

describe('flow batch', () => {
  it('max 10 fetchMarketTrades calls from 15 uncached markets', async () => {
    const markets = makeMarketList(15);
    const promise = runFlowBatch(markets, {}, null);
    await vi.runAllTimersAsync();
    await promise;
    expect(fetchMarketTrades).toHaveBeenCalledTimes(10);
  });

  it('respects 300ms inter-request delay', async () => {
    const markets = makeMarketList(3);
    const timestamps = [];
    fetchMarketTrades.mockImplementation(async () => {
      timestamps.push(Date.now());
      return [{ id: 't' }];
    });
    const promise = runFlowBatch(markets, {}, null);
    await vi.runAllTimersAsync();
    await promise;
    expect(timestamps).toHaveLength(3);
    expect(timestamps[1] - timestamps[0]).toBe(FLOW_FETCH_DELAY);
    expect(timestamps[2] - timestamps[1]).toBe(FLOW_FETCH_DELAY);
  });

  it('skips markets in flowCache', async () => {
    const markets = makeMarketList(10);
    const cache = {};
    markets.slice(0, 3).forEach((m) => { cache[m.id] = { dataAvailable: true }; });
    const promise = runFlowBatch(markets, cache, null);
    await vi.runAllTimersAsync();
    await promise;
    expect(fetchMarketTrades).toHaveBeenCalledTimes(7);
  });

  it('skips markets in module cache (getCachedTradeFlow)', async () => {
    const markets = makeMarketList(10);
    getCachedTradeFlow.mockImplementation((id) => {
      return ['market-0', 'market-1', 'market-2'].includes(id) ? { dataAvailable: true } : null;
    });
    const promise = runFlowBatch(markets, {}, null);
    await vi.runAllTimersAsync();
    await promise;
    expect(fetchMarketTrades).toHaveBeenCalledTimes(7);
  });
});

// ── Gap filler tests ───────────────────────────────────────────────

describe('gap filler', () => {
  it('max 3 spread + 2 flow calls', async () => {
    const markets = makeMarketList(10);
    await runGapFill(markets, {}, {});
    expect(fetchOrderBook).toHaveBeenCalledTimes(3);
    expect(fetchMarketTrades).toHaveBeenCalledTimes(2);
  });

  it('does nothing when all visible markets cached', async () => {
    const markets = makeMarketList(5);
    const spreadCache = {};
    const flowCache = {};
    markets.forEach((m) => {
      spreadCache[m.id] = 0.01;
      flowCache[m.id] = { dataAvailable: true };
    });
    await runGapFill(markets, spreadCache, flowCache);
    expect(fetchOrderBook).not.toHaveBeenCalled();
    expect(fetchMarketTrades).not.toHaveBeenCalled();
  });

  it('finds markets not in cache despite being visible', async () => {
    const markets = makeMarketList(5);
    const spreadCache = {};
    const flowCache = {};
    // Cache 3 of 5
    markets.slice(0, 3).forEach((m) => {
      spreadCache[m.id] = 0.01;
      flowCache[m.id] = { dataAvailable: true };
    });
    await runGapFill(markets, spreadCache, flowCache);
    expect(fetchOrderBook).toHaveBeenCalledTimes(2); // 2 uncached spread
    expect(fetchMarketTrades).toHaveBeenCalledTimes(2); // 2 uncached flow
  });

  it('gapRunning semaphore prevents concurrent executions', async () => {
    // Replicate the gapRunningRef pattern from ResultsTable lines 365-433.
    // When useBackgroundBatchFetch is extracted, this becomes the real contract test.
    let gapRunning = false;
    let concurrentAttempts = 0;

    async function simulateGapFill() {
      if (gapRunning) { concurrentAttempts++; return; }
      gapRunning = true;
      try {
        await runGapFill(makeMarketList(5), {}, {});
      } finally {
        gapRunning = false;
      }
    }

    // Start two concurrent gap fills
    const p1 = simulateGapFill();
    const p2 = simulateGapFill(); // should be blocked
    await Promise.all([p1, p2]);

    expect(concurrentAttempts).toBe(1); // second call was blocked
  });

  it('continues after rate limit recovery', async () => {
    const markets = makeMarketList(5);
    // First call: rate limited
    isClobRateLimited.mockReturnValue(true);
    const result1 = await runGapFill(markets, {}, {});
    expect(result1.spreadFetched).toBe(0);
    expect(result1.flowFetched).toBe(0);

    // After recovery
    isClobRateLimited.mockReturnValue(false);
    const result2 = await runGapFill(markets, {}, {});
    expect(result2.spreadFetched).toBe(3);
    expect(result2.flowFetched).toBe(2);
  });
});

// ── Rate limit integration ─────────────────────────────────────────

describe('rate limit integration', () => {
  it('skips all fetching when isClobRateLimited() is true', async () => {
    isClobRateLimited.mockReturnValue(true);
    const markets = makeMarketList(10);
    const p1 = runSpreadBatch(markets, {}, null);
    const p2 = runFlowBatch(markets, {}, null);
    await vi.runAllTimersAsync();
    await Promise.all([p1, p2]);
    expect(fetchOrderBook).not.toHaveBeenCalled();
    expect(fetchMarketTrades).not.toHaveBeenCalled();
  });

  it('429 from fetchOrderBook triggers triggerClobRateLimit(429)', async () => {
    const err = new Error('Rate limited');
    err.status = 429;
    fetchOrderBook.mockRejectedValue(err);
    const markets = makeMarketList(5);
    const promise = runSpreadBatch(markets, {}, null);
    await vi.runAllTimersAsync();
    await promise;
    expect(triggerClobRateLimit).toHaveBeenCalledWith(429);
  });

  it('403 from fetchMarketTrades triggers triggerClobRateLimit(403)', async () => {
    const err = new Error('Forbidden');
    err.status = 403;
    fetchMarketTrades.mockRejectedValue(err);
    const markets = makeMarketList(5);
    const promise = runFlowBatch(markets, {}, null);
    await vi.runAllTimersAsync();
    await promise;
    expect(triggerClobRateLimit).toHaveBeenCalledWith(403);
  });

  it('after rate limit trip, remaining batch items skipped', async () => {
    let callCount = 0;
    fetchOrderBook.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        const err = new Error('Rate limited');
        err.status = 429;
        throw err;
      }
      return { bids: [], asks: [] };
    });
    // Intentional mock coupling: triggerClobRateLimit mutates isClobRateLimited's
    // return value because production has the same coupling — tripping the breaker
    // immediately makes isClobRateLimited() return true.
    triggerClobRateLimit.mockImplementation(() => {
      isClobRateLimited.mockReturnValue(true);
    });
    const markets = makeMarketList(5);
    const promise = runSpreadBatch(markets, {}, null);
    await vi.runAllTimersAsync();
    await promise;
    expect(callCount).toBe(2); // stopped after 429 on call 2
  });
});

// ── Total request volume ───────────────────────────────────────────

describe('total request volume', () => {
  it('total CLOB requests from all 3 systems ≤ 40', async () => {
    const markets = makeMarketList(30);
    const spreadCache = {};
    const flowCache = {};

    // Run all three systems sequentially (spread batch, flow batch, gap filler)
    const p1 = runSpreadBatch(markets, spreadCache, null);
    await vi.runAllTimersAsync();
    await p1;

    const p2 = runFlowBatch(markets, flowCache, null);
    await vi.runAllTimersAsync();
    await p2;

    // Gap filler runs on remaining uncached markets
    await runGapFill(markets.slice(0, 20), spreadCache, flowCache);

    const totalCalls = fetchOrderBook.mock.calls.length + fetchMarketTrades.mock.calls.length;
    expect(totalCalls).toBeLessThanOrEqual(40); // 25 spread + 10 flow + 3+2 gap = 40 max
  });
});
