import { describe, it, expect } from 'vitest';
import { calculateKelly } from '../KellyEngine';

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
    const result = calculateKelly(0.60, 0.50, 'YES', {
      gammaCategory: 'crypto',
      feesEnabled: false,
    });
    expect(result.takerFeeRate).toBe(0);
    expect(result.feeAdjustedEdge).toBeCloseTo(result.edge, 6);
  });

  it('reduces edge for crypto at p=0.50', () => {
    const noFee = calculateKelly(0.60, 0.50, 'YES');
    const withFee = calculateKelly(0.60, 0.50, 'YES', {
      gammaCategory: 'crypto',
      feesEnabled: true,
    });

    expect(withFee.valid).toBe(true);
    // takerFeeRate = 0.072 × (0.50 × 0.50)^1 = 0.018
    expect(withFee.takerFeeRate).toBeCloseTo(0.018, 6);
    // feeAdjustedEdge should be less than raw edge (both in pp)
    expect(withFee.feeAdjustedEdge).toBeLessThan(noFee.edge);
    // Difference in pp should be ~1.8pp (takerFeeRate * 100)
    expect(noFee.edge - withFee.feeAdjustedEdge).toBeCloseTo(1.8, 1);
  });

  it('produces smaller Kelly fraction with fees than without', () => {
    const noFee = calculateKelly(0.60, 0.50, 'YES');
    const withFee = calculateKelly(0.60, 0.50, 'YES', {
      gammaCategory: 'crypto',
      feesEnabled: true,
    });

    expect(withFee.feeAdjustedFullKelly).toBeLessThan(noFee.fullKelly);
    expect(withFee.fractionalKelly).toBeLessThan(noFee.fractionalKelly);
  });

  it('zeros Kelly fraction when fees consume entire edge', () => {
    // Small edge scenario: 51% estimate vs 50% price → ~2pp edge
    // Crypto fee at 50¢ = 1.8pp effective fee rate → barely positive
    // Let's use an even tighter edge
    const result = calculateKelly(0.505, 0.50, 'YES', {
      gammaCategory: 'crypto',
      feesEnabled: true,
    });

    // 0.505 vs 0.50 gives ~1pp raw edge, crypto fee = 1.8% effective rate
    // Fee exceeds edge → either noEdge is true, or feeAdjustedFullKelly is 0
    expect(result.valid).toBe(true);
    expect(result.noEdge || result.feeAdjustedFullKelly === 0).toBe(true);
  });

  it('fee-free category has zero fee impact', () => {
    const result = calculateKelly(0.60, 0.50, 'YES', {
      gammaCategory: 'world-politics',
      feesEnabled: true,
    });

    expect(result.takerFeeRate).toBe(0);
    const noFee = calculateKelly(0.60, 0.50, 'YES');
    expect(result.feeAdjustedEdge).toBeCloseTo(noFee.edge, 6);
  });

  it('works with NO side', () => {
    const result = calculateKelly(0.40, 0.50, 'NO', {
      gammaCategory: 'sports',
      feesEnabled: true,
    });

    expect(result.valid).toBe(true);
    // sports at 0.50: feeRate=0.03 × 0.25 = 0.0075
    expect(result.takerFeeRate).toBeCloseTo(0.0075, 6);
    expect(result.feeAdjustedEdge).toBeLessThan(result.edge);
  });

  it('handles empty feeOptions gracefully', () => {
    const result = calculateKelly(0.60, 0.50, 'YES', {});
    expect(result.valid).toBe(true);
    expect(result.takerFeeRate).toBe(0);
  });

  it('uses correct fee for off-center prices', () => {
    // Crypto at p=0.20: effectiveFeeRate = 0.072 × (0.20 × 0.80)^1 = 0.072 × 0.16 = 0.01152
    const result = calculateKelly(0.35, 0.20, 'YES', {
      gammaCategory: 'crypto',
      feesEnabled: true,
    });

    expect(result.takerFeeRate).toBeCloseTo(0.01152, 6);
  });
});
