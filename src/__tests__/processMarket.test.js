import { describe, it, expect, afterEach, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); });
import { processMarket, calculateEdgeScore, enrichWithBaseRate, ALL_CATEGORIES } from '../processMarket';
import { analyzeFLB } from '../FLBEngine';
import { analyzeBaseRate } from '../BaseRateEngine';

// Mock all engine modules — processMarket.js is pure computation; we test the
// wiring and scoring logic, not the engines themselves.
vi.mock('../ConjunctionEngine', () => ({
  analyzeConjunction: vi.fn(() => null),
  conjunctionEdgeBonus: vi.fn(() => 0),
}));
vi.mock('../FLBEngine', () => ({
  analyzeFLB: vi.fn(() => null),
}));
vi.mock('../ThetaEngine', () => ({
  analyzeTheta: vi.fn(() => null),
}));
vi.mock('../ResolutionAnalyzer', () => ({
  analyzeResolution: vi.fn(() => null),
}));
vi.mock('../VolumeEfficiencyEngine', () => ({
  analyzeVolumeEfficiency: vi.fn(() => null),
}));
vi.mock('../BaseRateEngine', () => ({
  analyzeBaseRate: vi.fn(() => null),
}));

// ---------- helpers ----------

// clobTokenIds is JSON-stringified here to match raw API format; makeMarket() in fixtures uses parsed arrays
function makeRawMarket(overrides = {}) {
  return {
    id: 'test-123',
    question: 'Will it rain tomorrow?',
    description: 'Resolves yes if it rains.',
    outcomePrices: JSON.stringify([0.55, 0.45]),
    clobTokenIds: JSON.stringify(['tok-a', 'tok-b']),
    volume: '2000000',
    volume24hr: '50000',
    endDate: new Date(Date.now() + 30 * 86400000).toISOString(), // 30 days out
    active: true,
    closed: false,
    events: [{ slug: 'will-it-rain' }],
    ...overrides,
  };
}

/** Minimal processed market for calculateEdgeScore */
function makeScoreInput(overrides = {}) {
  return {
    volume: 2_000_000,
    yesPrice: 0.50,
    noPrice: 0.50,
    daysLeft: 30,
    spread: 0.005,
    flb: null,
    theta: null,
    resolutionAnalysis: null,
    volumeEfficiency: null,
    baseRate: null,
    conjunction: null,
    ...overrides,
  };
}

// =====================================================================
// inferCategory (tested via processMarket's category output)
// =====================================================================

describe('inferCategory (via processMarket)', () => {
  it.each([
    ['Politics', 'Will Trump win the election?'],
    ['Crypto', 'Will Bitcoin reach $100K?'],
    ['Finance', 'Will the S&P 500 close above 5000?'],
    ['Sports', 'Will the NBA finals go to game 7?'],
    ['Geopolitics', 'Will Russia and Ukraine agree to ceasefire?'],
    ['Tech', 'Will OpenAI release GPT-5?'],
    ['Pop Culture', 'Will Taylor Swift win a Grammy?'],
    ['Science', 'Will the hurricane hit Florida this season?'],
    ['Legal', 'Will the Supreme Court ruling overturn the case?'],
  ])('categorizes "%s" from question: %s', (expected, question) => {
    const result = processMarket(makeRawMarket({ question }));
    expect(result.category).toBe(expected);
  });

  it('returns "Other" for unmatched questions', () => {
    const result = processMarket(makeRawMarket({ question: 'Will my coffee be cold?' }));
    expect(result.category).toBe('Other');
  });

  it('matches on slug when question has no keywords', () => {
    const result = processMarket(makeRawMarket({
      question: 'Will this happen?',
      events: [{ slug: 'bitcoin-price-prediction' }],
    }));
    expect(result.category).toBe('Crypto');
  });

  it('uses Gamma category when mapped', () => {
    const m = processMarket(makeRawMarket({
      question: 'Will my coffee be cold?',
      category: 'crypto',
    }));
    expect(m.category).toBe('Crypto');
  });

  it('falls back to regex when Gamma category is unmapped', () => {
    const m = processMarket(makeRawMarket({
      question: 'Will Bitcoin reach $100K?',
      category: 'something-unknown',
    }));
    expect(m.category).toBe('Crypto'); // regex catches "Bitcoin"
  });

  it('falls back to regex when Gamma category is empty', () => {
    const m = processMarket(makeRawMarket({
      question: 'Will Bitcoin reach $100K?',
      category: '',
    }));
    expect(m.category).toBe('Crypto');
  });
});

// =====================================================================
// processMarket
// =====================================================================

describe('processMarket', () => {
  it('parses prices correctly', () => {
    const m = processMarket(makeRawMarket());
    expect(m.yesPrice).toBe(0.55);
    expect(m.noPrice).toBe(0.45);
  });

  it('handles "0" price without treating it as falsy', () => {
    const m = processMarket(makeRawMarket({ outcomePrices: JSON.stringify(['0', '1']) }));
    expect(m.yesPrice).toBe(0);
    expect(m.noPrice).toBe(1);
  });

  it('handles missing outcomePrices gracefully', () => {
    const m = processMarket(makeRawMarket({ outcomePrices: null }));
    expect(m.yesPrice).toBeNull();
    expect(m.noPrice).toBeNull();
  });

  it('handles malformed JSON in outcomePrices', () => {
    const m = processMarket(makeRawMarket({ outcomePrices: 'not json' }));
    expect(m.yesPrice).toBeNull();
    expect(m.noPrice).toBeNull();
  });

  it('calculates daysLeft as non-negative', () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    const m = processMarket(makeRawMarket({ endDate: pastDate }));
    expect(m.daysLeft).toBe(0);
  });

  it('sets daysLeft to null when endDate is missing', () => {
    const m = processMarket(makeRawMarket({ endDate: null }));
    expect(m.daysLeft).toBeNull();
  });

  it('sets daysLeft to null when endDate is invalid', () => {
    const m = processMarket(makeRawMarket({ endDate: 'not-a-date' }));
    expect(m.daysLeft).toBeNull();
  });

  it('calculates spread correctly', () => {
    const m = processMarket(makeRawMarket({ outcomePrices: JSON.stringify([0.60, 0.38]) }));
    // spread = |1 - 0.60 - 0.38| = 0.02
    expect(m.spread).toBeCloseTo(0.02, 10);
  });

  it('initializes _engineFailures as empty array', () => {
    const m = processMarket(makeRawMarket());
    expect(m._engineFailures).toEqual([]);
  });

  it('tracks engine failures in _engineFailures', () => {
    analyzeFLB.mockImplementationOnce(() => { throw new Error('boom'); });
    const m = processMarket(makeRawMarket());
    expect(m._engineFailures).toContain('flb');
  });

  it('sets baseRate to null (injected later by consumers)', () => {
    const m = processMarket(makeRawMarket());
    expect(m.baseRate).toBeNull();
  });

  it('includes all expected fields', () => {
    const m = processMarket(makeRawMarket());
    const expectedKeys = [
      'id', 'question', 'slug', 'description', 'yesPrice', 'noPrice',
      'volume', 'volume24hr', 'daysLeft', 'endDate', 'category', 'edgeScore',
      'spread', 'flb', 'theta', 'resolutionAnalysis', 'volumeEfficiency',
      'baseRate', 'conjunction', 'conditionId', 'clobTokenIds', 'active',
      'closed', 'gammaBestBid', 'gammaBestAsk', 'gammaSpread',
      'oneDayPriceChange', 'lastTradePrice',
      'liquidityClob', 'liquidityAmm', 'competitive', 'negRisk',
      'commentCount', 'volume1wk', 'volume1mo', 'acceptingOrders',
      'feesEnabled', 'gammaCategory', '_engineFailures',
    ];
    for (const key of expectedKeys) {
      expect(m).toHaveProperty(key);
    }
  });

  // ── Gamma field extraction ──

  it('extracts oneDayPriceChange from API data', () => {
    const m = processMarket(makeRawMarket({ oneDayPriceChange: -0.005 }));
    expect(m.oneDayPriceChange).toBe(-0.005);
  });

  it('extracts lastTradePrice from API data', () => {
    const m = processMarket(makeRawMarket({ lastTradePrice: 0.36 }));
    expect(m.lastTradePrice).toBe(0.36);
  });

  it('defaults oneDayPriceChange and lastTradePrice to null when absent', () => {
    const m = processMarket(makeRawMarket());
    expect(m.oneDayPriceChange).toBeNull();
    expect(m.lastTradePrice).toBeNull();
  });

  it('uses bid-ask spread when gammaBestBid and gammaBestAsk are present', () => {
    const m = processMarket(makeRawMarket({ bestBid: 0.50, bestAsk: 0.56 }));
    expect(m.spread).toBeCloseTo(0.06);
    expect(m.gammaBestBid).toBe(0.50);
    expect(m.gammaBestAsk).toBe(0.56);
  });

  it('falls back to overround spread when bid/ask absent', () => {
    // yesPrice=0.55, noPrice=0.45 → overround = |1 - 0.55 - 0.45| = 0
    const m = processMarket(makeRawMarket());
    expect(m.spread).toBeCloseTo(0);
    expect(m.gammaBestBid).toBeNull();
    expect(m.gammaBestAsk).toBeNull();
  });

  it('extracts gammaSpread from API data', () => {
    const m = processMarket(makeRawMarket({ spread: 0.14 }));
    expect(m.gammaSpread).toBe(0.14);
  });

  it('defaults gammaBestBid, gammaBestAsk, gammaSpread to null when absent', () => {
    const m = processMarket(makeRawMarket());
    expect(m.gammaBestBid).toBeNull();
    expect(m.gammaBestAsk).toBeNull();
    expect(m.gammaSpread).toBeNull();
  });

  it('extracts market metadata fields when present', () => {
    const m = processMarket(makeRawMarket({
      liquidityClob: 5000,
      competitive: 0.85,
      negRisk: true,
      volume1wk: 100000,
      volume1mo: 500000,
      acceptingOrders: true,
      feesEnabled: true,
      category: 'crypto',
      events: [{ slug: 'test', liquidityAmm: 300, commentCount: 42 }],
    }));
    expect(m.liquidityClob).toBe(5000);
    expect(m.liquidityAmm).toBe(300);
    expect(m.competitive).toBe(0.85);
    expect(m.negRisk).toBe(true);
    expect(m.commentCount).toBe(42);
    expect(m.volume1wk).toBe(100000);
    expect(m.volume1mo).toBe(500000);
    expect(m.acceptingOrders).toBe(true);
    expect(m.feesEnabled).toBe(true);
    expect(m.gammaCategory).toBe('crypto');
  });

  it('defaults metadata fields to null/false when absent', () => {
    const m = processMarket(makeRawMarket());
    expect(m.liquidityClob).toBeNull();
    expect(m.liquidityAmm).toBeNull();
    expect(m.competitive).toBeNull();
    expect(m.negRisk).toBeNull();
    expect(m.commentCount).toBeNull();
    expect(m.volume1wk).toBeNull();
    expect(m.volume1mo).toBeNull();
    expect(m.acceptingOrders).toBeNull();
    expect(m.feesEnabled).toBe(false);
    expect(m.gammaCategory).toBeNull();
  });
});

// =====================================================================
// calculateEdgeScore
// =====================================================================

describe('calculateEdgeScore', () => {
  // --- Volume ---
  it.each([
    [2_000_000, 25], // sweet spot 1M-5M
    [750_000, 15],   // 500K-1M
    [7_000_000, 15], // 5M-10M
    [250_000, 10],   // 100K-500K
    [50_000, 0],     // below 100K
    [15_000_000, 0], // above 10M
  ])('volume %d → +%d', (volume, expectedBonus) => {
    const base = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: null, daysLeft: null, spread: null }));
    const withVolume = calculateEdgeScore(makeScoreInput({ volume, yesPrice: null, daysLeft: null, spread: null }));
    expect(withVolume - base).toBe(expectedBonus);
  });

  // --- Price ---
  it('mid-range price (25-75¢) → +25', () => {
    const score = calculateEdgeScore(makeScoreInput({ volume: 0, daysLeft: null, spread: null }));
    const noPrice = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: null, daysLeft: null, spread: null }));
    expect(score - noPrice).toBe(25);
  });

  it('longshot price (5-15¢) → +15', () => {
    const score = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: 0.10, noPrice: 0.90, daysLeft: null, spread: null }));
    // noPrice 90 is extreme, but yesPrice 10 hits longshot — wait, nc=90 so midrange check: yc=10 not in [25,75], nc=90 not in [25,75]. Then longshot: yc=10 in [5,15] → +15
    const noPrice = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: null, daysLeft: null, spread: null }));
    expect(score - noPrice).toBe(15);
  });

  it('extreme price (≥90¢) → +0', () => {
    const score = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: 0.95, noPrice: 0.05, daysLeft: null, spread: null }));
    // yc=95 ≥ 90 → extreme → 0 bonus. But wait: nc=5, check midrange: yc=95 not in [25,75], nc=5 not in [25,75]. Longshot: yc=95 not in [5,15]. Extreme: yc=95≥90 → no bonus.
    const noPrice = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: null, daysLeft: null, spread: null }));
    expect(score - noPrice).toBe(0);
  });

  // --- Days Left ---
  it.each([
    [30, 25],   // 14-56 sweet spot
    [7, 15],    // 0-13
    [90, 15],   // 57-120
    [200, 5],   // >180
    [150, 10],  // 121-180 default
  ])('daysLeft %d → +%d', (daysLeft, expectedBonus) => {
    const base = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: null, spread: null, daysLeft: null }));
    const withDays = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: null, spread: null, daysLeft }));
    expect(withDays - base).toBe(expectedBonus);
  });

  // --- Spread ---
  it('tight spread (<2%) → +25', () => {
    const base = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: 0.50, noPrice: 0.50, spread: 0.005, daysLeft: null }));
    const noSpread = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: null, daysLeft: null, spread: null }));
    // Price also scores +25, so isolate spread
    const priceOnly = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: 0.50, noPrice: 0.50, spread: null, daysLeft: null }));
    expect(base - priceOnly).toBe(25);
  });

  // --- FLB ---
  it('FLB bias opportunity → +15', () => {
    const base = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: null, daysLeft: null, spread: null }));
    const withFlb = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: null, daysLeft: null, spread: null, flb: { isBiasOpportunity: true } }));
    expect(withFlb - base).toBe(15);
  });

  it('FLB moderate edge → +8', () => {
    const base = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: null, daysLeft: null, spread: null }));
    const withFlb = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: null, daysLeft: null, spread: null, flb: { isModerateEdge: true } }));
    expect(withFlb - base).toBe(8);
  });

  // --- Theta ---
  it('high theta (>0.5¢/day) → +10', () => {
    const base = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: null, daysLeft: null, spread: null }));
    const withTheta = calculateEdgeScore(makeScoreInput({
      volume: 0, yesPrice: null, daysLeft: null, spread: null,
      theta: { bestTheta: 0.006, zones: [] }, // abs * 100 = 0.6 > 0.5
    }));
    expect(withTheta - base).toBe(10);
  });

  it('THETA_CRUSH_ZONE → +8', () => {
    const base = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: null, daysLeft: null, spread: null }));
    const withTheta = calculateEdgeScore(makeScoreInput({
      volume: 0, yesPrice: null, daysLeft: null, spread: null,
      theta: { bestTheta: 0, zones: ['THETA_CRUSH_ZONE'] },
    }));
    expect(withTheta - base).toBe(8);
  });

  it('DEAD_MONEY → -5', () => {
    const base = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: null, daysLeft: null, spread: null }));
    const withTheta = calculateEdgeScore(makeScoreInput({
      volume: 0, yesPrice: null, daysLeft: null, spread: null,
      theta: { bestTheta: 0, zones: ['DEAD_MONEY'] },
    }));
    expect(withTheta - base).toBe(-5);
  });

  // --- Volume efficiency ---
  it.each([
    ['SWEET_SPOT', 15],
    ['OPPORTUNITY', 8],
    ['MARGINAL', 3],
    ['LOW_LIQUIDITY', -5],
  ])('volume efficiency %s → %+d', (priority, expectedBonus) => {
    const base = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: null, daysLeft: null, spread: null }));
    const withVe = calculateEdgeScore(makeScoreInput({
      volume: 0, yesPrice: null, daysLeft: null, spread: null,
      volumeEfficiency: { priority },
    }));
    expect(withVe - base).toBe(expectedBonus);
  });

  // --- Base rate ---
  it('NARRATIVE_PREMIUM with large gap → +10', () => {
    const base = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: null, daysLeft: null, spread: null }));
    const withBr = calculateEdgeScore(makeScoreInput({
      volume: 0, yesPrice: null, daysLeft: null, spread: null,
      baseRate: { gapType: 'NARRATIVE_PREMIUM', absGapCents: 12, confidence: 'HIGH' },
    }));
    expect(withBr - base).toBe(10);
  });

  it('NARRATIVE_DISCOUNT with large gap → +8', () => {
    const base = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: null, daysLeft: null, spread: null }));
    const withBr = calculateEdgeScore(makeScoreInput({
      volume: 0, yesPrice: null, daysLeft: null, spread: null,
      baseRate: { gapType: 'NARRATIVE_DISCOUNT', absGapCents: 12, confidence: 'HIGH' },
    }));
    expect(withBr - base).toBe(8);
  });

  it('small gap (>5¢) → +5', () => {
    const base = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: null, daysLeft: null, spread: null }));
    const withBr = calculateEdgeScore(makeScoreInput({
      volume: 0, yesPrice: null, daysLeft: null, spread: null,
      baseRate: { gapType: 'OTHER', absGapCents: 7, confidence: 'HIGH' },
    }));
    expect(withBr - base).toBe(5);
  });

  it('LOW confidence base rate → +0', () => {
    const base = calculateEdgeScore(makeScoreInput({ volume: 0, yesPrice: null, daysLeft: null, spread: null }));
    const withBr = calculateEdgeScore(makeScoreInput({
      volume: 0, yesPrice: null, daysLeft: null, spread: null,
      baseRate: { gapType: 'NARRATIVE_PREMIUM', absGapCents: 12, confidence: 'LOW' },
    }));
    expect(withBr - base).toBe(0);
  });

  // --- Cap ---
  it('caps at 100', () => {
    const score = calculateEdgeScore(makeScoreInput({
      volume: 2_000_000,   // +25
      yesPrice: 0.50,      // +25 (mid-range)
      noPrice: 0.50,
      daysLeft: 30,        // +25
      spread: 0.001,       // +25 (< 2% of 0.50 mid)
      flb: { isBiasOpportunity: true }, // +15
      theta: { bestTheta: 0.006, zones: ['THETA_CRUSH_ZONE'] }, // +10 +8
      volumeEfficiency: { priority: 'SWEET_SPOT' }, // +15
    }));
    expect(score).toBe(100);
  });

  it('returns 0 when all inputs are null/empty', () => {
    const score = calculateEdgeScore(makeScoreInput({
      volume: 0, yesPrice: null, noPrice: null, daysLeft: null,
      spread: null, flb: null, theta: null,
      resolutionAnalysis: null, volumeEfficiency: null,
      baseRate: null, conjunction: null,
    }));
    expect(score).toBe(0);
  });
});

// =====================================================================
// enrichWithBaseRate
// =====================================================================

describe('enrichWithBaseRate', () => {
  const processed = {
    id: 'test-1',
    yesPrice: 0.50,
    noPrice: 0.50,
    volume: 2_000_000,
    daysLeft: 30,
    spread: 0.005,
    edgeScore: 50,
    baseRate: null,
    _engineFailures: [],
    flb: null,
    theta: null,
    resolutionAnalysis: null,
    volumeEfficiency: null,
    conjunction: null,
  };

  it('returns market unchanged when baseRates is null', () => {
    const result = enrichWithBaseRate(processed, null);
    expect(result).toBe(processed); // identity — no allocation
  });

  it('returns market unchanged when analyzeBaseRate returns null', () => {
    // Mock returns null by default
    const result = enrichWithBaseRate(processed, {});
    expect(result).toBe(processed);
  });

  it('short-circuits when base rate fields are unchanged', () => {
    const existingBr = { baseRate: 0.5, gapType: 'NONE', confidence: 'HIGH' };
    analyzeBaseRate.mockReturnValueOnce({ baseRate: 0.5, gapType: 'NONE', confidence: 'HIGH' });
    const marketWithBr = { ...processed, baseRate: existingBr };
    const result = enrichWithBaseRate(marketWithBr, {});
    expect(result).toBe(marketWithBr); // identity — short-circuit
  });

  it('creates new object with updated base rate when changed', () => {
    const newBr = { baseRate: 0.6, gapType: 'NARRATIVE_PREMIUM', confidence: 'HIGH', absGapCents: 10 };
    analyzeBaseRate.mockReturnValueOnce(newBr);
    const result = enrichWithBaseRate(processed, {});
    expect(result).not.toBe(processed);
    expect(result.baseRate).toBe(newBr);
    expect(result.id).toBe(processed.id);
  });

  it('defensive-copies _engineFailures', () => {
    analyzeBaseRate.mockReturnValueOnce({ baseRate: 0.7, gapType: 'X', confidence: 'HIGH' });
    const failures = ['resolution'];
    const market = { ...processed, _engineFailures: failures };
    const result = enrichWithBaseRate(market, {});
    expect(result._engineFailures).toEqual(['resolution']);
    expect(result._engineFailures).not.toBe(failures); // different array instance
  });

  it('catches errors and returns original market', () => {
    analyzeBaseRate.mockImplementationOnce(() => { throw new Error('boom'); });
    const result = enrichWithBaseRate(processed, {});
    expect(result).toBe(processed);
  });
});

// =====================================================================
// ALL_CATEGORIES
// =====================================================================

describe('ALL_CATEGORIES', () => {
  it('includes all rule-based categories plus Other', () => {
    expect(ALL_CATEGORIES).toContain('Politics');
    expect(ALL_CATEGORIES).toContain('Crypto');
    expect(ALL_CATEGORIES).toContain('Other');
    expect(ALL_CATEGORIES[ALL_CATEGORIES.length - 1]).toBe('Other');
  });

  it('has no duplicates', () => {
    expect(new Set(ALL_CATEGORIES).size).toBe(ALL_CATEGORIES.length);
  });
});
