/**
 * Fee calculator for Polymarket taker/maker fees.
 *
 * Two key outputs:
 * - computeEffectiveFeeRate: fee as fraction of trade value (for display, Kelly)
 * - computeFeePP: fee in probability points (for FLB edge subtraction, theta break-even)
 *
 * Formula from Polymarket docs:
 *   effectiveFeeRate = feeRate × (p × (1 - p))^exponent
 *   feePP = effectiveFeeRate × price × 100
 */

// Fee parameters by Gamma category slug.
//
// Verified 2026-04-01:
//   - CLOB GET /fee-rate?token_id={id} exists (bare /fee-rate → 400, not 404)
//   - CLOB returns {"base_fee":1000} for fee-enabled tokens (BPS for order signing, not effective rate)
//   - Individual /markets/{id} has authoritative feeSchedule: {rate, exponent, rebateRate, takerOnly}
//   - Bulk /markets and /events endpoints do NOT populate feeSchedule/makerBaseFee/takerBaseFee
//   - Tags exist on /events endpoint but are stripped from /markets nested events
//   - extractFeeCategoryFromTags() is a no-op until market loading fetches event tags
//   - 6 live feeTypes verified: crypto_fees_v2, sports_fees_v2, finance_prices_fees,
//     politics_fees, weather_fees, culture_fees (see Commit 4b for full comparison)
// Re-verify when new feeType values appear or unverified categories go live.
const FEE_PARAMS = {
  'crypto':             { feeRate: 0.072, exponent: 1,   makerRebatePct: 0.20 },
  'sports':             { feeRate: 0.03,  exponent: 1,   makerRebatePct: 0.25 },
  'business':           { feeRate: 0.04,  exponent: 1,   makerRebatePct: 0.50 },
  'us-current-affairs': { feeRate: 0.04,  exponent: 1,   makerRebatePct: 0.25 },
  'us-politics':        { feeRate: 0.04,  exponent: 1,   makerRebatePct: 0.25 },
  'technology':         { feeRate: 0.04,  exponent: 1,   makerRebatePct: 0.25 },
  'pop-culture':        { feeRate: 0.05,  exponent: 1,   makerRebatePct: 0.25 },
  'economics':          { feeRate: 0.03,  exponent: 0.5, makerRebatePct: 0.25 },
  'weather':            { feeRate: 0.025, exponent: 0.5, makerRebatePct: 0.25 },
  'culture':            { feeRate: 0.05,  exponent: 1,   makerRebatePct: 0.25 },
  'world-politics':     { feeRate: 0,     exponent: 1,   makerRebatePct: 0 },
  'mentions':           { feeRate: 0.25,  exponent: 2,   makerRebatePct: 0.25 },
  'other':              { feeRate: 0.2,   exponent: 2,   makerRebatePct: 0.25 },
  '_default':           { feeRate: 0.04,  exponent: 1,   makerRebatePct: 0.25 },
};

/** Set of valid fee category slugs (excludes '_default'). Used by processMarket to match event tags. */
export const FEE_PARAM_SLUGS = new Set(Object.keys(FEE_PARAMS).filter(k => k !== '_default'));

/**
 * Get fee parameters for a category. Returns default for unmapped slugs.
 */
export function getFeeParams(gammaCategory) {
  if (!gammaCategory) return FEE_PARAMS['_default'];
  const key = gammaCategory.toLowerCase();
  const params = FEE_PARAMS[key];
  if (!params) {
    console.warn(`[feeCalculator] Unknown category "${gammaCategory}", using _default fee params`);
    return FEE_PARAMS['_default'];
  }
  return params;
}

/**
 * Check if a category is fee-free.
 */
export function isFeeFree(gammaCategory) {
  const params = getFeeParams(gammaCategory);
  return !params || params.feeRate === 0;
}

/**
 * Fee rate as a fraction of trade value (for display and Kelly).
 * e.g., 0.018 means 1.8% of trade value.
 */
export function computeEffectiveFeeRate(price, gammaCategory, feesEnabled) {
  if (!feesEnabled || price == null || price <= 0 || price >= 1) return 0;
  const params = getFeeParams(gammaCategory);
  if (!params || params.feeRate === 0) return 0;
  return params.feeRate * Math.pow(price * (1 - price), params.exponent);
}

/**
 * Fee cost in probability points (for subtracting from FLB edge, theta break-even).
 * e.g., 0.9 means 0.9pp = 0.9 cents per share.
 *
 * CRITICAL: feePP = effectiveFeeRate × price × 100
 * NOT effectiveFeeRate × 100 (which would be 2x overstatement).
 */
export function computeFeePP(price, gammaCategory, feesEnabled) {
  return computeEffectiveFeeRate(price, gammaCategory, feesEnabled) * price * 100;
}

/**
 * Maker rebate in probability points.
 */
export function computeMakerRebatePP(price, gammaCategory, feesEnabled) {
  const feePP = computeFeePP(price, gammaCategory, feesEnabled);
  const params = getFeeParams(gammaCategory);
  return feePP * (params?.makerRebatePct || 0);
}

/**
 * Round-trip cost in probability points.
 *
 * Spread cost is the FULL spread (not half) because a round trip crosses
 * the spread twice: half-spread above mid on entry, half-spread below mid on exit.
 *
 * @param {number} price — share price (0-1)
 * @param {number} spread — bid-ask spread in decimal (e.g., 0.02 for 2¢)
 * @param {string} gammaCategory — raw Gamma category slug
 * @param {boolean} feesEnabled
 * @returns {{ entryFeePP, exitFeePP, roundTripFeePP, spreadCostPP, totalCostPP }}
 */
export function computeRoundTripCostPP(price, spread, gammaCategory, feesEnabled) {
  const entryFeePP = computeFeePP(price, gammaCategory, feesEnabled);
  const exitFeePP = entryFeePP;
  const spreadCostPP = spread != null ? spread * 100 : 0;
  return {
    entryFeePP,
    exitFeePP,
    roundTripFeePP: entryFeePP + exitFeePP,
    spreadCostPP,
    totalCostPP: entryFeePP + exitFeePP + spreadCostPP,
  };
}
