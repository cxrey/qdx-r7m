import { describe, it, expect } from 'vitest';
import {
  normalizeOrderBook,
  calculateSpread,
  simulateFill,
  calculateDepthMetrics,
  calculateFrictionScore,
  calculateEdgeSurvival,
  estimateSpreadFromPrices,
} from '../SpreadFrictionEngine.js';
import { resolveFeeParams } from '../feeCalculator';

// ─── Helpers ──────────────────────────────────────────────────────

function makeBook(bids, asks) {
  return {
    bids: bids.map(([price, size]) => ({ price: String(price), size: String(size) })),
    asks: asks.map(([price, size]) => ({ price: String(price), size: String(size) })),
  };
}

// ─── 1. normalizeOrderBook() ──────────────────────────────────────

describe('normalizeOrderBook', () => {
  it('returns null for null input', () => {
    expect(normalizeOrderBook(null)).toBeNull();
  });

  it('parses string prices and sizes to numbers', () => {
    const book = makeBook([[0.55, 100]], [[0.58, 200]]);
    const norm = normalizeOrderBook(book);
    expect(norm.bids[0].price).toBe(0.55);
    expect(norm.asks[0].size).toBe(200);
  });

  it('filters out entries with NaN price or zero size', () => {
    const book = {
      bids: [
        { price: '0.50', size: '100' },
        { price: 'bad', size: '50' },
        { price: '0.45', size: '0' },
      ],
      asks: [{ price: '0.55', size: '100' }],
    };
    const norm = normalizeOrderBook(book);
    expect(norm.bids.length).toBe(1);
    expect(norm.bids[0].price).toBe(0.50);
  });

  it('sorts bids descending by price', () => {
    const book = makeBook([[0.40, 10], [0.50, 20], [0.45, 15]], [[0.55, 100]]);
    const norm = normalizeOrderBook(book);
    expect(norm.bids[0].price).toBe(0.50);
    expect(norm.bids[1].price).toBe(0.45);
    expect(norm.bids[2].price).toBe(0.40);
  });

  it('sorts asks ascending by price', () => {
    const book = makeBook([[0.50, 10]], [[0.60, 10], [0.55, 20], [0.58, 15]]);
    const norm = normalizeOrderBook(book);
    expect(norm.asks[0].price).toBe(0.55);
    expect(norm.asks[1].price).toBe(0.58);
    expect(norm.asks[2].price).toBe(0.60);
  });

  it('is idempotent — re-normalizing returns the same object', () => {
    const book = makeBook([[0.50, 100]], [[0.55, 100]]);
    const norm1 = normalizeOrderBook(book);
    const norm2 = normalizeOrderBook(norm1);
    expect(norm2).toBe(norm1); // same reference
  });

  it('handles missing bids array', () => {
    const norm = normalizeOrderBook({ asks: [{ price: '0.55', size: '100' }] });
    expect(norm.bids).toEqual([]);
    expect(norm.asks.length).toBe(1);
  });
});

// ─── 2. calculateSpread() ─────────────────────────────────────────

describe('calculateSpread', () => {
  it('returns null for null order book', () => {
    expect(calculateSpread(null)).toBeNull();
  });

  it('returns null when bids are empty', () => {
    expect(calculateSpread({ bids: [], asks: [{ price: '0.55', size: '100' }] })).toBeNull();
  });

  it('returns null when asks are empty', () => {
    expect(calculateSpread({ bids: [{ price: '0.50', size: '100' }], asks: [] })).toBeNull();
  });

  it('calculates correct spread metrics', () => {
    const book = makeBook([[0.50, 100]], [[0.55, 100]]);
    const spread = calculateSpread(book);
    expect(spread.bestBid).toBe(0.50);
    expect(spread.bestAsk).toBe(0.55);
    expect(spread.midpoint).toBeCloseTo(0.525, 4);
    expect(spread.absoluteSpread).toBeCloseTo(0.05, 4);
  });

  it('handles tight spread correctly', () => {
    const book = makeBook([[0.60, 500]], [[0.61, 500]]);
    const spread = calculateSpread(book);
    expect(spread.absoluteSpread).toBeCloseTo(0.01, 4);
  });
});

// ─── 3. simulateFill() ───────────────────────────────────────────

describe('simulateFill', () => {
  it('returns null for null order book', () => {
    expect(simulateFill(null, 'BUY_YES', 100)).toBeNull();
  });

  it('returns null for zero entry size', () => {
    const book = makeBook([[0.50, 100]], [[0.55, 100]]);
    expect(simulateFill(book, 'BUY_YES', 0)).toBeNull();
  });

  it('returns null for negative entry size', () => {
    const book = makeBook([[0.50, 100]], [[0.55, 100]]);
    expect(simulateFill(book, 'BUY_YES', -10)).toBeNull();
  });

  it('returns null for unknown side', () => {
    const book = makeBook([[0.50, 100]], [[0.55, 100]]);
    expect(simulateFill(book, 'SELL_YES', 100)).toBeNull();
  });

  it('BUY_YES: fills entirely at best ask for small order', () => {
    const book = makeBook([[0.50, 1000]], [[0.55, 1000]]);
    const fill = simulateFill(book, 'BUY_YES', 10);
    expect(fill.averageFillPrice).toBeCloseTo(0.55, 4);
    expect(fill.slippage).toBeCloseTo(0, 4);
    expect(fill.bookExhausted).toBe(false);
    expect(fill.unfilled).toBeCloseTo(0, 4);
    expect(fill.side).toBe('BUY_YES');
  });

  it('BUY_YES: walks the book across multiple levels', () => {
    // asks: 100 shares at 0.55, 100 shares at 0.60
    const book = makeBook([[0.50, 1000]], [[0.55, 100], [0.60, 100]]);
    // Trying to buy $100 worth: 100 shares * 0.55 = $55 at first level, remaining $45 at 0.60 = 75 shares
    const fill = simulateFill(book, 'BUY_YES', 100);
    expect(fill.averageFillPrice).toBeGreaterThan(0.55);
    expect(fill.averageFillPrice).toBeLessThan(0.60);
    expect(fill.levelsConsumed).toBe(2);
    expect(fill.slippage).toBeGreaterThan(0);
  });

  it('BUY_YES: detects book exhaustion', () => {
    const book = makeBook([[0.50, 10]], [[0.55, 10]]); // only 10*0.55=$5.50 on ask
    const fill = simulateFill(book, 'BUY_YES', 100);
    expect(fill.bookExhausted).toBe(true);
    expect(fill.unfilled).toBeGreaterThan(0);
  });

  it('BUY_NO: fills by hitting bids on the yes book', () => {
    const book = makeBook([[0.60, 1000]], [[0.65, 1000]]);
    // noPrice = 1 - 0.60 = 0.40
    const fill = simulateFill(book, 'BUY_NO', 10);
    expect(fill.side).toBe('BUY_NO');
    expect(fill.averageFillPrice).toBeCloseTo(0.40, 4); // 1 - bestBid
    expect(fill.bookExhausted).toBe(false);
  });

  it('BUY_NO: walks multiple bid levels', () => {
    // bids descending: 100 at 0.70, 100 at 0.65
    // noPrices: 0.30, 0.35
    const book = makeBook([[0.70, 100], [0.65, 100]], [[0.75, 1000]]);
    const fill = simulateFill(book, 'BUY_NO', 50);
    // First level: 100 * 0.30 = $30, second level: remaining $20 at 0.35
    expect(fill.averageFillPrice).toBeGreaterThan(0.30);
    expect(fill.levelsConsumed).toBe(2);
  });

  it('BUY_NO: skips bid levels where noPrice <= 0', () => {
    // bid at price 1.0 means noPrice = 0, should skip
    const book = makeBook([[1.0, 100], [0.60, 100]], [[0.65, 100]]);
    const fill = simulateFill(book, 'BUY_NO', 10);
    expect(fill.averageFillPrice).toBeCloseTo(0.40, 4);
    expect(fill.levelsConsumed).toBe(1); // only the 0.60 level counts
  });

  it('BUY_YES: frictionPct calculated correctly', () => {
    const book = makeBook([[0.50, 1000]], [[0.55, 1000]]);
    const fill = simulateFill(book, 'BUY_YES', 10);
    // midpoint = 0.525, spreadCost = 0.55 - 0.525 = 0.025, frictionPct = 0.025/0.55
    expect(fill.frictionPct).toBeCloseTo(0.025 / 0.55, 4);
  });
});

// ─── 4. calculateDepthMetrics() ───────────────────────────────────

describe('calculateDepthMetrics', () => {
  it('returns null for null order book', () => {
    expect(calculateDepthMetrics(null)).toBeNull();
  });

  it('returns null for empty bids', () => {
    expect(calculateDepthMetrics({ bids: [], asks: [{ price: '0.55', size: '100' }] })).toBeNull();
  });

  it('computes depth within 5 cents of best bid/ask', () => {
    const book = makeBook(
      [[0.50, 100], [0.48, 200], [0.40, 500]], // 0.40 is outside 5c of 0.50
      [[0.55, 150], [0.58, 100], [0.65, 300]], // 0.65 is outside 5c of 0.55
    );
    const depth = calculateDepthMetrics(book);
    // bidDepthAt5c: 100*0.50 + 200*0.48 = 50 + 96 = 146
    expect(depth.bidDepthAt5c).toBeCloseTo(146, 1);
    // askDepthAt5c: 150*0.55 + 100*0.58 = 82.5 + 58 = 140.5
    expect(depth.askDepthAt5c).toBeCloseTo(140.5, 1);
    expect(depth.totalNearDepth).toBeCloseTo(286.5, 1);
  });

  it('calculates depth imbalance ratio', () => {
    const book = makeBook([[0.50, 100]], [[0.55, 100]]);
    const depth = calculateDepthMetrics(book);
    const bidD = 100 * 0.50;
    const askD = 100 * 0.55;
    expect(depth.depthImbalance).toBeCloseTo(bidD / (bidD + askD), 4);
  });

  it('reports correct bid and ask level counts', () => {
    const book = makeBook([[0.50, 10], [0.48, 10], [0.45, 10]], [[0.55, 10]]);
    const depth = calculateDepthMetrics(book);
    expect(depth.bidLevels).toBe(3);
    expect(depth.askLevels).toBe(1);
  });
});

// ─── 5. calculateFrictionScore() ──────────────────────────────────

describe('calculateFrictionScore', () => {
  it('returns score=0 and label Unknown for null spreadData', () => {
    const result = calculateFrictionScore(null, null, 0.5);
    expect(result.score).toBe(0);
    expect(result.label).toBe('Unknown');
  });

  it('returns score=0 for null yesPrice', () => {
    const result = calculateFrictionScore({ absoluteSpread: 0.02 }, null, null);
    expect(result.score).toBe(0);
    expect(result.label).toBe('Unknown');
  });

  it('scores Clean for tight spread and deep book', () => {
    const spread = { absoluteSpread: 0.01 };
    const depth = { totalNearDepth: 60000 };
    const result = calculateFrictionScore(spread, depth, 0.50);
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.label).toBe('Clean');
  });

  it('scores Moderate for medium spread', () => {
    const spread = { absoluteSpread: 0.04 };
    const depth = { totalNearDepth: 60000 };
    const result = calculateFrictionScore(spread, depth, 0.50);
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.score).toBeLessThan(80);
    expect(result.label).toBe('Moderate');
  });

  it('scores Heavy for wide spread', () => {
    const spread = { absoluteSpread: 0.05 };
    const depth = { totalNearDepth: 5000 };
    const result = calculateFrictionScore(spread, depth, 0.50);
    expect(result.label).toBe('Heavy');
  });

  it('scores Prohibitive for very wide spread and thin book', () => {
    const spread = { absoluteSpread: 0.20 };
    const depth = { totalNearDepth: 100 };
    const result = calculateFrictionScore(spread, depth, 0.50);
    expect(result.score).toBeLessThan(35);
    expect(result.label).toBe('Prohibitive');
  });

  it('uses worst of yes/no spread percentage', () => {
    // yesPrice=0.10, spread=0.05 -> spreadPctYes=50%, spreadPctNo=5.6%
    const spread = { absoluteSpread: 0.05 };
    const depth = { totalNearDepth: 60000 };
    const result = calculateFrictionScore(spread, depth, 0.10);
    expect(result.worstSpreadPct).toBeCloseTo(0.5, 2); // 0.05/0.10
  });

  it('handles depth penalty tiers correctly', () => {
    const spread = { absoluteSpread: 0.01 }; // minimal spread penalty
    // totalNearDepth < 500 => 25 penalty
    const result = calculateFrictionScore(spread, { totalNearDepth: 100 }, 0.50);
    expect(result.score).toBe(75); // 100 - 0 - 25
  });

  it('applies no depth penalty when depthMetrics is null', () => {
    const spread = { absoluteSpread: 0.01 };
    const result = calculateFrictionScore(spread, null, 0.50);
    // totalNearDepth defaults to 0 => depthPenalty = 25
    expect(result.score).toBe(75);
  });
});

// ─── 6. calculateEdgeSurvival() ───────────────────────────────────

describe('calculateEdgeSurvival', () => {
  it('returns empty edges for null spreadData', () => {
    const result = calculateEdgeSurvival({}, null);
    expect(result.edges).toEqual([]);
    expect(result.survivingEdges).toBe(0);
    expect(result.killedEdges).toBe(0);
  });

  it('FLB edge survives when raw edge > halfSpread', () => {
    const market = { flb: { bestEdge: 0.10, bestSide: 'YES' } };
    const spread = { absoluteSpread: 0.04 }; // halfSpread = 0.02
    const result = calculateEdgeSurvival(market, spread);
    expect(result.edges.length).toBe(1);
    expect(result.edges[0].source).toBe('FLB');
    expect(result.edges[0].survives).toBe(true);
    expect(result.edges[0].netEdge).toBeCloseTo(0.08, 4);
    expect(result.survivingEdges).toBe(1);
  });

  it('FLB edge killed when raw edge < halfSpread', () => {
    const market = { flb: { bestEdge: 0.01, bestSide: 'YES' } };
    const spread = { absoluteSpread: 0.06 }; // halfSpread = 0.03
    const result = calculateEdgeSurvival(market, spread);
    expect(result.edges[0].survives).toBe(false);
    expect(result.killedEdges).toBe(1);
  });

  it('base rate edge converted from cents to fraction', () => {
    const market = { baseRate: { absGapCents: 10, gapType: 'NARRATIVE_PREMIUM' } };
    const spread = { absoluteSpread: 0.04 };
    const result = calculateEdgeSurvival(market, spread);
    expect(result.edges[0].rawEdge).toBeCloseTo(0.10, 4);
    expect(result.edges[0].side).toBe('NO');
  });

  it('FLB edge subtracts the taker fee on top of half spread', () => {
    // 0.03 raw − 0.01 half spread − 0.0175 fee (crypto @50¢) = 0.0025
    const market = { flb: { bestEdge: 0.03, bestSide: 'YES', takerFeePP: 1.75 } };
    const result = calculateEdgeSurvival(market, { absoluteSpread: 0.02 });
    expect(result.edges[0].netEdge).toBeCloseTo(0.0025, 6);
    expect(result.edges[0].survives).toBe(true);

    // Same edge with a 2.5pp fee is killed
    const killed = calculateEdgeSurvival(
      { flb: { bestEdge: 0.03, bestSide: 'YES', takerFeePP: 2.5 } },
      { absoluteSpread: 0.02 },
    );
    expect(killed.edges[0].survives).toBe(false);
  });

  it('base rate edge subtracts the fee at the suggested side price', () => {
    const market = {
      yesPrice: 0.5, noPrice: 0.5, feeParams: resolveFeeParams({ gammaCategory: 'crypto', feesEnabled: true }),
      baseRate: { absGapCents: 4, gapType: 'NARRATIVE_DISCOUNT' },
    };
    const result = calculateEdgeSurvival(market, { absoluteSpread: 0.02 });
    // 0.04 − 0.01 − 0.0175 = 0.0125
    expect(result.edges[0].side).toBe('YES');
    expect(result.edges[0].netEdge).toBeCloseTo(0.0125, 6);
  });

  it('theta edge accumulates over days left vs a full round trip', () => {
    // fee-free: |−0.005| × 10 days = 0.05 raw vs 0.02 full spread → 0.03 net
    const market = { yesPrice: 0.5, daysLeft: 10, theta: { bestTheta: -0.005, bestSide: 'NO' } };
    const result = calculateEdgeSurvival(market, { absoluteSpread: 0.02 });
    expect(result.edges[0].source).toBe('Theta (to expiry)');
    expect(result.edges[0].rawEdge).toBeCloseTo(0.05, 6);
    expect(result.edges[0].netEdge).toBeCloseTo(0.03, 6);
    expect(result.edges[0].survives).toBe(true);
  });

  it('theta round trip includes entry and exit fees', () => {
    // 0.05 raw − (0.02 spread + 2 × 0.0175 crypto fee) = −0.005 → killed
    const market = {
      yesPrice: 0.5, daysLeft: 10, feeParams: resolveFeeParams({ gammaCategory: 'crypto', feesEnabled: true }),
      theta: { bestTheta: 0.005, bestSide: 'NO' },
    };
    const result = calculateEdgeSurvival(market, { absoluteSpread: 0.02 });
    expect(result.edges[0].netEdge).toBeCloseTo(-0.005, 6);
    expect(result.edges[0].survives).toBe(false);
  });

  it('skips theta when daysLeft is unknown', () => {
    const result = calculateEdgeSurvival({ theta: { bestTheta: 0.01 } }, { absoluteSpread: 0.02 });
    expect(result.edges).toEqual([]);
  });

  it('counts multiple edges correctly', () => {
    const market = {
      yesPrice: 0.5, noPrice: 0.5, daysLeft: 1,
      flb: { bestEdge: 0.10 },
      baseRate: { absGapCents: 5, gapType: 'VALUE' },
      theta: { bestTheta: 0.01 },
    };
    const spread = { absoluteSpread: 0.06 }; // halfSpread = 0.03
    const result = calculateEdgeSurvival(market, spread);
    expect(result.edges.length).toBe(3);
    // FLB: 0.10 − 0.03 = 0.07 survives
    // BaseRate: 0.05 − 0.03 = 0.02 survives
    // Theta: 0.01 × 1 day − 0.06 round trip = −0.05 killed
    expect(result.survivingEdges).toBe(2);
    expect(result.killedEdges).toBe(1);
  });
});

// ─── 7. estimateSpreadFromPrices() ────────────────────────────────

describe('estimateSpreadFromPrices', () => {
  it('returns null spread for null yesPrice', () => {
    const result = estimateSpreadFromPrices(null, 0.45);
    expect(result.estimatedSpread).toBeNull();
    expect(result.isEstimate).toBe(true);
  });

  it('returns null spread for null noPrice', () => {
    const result = estimateSpreadFromPrices(0.55, null);
    expect(result.estimatedSpread).toBeNull();
  });

  it('calculates overround as estimated spread', () => {
    // yes=0.55, no=0.48 -> overround = |0.55+0.48 - 1| = 0.03
    const result = estimateSpreadFromPrices(0.55, 0.48);
    expect(result.estimatedSpread).toBeCloseTo(0.03, 4);
    expect(result.isEstimate).toBe(true);
  });

  it('returns 0 spread when prices sum to exactly 1', () => {
    const result = estimateSpreadFromPrices(0.60, 0.40);
    expect(result.estimatedSpread).toBeCloseTo(0, 4);
  });
});
