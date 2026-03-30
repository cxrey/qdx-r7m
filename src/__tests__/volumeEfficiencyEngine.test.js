import { describe, it, expect } from 'vitest';
import {
  interpolateEfficiency,
  calculateRecencyWeightedVolume,
  calculateMispricingZone,
  getEdgeConfidence,
  getVolEffSortValue,
  analyzeVolumeEfficiency,
} from '../VolumeEfficiencyEngine.js';

// ─── 1. interpolateEfficiency() ───────────────────────────────────

describe('interpolateEfficiency', () => {
  it('clamps to first anchor for volume below minimum', () => {
    const result = interpolateEfficiency(50);
    expect(result.fairZoneHalfWidth).toBe(0.48);
    expect(result.maxExpectedEdge).toBe(0.30);
    expect(result.effectiveVolume).toBe(50);
  });

  it('clamps to first anchor for volume equal to minimum', () => {
    const result = interpolateEfficiency(100_000);
    expect(result.fairZoneHalfWidth).toBe(0.48);
    expect(result.maxExpectedEdge).toBe(0.30);
  });

  it('clamps to last anchor for very high volume', () => {
    const result = interpolateEfficiency(500_000_000);
    expect(result.fairZoneHalfWidth).toBe(0.05);
    expect(result.maxExpectedEdge).toBe(0.01);
  });

  it('clamps to last anchor at exactly 100M', () => {
    const result = interpolateEfficiency(100_000_000);
    expect(result.fairZoneHalfWidth).toBe(0.05);
    expect(result.maxExpectedEdge).toBe(0.01);
  });

  it('interpolates between anchors on log scale', () => {
    // Between 100k (hw=0.48) and 200k (hw=0.47)
    // geometric midpoint of 100k and 200k: sqrt(100k*200k) ~ 141421
    const mid = Math.sqrt(100_000 * 200_000);
    const result = interpolateEfficiency(mid);
    // At log midpoint, t=0.5, hw = 0.48 + 0.5*(0.47-0.48) = 0.475
    expect(result.fairZoneHalfWidth).toBeCloseTo(0.475, 3);
    expect(result.maxExpectedEdge).toBeCloseTo(0.275, 3);
  });

  it('returns narrower zone for higher volume', () => {
    const low = interpolateEfficiency(200_000);
    const high = interpolateEfficiency(10_000_000);
    expect(high.fairZoneHalfWidth).toBeLessThan(low.fairZoneHalfWidth);
    expect(high.maxExpectedEdge).toBeLessThan(low.maxExpectedEdge);
  });

  it('handles volume=0 without error (clamps to 1)', () => {
    const result = interpolateEfficiency(0);
    expect(result.effectiveVolume).toBe(1);
    expect(result.fairZoneHalfWidth).toBe(0.48);
  });

  it('handles negative volume without error', () => {
    const result = interpolateEfficiency(-1000);
    expect(result.effectiveVolume).toBe(1);
  });

  it('exact match on middle anchor point', () => {
    // 1_000_000 is an anchor: hw=0.40, me=0.12
    const result = interpolateEfficiency(1_000_000);
    expect(result.fairZoneHalfWidth).toBeCloseTo(0.40, 4);
    expect(result.maxExpectedEdge).toBeCloseTo(0.12, 4);
  });
});

// ─── 2. calculateRecencyWeightedVolume() ──────────────────────────

describe('calculateRecencyWeightedVolume', () => {
  it('returns 0.5x multiplier for dead market (zero daily volume)', () => {
    const market = { volume: '1000000', volume24hr: '0' };
    const result = calculateRecencyWeightedVolume(market);
    expect(result.recencyMultiplier).toBe(0.5);
    expect(result.velocityLabel).toBe('Dead');
    expect(result.effectiveVolume).toBe(500_000);
  });

  it('returns Hot label when monthly projection > 50% of total', () => {
    // dailyVolume * 30 > totalVolume * 0.5
    const market = { volume: '100000', volume24hr: '2000' }; // 60k projected > 50k
    const result = calculateRecencyWeightedVolume(market);
    expect(result.recencyMultiplier).toBe(1.3);
    expect(result.velocityLabel).toBe('Hot');
  });

  it('returns Active label for moderate activity', () => {
    // monthlyProjected > total * 0.2 but <= total * 0.5
    const market = { volume: '1000000', volume24hr: '10000' }; // 300k projected, 20-50% range
    const result = calculateRecencyWeightedVolume(market);
    expect(result.recencyMultiplier).toBe(1.1);
    expect(result.velocityLabel).toBe('Active');
  });

  it('returns Normal label for typical activity', () => {
    // monthlyProjected > total * 0.05 but <= total * 0.2
    const market = { volume: '1000000', volume24hr: '3000' }; // 90k projected, 5-20% range
    const result = calculateRecencyWeightedVolume(market);
    expect(result.recencyMultiplier).toBe(1.0);
    expect(result.velocityLabel).toBe('Normal');
  });

  it('returns Stale label for low activity', () => {
    // monthlyProjected <= total * 0.05
    const market = { volume: '10000000', volume24hr: '100' }; // 3k projected << 500k threshold
    const result = calculateRecencyWeightedVolume(market);
    expect(result.recencyMultiplier).toBe(0.7);
    expect(result.velocityLabel).toBe('Stale');
  });

  it('handles missing volume fields gracefully', () => {
    const market = {};
    const result = calculateRecencyWeightedVolume(market);
    expect(result.rawVolume).toBe(0);
    expect(result.dailyVolume).toBe(0);
    // dailyVolume = 0 -> Dead
    expect(result.velocityLabel).toBe('Dead');
  });

  it('parses string volume values', () => {
    const market = { volume: '5000000', volume24hr: '25000' };
    const result = calculateRecencyWeightedVolume(market);
    expect(result.rawVolume).toBe(5_000_000);
    expect(result.dailyVolume).toBe(25_000);
  });
});

// ─── 3. calculateMispricingZone() ─────────────────────────────────

describe('calculateMispricingZone', () => {
  it('returns null for null yesPrice', () => {
    expect(calculateMispricingZone(null, 1_000_000, 'Normal', 1.0, null)).toBeNull();
  });

  it('returns null for null effectiveVolume', () => {
    expect(calculateMispricingZone(0.50, null, 'Normal', 1.0, null)).toBeNull();
  });

  it('price at 0.50 is in-zone with maximum zoneDepth', () => {
    const result = calculateMispricingZone(0.50, 1_000_000, 'Normal', 1.0, null);
    expect(result.inZone).toBe(true);
    expect(result.zoneDepth).toBeCloseTo(1.0, 4);
    expect(result.distanceFromCenter).toBeCloseTo(0, 4);
  });

  it('extreme price is outside the fair zone for high volume', () => {
    // At 10M volume, halfWidth=0.22; price 0.05 is 0.45 from center
    const result = calculateMispricingZone(0.05, 10_000_000, 'Normal', 1.0, null);
    expect(result.inZone).toBe(false);
    expect(result.zoneDepth).toBeLessThan(0);
  });

  it('estimatedEdge is 0 when outside the zone', () => {
    const result = calculateMispricingZone(0.01, 50_000_000, 'Normal', 1.0, null);
    expect(result.inZone).toBe(false);
    expect(result.estimatedEdge).toBe(0);
  });

  it('estimatedEdge is positive when in zone', () => {
    const result = calculateMispricingZone(0.50, 1_000_000, 'Normal', 1.0, null);
    expect(result.estimatedEdge).toBeGreaterThan(0);
  });

  it('SWEET_SPOT priority for medium volume, in-zone, active market', () => {
    const result = calculateMispricingZone(0.50, 1_000_000, 'Active', 1.1, null);
    expect(result.priority).toBe('SWEET_SPOT');
  });

  it('LOW_LIQUIDITY priority for very low volume', () => {
    const result = calculateMispricingZone(0.50, 50_000, 'Normal', 1.0, null);
    expect(result.priority).toBe('LOW_LIQUIDITY');
  });

  it('EFFICIENT priority when price is outside zone', () => {
    const result = calculateMispricingZone(0.02, 50_000_000, 'Normal', 1.0, null);
    expect(result.priority).toBe('EFFICIENT');
  });

  it('applies book depth adjustment when bookDepth is provided', () => {
    const bookDepth = { totalBidDepth: 1000, totalAskDepth: 1000 }; // thin = 0.8 multiplier
    const withDepth = calculateMispricingZone(0.50, 1_000_000, 'Normal', 1.0, bookDepth);
    const withoutDepth = calculateMispricingZone(0.50, 1_000_000, 'Normal', 1.0, null);

    expect(withDepth.depthAdjusted).toBe(true);
    expect(withDepth.depthMultiplier).toBe(0.8);
    // Thin book -> wider half-width (less efficient) since adjustedHalfWidth = hw / 0.8
    expect(withDepth.adjustedHalfWidth).toBeGreaterThan(withoutDepth.adjustedHalfWidth);
  });

  it('deep book tightens the fair zone', () => {
    const bookDepth = { totalBidDepth: 60000, totalAskDepth: 60000 }; // >100k => 1.1 multiplier
    const result = calculateMispricingZone(0.50, 1_000_000, 'Normal', 1.0, bookDepth);
    expect(result.depthMultiplier).toBe(1.1);
    // adjustedHalfWidth = 0.40 / 1.1 < 0.40
    expect(result.adjustedHalfWidth).toBeLessThan(0.40);
  });

  it('zoneMin and zoneMax are symmetric around 0.50', () => {
    const result = calculateMispricingZone(0.50, 1_000_000, 'Normal', 1.0, null);
    expect(result.zoneMin).toBeCloseTo(0.50 - result.adjustedHalfWidth, 6);
    expect(result.zoneMax).toBeCloseTo(0.50 + result.adjustedHalfWidth, 6);
  });

  it('MARGINAL priority for in-zone but low zoneDepth', () => {
    // Price near the edge of the zone
    // At 1M volume: halfWidth=0.40, so zone is [0.10, 0.90]
    // Price at 0.15 -> distance=0.35, zoneDepth = 1 - 0.35/0.40 = 0.125 -> MARGINAL
    const result = calculateMispricingZone(0.15, 1_000_000, 'Dead', 0.5, null);
    // Dead velocity disqualifies SWEET_SPOT; zoneDepth ~0.125 with small estimatedEdge
    expect(['MARGINAL', 'OPPORTUNITY']).toContain(result.priority);
  });
});

// ─── 4. getEdgeConfidence() ───────────────────────────────────────

describe('getEdgeConfidence', () => {
  it('returns UNKNOWN for null volumeAnalysis', () => {
    expect(getEdgeConfidence(0.05, null)).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for null claimedEdge', () => {
    expect(getEdgeConfidence(null, { maxExpectedEdge: 0.10 })).toBe('UNKNOWN');
  });

  it('returns HIGH when claimedEdge <= maxExpectedEdge', () => {
    expect(getEdgeConfidence(0.05, { maxExpectedEdge: 0.10 })).toBe('HIGH');
  });

  it('returns HIGH when claimedEdge equals maxExpectedEdge', () => {
    expect(getEdgeConfidence(0.10, { maxExpectedEdge: 0.10 })).toBe('HIGH');
  });

  it('returns MEDIUM when claimedEdge is between max and 2x max', () => {
    expect(getEdgeConfidence(0.15, { maxExpectedEdge: 0.10 })).toBe('MEDIUM');
  });

  it('returns LOW when claimedEdge > 2x maxExpectedEdge', () => {
    expect(getEdgeConfidence(0.25, { maxExpectedEdge: 0.10 })).toBe('LOW');
  });

  it('returns HIGH for zero edge', () => {
    expect(getEdgeConfidence(0, { maxExpectedEdge: 0.10 })).toBe('HIGH');
  });
});

// ─── 5. getVolEffSortValue() ──────────────────────────────────────

describe('getVolEffSortValue', () => {
  it('returns 0 for null input', () => {
    expect(getVolEffSortValue(null)).toBe(0);
  });

  it('returns 0 for undefined input', () => {
    expect(getVolEffSortValue(undefined)).toBe(0);
  });

  it('SWEET_SPOT ranks higher than OPPORTUNITY', () => {
    const sweet = getVolEffSortValue({ priority: 'SWEET_SPOT', estimatedEdge: 0.05 });
    const opp = getVolEffSortValue({ priority: 'OPPORTUNITY', estimatedEdge: 0.05 });
    expect(sweet).toBeGreaterThan(opp);
  });

  it('OPPORTUNITY ranks higher than MARGINAL', () => {
    const opp = getVolEffSortValue({ priority: 'OPPORTUNITY', estimatedEdge: 0.05 });
    const marg = getVolEffSortValue({ priority: 'MARGINAL', estimatedEdge: 0.05 });
    expect(opp).toBeGreaterThan(marg);
  });

  it('higher edge within same tier sorts higher', () => {
    const highEdge = getVolEffSortValue({ priority: 'SWEET_SPOT', estimatedEdge: 0.10 });
    const lowEdge = getVolEffSortValue({ priority: 'SWEET_SPOT', estimatedEdge: 0.02 });
    expect(highEdge).toBeGreaterThan(lowEdge);
  });

  it('EFFICIENT is lowest priority tier', () => {
    const eff = getVolEffSortValue({ priority: 'EFFICIENT', estimatedEdge: 0.10 });
    const lowLiq = getVolEffSortValue({ priority: 'LOW_LIQUIDITY', estimatedEdge: 0 });
    expect(eff).toBeLessThan(lowLiq);
  });
});

// ─── 6. analyzeVolumeEfficiency() ─────────────────────────────────

describe('analyzeVolumeEfficiency', () => {
  it('returns null for market with undefined yesPrice', () => {
    const result = analyzeVolumeEfficiency({ volume: '1000000', volume24hr: '5000' });
    expect(result).toBeNull();
  });

  it('returns full analysis for valid market', () => {
    const market = { yesPrice: 0.50, volume: '2000000', volume24hr: '10000' };
    const result = analyzeVolumeEfficiency(market);
    expect(result).not.toBeNull();
    expect(result.inZone).toBeDefined();
    expect(result.priority).toBeDefined();
    expect(result.rawVolume).toBe(2_000_000);
    expect(result.dailyVolume).toBe(10_000);
  });

  it('includes recency-adjusted volume', () => {
    const market = { yesPrice: 0.50, volume: '1000000', volume24hr: '0' };
    const result = analyzeVolumeEfficiency(market);
    // Dead market: multiplier=0.5
    expect(result.effectiveVolume).toBe(500_000);
    expect(result.velocityLabel).toBe('Dead');
  });

  it('handles market with zero volume', () => {
    const market = { yesPrice: 0.50, volume: '0', volume24hr: '0' };
    const result = analyzeVolumeEfficiency(market);
    expect(result).not.toBeNull();
    expect(result.priority).toBe('LOW_LIQUIDITY');
  });
});
