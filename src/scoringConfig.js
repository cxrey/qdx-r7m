/**
 * Scoring thresholds for calculateEdgeScore.
 *
 * Each section documents the rationale behind its bands. All values are
 * tunable — changing a number here propagates everywhere automatically.
 * The shape of each band array is: [{ min, max, score }] evaluated
 * top-to-bottom (first match wins), except where noted.
 */

// --- Volume ---
// Sweet spot: $1M–5M signals strong interest without whale domination.
// $500K–1M and $5M–10M are respectable but less ideal.
// Below $100K = too thin; above $10M = already priced in.
export const VOLUME_BANDS = [
  { min: 1_000_000, max: 5_000_000, score: 25 },
  { min: 500_000,   max: 1_000_000, score: 15 },
  { min: 5_000_001, max: 10_000_000, score: 15 },
  { min: 100_000,   max: 500_000,   score: 10 },
];

// --- Price ---
// Mid-range prices (25–75¢) have the most room for movement in either direction.
// Low prices (5–15¢) are longshots with asymmetric upside.
// Extreme prices (≥90¢ either side) are nearly resolved — no bonus.
export const PRICE_MIDRANGE = { min: 25, max: 75, score: 25 };
export const PRICE_LONGSHOT = { min: 5, max: 15, score: 15 };
export const PRICE_DEFAULT_SCORE = 5;
export const PRICE_EXTREME_THRESHOLD = 90; // ≥90¢ on either side → 0 bonus

// --- Days Left ---
// 2–8 weeks is the action zone: enough time for catalysts, not so much that theta bleeds.
// <14d or 57–120d are still tradeable. >180d is long-duration (low theta value).
// 121–180d is the "dead zone" — too far for catalysts, too close for long-hold.
export const DAYS_LEFT_BANDS = [
  { min: 14, max: 56,  score: 25 },
  { min: 0,  max: 13,  score: 15 },
  { min: 57, max: 120, score: 15 },
  { min: 181, max: Infinity, score: 5 },
];
export const DAYS_LEFT_DEFAULT_SCORE = 10; // 121–180d fallback

// --- Spread ---
// Tight spreads (<2%) mean you can enter/exit cheaply.
// Up to 5% is acceptable for less liquid markets.
// 5–10% is tradeable but costly; >10% = no bonus.
// `lt` = strict less-than; `lte` = less-than-or-equal. Original code used < for the
// first band and <= for the rest, so we preserve that distinction.
export const SPREAD_BANDS = [
  { maxPct: 2,  score: 25, strict: true },
  { maxPct: 5,  score: 15, strict: false },
  { maxPct: 10, score: 10, strict: false },
];

// --- FLB (Favourite-Longshot Bias) ---
// Strong bias opportunity = mispricing the public hasn't corrected.
// Moderate edge = smaller but still exploitable.
export const FLB_BIAS_OPPORTUNITY_SCORE = 15;
export const FLB_MODERATE_EDGE_SCORE = 8;

// --- Theta ---
// High daily theta (>0.5¢/day) = meaningful time decay to exploit.
// Moderate (>0.2¢/day) = still worth noting.
// THETA_CRUSH_ZONE = approaching catalyst where theta accelerates.
// DEAD_MONEY = flat theta, capital is idle.
export const THETA_HIGH_THRESHOLD = 0.5;
export const THETA_HIGH_SCORE = 10;
export const THETA_MODERATE_THRESHOLD = 0.2;
export const THETA_MODERATE_SCORE = 5;
export const THETA_CRUSH_ZONE_SCORE = 8;
export const THETA_DEAD_MONEY_PENALTY = -5;

// --- Resolution Strictness ---
// Strict resolution criteria (score > 75) + non-cheap price (>30¢) = high confidence trade.
// Moderate strictness (>60) + reasonable price (>25¢) = decent signal.
// TOUCH-type resolution with cheap price (<15¢) = asymmetric upside on binary events.
export const RESOLUTION_STRICT_THRESHOLD = 75;
export const RESOLUTION_STRICT_PRICE_MIN = 0.30;
export const RESOLUTION_STRICT_SCORE = 12;
export const RESOLUTION_MODERATE_THRESHOLD = 60;
export const RESOLUTION_MODERATE_PRICE_MIN = 0.25;
export const RESOLUTION_MODERATE_SCORE = 6;
export const RESOLUTION_TOUCH_PRICE_MAX = 0.15;
export const RESOLUTION_TOUCH_SCORE = 8;

// --- Volume Efficiency ---
// SWEET_SPOT: optimal volume/liquidity ratio for the price level.
// OPPORTUNITY: decent ratio, slightly imbalanced. MARGINAL: thin but tradeable.
// LOW_LIQUIDITY: dangerous — wide slippage, penalize.
export const VOLUME_EFFICIENCY_SCORES = {
  SWEET_SPOT: 15,
  OPPORTUNITY: 8,
  MARGINAL: 3,
  LOW_LIQUIDITY: -5,
};

// --- Base Rate ---
// NARRATIVE_PREMIUM: market overprices vs. historical base rate (>8¢ gap) → fade opportunity.
// NARRATIVE_DISCOUNT: market underprices vs. base rate → value buy.
// Any gap >5¢ with decent confidence is still informative.
export const BASE_RATE_GAP_LARGE = 8;
export const BASE_RATE_GAP_SMALL = 5;
export const BASE_RATE_NARRATIVE_PREMIUM_SCORE = 10;
export const BASE_RATE_NARRATIVE_DISCOUNT_SCORE = 8;
export const BASE_RATE_DEFAULT_SCORE = 5;

// --- Fees ---
// Fee impact = takerFeePP / rawEdgePP. Higher impact means fees eat more of the edge.
// Fee-free markets get a structural bonus.
export const FEE_IMPACT_HIGH_THRESHOLD = 0.75;
export const FEE_IMPACT_HIGH_PENALTY = -5;
export const FEE_IMPACT_MODERATE_THRESHOLD = 0.50;
export const FEE_IMPACT_MODERATE_PENALTY = -3;
export const FEE_IMPACT_LOW_THRESHOLD = 0.25;
export const FEE_IMPACT_LOW_PENALTY = -1;
export const FEE_FREE_BONUS = 2;

// --- Global ---
export const MAX_EDGE_SCORE = 100;
