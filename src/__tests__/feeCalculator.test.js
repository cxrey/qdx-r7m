import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  computeEffectiveFeeRate,
  computeFeePP,
  computeMakerRebatePP,
  computeRoundTripCostPP,
  getFeeParams,
  isFeeFree,
  FEE_PARAM_SLUGS,
} from '../feeCalculator';
import { TAG_SLUG_TO_FEE_SLUG, DISPLAY_TO_FEE_SLUG } from '../processMarket';

describe('getFeeParams', () => {
  it('returns params for known slug', () => {
    const p = getFeeParams('crypto');
    expect(p.feeRate).toBe(0.072);
    expect(p.exponent).toBe(1);
    expect(p.makerRebatePct).toBe(0.20);
  });

  it('returns default for unknown slug and warns', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = getFeeParams('unknown-slug');
    expect(p.feeRate).toBe(0.04);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Unknown category'));
    spy.mockRestore();
  });

  it('returns default for null', () => {
    expect(getFeeParams(null).feeRate).toBe(0.04);
  });

  it('is case-insensitive', () => {
    expect(getFeeParams('CRYPTO').feeRate).toBe(0.072);
    expect(getFeeParams('Crypto').feeRate).toBe(0.072);
  });
});

describe('isFeeFree', () => {
  it('returns true for world-politics', () => {
    expect(isFeeFree('world-politics')).toBe(true);
  });

  it('returns false for crypto', () => {
    expect(isFeeFree('crypto')).toBe(false);
  });

  it('returns false for unknown slug (uses default)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(isFeeFree('some-new-category')).toBe(false);
    spy.mockRestore();
  });
});

describe('computeEffectiveFeeRate', () => {
  it('returns 0 when feesEnabled is false', () => {
    expect(computeEffectiveFeeRate(0.50, 'crypto', false)).toBe(0);
  });

  it('returns 0 for null price', () => {
    expect(computeEffectiveFeeRate(null, 'crypto', true)).toBe(0);
  });

  it('returns 0 for undefined price', () => {
    expect(computeEffectiveFeeRate(undefined, 'crypto', true)).toBe(0);
  });

  it('returns 0 for price <= 0', () => {
    expect(computeEffectiveFeeRate(0, 'crypto', true)).toBe(0);
    expect(computeEffectiveFeeRate(-0.5, 'crypto', true)).toBe(0);
  });

  it('returns 0 for price >= 1', () => {
    expect(computeEffectiveFeeRate(1, 'crypto', true)).toBe(0);
    expect(computeEffectiveFeeRate(1.5, 'crypto', true)).toBe(0);
  });

  it('returns 0 for fee-free category', () => {
    expect(computeEffectiveFeeRate(0.50, 'world-politics', true)).toBe(0);
  });

  // Crypto at p=0.50: 0.072 × (0.50 × 0.50)^1 = 0.072 × 0.25 = 0.018
  it('computes correct rate for crypto at p=0.50', () => {
    expect(computeEffectiveFeeRate(0.50, 'crypto', true)).toBeCloseTo(0.018, 6);
  });

  // Sports at p=0.50: 0.03 × (0.50 × 0.50)^1 = 0.03 × 0.25 = 0.0075
  it('computes correct rate for sports at p=0.50', () => {
    expect(computeEffectiveFeeRate(0.50, 'sports', true)).toBeCloseTo(0.0075, 6);
  });

  // Crypto at p=0.20: 0.072 × (0.20 × 0.80)^1 = 0.072 × 0.16 = 0.01152
  it('computes correct rate for crypto at p=0.20', () => {
    expect(computeEffectiveFeeRate(0.20, 'crypto', true)).toBeCloseTo(0.01152, 6);
  });

  // Near-zero at extremes
  it('returns near-zero at p=0.01', () => {
    const rate = computeEffectiveFeeRate(0.01, 'crypto', true);
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThan(0.001);
  });

  it('returns near-zero at p=0.99', () => {
    const rate = computeEffectiveFeeRate(0.99, 'crypto', true);
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThan(0.001);
  });

  // Exponent 0.5 (economics) produces higher fees at extremes than exponent 1 (politics)
  it('exponent 0.5 produces higher fees at extremes than exponent 1', () => {
    const economicsAt20 = computeEffectiveFeeRate(0.20, 'economics', true);
    const politicsAt20 = computeEffectiveFeeRate(0.20, 'us-politics', true);
    // economics feeRate=0.03 exp=0.5 vs politics feeRate=0.04 exp=1
    // At 0.20: p(1-p) = 0.16
    // economics: 0.03 × 0.16^0.5 = 0.03 × 0.4 = 0.012
    // politics: 0.04 × 0.16^1 = 0.04 × 0.16 = 0.0064
    expect(economicsAt20).toBeGreaterThan(politicsAt20);
  });

  // Exponent 2 (mentions) produces lower fees at extremes than exponent 1
  it('exponent 2 produces lower fees at extremes than exponent 1 at same rate', () => {
    // Compare at p=0.20: p(1-p) = 0.16
    // exp 2: 0.16^2 = 0.0256
    // exp 1: 0.16^1 = 0.16
    const mentionsAt20 = computeEffectiveFeeRate(0.20, 'mentions', true);
    const cultureAt20 = computeEffectiveFeeRate(0.20, 'culture', true);
    // mentions: 0.25 × 0.0256 = 0.0064
    // culture: 0.05 × 0.16 = 0.008
    expect(mentionsAt20).toBeLessThan(cultureAt20);
  });
});

describe('computeFeePP', () => {
  // CRITICAL unit conversion tests

  // Crypto at p=0.50: effectiveFeeRate=0.018, feePP = 0.018 × 0.50 × 100 = 0.9pp
  it('computes 0.9pp for crypto at p=0.50', () => {
    expect(computeFeePP(0.50, 'crypto', true)).toBeCloseTo(0.9, 4);
  });

  // Sports at p=0.50: effectiveFeeRate=0.0075, feePP = 0.0075 × 0.50 × 100 = 0.375pp
  it('computes 0.375pp for sports at p=0.50', () => {
    expect(computeFeePP(0.50, 'sports', true)).toBeCloseTo(0.375, 4);
  });

  // Finance at p=0.50: effectiveFeeRate=0.04×0.25=0.01, feePP = 0.01 × 0.50 × 100 = 0.5pp
  it('computes 0.5pp for business (finance) at p=0.50', () => {
    expect(computeFeePP(0.50, 'business', true)).toBeCloseTo(0.5, 4);
  });

  // Crypto at p=0.20: effectiveFeeRate=0.01152, feePP = 0.01152 × 0.20 × 100 = 0.2304pp
  it('computes 0.2304pp for crypto at p=0.20', () => {
    expect(computeFeePP(0.20, 'crypto', true)).toBeCloseTo(0.2304, 4);
  });

  it('returns 0 for world-politics (fee-free)', () => {
    expect(computeFeePP(0.50, 'world-politics', true)).toBe(0);
  });

  it('returns 0 when feesEnabled is false', () => {
    expect(computeFeePP(0.50, 'crypto', false)).toBe(0);
  });

  // Verify against documented fee table: 100 shares
  // Crypto at p=0.50: total fee = 100 × 0.50 × 0.018 = $0.90 → per share = $0.009 → 0.9pp
  it('matches documented crypto fee table (100 shares at 50¢)', () => {
    const feePerShare = computeFeePP(0.50, 'crypto', true) / 100; // pp → decimal
    const totalFee100Shares = 100 * 0.50 * computeEffectiveFeeRate(0.50, 'crypto', true);
    expect(totalFee100Shares).toBeCloseTo(0.90, 2);
    expect(feePerShare).toBeCloseTo(0.009, 4);
  });

  // Sports at p=0.50: 100 × 0.50 × 0.0075 = $0.375
  it('matches documented sports fee table (100 shares at 50¢)', () => {
    const totalFee = 100 * 0.50 * computeEffectiveFeeRate(0.50, 'sports', true);
    expect(totalFee).toBeCloseTo(0.375, 2);
  });

  // Finance at p=0.50: 100 × 0.50 × 0.01 = $0.50
  it('matches documented finance fee table (100 shares at 50¢)', () => {
    const totalFee = 100 * 0.50 * computeEffectiveFeeRate(0.50, 'business', true);
    expect(totalFee).toBeCloseTo(0.50, 2);
  });
});

describe('computeMakerRebatePP', () => {
  // Business (finance) has 25% rebate (verified against live feeSchedule)
  it('returns 25% of feePP for business at p=0.50', () => {
    const feePP = computeFeePP(0.50, 'business', true);
    const rebate = computeMakerRebatePP(0.50, 'business', true);
    expect(rebate).toBeCloseTo(feePP * 0.25, 6);
  });

  // Crypto has 20% rebate
  it('returns 20% of feePP for crypto at p=0.50', () => {
    const feePP = computeFeePP(0.50, 'crypto', true);
    const rebate = computeMakerRebatePP(0.50, 'crypto', true);
    expect(rebate).toBeCloseTo(feePP * 0.20, 6);
  });

  it('returns 0 for fee-free category', () => {
    expect(computeMakerRebatePP(0.50, 'world-politics', true)).toBe(0);
  });
});

describe('computeRoundTripCostPP', () => {
  // 2¢ spread + crypto at 50¢
  it('computes correct round-trip with 2¢ spread + crypto at 50¢', () => {
    const rt = computeRoundTripCostPP(0.50, 0.02, 'crypto', true);
    expect(rt.entryFeePP).toBeCloseTo(0.9, 4);
    expect(rt.exitFeePP).toBeCloseTo(0.9, 4);
    expect(rt.roundTripFeePP).toBeCloseTo(1.8, 4);
    // Full spread for round trip: 0.02 × 100 = 2.0pp
    expect(rt.spreadCostPP).toBeCloseTo(2.0, 4);
    // Total: 0.9 + 0.9 + 2.0 = 3.8pp
    expect(rt.totalCostPP).toBeCloseTo(3.8, 4);
  });

  it('uses full spread, not half spread', () => {
    const rt = computeRoundTripCostPP(0.50, 0.04, 'world-politics', true);
    // Fee-free, so only spread cost
    expect(rt.roundTripFeePP).toBe(0);
    expect(rt.spreadCostPP).toBeCloseTo(4.0, 4); // 0.04 × 100
    expect(rt.totalCostPP).toBeCloseTo(4.0, 4);
  });

  it('handles null spread', () => {
    const rt = computeRoundTripCostPP(0.50, null, 'crypto', true);
    expect(rt.spreadCostPP).toBe(0);
    expect(rt.totalCostPP).toBeCloseTo(1.8, 4); // just fees
  });

  it('returns all zeros for fee-free with null spread', () => {
    const rt = computeRoundTripCostPP(0.50, null, 'world-politics', true);
    expect(rt.totalCostPP).toBe(0);
  });
});

describe('fee slug mapping sync', () => {
  it('every TAG_SLUG_TO_FEE_SLUG value exists in FEE_PARAM_SLUGS', () => {
    for (const [tag, feeSlug] of Object.entries(TAG_SLUG_TO_FEE_SLUG)) {
      expect(FEE_PARAM_SLUGS.has(feeSlug), `TAG_SLUG_TO_FEE_SLUG["${tag}"] maps to "${feeSlug}" which is not in FEE_PARAM_SLUGS`).toBe(true);
    }
  });

  it('every DISPLAY_TO_FEE_SLUG value exists in FEE_PARAM_SLUGS', () => {
    for (const [display, feeSlug] of Object.entries(DISPLAY_TO_FEE_SLUG)) {
      expect(FEE_PARAM_SLUGS.has(feeSlug), `DISPLAY_TO_FEE_SLUG["${display}"] maps to "${feeSlug}" which is not in FEE_PARAM_SLUGS`).toBe(true);
    }
  });
});

describe('peak effective rates at p=0.50 (regression guard)', () => {
  // At p=0.50, p×(1-p) = 0.25. These values come from the Polymarket docs fee table.
  // If anyone changes FEE_PARAMS values, these tests break.
  const cases = [
    // category,           expected,   formula
    ['crypto',             0.018,      '0.072 × 0.25^1'],
    ['sports',             0.0075,     '0.03 × 0.25^1'],
    ['business',           0.01,       '0.04 × 0.25^1'],
    ['us-current-affairs', 0.01,       '0.04 × 0.25^1'],
    ['us-politics',        0.01,       '0.04 × 0.25^1'],
    ['technology',         0.01,       '0.04 × 0.25^1'],
    ['pop-culture',        0.0125,     '0.05 × 0.25^1'],
    ['economics',          0.015,      '0.03 × 0.25^0.5'],
    ['weather',            0.0125,     '0.05 × 0.25^1'],
    ['culture',            0.0125,     '0.05 × 0.25^1'],
    ['world-politics',     0,          'fee-free'],
    ['mentions',           0.015625,   '0.25 × 0.25^2'],
    ['other',              0.0125,     '0.2 × 0.25^2'],
  ];

  for (const [category, expected, formula] of cases) {
    it(`${category}: ${formula} = ${expected}`, () => {
      expect(computeEffectiveFeeRate(0.50, category, true)).toBeCloseTo(expected, 6);
    });
  }
});
