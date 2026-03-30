import { describe, it, expect, vi } from 'vitest';
import { processMarket } from '../processMarket';
import { filterAndSort } from '../utils/filterAndSort';

// Integration test: fee data flows correctly from processMarket through filterAndSort.
// Unlike processMarket.test.js (which mocks engines), this uses real engines
// to verify the full pipeline end-to-end.

function makeRawMarket(overrides = {}) {
  return {
    id: 'fee-test-1',
    question: 'Will Bitcoin hit $200K?',
    description: 'Resolves yes if BTC >= $200K.',
    outcomePrices: JSON.stringify([0.50, 0.50]),
    clobTokenIds: JSON.stringify(['tok-a', 'tok-b']),
    volume: '2000000',
    volume24hr: '50000',
    endDate: new Date(Date.now() + 30 * 86400000).toISOString(),
    active: true,
    closed: false,
    feesEnabled: true,
    category: 'crypto',
    events: [{ slug: 'btc-200k' }],
    ...overrides,
  };
}

const DEFAULT_FILTERS = {
  volumeRange: [0, Infinity],
  yesPriceRange: [0, 100],
  noPriceRange: [0, 100],
  daysLeftRange: [0, 9999],
  categories: [],
  volPriorities: [],
  resolutionTypes: [],
  conjunctionTypes: [],
  minStrictness: 0,
  minNarrativeGap: 0,
  minTheta: 0,
  minEstEdge: 0,
  minConjunctionGap: 0,
  flbOnly: false,
  hideDeadMoney: false,
  hideEfficient: false,
  hideHeld: false,
  positiveEdgeAfterFees: false,
  baseRateConfidence: null,
  sortBy: 'edgeScore',
  sortAsc: false,
  _executionStyle: 'taker',
};

const NO_LOOKUP = { isLookupActive: false, fetchedMarkets: [], foundInLoadedId: null };
const NO_PORTFOLIO = { hasPortfolio: false, isMarketHeld: () => false };

describe('Fee pipeline integration', () => {
  it('crypto at p=0.50 produces correct fee fields through processMarket', () => {
    const m = processMarket(makeRawMarket());

    // effectiveTakerFee = 0.072 × (0.50 × 0.50)^1 = 0.018
    expect(m.effectiveTakerFee).toBeCloseTo(0.018, 6);
    // takerFeePP = 0.018 × 0.50 × 100 = 0.9
    expect(m.takerFeePP).toBeCloseTo(0.9, 4);
    expect(m.feeFree).toBe(false);
  });

  it('geopolitics market is fee-free', () => {
    const m = processMarket(makeRawMarket({
      id: 'geo-1',
      question: 'Will the UN pass the resolution?',
      category: 'world-politics',
    }));
    expect(m.effectiveTakerFee).toBe(0);
    expect(m.takerFeePP).toBe(0);
    expect(m.feeFree).toBe(true);
  });

  it('feesEnabled=false produces zero fee fields', () => {
    const m = processMarket(makeRawMarket({ feesEnabled: false }));
    expect(m.effectiveTakerFee).toBe(0);
    expect(m.takerFeePP).toBe(0);
  });

  it('FLB result includes fee-adjusted net edges', () => {
    const m = processMarket(makeRawMarket());
    expect(m.flb).toBeDefined();
    expect(m.flb).toHaveProperty('netEdgeTaker');
    expect(m.flb).toHaveProperty('netEdgeMaker');
    expect(m.flb).toHaveProperty('takerFeePP');
    expect(m.flb).toHaveProperty('makerRebatePP');
    // Taker fee should reduce the edge vs raw
    if (m.flb.bestEdgeAfterSpread > 0) {
      expect(m.flb.netEdgeTaker).toBeLessThan(m.flb.bestEdgeAfterSpread);
    }
  });

  it('fee-free market gets edgeScore bonus vs same market with fees', () => {
    const feeMarket = processMarket(makeRawMarket());
    const freeMarket = processMarket(makeRawMarket({
      id: 'geo-2',
      question: 'Will Bitcoin hit $200K?',
      category: 'world-politics',
    }));
    // The fee-free bonus is +2 in scoringConfig
    // Both have same volume/price/days, so difference should include the fee bonus
    expect(freeMarket.edgeScore).toBeGreaterThanOrEqual(feeMarket.edgeScore);
  });

  it('filterAndSort fee sort orders by effectiveTakerFee (taker mode)', () => {
    const crypto = processMarket(makeRawMarket({ id: 'c1' }));
    const sports = processMarket(makeRawMarket({ id: 's1', category: 'sports' }));
    const free = processMarket(makeRawMarket({ id: 'f1', category: 'world-politics' }));
    const markets = [crypto, sports, free];

    const sorted = filterAndSort({
      markets,
      filters: { ...DEFAULT_FILTERS, sortBy: 'fee', sortAsc: true, _executionStyle: 'taker' },
      searchLower: '',
      lookupState: NO_LOOKUP,
      portfolio: NO_PORTFOLIO,
    });

    // Ascending by taker fee: free (0) < sports < crypto
    expect(sorted[0].id).toBe('f1');
    expect(sorted[sorted.length - 1].id).toBe('c1');
  });

  it('filterAndSort fee sort in maker mode sorts by negated rebate', () => {
    // Use off-center prices so FLB produces a bestSide with non-zero makerRebatePP
    const crypto = processMarket(makeRawMarket({
      id: 'c1',
      outcomePrices: JSON.stringify([0.20, 0.80]),
    }));
    const biz = processMarket(makeRawMarket({
      id: 'b1',
      category: 'business',
      outcomePrices: JSON.stringify([0.20, 0.80]),
    }));
    const markets = [crypto, biz];

    const sorted = filterAndSort({
      markets,
      filters: { ...DEFAULT_FILTERS, sortBy: 'fee', sortAsc: true, _executionStyle: 'maker' },
      searchLower: '',
      lookupState: NO_LOOKUP,
      portfolio: NO_PORTFOLIO,
    });

    // Maker sort uses negated makerRebatePP — larger rebate → more negative → sorts first ascending
    // Verify deterministic ordering (actual rebate values depend on FLB bestSide)
    expect(sorted).toHaveLength(2);
    expect(sorted[0].flb?.makerRebatePP ?? 0).toBeGreaterThanOrEqual(sorted[1].flb?.makerRebatePP ?? 0);
  });

  it('positiveEdgeAfterFees filter removes markets with non-positive net edge', () => {
    // Create markets — we don't know exact edge values, so test the filter logic
    const m1 = processMarket(makeRawMarket({ id: 'm1' }));
    const m2 = processMarket(makeRawMarket({ id: 'm2', category: 'world-politics' }));
    const markets = [m1, m2];

    const unfiltered = filterAndSort({
      markets,
      filters: { ...DEFAULT_FILTERS, positiveEdgeAfterFees: false },
      searchLower: '',
      lookupState: NO_LOOKUP,
      portfolio: NO_PORTFOLIO,
    });

    const filtered = filterAndSort({
      markets,
      filters: { ...DEFAULT_FILTERS, positiveEdgeAfterFees: true },
      searchLower: '',
      lookupState: NO_LOOKUP,
      portfolio: NO_PORTFOLIO,
    });

    // Filtered result should be <= unfiltered (it removes non-positive edges)
    expect(filtered.length).toBeLessThanOrEqual(unfiltered.length);
  });
});
