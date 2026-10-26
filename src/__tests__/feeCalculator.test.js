import { describe, it, expect, vi } from 'vitest';
import {
  computeEffectiveFeeRate,
  computeFeePP,
  computeMakerRebatePP,
  computeRoundTripCostPP,
  getFeeParams,
  isFeeFree,
  normalizeFeeSchedule,
  resolveFeeParams,
  FEE_PARAM_SLUGS,
  FEETYPE_TO_FEE_SLUG,
} from '../feeCalculator';
import { TAG_SLUG_TO_FEE_SLUG, DISPLAY_TO_FEE_SLUG } from '../processMarket';

/** Shorthand: resolved fee params for a category (fees enabled by default). */
const fp = (gammaCategory, feesEnabled = true, feeSchedule = null) =>
  resolveFeeParams({ gammaCategory, feesEnabled, feeSchedule });

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

});

describe('resolveFeeParams', () => {
  it('prefers a live feeSchedule over the category table', () => {
    // Live schedule says 0.03 even though the crypto table entry says 0.07
    const p = fp('crypto', true, { rate: 0.03, exponent: 1, rebateRate: 0.10 });
    expect(p).toEqual({ feeRate: 0.03, exponent: 1, makerRebatePct: 0.10, enabled: true });
  });

  it('falls back to the table when the feeSchedule is malformed', () => {
    expect(fp('crypto', true, { rate: 'bogus' }).feeRate).toBe(0.07);
    expect(fp('crypto', true, {}).feeRate).toBe(0.07);
    expect(fp('crypto', true, null).feeRate).toBe(0.07);
  });

  it('carries the feesEnabled flag', () => {
    expect(fp('crypto').enabled).toBe(true);
    expect(fp('crypto', false).enabled).toBe(false);
    expect(resolveFeeParams().enabled).toBe(false);
  });
});

describe('normalizeFeeSchedule', () => {
  it('normalizes the live Gamma shape ({ rate, exponent, rebateRate })', () => {
    const n = normalizeFeeSchedule({ rate: 0.05, exponent: 1, rebateRate: 0.15, takerOnly: true });
    expect(n).toEqual({ feeRate: 0.05, exponent: 1, makerRebatePct: 0.15 });
  });

  it('rejects the already-normalized internal shape (raw Gamma shape only)', () => {
    expect(normalizeFeeSchedule({ feeRate: 0.04, exponent: 1, makerRebatePct: 0.25 })).toBeNull();
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
    expect(isFeeFree(fp('world-politics'))).toBe(true);
  });

  it('returns false for crypto', () => {
    expect(isFeeFree(fp('crypto'))).toBe(false);
  });

  it('returns true when fees are disabled, even in a fee category', () => {
    // Single definition: disabled fees ⇒ fee-free (previously market.feeFree
    // ignored feesEnabled and disagreed with flb.feeFree)
    expect(isFeeFree(fp('crypto', false))).toBe(true);
  });

  it('returns true for missing params', () => {
    expect(isFeeFree(null)).toBe(true);
    expect(isFeeFree(undefined)).toBe(true);
  });

  it('respects a live zero-rate schedule', () => {
    expect(isFeeFree(fp('crypto', true, { rate: 0, exponent: 1, rebateRate: 0 }))).toBe(true);
  });

  it('returns false for unknown slug (uses default)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(isFeeFree(fp('some-new-category'))).toBe(false);
    spy.mockRestore();
  });
});

describe('computeEffectiveFeeRate', () => {
  it('returns 0 when feesEnabled is false', () => {
    expect(computeEffectiveFeeRate(0.50, fp('crypto', false))).toBe(0);
  });

  it('returns 0 for null/undefined price', () => {
    expect(computeEffectiveFeeRate(null, fp('crypto'))).toBe(0);
    expect(computeEffectiveFeeRate(undefined, fp('crypto'))).toBe(0);
  });

  it('returns 0 for price <= 0 or >= 1', () => {
    expect(computeEffectiveFeeRate(0, fp('crypto'))).toBe(0);
    expect(computeEffectiveFeeRate(-0.5, fp('crypto'))).toBe(0);
    expect(computeEffectiveFeeRate(1, fp('crypto'))).toBe(0);
    expect(computeEffectiveFeeRate(1.5, fp('crypto'))).toBe(0);
  });

  it('returns 0 for fee-free category', () => {
    expect(computeEffectiveFeeRate(0.50, fp('world-politics'))).toBe(0);
  });

  // effectiveFeeRate = feePerShare / price = feeRate × (p(1−p))^exp / p
  // Crypto at p=0.50: 0.07 × 0.25 / 0.50 = 0.035 (3.5% of trade value)
  it('computes 3.5% of trade value for crypto at p=0.50', () => {
    expect(computeEffectiveFeeRate(0.50, fp('crypto'))).toBeCloseTo(0.035, 6);
  });

  // Sports at p=0.50: 0.05 × 0.25 / 0.50 = 0.025
  it('computes 2.5% of trade value for sports at p=0.50', () => {
    expect(computeEffectiveFeeRate(0.50, fp('sports'))).toBeCloseTo(0.025, 6);
  });

  // Crypto at p=0.20: 0.07 × 0.16 / 0.20 = 0.056
  it('computes correct rate for crypto at p=0.20', () => {
    expect(computeEffectiveFeeRate(0.20, fp('crypto'))).toBeCloseTo(0.056, 6);
  });

  // For exp=1 the rate simplifies to feeRate × (1−p): approaches feeRate as
  // p→0 (cheap longshots pay ~full rate on their stake) and 0 as p→1.
  it('approaches feeRate as p→0 and zero as p→1', () => {
    expect(computeEffectiveFeeRate(0.01, fp('crypto'))).toBeCloseTo(0.07 * 0.99, 6);
    expect(computeEffectiveFeeRate(0.99, fp('crypto'))).toBeCloseTo(0.07 * 0.01, 6);
  });

  it('applies a live feeSchedule exponent', () => {
    // exp 2 at p=0.50: perShare = 0.20 × 0.25² = 0.0125 → rate = 0.0125/0.5 = 0.025
    const rate = computeEffectiveFeeRate(0.50, fp('other', true, { rate: 0.20, exponent: 2, rebateRate: 0.25 }));
    expect(rate).toBeCloseTo(0.025, 6);
  });
});

describe('computeFeePP', () => {
  // feePP = feeRate × (p(1−p))^exp × 100 — the per-share fee in ¢/share.
  // Pinned to the documented worked example (docs.polymarket.com/trading/fees):
  // 100 crypto shares at 50¢ → $1.75 total → 1.75¢/share.
  it('matches the docs worked example: crypto at 50¢ = 1.75¢/share ($1.75 per 100 shares)', () => {
    const feePP = computeFeePP(0.50, fp('crypto'));
    expect(feePP).toBeCloseTo(1.75, 6);
    const totalFor100Shares = (feePP / 100) * 100; // $/share × 100 shares
    expect(totalFor100Shares).toBeCloseTo(1.75, 6);
  });

  // Cross-check via effectiveFeeRate: $50 notional × 3.5% = $1.75
  it('is consistent with effectiveFeeRate on the docs example', () => {
    const notional = 100 * 0.50;
    const viaRate = notional * computeEffectiveFeeRate(0.50, fp('crypto'));
    expect(viaRate).toBeCloseTo(1.75, 6);
  });

  // Sports at p=0.50: 0.05 × 0.25 × 100 = 1.25pp (docs: $1.25 per 100 shares)
  it('computes 1.25pp for sports at p=0.50', () => {
    expect(computeFeePP(0.50, fp('sports'))).toBeCloseTo(1.25, 6);
  });

  // Finance at p=0.50: 0.04 × 0.25 × 100 = 1.0pp (docs: $1.00 per 100 shares)
  it('computes 1.0pp for business (finance) at p=0.50', () => {
    expect(computeFeePP(0.50, fp('business'))).toBeCloseTo(1.0, 6);
  });

  // Crypto at p=0.20: 0.07 × 0.16 × 100 = 1.12pp
  it('computes 1.12pp for crypto at p=0.20', () => {
    expect(computeFeePP(0.20, fp('crypto'))).toBeCloseTo(1.12, 6);
  });

  it('is symmetric around p=0.50', () => {
    expect(computeFeePP(0.30, fp('crypto'))).toBeCloseTo(computeFeePP(0.70, fp('crypto')), 10);
  });

  it('returns 0 for world-politics (fee-free)', () => {
    expect(computeFeePP(0.50, fp('world-politics'))).toBe(0);
  });

  it('returns 0 when feesEnabled is false', () => {
    expect(computeFeePP(0.50, fp('crypto', false))).toBe(0);
  });

  it('uses a live feeSchedule over the table', () => {
    // Live sports schedule at 0.05 vs a hypothetical stale table
    const feePP = computeFeePP(0.50, fp('sports', true, { rate: 0.03, exponent: 1, rebateRate: 0.25 }));
    expect(feePP).toBeCloseTo(0.75, 6); // 0.03 × 0.25 × 100
  });
});

describe('computeMakerRebatePP', () => {
  // Business (finance) has 25% rebate
  it('returns 25% of feePP for business at p=0.50', () => {
    const feePP = computeFeePP(0.50, fp('business'));
    const rebate = computeMakerRebatePP(0.50, fp('business'));
    expect(rebate).toBeCloseTo(feePP * 0.25, 6);
  });

  // Crypto has 20% rebate
  it('returns 20% of feePP for crypto at p=0.50', () => {
    const feePP = computeFeePP(0.50, fp('crypto'));
    const rebate = computeMakerRebatePP(0.50, fp('crypto'));
    expect(rebate).toBeCloseTo(feePP * 0.20, 6);
  });

  // Sports rebate dropped to 15% in the July 2026 schedule
  it('returns 15% of feePP for sports at p=0.50', () => {
    const feePP = computeFeePP(0.50, fp('sports'));
    const rebate = computeMakerRebatePP(0.50, fp('sports'));
    expect(rebate).toBeCloseTo(feePP * 0.15, 6);
  });

  it('uses the live feeSchedule rebateRate', () => {
    const rebate = computeMakerRebatePP(0.50, fp('sports', true, { rate: 0.05, exponent: 1, rebateRate: 0.15 }));
    expect(rebate).toBeCloseTo(1.25 * 0.15, 6);
  });

  it('returns 0 for fee-free category', () => {
    expect(computeMakerRebatePP(0.50, fp('world-politics'))).toBe(0);
  });
});

describe('computeRoundTripCostPP', () => {
  // 2¢ spread + crypto at 50¢: entry/exit fee 1.75pp each
  it('computes correct round-trip with 2¢ spread + crypto at 50¢', () => {
    const rt = computeRoundTripCostPP(0.50, 0.02, fp('crypto'));
    expect(rt.entryFeePP).toBeCloseTo(1.75, 4);
    expect(rt.exitFeePP).toBeCloseTo(1.75, 4);
    expect(rt.roundTripFeePP).toBeCloseTo(3.5, 4);
    // Full spread for round trip: 0.02 × 100 = 2.0pp
    expect(rt.spreadCostPP).toBeCloseTo(2.0, 4);
    // Total: 1.75 + 1.75 + 2.0 = 5.5pp
    expect(rt.totalCostPP).toBeCloseTo(5.5, 4);
  });

  it('uses full spread, not half spread', () => {
    const rt = computeRoundTripCostPP(0.50, 0.04, fp('world-politics'));
    // Fee-free, so only spread cost
    expect(rt.roundTripFeePP).toBe(0);
    expect(rt.spreadCostPP).toBeCloseTo(4.0, 4); // 0.04 × 100
    expect(rt.totalCostPP).toBeCloseTo(4.0, 4);
  });

  it('handles null spread', () => {
    const rt = computeRoundTripCostPP(0.50, null, fp('crypto'));
    expect(rt.spreadCostPP).toBe(0);
    expect(rt.totalCostPP).toBeCloseTo(3.5, 4); // just fees
  });

  it('returns all zeros for fee-free with null spread', () => {
    const rt = computeRoundTripCostPP(0.50, null, fp('world-politics'));
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

  it('covers every fee-charging feeType in the live catalog (2026-10-26)', () => {
    const live = {
      crypto_fees_v2: 'crypto', crypto_15_min: 'crypto',
      sports_fees_v2: 'sports', sports_fees_v3: 'sports', sports_fees_nfl_cfb_oct26: 'sports',
      general_fees: 'other', politics_fees: 'us-politics', weather_fees: 'weather', finance_prices_fees: 'business',
    };
    for (const [feeType, slug] of Object.entries(live)) expect(FEETYPE_TO_FEE_SLUG[feeType]).toBe(slug);
    // zero_fees markets carry a 0-rate schedule; their category comes from tags
    expect(FEETYPE_TO_FEE_SLUG.zero_fees).toBeUndefined();
  });
});

describe('live feeSchedule shapes (full catalog, 2026-10-26)', () => {
  const live = (feeSchedule) => resolveFeeParams({ gammaCategory: 'pop-culture', feesEnabled: true, feeSchedule });

  it('zero_fees schedule (rate 0) is fee-free, overriding the category table', () => {
    const p = live({ exponent: 1, rate: 0, takerOnly: true, rebateRate: 0 });
    expect(computeFeePP(0.5, p)).toBe(0);
  });

  it('sports_fees_nfl_cfb_oct26 (0.03) wins over the 0.05 sports table rate', () => {
    expect(computeFeePP(0.5, resolveFeeParams({ gammaCategory: 'sports', feesEnabled: true, feeSchedule: { exponent: 1, rate: 0.03, takerOnly: true, rebateRate: 0.15 } }))).toBeCloseTo(0.75, 6);
  });

  it('crypto_15_min (rate 0.25, exponent 2): 0.25 × 0.25² × 100 = 1.5625¢ at 50¢', () => {
    expect(computeFeePP(0.5, live({ exponent: 2, rate: 0.25, takerOnly: true, rebateRate: 0.2 }))).toBeCloseTo(1.5625, 6);
  });

  it('docs worked examples: crypto 100 shares at 0.10 and 0.90 → $0.63 (symmetric)', () => {
    const crypto = live({ exponent: 1, rate: 0.07, takerOnly: true, rebateRate: 0.2 });
    expect(computeFeePP(0.1, crypto)).toBeCloseTo(0.63, 6);
    expect(computeFeePP(0.9, crypto)).toBeCloseTo(0.63, 6);
  });
});

describe('per-share fees at p=0.50 (regression guard vs docs fee table)', () => {
  // At p=0.50, p×(1−p) = 0.25. feePP = rate × 0.25 × 100.
  // Values from the docs.polymarket.com/trading/fees category table, checked
  // 2026-10-26. If FEE_PARAMS changes, these break.
  const cases = [
    ['combos',             1.25,   '0.05 × 0.25 × 100'],
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
      expect(computeFeePP(0.50, fp(category))).toBeCloseTo(expected, 6);
    });
  }
});
