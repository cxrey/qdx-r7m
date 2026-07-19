/**
 * engineConfig.js — Named constants for tunable parameters across engines.
 *
 * Only includes cross-cutting or frequently-tuned values.
 * Engine-internal constants remain in their respective files.
 */

// ─── Cache TTLs ────────────────────────────────────────────────────
export const CACHE_TTL_24H = 24 * 60 * 60 * 1000;
export const CACHE_TTL_5M = 5 * 60 * 1000;
export const CACHE_TTL_POSITIONS = 5 * 60 * 1000;

// ─── Price bounds (shared across Theta, FLB, BaseRate) ─────────────
export const PRICE_VALID_MIN = 0.02;
export const PRICE_VALID_MAX = 0.95;
export const PRICE_CLAMP_MIN = 0.001;
export const PRICE_CLAMP_MAX = 0.999;

// ─── Time thresholds ───────────────────────────────────────────────
export const MIN_DAYS_REMAINING = 0.5;
export const THETA_ACCELERATION_LOOKAHEAD_DAYS = 7;
export const PROJECTION_DAYS = [7, 14, 21, 28];

// ─── Theta zones ───────────────────────────────────────────────────
export const THETA_CRUSH_ZONE = { priceLow: 0.25, priceHigh: 0.75, maxDays: 7 };
export const DEAD_MONEY_ZONE = { priceLow: 0.35, priceHigh: 0.65, minDays: 120 };
export const THETA_EXHAUSTED_ZONE = { priceLow: 0.05, priceHigh: 0.95, minDays: 14 };

// ─── ThetaEngine ───────────────────────────────────────────────────
export const DAILY_CLOSE_CORRECTION_FACTOR = 0.85;
export const HAZARD_RATE_MIN = 0.0001;
export const HAZARD_RATE_MAX = 0.5;

// ─── FLBEngine ─────────────────────────────────────────────────────
export const FLB_BIAS_OPPORTUNITY_EDGE = 0.03;
export const FLB_MODERATE_EDGE = 0.015;
export const FLB_SPREAD_KILLS_EDGE = 0.015;

// ─── BaseRateEngine ────────────────────────────────────────────────
export const BASE_RATE_MAX_RESOLVED = 5000;
export const BASE_RATE_MAX_PAGES = 200;
export const BASE_RATE_CONCURRENCY = 4;
export const BASE_RATE_MIN_DATA_POINTS = 20;
export const BASE_RATE_HIGH_CONFIDENCE_SAMPLE = 100;
export const BASE_RATE_FAIR_GAP_CENTS = 3;
export const BASE_RATE_SUGGESTION_GAP_CENTS = 5;

export const DURATION_BUCKETS = [7, 30, 90, 180]; // days

// ─── ResolutionAnalyzer ────────────────────────────────────────────
export const STRICTNESS_BASE_SCORE = 50;
export const MAX_PENALTY_MULTIPLIER = 2.0;
export const MULTI_CONDITION_PENALTY_RATE = 0.15;
export const EXCLUSIONARY_PENALTY_RATE = 0.12;
export const CONTINUOUS_PENALTY_PER_DAY = 0.02;
export const CONSENSUS_PENALTY = 1.10;
export const TOUCH_DISCOUNT = 0.75;
export const DATA_DRIVEN_DISCOUNT = 0.95;

// ─── SpreadFrictionEngine ──────────────────────────────────────────
export const SPREAD_THRESHOLDS = {
  noPenalty: 0.02,
  band1: 0.05,
  band2: 0.10,
};
export const FRICTION_SCORE_THRESHOLDS = { clean: 80, moderate: 60, heavy: 35 };

// ─── TradeFlowEngine ───────────────────────────────────────────────
export const LEADERBOARD_FETCH_LIMIT = 50;
export const ACTIVITY_FETCH_LIMIT = 100;
export const WASH_TRADE_WINDOW_SECONDS = 7200;
export const WALLET_IMBALANCE_THRESHOLD = 0.15;
export const MAX_FLOW_CACHE_SIZE = 500;

// ─── PortfolioEngine ───────────────────────────────────────────────
export const MAX_ENTITY_CACHE_SIZE = 500;
export const CLUSTER_CORRELATION_THRESHOLD = 0.4;
export const MAX_CORRELATION_CAP = 0.95;
export const DIVERSIFICATION_THRESHOLDS = {
  highlyConcentrated: 30,
  concentrated: 50,
  moderate: 80,
};

// ─── KellyEngine ───────────────────────────────────────────────────
export const KELLY_DEFAULT_BANKROLL = 1000;
export const KELLY_DEFAULT_MAX_POSITION_PCT = 20;
export const KELLY_DEFAULT_FRACTION = 0.25;
export const MULTI_OUTCOME_ALLOCATION_CAP = 0.8;
export const SENSITIVITY_RANGE_PP = 15;
export const MAX_JOURNAL_ENTRIES = 200;
export const MAX_CALIBRATION_POINTS = 500;

// ─── VolumeEfficiencyEngine ────────────────────────────────────────
export const VELOCITY_THRESHOLDS = {
  hot: 0.5,
  active: 0.2,
  stale: 0.05,
};
export const VOLUME_SWEET_SPOT = { min: 500_000, max: 5_000_000 };
export const OPPORTUNITY_MIN_EDGE = 0.02;
