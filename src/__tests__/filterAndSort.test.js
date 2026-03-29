import { describe, it, expect, afterEach, vi } from 'vitest';
import { filterAndSort } from '../utils/filterAndSort';
import { makeProcessedMarket as mkMarket } from './helpers/marketFixtures';

afterEach(() => { vi.restoreAllMocks(); });

// ── Helpers ──────────────────────────────────────────────────────

const DEFAULT_FILTERS = {
  search: '',
  volumeRange: [0, 50_000_000],
  yesPriceRange: [0, 100],
  noPriceRange: [0, 100],
  daysLeftRange: [0, 365],
  categories: [],
  sortBy: 'edgeScore',
  sortAsc: false,
  perPage: 50,
  flbOnly: false,
  minTheta: 0,
  hideDeadMoney: false,
  resolutionTypes: [],
  minStrictness: 0,
  volPriorities: [],
  hideEfficient: false,
  minEstEdge: 0,
  minNarrativeGap: 0,
  baseRateConfidence: 'any',
  conjunctionTypes: [],
  minConjunctionGap: 0,
  highlightHeld: true,
  hideHeld: false,
  showPortfolioFit: true,
  flowDirection: 'any',
  leaderboardActive: false,
  relevantExpertActive: false,
};

const NO_LOOKUP = { isLookupActive: false, fetchedMarkets: [], foundInLoadedId: null };
const NO_PORTFOLIO = { hasPortfolio: false, isMarketHeld: () => false };

function run(opts = {}) {
  return filterAndSort({
    markets: opts.markets || [],
    filters: { ...DEFAULT_FILTERS, ...opts.filters },
    searchLower: opts.searchLower || '',
    lookupState: opts.lookupState || NO_LOOKUP,
    portfolio: opts.portfolio || NO_PORTFOLIO,
  });
}

// ── Tests ────────────────────────────────────────────────────────

describe('filterAndSort', () => {
  // ── Empty / edge cases ──

  it('returns empty array for empty markets', () => {
    expect(run({ markets: [] })).toEqual([]);
  });

  it('returns all markets when no filters applied', () => {
    const markets = [mkMarket({ id: 'a' }), mkMarket({ id: 'b' })];
    expect(run({ markets })).toHaveLength(2);
  });

  // ── Lookup short-circuit ──

  it('returns fetchedMarkets when lookup is active with results', () => {
    const fetched = [mkMarket({ id: 'fetched-1' })];
    const markets = [mkMarket({ id: 'loaded-1' }), mkMarket({ id: 'loaded-2' })];
    const result = run({
      markets,
      lookupState: { isLookupActive: true, fetchedMarkets: fetched, foundInLoadedId: null },
    });
    expect(result).toEqual(fetched);
  });

  it('does NOT short-circuit when lookup active but fetchedMarkets empty', () => {
    const markets = [mkMarket({ id: 'a' })];
    const result = run({
      markets,
      lookupState: { isLookupActive: true, fetchedMarkets: [], foundInLoadedId: null },
    });
    expect(result).toHaveLength(1);
  });

  // ── Pinned market (foundInLoadedId) ──

  it('pins found-in-loaded market to top of results regardless of sort', () => {
    const markets = [
      mkMarket({ id: 'low', edgeScore: 10 }),
      mkMarket({ id: 'high', edgeScore: 90 }),
    ];
    const result = run({
      markets,
      filters: { sortBy: 'edgeScore', sortAsc: false },
      lookupState: { isLookupActive: true, fetchedMarkets: [], foundInLoadedId: 'low' },
    });
    expect(result[0].id).toBe('low');
  });

  it('pinned market bypasses all filters', () => {
    const markets = [mkMarket({ id: 'pinned', volume: 0 })]; // volume=0 would be filtered out
    const result = run({
      markets,
      filters: { volumeRange: [1000, 50_000_000] },
      lookupState: { isLookupActive: true, fetchedMarkets: [], foundInLoadedId: 'pinned' },
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('pinned');
  });

  // ── Volume filter ──

  it('filters markets below volume minimum', () => {
    const markets = [mkMarket({ id: 'low', volume: 50 }), mkMarket({ id: 'high', volume: 5000 })];
    const result = run({ markets, filters: { volumeRange: [1000, 50_000_000] } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('high');
  });

  it('filters markets above volume maximum', () => {
    const markets = [mkMarket({ id: 'a', volume: 100 }), mkMarket({ id: 'b', volume: 200_000 })];
    const result = run({ markets, filters: { volumeRange: [0, 100_000] } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  // ── Yes/No price filter ──

  it('filters by yes price range (converted to cents)', () => {
    const markets = [
      mkMarket({ id: 'a', yesPrice: 0.30 }), // 30 cents
      mkMarket({ id: 'b', yesPrice: 0.70 }), // 70 cents
    ];
    const result = run({ markets, filters: { yesPriceRange: [40, 80] } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('b');
  });

  it('filters by no price range', () => {
    const markets = [
      mkMarket({ id: 'a', noPrice: 0.20 }),
      mkMarket({ id: 'b', noPrice: 0.60 }),
    ];
    const result = run({ markets, filters: { noPriceRange: [50, 100] } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('b');
  });

  it('passes markets with null yesPrice through price filter', () => {
    const markets = [mkMarket({ id: 'a', yesPrice: null })];
    const result = run({ markets, filters: { yesPriceRange: [40, 80] } });
    expect(result).toHaveLength(1);
  });

  // ── Days left filter ──

  it('filters by daysLeft range', () => {
    const markets = [
      mkMarket({ id: 'a', daysLeft: 5 }),
      mkMarket({ id: 'b', daysLeft: 100 }),
    ];
    const result = run({ markets, filters: { daysLeftRange: [10, 365] } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('b');
  });

  it('passes markets with null daysLeft through days filter', () => {
    const markets = [mkMarket({ id: 'a', daysLeft: null })];
    const result = run({ markets, filters: { daysLeftRange: [10, 365] } });
    expect(result).toHaveLength(1);
  });

  // ── Category filter ──

  it('filters by category', () => {
    const markets = [
      mkMarket({ id: 'a', category: 'Sports' }),
      mkMarket({ id: 'b', category: 'Politics' }),
    ];
    const result = run({ markets, filters: { categories: ['Politics'] } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('b');
  });

  it('allows multiple categories', () => {
    const markets = [
      mkMarket({ id: 'a', category: 'Sports' }),
      mkMarket({ id: 'b', category: 'Politics' }),
      mkMarket({ id: 'c', category: 'Tech' }),
    ];
    const result = run({ markets, filters: { categories: ['Sports', 'Tech'] } });
    expect(result).toHaveLength(2);
  });

  // ── Boolean toggles ──

  it('flbOnly filters to FLB opportunities', () => {
    const markets = [
      mkMarket({ id: 'a', flb: { isBiasOpportunity: true, bestEdge: 0.1 } }),
      mkMarket({ id: 'b', flb: null }),
      mkMarket({ id: 'c', flb: { isBiasOpportunity: false } }),
    ];
    const result = run({ markets, filters: { flbOnly: true } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  it('hideDeadMoney filters theta DEAD_MONEY zones', () => {
    const markets = [
      mkMarket({ id: 'a', theta: { zones: ['DEAD_MONEY'], bestTheta: 0.01 } }),
      mkMarket({ id: 'b', theta: { zones: ['OPPORTUNITY'], bestTheta: 0.05 } }),
    ];
    const result = run({ markets, filters: { hideDeadMoney: true } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('b');
  });

  it('hideEfficient filters EFFICIENT priority markets', () => {
    const markets = [
      mkMarket({ id: 'a', volumeEfficiency: { priority: 'EFFICIENT' } }),
      mkMarket({ id: 'b', volumeEfficiency: { priority: 'HIGH' } }),
    ];
    const result = run({ markets, filters: { hideEfficient: true } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('b');
  });

  // ── Numeric thresholds ──

  it('minStrictness filters below threshold', () => {
    const markets = [
      mkMarket({ id: 'a', resolutionAnalysis: { strictness: { score: 30 } } }),
      mkMarket({ id: 'b', resolutionAnalysis: { strictness: { score: 80 } } }),
    ];
    const result = run({ markets, filters: { minStrictness: 50 } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('b');
  });

  it('minTheta filters markets with low theta (compared as percentage)', () => {
    const markets = [
      mkMarket({ id: 'a', theta: { bestTheta: 0.01 } }),  // 1%
      mkMarket({ id: 'b', theta: { bestTheta: 0.10 } }),  // 10%
    ];
    const result = run({ markets, filters: { minTheta: 5 } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('b');
  });

  it('minEstEdge filters below threshold (converted from pct to decimal)', () => {
    const markets = [
      mkMarket({ id: 'a', volumeEfficiency: { estimatedEdge: 0.02 } }),
      mkMarket({ id: 'b', volumeEfficiency: { estimatedEdge: 0.10 } }),
    ];
    const result = run({ markets, filters: { minEstEdge: 5 } }); // 5% = 0.05
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('b');
  });

  it('minNarrativeGap filters below threshold', () => {
    const markets = [
      mkMarket({ id: 'a', baseRate: { absGapCents: 3 } }),
      mkMarket({ id: 'b', baseRate: { absGapCents: 15 } }),
    ];
    const result = run({ markets, filters: { minNarrativeGap: 10 } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('b');
  });

  // ── Resolution types ──

  it('filters by resolution type with HIGH confidence', () => {
    const markets = [
      mkMarket({ id: 'a', resolutionAnalysis: { characteristics: [{ type: 'BINARY', confidence: 'HIGH' }] } }),
      mkMarket({ id: 'b', resolutionAnalysis: { characteristics: [{ type: 'BINARY', confidence: 'LOW' }] } }),
      mkMarket({ id: 'c', resolutionAnalysis: null }),
    ];
    const result = run({ markets, filters: { resolutionTypes: ['BINARY'] } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  // ── Base rate confidence ──

  it('filters by baseRateConfidence HIGH', () => {
    const markets = [
      mkMarket({ id: 'a', baseRate: { confidence: 'HIGH', absGapCents: 5 } }),
      mkMarket({ id: 'b', baseRate: { confidence: 'MEDIUM', absGapCents: 5 } }),
      mkMarket({ id: 'c', baseRate: null }),
    ];
    const result = run({ markets, filters: { baseRateConfidence: 'HIGH' } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  it('baseRateConfidence MEDIUM allows HIGH and MEDIUM', () => {
    const markets = [
      mkMarket({ id: 'a', baseRate: { confidence: 'HIGH' } }),
      mkMarket({ id: 'b', baseRate: { confidence: 'MEDIUM' } }),
      mkMarket({ id: 'c', baseRate: { confidence: 'LOW' } }),
    ];
    const result = run({ markets, filters: { baseRateConfidence: 'MEDIUM' } });
    expect(result).toHaveLength(2);
  });

  // ── Conjunction types ──

  it('filters conjunction type NONE (non-conjunction markets only)', () => {
    const markets = [
      mkMarket({ id: 'a', conjunction: { isConjunction: true, type: 'AND' } }),
      mkMarket({ id: 'b', conjunction: null }),
    ];
    const result = run({ markets, filters: { conjunctionTypes: ['NONE'] } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('b');
  });

  it('filters conjunction type AND', () => {
    const markets = [
      mkMarket({ id: 'a', conjunction: { isConjunction: true, type: 'AND', gapPp: 5 } }),
      mkMarket({ id: 'b', conjunction: { isConjunction: true, type: 'OR', gapPp: 3 } }),
      mkMarket({ id: 'c', conjunction: null }),
    ];
    const result = run({ markets, filters: { conjunctionTypes: ['AND'] } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  it('minConjunctionGap filters by absolute gap', () => {
    const markets = [
      mkMarket({ id: 'a', conjunction: { isConjunction: true, gapPp: 2 } }),
      mkMarket({ id: 'b', conjunction: { isConjunction: true, gapPp: 10 } }),
      mkMarket({ id: 'c', conjunction: null }),
    ];
    const result = run({ markets, filters: { minConjunctionGap: 5 } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('b');
  });

  // ── Portfolio: hideHeld ──

  it('hideHeld filters out held markets', () => {
    const heldSet = new Set(['a']);
    const markets = [mkMarket({ id: 'a' }), mkMarket({ id: 'b' })];
    const result = run({
      markets,
      filters: { hideHeld: true },
      portfolio: { hasPortfolio: true, isMarketHeld: (id) => heldSet.has(id) },
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('b');
  });

  it('hideHeld has no effect when no portfolio', () => {
    const markets = [mkMarket({ id: 'a' }), mkMarket({ id: 'b' })];
    const result = run({
      markets,
      filters: { hideHeld: true },
      portfolio: NO_PORTFOLIO,
    });
    expect(result).toHaveLength(2);
  });

  // ── Vol priorities ──

  it('filters by volume efficiency priority', () => {
    const markets = [
      mkMarket({ id: 'a', volumeEfficiency: { priority: 'HIGH' } }),
      mkMarket({ id: 'b', volumeEfficiency: { priority: 'LOW' } }),
      mkMarket({ id: 'c', volumeEfficiency: null }),
    ];
    const result = run({ markets, filters: { volPriorities: ['HIGH'] } });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  // ── Search (string matching) ──

  it('filters by search in question (case-insensitive)', () => {
    const markets = [
      mkMarket({ id: 'a', question: 'Will Bitcoin hit 100k?' }),
      mkMarket({ id: 'b', question: 'Will it snow tomorrow?' }),
    ];
    const result = run({ markets, searchLower: 'bitcoin' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  it('falls back to description when question does not match', () => {
    const markets = [
      mkMarket({ id: 'a', question: 'Market A', description: 'About Ethereum price' }),
      mkMarket({ id: 'b', question: 'Market B', description: 'About sports' }),
    ];
    const result = run({ markets, searchLower: 'ethereum' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  it('search is ignored when lookup is active', () => {
    const markets = [mkMarket({ id: 'a', question: 'No match here' })];
    const result = run({
      markets,
      searchLower: 'bitcoin',
      lookupState: { isLookupActive: true, fetchedMarkets: [], foundInLoadedId: 'a' },
    });
    expect(result).toHaveLength(1);
  });

  // ── Sorting ──

  it('sorts by edgeScore descending by default', () => {
    const markets = [
      mkMarket({ id: 'low', edgeScore: 20 }),
      mkMarket({ id: 'high', edgeScore: 80 }),
      mkMarket({ id: 'mid', edgeScore: 50 }),
    ];
    const result = run({ markets, filters: { sortBy: 'edgeScore', sortAsc: false } });
    expect(result.map((m) => m.id)).toEqual(['high', 'mid', 'low']);
  });

  it('sorts ascending when sortAsc is true', () => {
    const markets = [
      mkMarket({ id: 'low', edgeScore: 20 }),
      mkMarket({ id: 'high', edgeScore: 80 }),
    ];
    const result = run({ markets, filters: { sortBy: 'edgeScore', sortAsc: true } });
    expect(result.map((m) => m.id)).toEqual(['low', 'high']);
  });

  it('sorts by volume', () => {
    const markets = [
      mkMarket({ id: 'a', volume: 1000 }),
      mkMarket({ id: 'b', volume: 50000 }),
    ];
    const result = run({ markets, filters: { sortBy: 'volume', sortAsc: false } });
    expect(result[0].id).toBe('b');
  });

  it('sorts by flbEdge', () => {
    const markets = [
      mkMarket({ id: 'a', flb: { bestEdge: 0.05 } }),
      mkMarket({ id: 'b', flb: { bestEdge: 0.15 } }),
      mkMarket({ id: 'c', flb: null }),
    ];
    const result = run({ markets, filters: { sortBy: 'flbEdge', sortAsc: false } });
    expect(result[0].id).toBe('b');
    expect(result[2].id).toBe('c'); // null → 0
  });

  it('sorts by theta (absolute value)', () => {
    const markets = [
      mkMarket({ id: 'a', theta: { bestTheta: -0.08 } }),
      mkMarket({ id: 'b', theta: { bestTheta: 0.03 } }),
    ];
    const result = run({ markets, filters: { sortBy: 'theta', sortAsc: false } });
    expect(result[0].id).toBe('a'); // |0.08| > |0.03|
  });

  it('sorts by conjunctionGap (absolute value)', () => {
    const markets = [
      mkMarket({ id: 'a', conjunction: { gapPp: -10 } }),
      mkMarket({ id: 'b', conjunction: { gapPp: 5 } }),
    ];
    const result = run({ markets, filters: { sortBy: 'conjunctionGap', sortAsc: false } });
    expect(result[0].id).toBe('a'); // |10| > |5|
  });

  it('sorts by baseRateGap', () => {
    const markets = [
      mkMarket({ id: 'a', baseRate: { absGapCents: 3 } }),
      mkMarket({ id: 'b', baseRate: { absGapCents: 12 } }),
    ];
    const result = run({ markets, filters: { sortBy: 'baseRateGap', sortAsc: false } });
    expect(result[0].id).toBe('b');
  });

  // ── Combined filters ──

  it('applies multiple filters simultaneously', () => {
    const markets = [
      mkMarket({ id: 'a', volume: 5000, category: 'Politics', edgeScore: 80 }),
      mkMarket({ id: 'b', volume: 500, category: 'Politics', edgeScore: 90 }),  // filtered: volume
      mkMarket({ id: 'c', volume: 5000, category: 'Sports', edgeScore: 70 }),   // filtered: category
      mkMarket({ id: 'd', volume: 5000, category: 'Politics', edgeScore: 60 }),
    ];
    const result = run({
      markets,
      filters: { volumeRange: [1000, 50_000_000], categories: ['Politics'], sortBy: 'edgeScore', sortAsc: false },
    });
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('a');
    expect(result[1].id).toBe('d');
  });

  // ── Defensive / error paths ──

  it('does not throw on null markets array', () => {
    expect(() => run({ markets: null })).not.toThrow();
  });

  it('does not throw on undefined markets', () => {
    expect(() => run({ markets: undefined })).not.toThrow();
  });

  it('does not throw when optional filter arrays are empty', () => {
    expect(() => run({
      markets: [mkMarket({ id: 'a' })],
      filters: { categories: [], resolutionTypes: [], volPriorities: [], conjunctionTypes: [] },
    })).not.toThrow();
  });

  it('handles market with all null fields', () => {
    const broken = mkMarket({
      id: 'null-market',
      question: null,
      description: null,
      volume: null,
      yesPrice: null,
      noPrice: null,
      daysLeft: null,
      category: null,
      edgeScore: null,
    });
    expect(() => run({ markets: [broken] })).not.toThrow();
  });

  it('handles NaN in numeric filter ranges', () => {
    expect(() => run({
      markets: [mkMarket({ id: 'a' })],
      filters: { volumeRange: [NaN, NaN] },
    })).not.toThrow();
  });

  it('handles Infinity in filter ranges', () => {
    expect(() => run({
      markets: [mkMarket({ id: 'a' })],
      filters: { volumeRange: [0, Infinity] },
    })).not.toThrow();
  });
});
