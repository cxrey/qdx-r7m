// Volume-Price Efficiency Analyzer
// Determines whether a market's price is likely mispriced based on volume-price combination.
// Core insight: as more money flows through a market, the price range where mispricing
// can persist narrows toward the center.

// ─── Efficiency Curve ───
// [volume, fairZoneCenter, fairZoneHalfWidth, maxExpectedEdge]
const EFFICIENCY_CURVE = [
  [100_000,     0.50, 0.48, 0.30],
  [200_000,     0.50, 0.47, 0.25],
  [350_000,     0.50, 0.45, 0.20],
  [500_000,     0.50, 0.43, 0.18],
  [750_000,     0.50, 0.42, 0.15],
  [1_000_000,   0.50, 0.40, 0.12],
  [1_500_000,   0.50, 0.38, 0.10],
  [3_000_000,   0.50, 0.35, 0.08],
  [5_000_000,   0.50, 0.30, 0.06],
  [10_000_000,  0.50, 0.22, 0.04],
  [20_000_000,  0.50, 0.15, 0.03],
  [50_000_000,  0.50, 0.10, 0.02],
  [100_000_000, 0.50, 0.05, 0.01],
];

/**
 * Log-scale interpolation between efficiency curve anchor points.
 */
export function interpolateEfficiency(volume) {
  const v = Math.max(volume, 1); // avoid log(0)

  // Clamp to curve bounds
  if (v <= EFFICIENCY_CURVE[0][0]) {
    return {
      fairZoneHalfWidth: EFFICIENCY_CURVE[0][2],
      maxExpectedEdge: EFFICIENCY_CURVE[0][3],
      effectiveVolume: v,
    };
  }
  const last = EFFICIENCY_CURVE[EFFICIENCY_CURVE.length - 1];
  if (v >= last[0]) {
    return {
      fairZoneHalfWidth: last[2],
      maxExpectedEdge: last[3],
      effectiveVolume: v,
    };
  }

  const logV = Math.log10(v);

  for (let i = 0; i < EFFICIENCY_CURVE.length - 1; i++) {
    const [v0, , hw0, me0] = EFFICIENCY_CURVE[i];
    const [v1, , hw1, me1] = EFFICIENCY_CURVE[i + 1];

    if (v >= v0 && v <= v1) {
      const logV0 = Math.log10(v0);
      const logV1 = Math.log10(v1);
      const t = (logV - logV0) / (logV1 - logV0);

      return {
        fairZoneHalfWidth: hw0 + t * (hw1 - hw0),
        maxExpectedEdge: me0 + t * (me1 - me0),
        effectiveVolume: v,
      };
    }
  }

  // Fallback (shouldn't reach)
  return { fairZoneHalfWidth: 0.40, maxExpectedEdge: 0.12, effectiveVolume: v };
}

/**
 * Calculate recency-weighted effective volume.
 */
export function calculateRecencyWeightedVolume(market) {
  const totalVolume = parseFloat(market.volume || 0);
  const dailyVolume = parseFloat(market.volume24hr || 0);

  let recencyMultiplier = 1.0;
  let velocityLabel = 'Normal';

  if (dailyVolume != null && !isNaN(dailyVolume)) {
    const monthlyProjected = dailyVolume * 30;

    if (dailyVolume === 0) {
      recencyMultiplier = 0.5;
      velocityLabel = 'Dead';
    } else if (monthlyProjected > totalVolume * 0.5) {
      recencyMultiplier = 1.3;
      velocityLabel = 'Hot';
    } else if (monthlyProjected > totalVolume * 0.2) {
      recencyMultiplier = 1.1;
      velocityLabel = 'Active';
    } else if (monthlyProjected > totalVolume * 0.05) {
      recencyMultiplier = 1.0;
      velocityLabel = 'Normal';
    } else {
      recencyMultiplier = 0.7;
      velocityLabel = 'Stale';
    }
  }

  return {
    effectiveVolume: totalVolume * recencyMultiplier,
    recencyMultiplier,
    velocityLabel,
    rawVolume: totalVolume,
    dailyVolume,
  };
}

/**
 * Determine if a market's price falls in the "likely mispriced" zone for its volume.
 */
export function calculateMispricingZone(yesPrice, effectiveVolume, velocityLabel, recencyMultiplier, bookDepth) {
  if (yesPrice == null || effectiveVolume == null) {
    return null;
  }

  // 1. Base efficiency params
  const { fairZoneHalfWidth, maxExpectedEdge } = interpolateEfficiency(effectiveVolume);

  // 2. Book depth adjustment
  let depthMultiplier = null;
  let adjustedHalfWidth = fairZoneHalfWidth;
  let adjustedMaxEdge = maxExpectedEdge;
  let depthAdjusted = false;

  if (bookDepth) {
    const totalDepth = (bookDepth.totalBidDepth || 0) + (bookDepth.totalAskDepth || 0);
    depthAdjusted = true;

    if (totalDepth < 5000) depthMultiplier = 0.8;
    else if (totalDepth <= 20000) depthMultiplier = 0.95;
    else if (totalDepth <= 100000) depthMultiplier = 1.0;
    else depthMultiplier = 1.1;

    adjustedHalfWidth = Math.min(0.49, fairZoneHalfWidth / depthMultiplier);
    adjustedMaxEdge = maxExpectedEdge / depthMultiplier;
  }

  // 3. Zone boundaries
  const zoneMin = 0.50 - adjustedHalfWidth;
  const zoneMax = 0.50 + adjustedHalfWidth;

  // 4. Position within zone
  const distanceFromCenter = Math.abs(yesPrice - 0.50);
  let inZone, zoneDepth;

  if (distanceFromCenter <= adjustedHalfWidth) {
    inZone = true;
    zoneDepth = adjustedHalfWidth > 0 ? 1 - (distanceFromCenter / adjustedHalfWidth) : 1;
  } else {
    inZone = false;
    const outerRange = 0.50 - adjustedHalfWidth;
    zoneDepth = outerRange > 0 ? -(distanceFromCenter - adjustedHalfWidth) / outerRange : -1;
  }

  // 5. Estimated available edge
  let estimatedEdge = 0;
  if (inZone) {
    estimatedEdge = adjustedMaxEdge * zoneDepth * 0.7;
  }

  // 6. Priority tier
  let priority;
  if (effectiveVolume < 100_000) {
    priority = 'LOW_LIQUIDITY';
  } else if (!inZone) {
    priority = 'EFFICIENT';
  } else if (
    effectiveVolume >= 500_000 && effectiveVolume <= 5_000_000 &&
    zoneDepth > 0.3 && velocityLabel !== 'Dead'
  ) {
    priority = 'SWEET_SPOT';
  } else if (zoneDepth > 0.1 && estimatedEdge > 0.02) {
    priority = 'OPPORTUNITY';
  } else {
    priority = 'MARGINAL';
  }

  return {
    zoneMin,
    zoneMax,
    adjustedHalfWidth,
    inZone,
    zoneDepth,
    distanceFromCenter,
    effectiveVolume,
    recencyMultiplier,
    velocityLabel,
    estimatedEdge,
    maxExpectedEdge: adjustedMaxEdge,
    priority,
    depthAdjusted,
    depthMultiplier,
  };
}

/**
 * Check if a claimed edge is plausible for a market's volume tier.
 */
export function getEdgeConfidence(claimedEdge, volumeAnalysis) {
  if (!volumeAnalysis || claimedEdge == null) return 'UNKNOWN';

  const max = volumeAnalysis.maxExpectedEdge;
  if (claimedEdge <= max) return 'HIGH';
  if (claimedEdge <= max * 2) return 'MEDIUM';
  return 'LOW';
}

// Priority sort order (higher = better)
const PRIORITY_ORDER = {
  SWEET_SPOT: 5,
  OPPORTUNITY: 4,
  MARGINAL: 3,
  LOW_LIQUIDITY: 2,
  EFFICIENT: 1,
};

/**
 * Get a numeric sort value for a volume efficiency result.
 * Sorts by priority tier first, then by estimatedEdge within tier.
 */
export function getVolEffSortValue(ve) {
  if (!ve) return 0;
  const tierValue = (PRIORITY_ORDER[ve.priority] || 0) * 1000;
  return tierValue + (ve.estimatedEdge || 0) * 100;
}

/**
 * Convenience wrapper — full analysis from a market object.
 */
export function analyzeVolumeEfficiency(market) {
  const yesPrice = market.yesPrice;
  const recency = calculateRecencyWeightedVolume(market);

  const result = calculateMispricingZone(
    yesPrice,
    recency.effectiveVolume,
    recency.velocityLabel,
    recency.recencyMultiplier,
    null // TODO: re-run with book depth data when market row is expanded
  );

  if (!result) return null;

  return {
    ...result,
    rawVolume: recency.rawVolume,
    dailyVolume: recency.dailyVolume,
  };
}
