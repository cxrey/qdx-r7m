import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../fetchUtils', () => ({
  withTimeout: vi.fn((callerSignal) => callerSignal || new AbortController().signal),
  TIMEOUT_GAMMA_PAGE: 10000,
}));

vi.mock('../categoryPatterns', () => ({
  inferCategory: vi.fn(() => 'Other'),
}));

import {
  fetchResolvedMarkets, getBaseRates, computeBaseRates, analyzeBaseRate,
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

// A /markets/keyset page: next_cursor is omitted on the last page
function keysetResponse(markets, nextCursor) {
  const body = nextCursor ? { markets, next_cursor: nextCursor } : { markets };
  return new Response(JSON.stringify(body), { status: 200 });
}

// ── getBaseRates (cache wrapper) ───────────────────────────────────

describe('getBaseRates', () => {
  it('returns cached computed rates from localStorage within 24h', async () => {
    const cachedRates = {
      global: { total: 100, yesResolved: 40 },
      byCategory: {},
      byDuration: {},
      byCategoryAndDuration: {},
    };
    mockLocalStorage['polymarket_base_rates_v2'] = JSON.stringify({
      ts: Date.now(),
      data: cachedRates,
    });

    const result = await getBaseRates();
    expect(result).toEqual(cachedRates);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('ignores expired cache (>24h) and fetches fresh', async () => {
    mockLocalStorage['polymarket_base_rates_v2'] = JSON.stringify({
      ts: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      data: { global: { total: 100, yesResolved: 40 } },
    });

    // Return empty pages so it finishes quickly
    mockFetch.mockImplementation(async () => keysetResponse([]));

    const promise = getBaseRates();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(mockFetch).toHaveBeenCalled(); // fetched fresh
    expect(result.global.total).toBe(0); // no data from empty pages
  });

  it('removes the legacy raw-market cache key', async () => {
    mockLocalStorage['polymarket_base_rates'] = JSON.stringify({ ts: Date.now(), data: {} });
    mockFetch.mockImplementation(async () => keysetResponse([]));

    const promise = getBaseRates();
    await vi.runAllTimersAsync();
    await promise;

    expect(localStorage.removeItem).toHaveBeenCalledWith('polymarket_base_rates');
  });

  it('saves computed rates (not raw markets) when sample is large enough', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return keysetResponse(makeResolvedMarkets(100));
      return keysetResponse([]);
    });

    const promise = getBaseRates();
    await vi.runAllTimersAsync();
    await promise;

    const savedCall = localStorage.setItem.mock.calls.find(
      ([key]) => key === 'polymarket_base_rates_v2'
    );
    expect(savedCall).toBeTruthy();
    const saved = JSON.parse(savedCall[1]);
    expect(saved.data.global.total).toBe(100);
    expect(saved.data.resolvedMarkets).toBeUndefined();
  });

  it('does not cache when the sample is too small (rate-limited partial fetch)', async () => {
    mockFetch.mockImplementation(async () => keysetResponse([]));

    const promise = getBaseRates();
    await vi.runAllTimersAsync();
    await promise;

    const savedCall = localStorage.setItem.mock.calls.find(
      ([key]) => key === 'polymarket_base_rates_v2'
    );
    expect(savedCall).toBeFalsy();
  });
});

// ── fetchResolvedMarkets ───────────────────────────────────────────

describe('fetchResolvedMarkets', () => {
  // Routes each request by volume band (volume_num_min, or 'bottom' for the
  // open-ended band) and cursor. `pages[band][cursor ?? 'start']` is a Response
  // factory; unrouted requests get an empty last page.
  function bandOf(url) {
    return new URL(url, 'http://localhost').searchParams.get('volume_num_min') ?? 'bottom';
  }

  function routeFetch(pages) {
    mockFetch.mockImplementation(async (url) => {
      const cursor = new URL(url, 'http://localhost').searchParams.get('after_cursor') ?? 'start';
      const handler = pages[bandOf(url)]?.[cursor];
      return handler ? handler() : keysetResponse([]);
    });
  }

  const urlsFor = (band) => mockFetch.mock.calls.map(([url]) => url).filter((url) => bandOf(url) === band);
  const callsWithCursor = (cursor) => mockFetch.mock.calls.filter(([url]) => url.includes(`after_cursor=${cursor}`));

  it('crawls /markets/keyset for closed markets with one cursor chain per volume band', async () => {
    routeFetch({});
    const promise = fetchResolvedMarkets();
    await vi.runAllTimersAsync();
    await promise;

    expect(mockFetch).toHaveBeenCalledTimes(4);
    for (const [url] of mockFetch.mock.calls) {
      expect(url).toMatch(/^\/gamma-api\/markets\/keyset\?/);
      expect(url).toContain('closed=true');
      expect(url).toContain('limit=100');
      expect(url).toContain('order=volumeNum&ascending=false');
      expect(url).not.toContain('offset=');
    }
    expect(urlsFor('5000000')[0]).not.toContain('volume_num_max');
    expect(urlsFor('bottom')[0]).toContain('volume_num_max=2500000');
  });

  it('follows next_cursor until a page has none', async () => {
    routeFetch({
      5000000: {
        start: () => keysetResponse(makeResolvedMarkets(100, 0), 'c1'),
        c1: () => keysetResponse(makeResolvedMarkets(100, 100), 'c 2'),
        'c 2': () => keysetResponse(makeResolvedMarkets(40, 200)),
      },
    });
    const promise = fetchResolvedMarkets();
    await vi.runAllTimersAsync();
    const result = await promise;

    const urls = urlsFor('5000000');
    expect(urls).toHaveLength(3);
    expect(urls[1]).toContain('after_cursor=c1');
    expect(urls[2]).toContain('after_cursor=c%202');
    expect(result.resolvedMarkets).toHaveLength(240);
  });

  it('orders results by band (descending volume) and dedupes markets on a band edge', async () => {
    const edge = makeResolvedMarkets(1, 999)[0];
    routeFetch({
      5000000: { start: () => keysetResponse([...makeResolvedMarkets(2, 0), edge]) },
      3500000: { start: () => keysetResponse([edge, ...makeResolvedMarkets(2, 10)]) },
      bottom: { start: () => keysetResponse(makeResolvedMarkets(2, 20)) },
    });
    const promise = fetchResolvedMarkets();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.resolvedMarkets.map((m) => m.id)).toEqual([
      'rm-0', 'rm-1', 'rm-999', 'rm-10', 'rm-11', 'rm-20', 'rm-21',
    ]);
  });

  it('stops the open-ended bottom band at MAX_RESOLVED (5000) and truncates to it', async () => {
    let next = 0;
    const endlessPage = () => {
      const page = makeResolvedMarkets(100, next);
      next += 100;
      return keysetResponse(page, 'more');
    };
    routeFetch({
      5000000: { start: () => keysetResponse(makeResolvedMarkets(30, 100_000)) },
      bottom: { start: endlessPage, more: endlessPage },
    });
    const promise = fetchResolvedMarkets();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.resolvedMarkets).toHaveLength(5000);
    expect(result.resolvedMarkets[0].id).toBe('rm-100000'); // top band first
    expect(urlsFor('bottom')).toHaveLength(50);
  });

  it('only keeps markets with a resolved outcome', async () => {
    const unresolved = { id: 'open-1', question: 'Still open?' };
    routeFetch({ 5000000: { start: () => keysetResponse([unresolved, ...makeResolvedMarkets(3)]) } });
    const promise = fetchResolvedMarkets();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.resolvedMarkets.map((m) => m.id)).toEqual(['rm-0', 'rm-1', 'rm-2']);
  });

  it('ends a band at once on a 422 (no retries) and keeps its earlier pages', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    routeFetch({
      5000000: {
        start: () => keysetResponse(makeResolvedMarkets(100), 'bad'),
        bad: () => new Response(JSON.stringify({ type: 'validation error', error: 'invalid cursor' }), { status: 422 }),
      },
    });
    const promise = fetchResolvedMarkets();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(urlsFor('5000000')).toHaveLength(2);
    expect(callsWithCursor('bad')).toHaveLength(1);
    expect(result.resolvedMarkets).toHaveLength(100);
  });

  it('retries a 5xx page with backoff', async () => {
    let attempts = 0;
    routeFetch({
      5000000: {
        start: () => {
          attempts++;
          return attempts <= 2
            ? new Response('Server Error', { status: 500 })
            : keysetResponse(makeResolvedMarkets(10));
        },
      },
    });
    const promise = fetchResolvedMarkets();
    // fetchResolvedPage retries with 1000 * (attempt + 1) delay
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(attempts).toBe(3);
    expect(result.resolvedMarkets).toHaveLength(10);
  });

  it('reads Retry-After header on 429', async () => {
    let attempts = 0;
    routeFetch({
      5000000: {
        start: () => {
          attempts++;
          return attempts === 1
            ? new Response('Rate limited', { status: 429, headers: { 'Retry-After': '5' } })
            : keysetResponse(makeResolvedMarkets(10));
        },
      },
    });
    const promise = fetchResolvedMarkets();
    await vi.advanceTimersByTimeAsync(4999);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(attempts).toBe(2);
    expect(result.resolvedMarkets).toHaveLength(10);
  });

  it('stops every band on a persistent 429 and keeps the markets fetched so far', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    routeFetch({
      5000000: {
        start: () => keysetResponse(makeResolvedMarkets(100), 'next'),
        next: () => new Response('Rate limited', { status: 429, headers: { 'Retry-After': '1' } }),
      },
      bottom: {
        start: () => keysetResponse(makeResolvedMarkets(100, 500), 'b1'),
        // Resolves only after the top band has given up on its 429 retries
        b1: () => new Promise((resolve) => {
          setTimeout(() => resolve(keysetResponse(makeResolvedMarkets(100, 600), 'b2')), 10_000);
        }),
        b2: () => keysetResponse(makeResolvedMarkets(100, 700)),
      },
    });
    const promise = fetchResolvedMarkets();
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(callsWithCursor('next')).toHaveLength(3);
    expect(callsWithCursor('b2')).toHaveLength(0);
    expect(result.resolvedMarkets).toHaveLength(300);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Rate limited'), 300, expect.any(String));
  });

  it('returns partial results when the signal aborts', async () => {
    const controller = new AbortController();
    routeFetch({
      5000000: {
        start: () => keysetResponse(makeResolvedMarkets(100), 'next'),
        next: () => {
          controller.abort();
          return Promise.reject(new DOMException('Aborted', 'AbortError'));
        },
      },
    });
    const promise = fetchResolvedMarkets(controller.signal);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.resolvedMarkets).toHaveLength(100);
    expect(callsWithCursor('next')).toHaveLength(1);
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

  it('buckets by full lifetime duration (created → end)', () => {
    // makeResolved: created 60d ago, ended 30d ago → 30-day lifetime → 8-30d
    const markets = [makeResolved('Yes'), makeResolved('No')];
    const rates = computeBaseRates(markets);
    expect(rates.byDuration['8-30d'].total).toBe(2);
    expect(rates.byDuration['8-30d'].yesResolved).toBe(1);
    expect(rates.byCategoryAndDuration['Other|8-30d'].total).toBe(2);
  });

  it('does not build price buckets (post-resolution prices are settlement values)', () => {
    const rates = computeBaseRates([makeResolved('Yes', [0.99, 0.01])]);
    expect(rates.byPriceBucket).toBeUndefined();
    expect(rates.byCategoryAndPrice).toBeUndefined();
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
    global: { total: 100, yesResolved: 50 },                                  // 50%
    byCategory: { Other: { total: 50, yesResolved: 25 } },                    // 50%
    byDuration: { '8-30d': { total: 20, yesResolved: 10 } },                  // 50%
    byCategoryAndDuration: { 'Other|8-30d': { total: 20, yesResolved: 12 } }, // 60%
  };

  it('returns null when baseRates has < 20 global samples', () => {
    const result = analyzeBaseRate(
      { yesPrice: 0.55, category: 'Other', durationDays: 15 },
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
      { yesPrice: 0.55, category: 'Other', durationDays: 15 },
      baseRates,
    );
    expect(result).not.toBeNull();
    // Weighted: catDur(60%×3) + cat(50%×2) + dur(50%×1) = 3.3/6 = 0.55
    expect(result.baseRate).toBeCloseTo(0.55, 4);
    expect(result.marketPrice).toBe(0.55);
    expect(result.sources.length).toBe(3);
  });

  it('matches duration buckets on durationDays (full lifetime), not daysLeft', () => {
    // durationDays 15 → '8-30d' bucket matches; daysLeft should be ignored
    const result = analyzeBaseRate(
      { yesPrice: 0.55, category: 'Other', durationDays: 15, daysLeft: 200 },
      baseRates,
    );
    expect(result.durationBucket).toBe('8-30d');
    expect(result.sources.some((s) => s.label === 'Duration 8-30d')).toBe(true);
  });

  it('classifies NARRATIVE_PREMIUM when market overprices YES', () => {
    // Market at 85¢, base rate 55% → gap = +30¢ → NARRATIVE_PREMIUM
    const result = analyzeBaseRate(
      { yesPrice: 0.85, category: 'Other', durationDays: 15 },
      baseRates,
    );
    expect(result.gapType).toBe('NARRATIVE_PREMIUM');
    expect(result.suggestion).toBe('BUY_NO');
  });

  it('classifies NARRATIVE_DISCOUNT when market underprices YES', () => {
    // Market at 25¢, base rate 55% → gap = -30¢ → NARRATIVE_DISCOUNT
    const result = analyzeBaseRate(
      { yesPrice: 0.25, category: 'Other', durationDays: 15 },
      baseRates,
    );
    expect(result.gapType).toBe('NARRATIVE_DISCOUNT');
    expect(result.suggestion).toBe('BUY_YES');
  });

  it('classifies FAIR when gap < 3¢', () => {
    // Weighted base rate ≈ 0.55; market at 56¢ → gap ≈ 1¢
    const result = analyzeBaseRate(
      { yesPrice: 0.56, category: 'Other', durationDays: 15 },
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
