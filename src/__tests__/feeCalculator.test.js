import { describe, it, expect, vi } from 'vitest';
import {
  computeEffectiveFeeRate,
  computeFeePP,
  computeMakerRebatePP,
  computeRoundTripCostPP,
  getFeeParams,
  isFeeFree,
  normalizeFeeSchedule,
  FEE_PARAM_SLUGS,
  FEETYPE_TO_FEE_SLUG,
} from '../feeCalculator';
import { TAG_SLUG_TO_FEE_SLUG, DISPLAY_TO_FEE_SLUG } from '../processMarket';

describe('getFeeParams', () => {
  it('returns params for known slug', () => {
    const p = getFeeParams('crypto');
    expect(p.feeRate).toBe(0.07);
    expect(p.exponent).toBe(1);
    expect(p.makerRebatePct).toBe(0.20);
  });

  it('sports matches July 2026 schedule (0.05 / 15% rebate)', () => {
    const p = getFeeParams('sports');
    expect(p.feeRate).toBe(0.05);
    expect(p.makerRebatePct).toBe(0.15);
  });

  it('returns default for unknown slug and warns', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = getFeeParams('unknown-slug');
    expect(p.feeRate).toBe(0.05);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Unknown category'));
    spy.mockRestore();
  });

  it('returns default for null', () => {
    expect(getFeeParams(null).feeRate).toBe(0.05);
  });

  it('is case-insensitive', () => {
    expect(getFeeParams('CRYPTO').feeRate).toBe(0.07);
    expect(getFeeParams('Crypto').feeRate).toBe(0.07);
  });

  it('prefers a live feeSchedule over the category table', () => {
    // Live schedule says 0.03 even though the crypto table entry says 0.07
    const p = getFeeParams('crypto', { rate: 0.03, exponent: 1, rebateRate: 0.10 });
    expect(p.feeRate).toBe(0.03);
    expect(p.makerRebatePct).toBe(0.10);
  });

  it('falls back to the table when the feeSchedule is malformed', () => {
    expect(getFeeParams('crypto', { rate: 'bogus' }).feeRate).toBe(0.07);
    expect(getFeeParams('crypto', {}).feeRate).toBe(0.07);
    expect(getFeeParams('crypto', null).feeRate).toBe(0.07);
  });
});

describe('normalizeFeeSchedule', () => {
  it('normalizes the live Gamma shape ({ rate, exponent, rebateRate })', () => {
    const n = normalizeFeeSchedule({ rate: 0.05, exponent: 1, rebateRate: 0.15, takerOnly: true });
    expect(n).toEqual({ feeRate: 0.05, exponent: 1, makerRebatePct: 0.15 });
  });

  it('passes through an already-normalized shape', () => {
    const n = normalizeFeeSchedule({ feeRate: 0.04, exponent: 1, makerRebatePct: 0.25 });
    expect(n).toEqual({ feeRate: 0.04, exponent: 1, makerRebatePct: 0.25 });
  });

  it('defaults missing exponent to 1 and missing rebate to 0', () => {
    const n = normalizeFeeSchedule({ rate: 0.05 });
    expect(n).toEqual({ feeRate: 0.05, exponent: 1, makerRebatePct: 0 });
  });

  it('returns null for absent or malformed input', () => {
    expect(normalizeFeeSchedule(null)).toBeNull();
    expect(normalizeFeeSchedule(undefined)).toBeNull();
    expect(normalizeFeeSchedule('sports_fees_v2')).toBeNull();
    expect(normalizeFeeSchedule({ rate: NaN })).toBeNull();
    expect(normalizeFeeSchedule({ rate: -0.05 })).toBeNull();
  });
});

describe('isFeeFree', () => {
  it('returns true for world-politics', () => {
    expect(isFeeFree('world-politics')).toBe(true);
  });

  it('returns false for crypto', () => {
    expect(isFeeFree('crypto')).toBe(false);
  });

  it('respects a live zero-rate schedule', () => {
    expect(isFeeFree('crypto', { rate: 0, exponent: 1, rebateRate: 0 })).toBe(true);
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

  it('returns 0 for null/undefined price', () => {
    expect(computeEffectiveFeeRate(null, 'crypto', true)).toBe(0);
    expect(computeEffectiveFeeRate(undefined, 'crypto', true)).toBe(0);
  });

  it('returns 0 for price <= 0 or >= 1', () => {
    expect(computeEffectiveFeeRate(0, 'crypto', true)).toBe(0);
    expect(computeEffectiveFeeRate(-0.5, 'crypto', true)).toBe(0);
    expect(computeEffectiveFeeRate(1, 'crypto', true)).toBe(0);
    expect(computeEffectiveFeeRate(1.5, 'crypto', true)).toBe(0);
  });

  it('returns 0 for fee-free category', () => {
    expect(computeEffectiveFeeRate(0.50, 'world-politics', true)).toBe(0);
  });

  // effectiveFeeRate = feePerShare / price = feeRate × (p(1−p))^exp / p
  // Crypto at p=0.50: 0.07 × 0.25 / 0.50 = 0.035 (3.5% of trade value)
  it('computes 3.5% of trade value for crypto at p=0.50', () => {
    expect(computeEffectiveFeeRate(0.50, 'crypto', true)).toBeCloseTo(0.035, 6);
  });

  // Sports at p=0.50: 0.05 × 0.25 / 0.50 = 0.025
  it('computes 2.5% of trade value for sports at p=0.50', () => {
    expect(computeEffectiveFeeRate(0.50, 'sports', true)).toBeCloseTo(0.025, 6);
  });

  // Crypto at p=0.20: 0.07 × 0.16 / 0.20 = 0.056
  it('computes correct rate for crypto at p=0.20', () => {
    expect(computeEffectiveFeeRate(0.20, 'crypto', true)).toBeCloseTo(0.056, 6);
  });

  // For exp=1 the rate simplifies to feeRate × (1−p): approaches feeRate as
  // p→0 (cheap longshots pay ~full rate on their stake) and 0 as p→1.
  it('approaches feeRate as p→0 and zero as p→1', () => {
    expect(computeEffectiveFeeRate(0.01, 'crypto', true)).toBeCloseTo(0.07 * 0.99, 6);
    expect(computeEffectiveFeeRate(0.99, 'crypto', true)).toBeCloseTo(0.07 * 0.01, 6);
  });

  it('applies a live feeSchedule exponent', () => {
    // exp 2 at p=0.50: perShare = 0.20 × 0.25² = 0.0125 → rate = 0.0125/0.5 = 0.025
    const rate = computeEffectiveFeeRate(0.50, 'other', true, { rate: 0.20, exponent: 2, rebateRate: 0.25 });
    expect(rate).toBeCloseTo(0.025, 6);
  });
});

describe('computeFeePP', () => {
  // feePP = feeRate × (p(1−p))^exp × 100 — the per-share fee in ¢/share.
  // Pinned to the documented worked example (docs.polymarket.com/trading/fees):
  // 100 crypto shares at 50¢ → $1.75 total → 1.75¢/share.
  it('matches the docs worked example: crypto at 50¢ = 1.75¢/share ($1.75 per 100 shares)', () => {
    const feePP = computeFeePP(0.50, 'crypto', true);
    expect(feePP).toBeCloseTo(1.75, 6);
    const totalFor100Shares = (feePP / 100) * 100; // $/share × 100 shares
    expect(totalFor100Shares).toBeCloseTo(1.75, 6);
  });

  // Cross-check via effectiveFeeRate: $50 notional × 3.5% = $1.75
  it('is consistent with effectiveFeeRate on the docs example', () => {
    const notional = 100 * 0.50;
    const viaRate = notional * computeEffectiveFeeRate(0.50, 'crypto', true);
    expect(viaRate).toBeCloseTo(1.75, 6);
  });

  // Sports at p=0.50: 0.05 × 0.25 × 100 = 1.25pp (docs: $1.25 per 100 shares)
  it('computes 1.25pp for sports at p=0.50', () => {
    expect(computeFeePP(0.50, 'sports', true)).toBeCloseTo(1.25, 6);
  });

  // Finance at p=0.50: 0.04 × 0.25 × 100 = 1.0pp (docs: $1.00 per 100 shares)
  it('computes 1.0pp for business (finance) at p=0.50', () => {
    expect(computeFeePP(0.50, 'business', true)).toBeCloseTo(1.0, 6);
  });

  // Crypto at p=0.20: 0.07 × 0.16 × 100 = 1.12pp
  it('computes 1.12pp for crypto at p=0.20', () => {
    expect(computeFeePP(0.20, 'crypto', true)).toBeCloseTo(1.12, 6);
  });

  it('is symmetric around p=0.50', () => {
    expect(computeFeePP(0.30, 'crypto', true)).toBeCloseTo(computeFeePP(0.70, 'crypto', true), 10);
  });

  it('returns 0 for world-politics (fee-free)', () => {
    expect(computeFeePP(0.50, 'world-politics', true)).toBe(0);
  });

  it('returns 0 when feesEnabled is false', () => {
    expect(computeFeePP(0.50, 'crypto', false)).toBe(0);
  });

  it('uses a live feeSchedule over the table', () => {
    // Live sports schedule at 0.05 vs a hypothetical stale table
    const feePP = computeFeePP(0.50, 'sports', true, { rate: 0.03, exponent: 1, rebateRate: 0.25 });
    expect(feePP).toBeCloseTo(0.75, 6); // 0.03 × 0.25 × 100
  });
});

describe('computeMakerRebatePP', () => {
  // Business (finance) has 25% rebate
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

  // Sports rebate dropped to 15% in the July 2026 schedule
  it('returns 15% of feePP for sports at p=0.50', () => {
    const feePP = computeFeePP(0.50, 'sports', true);
    const rebate = computeMakerRebatePP(0.50, 'sports', true);
    expect(rebate).toBeCloseTo(feePP * 0.15, 6);
  });

  it('uses the live feeSchedule rebateRate', () => {
    const rebate = computeMakerRebatePP(0.50, 'sports', true, { rate: 0.05, exponent: 1, rebateRate: 0.15 });
    expect(rebate).toBeCloseTo(1.25 * 0.15, 6);
  });

  it('returns 0 for fee-free category', () => {
    expect(computeMakerRebatePP(0.50, 'world-politics', true)).toBe(0);
  });
});

describe('computeRoundTripCostPP', () => {
  // 2¢ spread + crypto at 50¢: entry/exit fee 1.75pp each
  it('computes correct round-trip with 2¢ spread + crypto at 50¢', () => {
    const rt = computeRoundTripCostPP(0.50, 0.02, 'crypto', true);
    expect(rt.entryFeePP).toBeCloseTo(1.75, 4);
    expect(rt.exitFeePP).toBeCloseTo(1.75, 4);
    expect(rt.roundTripFeePP).toBeCloseTo(3.5, 4);
    // Full spread for round trip: 0.02 × 100 = 2.0pp
    expect(rt.spreadCostPP).toBeCloseTo(2.0, 4);
    // Total: 1.75 + 1.75 + 2.0 = 5.5pp
    expect(rt.totalCostPP).toBeCloseTo(5.5, 4);
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
    expect(rt.totalCostPP).toBeCloseTo(3.5, 4); // just fees
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

  it('every FEETYPE_TO_FEE_SLUG value exists in FEE_PARAM_SLUGS', () => {
    for (const [feeType, feeSlug] of Object.entries(FEETYPE_TO_FEE_SLUG)) {
      expect(FEE_PARAM_SLUGS.has(feeSlug), `FEETYPE_TO_FEE_SLUG["${feeType}"] maps to "${feeSlug}" which is not in FEE_PARAM_SLUGS`).toBe(true);
    }
  });
});

describe('per-share fees at p=0.50 (regression guard vs docs fee table)', () => {
  // At p=0.50, p×(1−p) = 0.25. feePP = rate × 0.25 × 100.
  // Values from docs.polymarket.com/trading/fees + live feeSchedule
  // sample, both checked 2026-07-19. If FEE_PARAMS changes, these break.
  const cases = [
    // category,           feePP,  formula
    ['crypto',             1.75,   '0.07 × 0.25 × 100'],
    ['sports',             1.25,   '0.05 × 0.25 × 100'],
    ['business',           1.00,   '0.04 × 0.25 × 100'],
    ['us-current-affairs', 1.00,   '0.04 × 0.25 × 100'],
    ['us-politics',        1.00,   '0.04 × 0.25 × 100'],
    ['technology',         1.00,   '0.04 × 0.25 × 100'],
    ['pop-culture',        1.25,   '0.05 × 0.25 × 100'],
    ['economics',          1.25,   '0.05 × 0.25 × 100'],
    ['weather',            1.25,   '0.05 × 0.25 × 100'],
    ['culture',            1.25,   '0.05 × 0.25 × 100'],
    ['world-politics',     0,      'fee-free'],
    ['mentions',           1.00,   '0.04 × 0.25 × 100'],
    ['other',              1.25,   '0.05 × 0.25 × 100'],
  ];

  for (const [category, expected, formula] of cases) {
    it(`${category}: ${formula} = ${expected}pp`, () => {
      expect(computeFeePP(0.50, category, true)).toBeCloseTo(expected, 6);
    });
  }
});
