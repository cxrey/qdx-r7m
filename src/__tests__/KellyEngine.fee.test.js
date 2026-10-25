import { describe, it, expect } from 'vitest';
import { calculateKelly, calculateMultiOutcomeKelly } from '../KellyEngine';
import { resolveFeeParams } from '../feeCalculator';

describe('calculateKelly with fee options', () => {
  // Baseline: no fees
  it('returns feeAdjustedEdge equal to raw edge when no fee options', () => {
    const result = calculateKelly(0.60, 0.50, 'YES');
    expect(result.valid).toBe(true);
    expect(result.noEdge).toBe(false);
    expect(result.takerFeeRate).toBe(0);
    expect(result.feeAdjustedEdge).toBeCloseTo(result.edge, 6);
  });

  it('returns zero takerFeeRate when feesEnabled is false', () => {
    const result = calculateKelly(0.60, 0.50, 'YES', resolveFeeParams({
      gammaCategory: 'crypto',
      feesEnabled: false,
    }));
    expect(result.takerFeeRate).toBe(0);
    expect(result.feeAdjustedEdge).toBeCloseTo(result.edge, 6);
  });

  it('reduces edge for crypto at p=0.50', () => {
    const noFee = calculateKelly(0.60, 0.50, 'YES');
    const withFee = calculateKelly(0.60, 0.50, 'YES', resolveFeeParams({
      gammaCategory: 'crypto',
      feesEnabled: true,
    }));

    expect(withFee.valid).toBe(true);
    // takerFeeRate (fraction of dollars staked) = feePerShare / price
    // = 0.07 × 0.25 / 0.50 = 0.035 (docs: $1.75 fee on a $50 notional)
    expect(withFee.takerFeeRate).toBeCloseTo(0.035, 6);
    // feeAdjustedEdge should be less than raw edge (both in pp)
    expect(withFee.feeAdjustedEdge).toBeLessThan(noFee.edge);
    // Difference in pp should be ~3.5pp (takerFeeRate * 100)
    expect(noFee.edge - withFee.feeAdjustedEdge).toBeCloseTo(3.5, 1);
  });

  it('uses a live feeSchedule over the category table', () => {
    const withSchedule = calculateKelly(0.60, 0.50, 'YES', resolveFeeParams({
      gammaCategory: 'crypto',
      feesEnabled: true,
      feeSchedule: { rate: 0.04, exponent: 1, rebateRate: 0.25 },
    }));
    // 0.04 × 0.25 / 0.50 = 0.02 — schedule wins over crypto's 0.07 table entry
    expect(withSchedule.takerFeeRate).toBeCloseTo(0.02, 6);
  });

  it('produces smaller Kelly fraction with fees than without', () => {
    const noFee = calculateKelly(0.60, 0.50, 'YES');
    const withFee = calculateKelly(0.60, 0.50, 'YES', resolveFeeParams({
      gammaCategory: 'crypto',
      feesEnabled: true,
    }));

    expect(withFee.feeAdjustedFullKelly).toBeLessThan(noFee.fullKelly);
    expect(withFee.fractionalKelly).toBeLessThan(noFee.fractionalKelly);
  });

  it('zeros Kelly fraction when fees consume entire edge', () => {
    // Small edge scenario: 50.5% estimate vs 50¢ price → ~1pp raw edge,
    // crypto fee = 3.5% of stake → fee exceeds edge
    const result = calculateKelly(0.505, 0.50, 'YES', resolveFeeParams({
      gammaCategory: 'crypto',
      feesEnabled: true,
    }));

    // Either noEdge is true, or feeAdjustedFullKelly is 0
    expect(result.valid).toBe(true);
    expect(result.noEdge || result.feeAdjustedFullKelly === 0).toBe(true);
  });

  it('fee-free category has zero fee impact', () => {
    const result = calculateKelly(0.60, 0.50, 'YES', resolveFeeParams({
      gammaCategory: 'world-politics',
      feesEnabled: true,
    }));

    expect(result.takerFeeRate).toBe(0);
    const noFee = calculateKelly(0.60, 0.50, 'YES');
    expect(result.feeAdjustedEdge).toBeCloseTo(noFee.edge, 6);
  });

  it('works with NO side', () => {
    const result = calculateKelly(0.40, 0.50, 'NO', resolveFeeParams({
      gammaCategory: 'sports',
      feesEnabled: true,
    }));

    expect(result.valid).toBe(true);
    // sports at 0.50: 0.05 × 0.25 / 0.50 = 0.025
    expect(result.takerFeeRate).toBeCloseTo(0.025, 6);
    expect(result.feeAdjustedEdge).toBeLessThan(result.edge);
  });

  it('handles empty fee context gracefully', () => {
    const result = calculateKelly(0.60, 0.50, 'YES', resolveFeeParams({}));
    expect(result.valid).toBe(true);
    expect(result.takerFeeRate).toBe(0);
  });

  it('uses correct fee for off-center prices', () => {
    // Crypto at p=0.20: feePerShare = 0.07 × 0.16 = 0.0112 → /0.20 = 0.056
    const result = calculateKelly(0.35, 0.20, 'YES', resolveFeeParams({
      gammaCategory: 'crypto',
      feesEnabled: true,
    }));

    expect(result.takerFeeRate).toBeCloseTo(0.056, 6);
  });
});

describe('calculateMultiOutcomeKelly with fees', () => {
  const crypto = resolveFeeParams({ gammaCategory: 'crypto', feesEnabled: true });
  const free = resolveFeeParams({ gammaCategory: 'world-politics', feesEnabled: true });
  const legs = (feeA, feeB) => [
    { name: 'A', estProb: 0.60, marketPrice: 0.50, feeParams: feeA },
    { name: 'B', estProb: 0.40, marketPrice: 0.45, feeParams: feeB },
  ];

  it('applies the fee params of each outcome', () => {
    const result = calculateMultiOutcomeKelly(legs(crypto, free));
    expect(result.outcomes[0].kelly.takerFeeRate).toBeCloseTo(0.035, 6);
    expect(result.outcomes[1].kelly.takerFeeRate).toBe(0);
  });

  it('sizes fee-bearing legs smaller than the same legs fee-free', () => {
    const withFees = calculateMultiOutcomeKelly(legs(crypto, crypto));
    const noFees = calculateMultiOutcomeKelly(legs(free, free));
    expect(withFees.outcomes[0].recommendedFraction).toBeLessThan(noFees.outcomes[0].recommendedFraction);
  });

  it('falls back to defaultFeeParams for outcomes without their own', () => {
    const result = calculateMultiOutcomeKelly(legs(undefined, undefined), crypto);
    expect(result.outcomes[0].kelly.takerFeeRate).toBeCloseTo(0.035, 6);
  });
});
