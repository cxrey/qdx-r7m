/**
 * Fee calculator for Polymarket taker/maker fees.
 *
 * Formula (docs.polymarket.com/trading/fees, verified 2026-07-19):
 *   fee (USDC) = shares × feeRate × (p × (1 − p))^exponent
 * Worked example from the docs: 100 crypto shares at 50¢
 *   → 100 × 0.07 × 0.25 = $1.75 (1.75¢ per share).
 *
 * Derived measures:
 * - feePerShare        = feeRate × (p(1−p))^exponent           [$ per share]
 * - computeFeePP       = feePerShare × 100                     [probability points = ¢/share]
 * - computeEffectiveFeeRate = feePerShare / p                  [fraction of trade value]
 *   (a $50 notional buys 100 shares at 50¢; $1.75 fee → 3.5% of trade value)
 *
 * Fee parameters come from the live per-market feeSchedule when available —
 * every fee-enabled Gamma market carries { rate, exponent, rebateRate,
 * takerOnly } — with FEE_PARAMS as the fallback for markets without one.
 * resolveFeeParams() combines both (plus feesEnabled) into one feeParams
 * object, resolved once in processMarket and passed to every calculator.
 */

// Fallback fee parameters by Gamma category slug.
//
// Synced 2026-07-19 against docs.polymarket.com/trading/fees AND live
// feeSchedule values sampled from 500 top-volume markets:
//   feeType              | rate | exp | rebate | Our key
//   crypto_fees_v2       | 0.07 | 1   | 0.20   | crypto
//   sports_fees_v2       | 0.05 | 1   | 0.15   | sports
//   finance_prices_fees  | 0.04 | 1   | 0.25   | business
//   politics_fees        | 0.04 | 1   | 0.25   | us-politics
//   economics_fees       | 0.05 | 1   | 0.25   | economics
//   tech_fees            | 0.04 | 1   | 0.25   | technology
//   culture_fees         | 0.05 | 1   | 0.25   | culture
//   weather_fees         | 0.05 | 1   | 0.25   | weather
//   mentions_fees        | 0.04 | 1   | 0.25   | mentions
//   (geopolitics)        | fee-free per docs   | world-politics
//   Other/General        | 0.05 | 1   | 0.25   | other, _default (docs table)
//
// NOTE: the schedule HAS changed before (sports was 0.03/25% in April 2026).
// The live feeSchedule on each market is authoritative; this table only
// covers markets the API doesn't attach a schedule to.
const FEE_PARAMS = {
  'crypto':             { feeRate: 0.07, exponent: 1, makerRebatePct: 0.20 },
  'sports':             { feeRate: 0.05, exponent: 1, makerRebatePct: 0.15 },
  'business':           { feeRate: 0.04, exponent: 1, makerRebatePct: 0.25 },
  'us-current-affairs': { feeRate: 0.04, exponent: 1, makerRebatePct: 0.25 },
  'us-politics':        { feeRate: 0.04, exponent: 1, makerRebatePct: 0.25 },
  'technology':         { feeRate: 0.04, exponent: 1, makerRebatePct: 0.25 },
  'pop-culture':        { feeRate: 0.05, exponent: 1, makerRebatePct: 0.25 },
  'economics':          { feeRate: 0.05, exponent: 1, makerRebatePct: 0.25 },
  'weather':            { feeRate: 0.05, exponent: 1, makerRebatePct: 0.25 },
  'culture':            { feeRate: 0.05, exponent: 1, makerRebatePct: 0.25 },
  'world-politics':     { feeRate: 0,    exponent: 1, makerRebatePct: 0 },
  'mentions':           { feeRate: 0.04, exponent: 1, makerRebatePct: 0.25 },
  'other':              { feeRate: 0.05, exponent: 1, makerRebatePct: 0.25 },
  '_default':           { feeRate: 0.05, exponent: 1, makerRebatePct: 0.25 },
};

/** Set of valid fee category slugs (excludes '_default'). Used by processMarket to match event tags. */
export const FEE_PARAM_SLUGS = new Set(Object.keys(FEE_PARAMS).filter(k => k !== '_default'));

/** Map live Gamma market.feeType values → our fee category slugs. */
export const FEETYPE_TO_FEE_SLUG = {
  'crypto_fees_v2':      'crypto',
  'sports_fees_v2':      'sports',
  'politics_fees':       'us-politics',
  'economics_fees':      'economics',
  'tech_fees':           'technology',
  'culture_fees':        'culture',
  'weather_fees':        'weather',
  'finance_prices_fees': 'business',
  'mentions_fees':       'mentions',
};

/**
 * Normalize a raw Gamma feeSchedule ({ rate, exponent, rebateRate }) to our
 * internal param shape. Returns null when absent or malformed so callers
 * fall back to the category table.
 */
export function normalizeFeeSchedule(feeSchedule) {
  if (!feeSchedule || typeof feeSchedule !== 'object') return null;
  const rate = Number(feeSchedule.rate);
  if (feeSchedule.rate == null || !isFinite(rate) || rate < 0) return null;
  const exponent = isFinite(Number(feeSchedule.exponent)) ? Number(feeSchedule.exponent) : 1;
  const rebate = isFinite(Number(feeSchedule.rebateRate)) ? Number(feeSchedule.rebateRate) : 0;
  return { feeRate: rate, exponent, makerRebatePct: rebate };
}

/**
 * Fallback-table fee parameters for a category slug (default for unmapped).
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
 * Resolve a market's fee context ONCE into the object every calculator
 * takes: { feeRate, exponent, makerRebatePct, enabled }.
 * The live per-market feeSchedule wins over the category table; `enabled`
 * carries the market's feesEnabled flag.
 */
export function resolveFeeParams({ gammaCategory = null, feesEnabled = false, feeSchedule = null } = {}) {
  const params = normalizeFeeSchedule(feeSchedule) || getFeeParams(gammaCategory);
  return { ...params, enabled: Boolean(feesEnabled) };
}

/**
 * A market is fee-free when fees are disabled OR its rate is zero.
 * Single definition used by processMarket, FLB, and the UI.
 */
export function isFeeFree(feeParams) {
  return !feeParams?.enabled || !(feeParams.feeRate > 0);
}

/** Per-share fee in dollars: feeRate × (p(1−p))^exponent. Internal helper. */
function feePerShare(price, feeParams) {
  if (isFeeFree(feeParams) || price == null || price <= 0 || price >= 1) return 0;
  return feeParams.feeRate * Math.pow(price * (1 - price), feeParams.exponent);
}

/**
 * Fee as a fraction of trade value (for display and Kelly's per-dollar edge).
 * = feePerShare / price. e.g. 0.035 → fees eat 3.5% of the dollars staked.
 */
export function computeEffectiveFeeRate(price, feeParams) {
  const perShare = feePerShare(price, feeParams);
  return perShare > 0 ? perShare / price : 0;
}

/**
 * Fee cost in probability points (¢ per share) — for subtracting from
 * FLB edges and theta break-evens, which are denominated per share.
 *
 * feePP = feeRate × (p(1−p))^exponent × 100.
 * Pinned to the docs' worked example: crypto at 50¢ → 0.07 × 0.25 × 100
 * = 1.75¢/share ($1.75 per 100 shares).
 */
export function computeFeePP(price, feeParams) {
  return feePerShare(price, feeParams) * 100;
}

/**
 * Maker rebate in probability points.
 */
export function computeMakerRebatePP(price, feeParams) {
  return computeFeePP(price, feeParams) * (feeParams?.makerRebatePct || 0);
}

/**
 * Round-trip cost in probability points.
 *
 * Spread cost is the FULL spread (not half) because a round trip crosses
 * the spread twice: half-spread above mid on entry, half-spread below mid on exit.
 *
 * @param {number} price — share price (0-1)
 * @param {number} spread — bid-ask spread in decimal (e.g., 0.02 for 2¢)
 * @param {object} feeParams — from resolveFeeParams
 * @returns {{ entryFeePP, exitFeePP, roundTripFeePP, spreadCostPP, totalCostPP }}
 */
export function computeRoundTripCostPP(price, spread, feeParams) {
  const entryFeePP = computeFeePP(price, feeParams);
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
