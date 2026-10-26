/**
 * Tests for batch fetch utilities (src/batchFetchUtils.js).
 *
 * These tests exercise the REAL production batch logic — runSpreadBatch,
 * runFlowBatch, runGapFill — with mocked fetch/cache dependencies.
 * If the production implementation changes, these tests break.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchOrderBook } from '../api';
import { calculateSpread } from '../SpreadFrictionEngine';
import { fetchMarketTrades, peekCachedTradeFlow } from '../TradeFlowEngine';
import { isClobRateLimited, triggerClobRateLimit } from '../clobRateLimit';
import {
  SPREAD_FETCH_DELAY, FLOW_FETCH_DELAY,
} from '../uiConfig';
import { runSpreadBatch, runFlowBatch, runGapFill, makePlainObjectCache, resetEmptyResults } from '../batchFetchUtils';
import { isDataApiRateLimited } from '../dataApi';
import { makeMarketList, resetCounter } from './helpers/marketFixtures';

vi.mock('../api', () => ({ fetchOrderBook: vi.fn() }));
vi.mock('../SpreadFrictionEngine', () => ({ calculateSpread: vi.fn() }));
vi.mock('../TradeFlowEngine', () => ({
  fetchMarketTrades: vi.fn(),
  analyzeTradeFlow: vi.fn(() => ({ dataAvailable: true })),
  getLeaderboardIndex: vi.fn(() => new Map()),
  peekCachedTradeFlow: vi.fn(() => null),
  setCachedTradeFlow: vi.fn(),
}));
vi.mock('../clobRateLimit', () => ({
  isClobRateLimited: vi.fn(() => false),
  triggerClobRateLimit: vi.fn(),
}));
vi.mock('../dataApi', () => ({ isDataApiRateLimited: vi.fn(() => false) }));
// Do NOT mock ../clobErrorHandler — let real handleClobError call the mocked triggerClobRateLimit

// ── Test setup ─────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetCounter();
  fetchOrderBook.mockResolvedValue({ bids: [{ price: '0.55' }], asks: [{ price: '0.56' }] });
  calculateSpread.mockReturnValue({ absoluteSpread: 0.01 });
  fetchMarketTrades.mockResolvedValue([{ id: 't1' }]);
  isClobRateLimited.mockReturnValue(false);
  isDataApiRateLimited.mockReturnValue(false);
  peekCachedTradeFlow.mockImplementation(() => null); // clearAllMocks keeps implementations
  resetEmptyResults();
});

afterEach(() => { vi.useRealTimers(); });

// ── Spread batch tests ─────────────────────────────────────────────

describe('spread batch', () => {
  it('max 25 fetchOrderBook calls from 30 uncached markets', async () => {
    const markets = makeMarketList(30);
    const promise = runSpreadBatch(markets, { cache: makePlainObjectCache({}) });
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
    calculateSpread.mockReturnValue({ absoluteSpread: 0.01 });
    const promise = runSpreadBatch(markets, { cache: makePlainObjectCache({}) });
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
    const promise = runSpreadBatch(markets, { cache: makePlainObjectCache(cache) });
    await vi.runAllTimersAsync();
    await promise;
    expect(fetchOrderBook).toHaveBeenCalledTimes(5);
  });

  it('skips markets with zero spread in cache (0 != null is true)', async () => {
    const markets = makeMarketList(3);
    const cache = { [markets[0].id]: 0 }; // zero spread — valid, should be skipped
    const promise = runSpreadBatch(markets, { cache: makePlainObjectCache(cache) });
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
    calculateSpread.mockReturnValue({ absoluteSpread: 0.01 });
    const promise = runSpreadBatch(markets, { cache: makePlainObjectCache({}), signal: controller.signal });
    await vi.runAllTimersAsync();
    await promise;
    // Abort fires inside call 3's fetchOne, but processOne for call 3 may
    // still run before the loop re-checks signal.aborted → bound is 4, not 3.
    expect(callCount).toBeLessThanOrEqual(4);
  });
});

// ── Flow batch tests ───────────────────────────────────────────────

describe('flow batch', () => {
  it('max 10 fetchMarketTrades calls from 15 uncached markets', async () => {
    const markets = makeMarketList(15);
    const promise = runFlowBatch(markets, { cache: makePlainObjectCache({}) });
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
    const promise = runFlowBatch(markets, { cache: makePlainObjectCache({}) });
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
    const promise = runFlowBatch(markets, { cache: makePlainObjectCache(cache) });
    await vi.runAllTimersAsync();
    await promise;
    expect(fetchMarketTrades).toHaveBeenCalledTimes(7);
  });

  it('skips markets in module cache (peekCachedTradeFlow)', async () => {
    const markets = makeMarketList(10);
    peekCachedTradeFlow.mockImplementation((id) => {
      return ['market-0', 'market-1', 'market-2'].includes(id) ? { dataAvailable: true } : null;
    });
    const promise = runFlowBatch(markets, { cache: makePlainObjectCache({}) });
    await vi.runAllTimersAsync();
    await promise;
    expect(fetchMarketTrades).toHaveBeenCalledTimes(7);
  });
});

// ── Gap filler tests ───────────────────────────────────────────────

describe('gap filler', () => {
  it('max 3 spread + 2 flow calls', async () => {
    const markets = makeMarketList(10);
    await runGapFill(markets, {
      spreadCache: makePlainObjectCache({}),
      flowCache: makePlainObjectCache({}),
    });
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
    await runGapFill(markets, {
      spreadCache: makePlainObjectCache(spreadCache),
      flowCache: makePlainObjectCache(flowCache),
    });
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
    await runGapFill(markets, {
      spreadCache: makePlainObjectCache(spreadCache),
      flowCache: makePlainObjectCache(flowCache),
    });
    expect(fetchOrderBook).toHaveBeenCalledTimes(2); // 2 uncached spread
    expect(fetchMarketTrades).toHaveBeenCalledTimes(2); // 2 uncached flow
  });

  it('gapRunning semaphore prevents concurrent executions', async () => {
    // Replicate the gapRunningRef pattern from ResultsTable.
    // The extracted runGapFill doesn't manage concurrency — that stays in the component.
    // This test verifies the caller-side pattern is correct.
    let gapRunning = false;
    let concurrentAttempts = 0;

    async function simulateGapFill() {
      if (gapRunning) { concurrentAttempts++; return; }
      gapRunning = true;
      try {
        await runGapFill(makeMarketList(5), {
          spreadCache: makePlainObjectCache({}),
          flowCache: makePlainObjectCache({}),
        });
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

  it('a CLOB rate limit pauses spreads only; trade flow (Data API) carries on, and spreads resume after', async () => {
    const markets = makeMarketList(5);
    isClobRateLimited.mockReturnValue(true);
    const result1 = await runGapFill(markets, {
      spreadCache: makePlainObjectCache({}),
      flowCache: makePlainObjectCache({}),
    });
    expect(result1.spreadFetched).toBe(0);
    expect(result1.flowFetched).toBe(2);

    isClobRateLimited.mockReturnValue(false);
    const result2 = await runGapFill(markets, {
      spreadCache: makePlainObjectCache({}),
      flowCache: makePlainObjectCache({}),
    });
    expect(result2.spreadFetched).toBe(3);
  });

  it('a Data API rate limit pauses trade flow only', async () => {
    isDataApiRateLimited.mockReturnValue(true);
    const result = await runGapFill(makeMarketList(5), {
      spreadCache: makePlainObjectCache({}),
      flowCache: makePlainObjectCache({}),
    });
    expect(result.spreadFetched).toBe(3);
    expect(fetchMarketTrades).not.toHaveBeenCalled();
  });

  it('markets with nothing to show no longer take the gap filler\'s slots on every pass', async () => {
    const markets = makeMarketList(6);
    // The first 3 have one-sided books (no spread) and the first 2 no trades
    calculateSpread.mockImplementation(() => null);
    fetchMarketTrades.mockResolvedValue([]);
    await runGapFill(markets, { spreadCache: makePlainObjectCache({}), flowCache: makePlainObjectCache({}) });
    const firstBooks = fetchOrderBook.mock.calls.length;
    const firstTrades = fetchMarketTrades.mock.calls.length;

    calculateSpread.mockReturnValue({ absoluteSpread: 0.01 });
    fetchMarketTrades.mockResolvedValue([{ id: 't1' }]);
    vi.clearAllMocks();
    fetchOrderBook.mockResolvedValue({ bids: [], asks: [] });
    calculateSpread.mockReturnValue({ absoluteSpread: 0.01 });
    fetchMarketTrades.mockResolvedValue([{ id: 't1' }]);
    await runGapFill(markets, { spreadCache: makePlainObjectCache({}), flowCache: makePlainObjectCache({}) });
    expect(firstBooks).toBe(3);
    expect(firstTrades).toBe(2);
    // Second pass moves on to the next markets instead of refetching the empty ones
    expect(fetchOrderBook.mock.calls.map(([tok]) => tok)).toEqual(markets.slice(3, 6).map((m) => m.clobTokenIds[0]));
    expect(fetchMarketTrades.mock.calls.map(([c]) => c)).toEqual(markets.slice(2, 4).map((m) => m.conditionId));
  });

  it('an empty book is retried after 60s; a failed trades request is retried at once', async () => {
    const markets = makeMarketList(1);
    calculateSpread.mockImplementation(() => null);
    fetchMarketTrades.mockResolvedValue(null); // request failed — not "no trades"
    const opts = () => ({ spreadCache: makePlainObjectCache({}), flowCache: makePlainObjectCache({}) });
    await runGapFill(markets, opts());
    await runGapFill(markets, opts());
    expect(fetchOrderBook).toHaveBeenCalledTimes(1); // remembered as empty
    expect(fetchMarketTrades).toHaveBeenCalledTimes(2); // failure not remembered
    await vi.advanceTimersByTimeAsync(60_001);
    await runGapFill(markets, opts());
    expect(fetchOrderBook).toHaveBeenCalledTimes(2);
  });
});

// ── Rate limit integration ─────────────────────────────────────────

describe('rate limit integration', () => {
  it('a CLOB rate limit skips order books but not trade flow (a different API)', async () => {
    isClobRateLimited.mockReturnValue(true);
    const markets = makeMarketList(10);
    const p1 = runSpreadBatch(markets, { cache: makePlainObjectCache({}) });
    const p2 = runFlowBatch(markets, { cache: makePlainObjectCache({}) });
    await vi.runAllTimersAsync();
    await Promise.all([p1, p2]);
    expect(fetchOrderBook).not.toHaveBeenCalled();
    expect(fetchMarketTrades).toHaveBeenCalled();
  });

  it('a Data API rate limit skips trade flow', async () => {
    isDataApiRateLimited.mockReturnValue(true);
    const p = runFlowBatch(makeMarketList(10), { cache: makePlainObjectCache({}) });
    await vi.runAllTimersAsync();
    await p;
    expect(fetchMarketTrades).not.toHaveBeenCalled();
  });

  it('trade flow takes no CLOB concurrency slot', async () => {
    const acquireSlot = vi.fn(async () => () => {});
    const p = runFlowBatch(makeMarketList(3), { cache: makePlainObjectCache({}), acquireSlot });
    await vi.runAllTimersAsync();
    await p;
    expect(fetchMarketTrades).toHaveBeenCalledTimes(3);
    expect(acquireSlot).not.toHaveBeenCalled();
  });

  it('429 from fetchOrderBook triggers triggerClobRateLimit(429)', async () => {
    const err = new Error('Rate limited');
    err.status = 429;
    fetchOrderBook.mockRejectedValue(err);
    const markets = makeMarketList(5);
    const promise = runSpreadBatch(markets, { cache: makePlainObjectCache({}) });
    await vi.runAllTimersAsync();
    await promise;
    expect(triggerClobRateLimit).toHaveBeenCalledWith(429);
  });

  it('a 403 from the Data API (trades) stops the flow batch without tripping the CLOB breaker', async () => {
    const err = new Error('Forbidden');
    err.status = 403;
    fetchMarketTrades.mockRejectedValue(err);
    const markets = makeMarketList(5);
    const promise = runFlowBatch(markets, { cache: makePlainObjectCache({}) });
    await vi.runAllTimersAsync();
    await promise;
    expect(triggerClobRateLimit).not.toHaveBeenCalled();
    expect(fetchMarketTrades).toHaveBeenCalledTimes(1); // stopped after the 403
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
    // triggerClobRateLimit mutates isClobRateLimited's return value — production coupling
    triggerClobRateLimit.mockImplementation(() => {
      isClobRateLimited.mockReturnValue(true);
    });
    const markets = makeMarketList(5);
    const promise = runSpreadBatch(markets, { cache: makePlainObjectCache({}) });
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
    const p1 = runSpreadBatch(markets, { cache: makePlainObjectCache(spreadCache) });
    await vi.runAllTimersAsync();
    await p1;

    const p2 = runFlowBatch(markets, { cache: makePlainObjectCache(flowCache) });
    await vi.runAllTimersAsync();
    await p2;

    // Gap filler runs on remaining uncached markets
    await runGapFill(markets.slice(0, 20), {
      spreadCache: makePlainObjectCache(spreadCache),
      flowCache: makePlainObjectCache(flowCache),
    });

    const totalCalls = fetchOrderBook.mock.calls.length + fetchMarketTrades.mock.calls.length;
    expect(totalCalls).toBeLessThanOrEqual(40); // 25 spread + 10 flow + 3+2 gap = 40 max
  });
});
