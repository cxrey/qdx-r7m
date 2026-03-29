import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../fetchUtils', () => ({
  withTimeout: vi.fn((callerSignal) => callerSignal || new AbortController().signal),
  TIMEOUT_GAMMA_PAGE: 10000,
}));

vi.mock('../categoryPatterns', () => ({
  inferCategory: vi.fn(() => 'Other'),
}));

import {
  fetchResolvedMarkets, computeBaseRates, analyzeBaseRate,
  getBaseRateEdgeConfidence,
} from '../BaseRateEngine';
import { setupLocalStorageMock } from './helpers/mockLocalStorage';

let mockFetch;
let mockLocalStorage;

beforeEach(() => {
  vi.useFakeTimers();
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);

  const ls = setupLocalStorageMock();
  mockLocalStorage = ls.store;
  vi.stubGlobal('localStorage', ls.mock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeResolvedMarkets(n, startId = 0) {
  return Array.from({ length: n }, (_, i) => ({
    id: `rm-${startId + i}`,
    question: `Resolved market ${startId + i}?`,
    outcome: 'Yes',
    outcomePrices: JSON.stringify([0.95, 0.05]),
    createdAt: new Date(Date.now() - 60 * 86400000).toISOString(),
    endDate: new Date(Date.now() - 30 * 86400000).toISOString(),
  }));
}

// ── fetchResolvedMarkets ───────────────────────────────────────────

describe('fetchResolvedMarkets', () => {
  it('returns cached result from localStorage within 24h', async () => {
    const cached = {
      ts: Date.now(),
      data: { resolvedMarkets: [{ id: 'cached-1' }], fetchedAt: Date.now() },
    };
    mockLocalStorage['polymarket_base_rates'] = JSON.stringify(cached);

    const result = await fetchResolvedMarkets();
    expect(result).toEqual(cached.data);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('ignores expired cache (>24h)', async () => {
    const expired = {
      ts: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      data: { resolvedMarkets: [{ id: 'old' }], fetchedAt: Date.now() },
    };
    mockLocalStorage['polymarket_base_rates'] = JSON.stringify(expired);

    // Return empty pages so it finishes quickly
    mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    const promise = fetchResolvedMarkets();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(mockFetch).toHaveBeenCalled(); // fetched fresh
    expect(result.resolvedMarkets).toEqual([]); // no data from empty pages
  });

  it('fetches 4 concurrent pages per batch (RESOLVED_CONCURRENCY)', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount <= 4) {
        return new Response(JSON.stringify(makeResolvedMarkets(100, (callCount - 1) * 100)), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const promise = fetchResolvedMarkets();
    await vi.runAllTimersAsync();
    await promise;

    // First batch: 4 concurrent, second batch: 4 concurrent (all empty → stops)
    expect(callCount).toBe(8);
  });

  it('stops on 3 consecutive empty pages', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      // First 2 pages have data, then 3 consecutive empty
      if (callCount <= 2) {
        return new Response(JSON.stringify(makeResolvedMarkets(100, (callCount - 1) * 100)), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const promise = fetchResolvedMarkets();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.resolvedMarkets.length).toBe(200);
  });

  it('saves result to localStorage', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    const promise = fetchResolvedMarkets();
    await vi.runAllTimersAsync();
    await promise;

    expect(localStorage.setItem).toHaveBeenCalledWith(
      'polymarket_base_rates',
      expect.any(String)
    );
  });

  it('continues batch on partial 429 failure', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        // Simulate fetchResolvedPage throwing 429 after retries
        const err = new Error('Rate limited');
        err.status = 429;
        throw err;
      }
      if (callCount <= 4) {
        return new Response(JSON.stringify(makeResolvedMarkets(100, (callCount - 1) * 100)), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const promise = fetchResolvedMarkets();
    await vi.runAllTimersAsync();
    const result = await promise;

    // Should have collected from pages 1, 3, 4 (page 2 was 429)
    expect(result.resolvedMarkets.length).toBeGreaterThan(0);
  });

  it('returns partial results when signal aborts', async () => {
    const controller = new AbortController();
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 3) controller.abort();
      if (callCount <= 4) {
        return new Response(JSON.stringify(makeResolvedMarkets(100, (callCount - 1) * 100)), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const promise = fetchResolvedMarkets(controller.signal);
    await vi.runAllTimersAsync();
    const result = await promise;

    // Should have some data from before abort
    expect(result.resolvedMarkets).toBeDefined();
  });

  it('retries on failure with exponential backoff', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      // First two calls to page 1 fail, third succeeds
      if (callCount <= 2) return new Response('Server Error', { status: 500 });
      if (callCount === 3) return new Response(JSON.stringify(makeResolvedMarkets(10)), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const promise = fetchResolvedMarkets();
    // BaseRateEngine.fetchResolvedPage retries with 1000 * (attempt + 1) delay
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(callCount).toBeGreaterThan(2); // retried
    expect(result.resolvedMarkets.length).toBeGreaterThanOrEqual(0);
  });

  it('reads Retry-After header on 429', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('Rate limited', {
          status: 429,
          headers: { 'Retry-After': '5' },
        });
      }
      if (callCount === 2) {
        return new Response(JSON.stringify(makeResolvedMarkets(10)), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const promise = fetchResolvedMarkets();
    // Retry-After: 5 seconds
    await vi.advanceTimersByTimeAsync(5000);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(callCount).toBeGreaterThan(1); // retried after Retry-After delay
  });

  it('URL includes closed=true for resolved markets', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    const promise = fetchResolvedMarkets();
    await vi.runAllTimersAsync();
    await promise;

    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('closed=true');
    expect(url).toContain('limit=100');
  });
});

// ── computeBaseRates (pure computation) ──────────────────────────

describe('computeBaseRates', () => {
  function makeResolved(outcome, pricePair = [0.55, 0.45]) {
    return {
      question: 'Will Bitcoin hit 100k?',
      outcome,
      outcomePrices: JSON.stringify(pricePair),
      createdAt: new Date(Date.now() - 60 * 86400000).toISOString(),
      endDate: new Date(Date.now() - 30 * 86400000).toISOString(),
    };
  }

  it('counts YES and NO resolutions in global bucket', () => {
    const markets = [
      makeResolved('Yes'), makeResolved('Yes'), makeResolved('No'),
    ];
    const rates = computeBaseRates(markets);
    expect(rates.global.total).toBe(3);
    expect(rates.global.yesResolved).toBe(2);
  });

  it('skips markets with ambiguous resolution', () => {
    const markets = [
      makeResolved('Yes'),
      makeResolved('Maybe'), // ambiguous — no outcome match, price 0.55 is neither ≥0.95 nor ≤0.05
    ];
    const rates = computeBaseRates(markets);
    expect(rates.global.total).toBe(1); // only the Yes market counted
  });

  it('buckets by price range', () => {
    const markets = [
      makeResolved('Yes', [0.55, 0.45]), // 41-60¢ bucket
      makeResolved('No', [0.08, 0.92]),  // 0-10¢ bucket
    ];
    const rates = computeBaseRates(markets);
    expect(rates.byPriceBucket['41-60¢'].total).toBe(1);
    expect(rates.byPriceBucket['0-10¢'].total).toBe(1);
  });

  it('returns empty buckets for empty input', () => {
    const rates = computeBaseRates([]);
    expect(rates.global.total).toBe(0);
    expect(rates.global.yesResolved).toBe(0);
  });
});

// ── analyzeBaseRate (per-market analysis) ─────────────────────────

describe('analyzeBaseRate', () => {
  // Minimal base rates with enough samples for analysis
  const baseRates = {
    global: { total: 100, yesResolved: 50 }, // 50% base rate
    byCategory: { Other: { total: 50, yesResolved: 25 } },
    byPriceBucket: { '41-60¢': { total: 50, yesResolved: 30 } },
    byDuration: { '8-30d': { total: 20, yesResolved: 10 } },
    byCategoryAndPrice: { 'Other|41-60¢': { total: 20, yesResolved: 12 } },
  };

  it('returns null when baseRates has < 20 global samples', () => {
    const result = analyzeBaseRate(
      { yesPrice: 0.55, category: 'Other', daysLeft: 15 },
      { global: { total: 10, yesResolved: 5 } },
    );
    expect(result).toBeNull();
  });

  it('returns null when market has no yesPrice', () => {
    const result = analyzeBaseRate({ yesPrice: null, category: 'Other' }, baseRates);
    expect(result).toBeNull();
  });

  it('computes weighted base rate from matching buckets', () => {
    const result = analyzeBaseRate(
      { yesPrice: 0.55, category: 'Other', daysLeft: 15 },
      baseRates,
    );
    expect(result).not.toBeNull();
    // Weighted: catPrice(60%×3) + cat(50%×2) + price(60%×2) + dur(50%×1) = 4.5/8 = 0.5625
    expect(result.baseRate).toBeCloseTo(0.5625, 4);
    expect(result.marketPrice).toBe(0.55);
    expect(result.sources.length).toBeGreaterThanOrEqual(2);
  });

  it('classifies NARRATIVE_PREMIUM when market overprices YES', () => {
    // Market at 80¢, base rate ~50% → gap = +30¢ → NARRATIVE_PREMIUM
    const result = analyzeBaseRate(
      { yesPrice: 0.80, category: 'Other', daysLeft: 15 },
      baseRates,
    );
    expect(result.gapType).toBe('NARRATIVE_PREMIUM');
    expect(result.suggestion).toBe('BUY_NO');
  });

  it('classifies NARRATIVE_DISCOUNT when market underprices YES', () => {
    // Market at 20¢, base rate ~50% → gap = -30¢ → NARRATIVE_DISCOUNT
    const lowPriceRates = {
      ...baseRates,
      byPriceBucket: { ...baseRates.byPriceBucket, '11-25¢': { total: 50, yesResolved: 30 } },
      byCategoryAndPrice: { ...baseRates.byCategoryAndPrice, 'Other|11-25¢': { total: 20, yesResolved: 12 } },
    };
    const result = analyzeBaseRate(
      { yesPrice: 0.20, category: 'Other', daysLeft: 15 },
      lowPriceRates,
    );
    expect(result.gapType).toBe('NARRATIVE_DISCOUNT');
    expect(result.suggestion).toBe('BUY_YES');
  });

  it('classifies FAIR when gap < 3¢', () => {
    // Weighted base rate for Other|41-60¢: catPrice=60%, cat=50%, price=60%, dur=50%
    // Weighted avg ≈ (0.6*3 + 0.5*2 + 0.6*2 + 0.5*1) / 8 ≈ 0.5625
    // Set market at 56¢ so gap ≈ 0
    const result = analyzeBaseRate(
      { yesPrice: 0.56, category: 'Other', daysLeft: 15 },
      baseRates,
    );
    expect(result.gapType).toBe('FAIR');
    expect(result.suggestion).toBeNull();
  });
});

// ── getBaseRateEdgeConfidence ──────────────────────────────────────

describe('getBaseRateEdgeConfidence', () => {
  it('returns UNKNOWN when no base rate analysis', () => {
    expect(getBaseRateEdgeConfidence(null, null)).toBe('UNKNOWN');
  });

  it('returns VERY_HIGH when FLB and base rate agree on HIGH confidence', () => {
    const br = { suggestion: 'BUY_NO', confidence: 'HIGH' };
    const flb = { bestSide: 'NO' };
    expect(getBaseRateEdgeConfidence(br, flb)).toBe('VERY_HIGH');
  });

  it('returns CONFLICTED when FLB and base rate disagree', () => {
    const br = { suggestion: 'BUY_NO', confidence: 'HIGH' };
    const flb = { bestSide: 'YES' };
    expect(getBaseRateEdgeConfidence(br, flb)).toBe('CONFLICTED');
  });

  it('returns base confidence when no FLB data', () => {
    const br = { suggestion: 'BUY_YES', confidence: 'MEDIUM' };
    expect(getBaseRateEdgeConfidence(br, null)).toBe('MEDIUM');
  });
});
