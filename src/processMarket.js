import { analyzeConjunction, conjunctionEdgeBonus } from './ConjunctionEngine';
import { computeEffectiveFeeRate, computeFeePP, computeRoundTripCostPP, isFeeFree, resolveFeeParams, FEE_PARAM_SLUGS, FEETYPE_TO_FEE_SLUG } from './feeCalculator';
import { MS_PER_DAY } from './engineConfig';
import { analyzeFLB } from './FLBEngine';
import { analyzeTheta } from './ThetaEngine';
import { analyzeResolution } from './ResolutionAnalyzer';
import { analyzeVolumeEfficiency } from './VolumeEfficiencyEngine';
import { analyzeBaseRate } from './BaseRateEngine';
import {
  VOLUME_BANDS, PRICE_MIDRANGE, PRICE_LONGSHOT, PRICE_DEFAULT_SCORE, PRICE_EXTREME_THRESHOLD,
  DAYS_LEFT_BANDS, DAYS_LEFT_DEFAULT_SCORE, SPREAD_BANDS,
  FLB_BIAS_OPPORTUNITY_SCORE, FLB_MODERATE_EDGE_SCORE,
  THETA_HIGH_THRESHOLD, THETA_HIGH_SCORE, THETA_MODERATE_THRESHOLD, THETA_MODERATE_SCORE,
  THETA_CRUSH_ZONE_SCORE, THETA_DEAD_MONEY_PENALTY,
  RESOLUTION_STRICT_THRESHOLD, RESOLUTION_STRICT_PRICE_MIN, RESOLUTION_STRICT_SCORE,
  RESOLUTION_MODERATE_THRESHOLD, RESOLUTION_MODERATE_PRICE_MIN, RESOLUTION_MODERATE_SCORE,
  RESOLUTION_TOUCH_PRICE_MAX, RESOLUTION_TOUCH_SCORE,
  VOLUME_EFFICIENCY_SCORES,
  BASE_RATE_GAP_LARGE, BASE_RATE_GAP_SMALL,
  BASE_RATE_NARRATIVE_PREMIUM_SCORE, BASE_RATE_NARRATIVE_DISCOUNT_SCORE, BASE_RATE_DEFAULT_SCORE,
  FEE_IMPACT_HIGH_THRESHOLD, FEE_IMPACT_HIGH_PENALTY,
  FEE_IMPACT_MODERATE_THRESHOLD, FEE_IMPACT_MODERATE_PENALTY,
  FEE_IMPACT_LOW_THRESHOLD, FEE_IMPACT_LOW_PENALTY,
  FEE_FREE_BONUS,
  MAX_EDGE_SCORE,
} from './scoringConfig';

const CATEGORY_RULES = [
  { category: 'Politics', patterns: [/president/i, /election/i, /trump/i, /biden/i, /congress/i, /senate/i, /governor/i, /democrat/i, /republican/i, /vote/i, /poll/i, /primary/i, /inaugur/i, /impeach/i, /parliament/i, /minister/i, /mayor/i, /political/i] },
  { category: 'Crypto', patterns: [/bitcoin/i, /btc/i, /ethereum/i, /eth\b/i, /crypto/i, /solana/i, /sol\b/i, /token/i, /defi/i, /nft/i, /blockchain/i, /doge/i, /xrp/i, /altcoin/i] },
  { category: 'Finance', patterns: [/stock/i, /s&p/i, /nasdaq/i, /dow jones/i, /fed\b/i, /interest rate/i, /inflation/i, /gdp/i, /recession/i, /treasury/i, /bond/i, /crude oil/i, /gold price/i, /\btsla\b/i, /\baapl\b/i, /\bnflx\b/i, /\bamzn\b/i, /\bgoog/i, /\bnvda\b/i, /market cap/i, /ipo\b/i, /earnings/i] },
  { category: 'Sports', patterns: [/nba/i, /nfl/i, /mlb/i, /nhl/i, /soccer/i, /football/i, /basketball/i, /baseball/i, /tennis/i, /golf/i, /ufc/i, /boxing/i, /f1\b/i, /formula/i, /championship/i, /playoff/i, /super bowl/i, /world cup/i, /premier league/i, /champions league/i, /draft/i, /mvp/i, /rookie/i, /coach/i] },
  { category: 'Geopolitics', patterns: [/war\b/i, /ceasefire/i, /iran/i, /russia/i, /ukraine/i, /china/i, /taiwan/i, /nato/i, /sanction/i, /military/i, /missile/i, /nuclear/i, /invasion/i, /conflict/i, /troops/i, /tariff/i, /trade war/i] },
  { category: 'Tech', patterns: [/\bai\b/i, /artificial intelligence/i, /openai/i, /google/i, /apple/i, /microsoft/i, /meta\b/i, /spacex/i, /tesla/i, /chatgpt/i, /gpt/i, /robot/i, /autonomous/i, /starship/i, /launch/i] },
  { category: 'Pop Culture', patterns: [/movie/i, /film/i, /oscar/i, /grammy/i, /emmy/i, /album/i, /music/i, /celebrity/i, /kanye/i, /taylor swift/i, /drake/i, /tiktok/i, /youtube/i, /kardashian/i, /gta/i, /game release/i, /rihanna/i, /beyonce/i] },
  { category: 'Science', patterns: [/climate/i, /temperature/i, /earthquake/i, /hurricane/i, /pandemic/i, /virus/i, /vaccine/i, /covid/i, /nasa/i, /space/i, /asteroid/i, /discovery/i] },
  { category: 'Legal', patterns: [/court/i, /lawsuit/i, /convicted/i, /trial\b/i, /judge/i, /indictment/i, /arrest/i, /guilty/i, /settlement/i, /supreme court/i, /ruling/i] },
];

// NOTE: Patterns must NOT use the /g flag — RegExp.test() with /g advances
// lastIndex between calls, causing alternating true/false on repeated matches.
function inferCategory(question, slug) {
  const text = `${question} ${slug}`;
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((p) => p.test(text))) return rule.category;
  }
  return 'Other';
}

export const ALL_CATEGORIES = CATEGORY_RULES.map((r) => r.category).concat('Other');

// Map Gamma API category slugs to our display categories.
// Unmapped slugs fall through to regex inferCategory.
const GAMMA_CATEGORY_MAP = {
  'us-current-affairs': 'Politics',
  'us-politics': 'Politics',
  'world-politics': 'Geopolitics',
  'crypto': 'Crypto',
  'sports': 'Sports',
  'science': 'Science',
  'pop-culture': 'Pop Culture',
  'business': 'Finance',
  'technology': 'Tech',
  'legal': 'Legal',
};

// Map event tag slugs → FEE_PARAMS keys for tags that don't match directly.
// Direct matches (crypto, sports, business, pop-culture, science, weather,
// mentions, other) don't need entries — they match FEE_PARAMS keys already.
export const TAG_SLUG_TO_FEE_SLUG = {
  'politics':    'us-politics',
  'geopolitics': 'world-politics',
  'tech':        'technology',
  'economy':     'economics',
  'finance':     'business',
  'legal':       'other',
};

// Last-resort fallback: map display category → fee slug for markets with no tags.
// Only map categories where the fee slug is confirmed by Polymarket's tag data.
// Unmapped categories (Science, Legal) fall through to null → _default.
export const DISPLAY_TO_FEE_SLUG = {
  'Politics':    'us-politics',
  'Crypto':      'crypto',
  'Sports':      'sports',
  'Finance':     'business',
  'Geopolitics': 'world-politics',
  'Tech':        'technology',
  'Pop Culture': 'pop-culture',
  'Other':       'other',
};

/**
 * Extract fee category slug from event tags array.
 * Returns the first tag slug that matches a FEE_PARAMS key (directly or via mapping).
 * Note: returns the first match in tag order — if the API returns tags in a different
 * order, a different fee slug could win. Currently safe because non-fee-relevant tags
 * (courts, earn-4, etc.) don't appear in FEE_PARAM_SLUGS or TAG_SLUG_TO_FEE_SLUG.
 */
function extractFeeCategoryFromTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return null;
  for (const tag of tags) {
    const slug = tag?.slug?.toLowerCase();
    if (!slug) continue;
    if (FEE_PARAM_SLUGS.has(slug)) return slug;
    if (slug in TAG_SLUG_TO_FEE_SLUG) return TAG_SLUG_TO_FEE_SLUG[slug];
  }
  return null;
}

const _loggedSlugs = new Set();
let _feeEnabledSeen = false;

/**
 * Run one analysis engine, isolating failures: on error, log it, record the
 * engine name in `failures`, and return `fallback` so the market still renders.
 */
function runEngine(name, failures, marketId, fn, fallback = null) {
  try {
    return fn();
  } catch (e) {
    console.warn(`[processMarket] ${name} failed for`, marketId, e.message);
    failures.push(name);
    return fallback;
  }
}

/** Safely coerce to finite number or null. Rejects NaN/Infinity/empty strings from bad API data. */
function safeNum(val) {
  if (val == null || val === '') return null;
  const n = Number(val);
  return isFinite(n) ? n : null;
}

export function processMarket(market) {
  const _engineFailures = [];

  let outcomePrices = [];
  try { if (market.outcomePrices) outcomePrices = JSON.parse(market.outcomePrices); } catch (e) {
    console.warn('[processMarket] Malformed outcomePrices for', market.id, e.message);
    _engineFailures.push('outcomePrices');
  }
  let clobTokenIds = [];
  try { if (market.clobTokenIds) clobTokenIds = JSON.parse(market.clobTokenIds); } catch (e) {
    console.warn('[processMarket] Malformed clobTokenIds for', market.id, e.message);
    _engineFailures.push('clobTokenIds');
  }

  const yesPrice = safeNum(outcomePrices[0]);
  const noPrice = safeNum(outcomePrices[1]);

  const rawEndDate = market.endDate || market.events?.[0]?.endDate;
  let endDate = rawEndDate ? new Date(rawEndDate) : null;
  if (endDate && isNaN(endDate.getTime())) endDate = null;
  const now = new Date();
  const daysLeft = endDate ? Math.max(0, Math.ceil((endDate - now) / MS_PER_DAY)) : null;

  // Full market lifetime (created → end) — the quantity BaseRateEngine
  // buckets resolved markets by. Distinct from daysLeft (time remaining).
  const rawCreatedAt = market.createdAt || market.events?.[0]?.createdAt;
  let createdDate = rawCreatedAt ? new Date(rawCreatedAt) : null;
  if (createdDate && isNaN(createdDate.getTime())) createdDate = null;
  const durationDays = endDate && createdDate
    ? Math.max(0, Math.ceil((endDate - createdDate) / MS_PER_DAY))
    : null;

  const volume = parseFloat(market.volume || 0);
  const volume24hr = parseFloat(market.volume24hr || 0);

  const gammaBestBid = safeNum(market.bestBid);
  const gammaBestAsk = safeNum(market.bestAsk);
  const gammaSpread = safeNum(market.spread);

  // Prefer real bid-ask spread when available, fall back to overround estimate
  if (gammaBestBid != null && gammaBestAsk != null && gammaBestBid > gammaBestAsk) {
    console.warn('[processMarket] Crossed book for', market.id, `bid=${gammaBestBid} ask=${gammaBestAsk}`);
  }
  let spread;
  if (gammaBestBid != null && gammaBestAsk != null && gammaBestAsk > gammaBestBid) {
    spread = gammaBestAsk - gammaBestBid;
  } else if (yesPrice != null && noPrice != null) {
    spread = Math.abs(1 - yesPrice - noPrice);
  } else {
    spread = null;
  }

  const question = market.question || market.title || 'Untitled';
  const description = market.description || '';
  const slug = market.events?.[0]?.slug || market.slug || '';
  // Prefer Gamma's own categorization when mapped, fall back to regex
  const rawCategory = market.category || null;
  const mappedCategory = rawCategory ? GAMMA_CATEGORY_MAP[rawCategory.toLowerCase()] : null;
  if (rawCategory && !mappedCategory && !_loggedSlugs.has(rawCategory)) {
    _loggedSlugs.add(rawCategory);
    console.debug('[processMarket] Unmapped Gamma category slug:', rawCategory);
  }
  const category = mappedCategory || inferCategory(question, slug);

  // ── Fee params + gammaCategory (fee slug) derivation ─────────
  // The live per-market feeSchedule ({ rate, exponent, rebateRate }) is the
  // authoritative fee source — every fee-enabled Gamma market carries one.
  // gammaCategory (fee slug) is only the FALLBACK path for markets without
  // a schedule, derived with priority:
  //   market.feeType (live) > rawCategory > event tags > display-category.
  // Both are resolved ONCE into feeParams, which every fee calculator takes.
  // Display category ('Crypto', 'Sports', ...) remains a separate concept
  // used for UI pills and filters.
  const feesEnabled = market.feesEnabled ?? false;
  if (feesEnabled && !_feeEnabledSeen) {
    _feeEnabledSeen = true;
    console.info('[processMarket] feesEnabled=true detected on', market.id, '— verify FEE_PARAMS against live API');
  }
  const feeType = market.feeType || null;
  const feeTypeSlug = feeType ? (FEETYPE_TO_FEE_SLUG[feeType] || null) : null;
  const tagCategory = extractFeeCategoryFromTags(market.events?.[0]?.tags);
  const gammaCategory = feeTypeSlug || rawCategory || tagCategory || DISPLAY_TO_FEE_SLUG[category] || null;
  const feeParams = resolveFeeParams({ gammaCategory, feesEnabled, feeSchedule: market.feeSchedule });

  const fail = _engineFailures;
  const resolutionAnalysis = runEngine('resolution', fail, market.id, () =>
    analyzeResolution({ ...market, yesPrice, endDate: rawEndDate, end_date: rawEndDate, created_at: rawCreatedAt }));

  const flb = runEngine('flb', fail, market.id, () =>
    analyzeFLB({ yesPrice, noPrice, spread, resolutionAnalysis, feeParams }));

  const theta = runEngine('theta', fail, market.id, () =>
    analyzeTheta({ yesPrice, noPrice, daysLeft, question, description, resolutionAnalysis }));

  const volumeEfficiency = runEngine('volumeEfficiency', fail, market.id, () =>
    analyzeVolumeEfficiency({ yesPrice, noPrice, volume, volume24hr }));

  // Base rate is always null here — it's injected later by consumers (useMarkets,
  // useDirectLookup, RefreshManager) after the async resolved-market fetch completes.
  const baseRate = null;

  const conjunction = runEngine('conjunction', fail, market.id, () =>
    analyzeConjunction({ question, description, yesPrice, noPrice, resolutionAnalysis }));

  // ── Gamma API field extraction (no new API calls) ────────────────────────
  const oneDayPriceChange = safeNum(market.oneDayPriceChange);
  const lastTradePrice = safeNum(market.lastTradePrice);
  const liquidityClob = safeNum(market.liquidityClob);
  const liquidityAmm = safeNum(market.events?.[0]?.liquidityAmm);
  const competitive = safeNum(market.competitive);
  const negRisk = typeof market.negRisk === 'boolean' ? market.negRisk : null;
  const commentCount = safeNum(market.events?.[0]?.commentCount);
  const volume1wk = safeNum(market.volume1wk);
  const volume1mo = safeNum(market.volume1mo);
  const acceptingOrders = typeof market.acceptingOrders === 'boolean' ? market.acceptingOrders : null;
  const openInterest = safeNum(market.events?.[0]?.openInterest);

  // Fee calculations — computed before edgeScore so the fee penalty/bonus applies on first pass
  const effectiveTakerFee = computeEffectiveFeeRate(yesPrice, feeParams);
  const takerFeePP = computeFeePP(yesPrice, feeParams);
  const feeFree = isFeeFree(feeParams);

  const edgeScore = runEngine('edgeScore', fail, market.id, () => calculateEdgeScore({
    volume, yesPrice, noPrice, daysLeft, spread, flb, theta,
    resolutionAnalysis, volumeEfficiency, baseRate, conjunction,
    takerFeePP, feeFree,
  }), 0);

  // Theta break-even: how many days of theta needed to overcome round-trip costs
  let thetaBreakEvenDays = null;
  if (theta && spread != null) {
    const roundTrip = computeRoundTripCostPP(yesPrice, spread, feeParams);
    const dailyThetaPP = Math.abs(theta.bestTheta) * 100;
    thetaBreakEvenDays = roundTrip.totalCostPP > 0 && dailyThetaPP > 0
      ? Math.ceil(roundTrip.totalCostPP / dailyThetaPP)
      : null;
  }

  return {
    id: market.id,
    question,
    slug,
    description,
    yesPrice,
    noPrice,
    volume,
    volume24hr,
    daysLeft,
    durationDays,
    endDate: endDate ? endDate.toLocaleDateString() : 'N/A',
    category,
    edgeScore,
    spread,
    flb,
    theta,
    resolutionAnalysis,
    volumeEfficiency,
    baseRate,
    conjunction,
    conditionId: market.conditionId || market.condition_id || null,
    clobTokenIds,
    active: market.active,
    closed: market.closed,
    gammaBestBid,
    gammaBestAsk,
    gammaSpread,
    oneDayPriceChange,
    lastTradePrice,
    liquidityClob,
    liquidityAmm,
    competitive,
    negRisk,
    commentCount,
    volume1wk,
    volume1mo,
    acceptingOrders,
    feesEnabled,
    gammaCategory,
    feeType,
    feeParams,
    openInterest,
    effectiveTakerFee,
    takerFeePP,
    feeFree,
    thetaBreakEvenDays,
    _engineFailures,
  };
}

export function calculateEdgeScore(market) {
  const { volume, yesPrice, noPrice, daysLeft, spread, flb, theta,
          resolutionAnalysis, volumeEfficiency, baseRate, conjunction,
          takerFeePP, feeFree } = market;

  let score = 0;

  // Volume scoring — first matching band wins
  for (const band of VOLUME_BANDS) {
    if (volume >= band.min && volume <= band.max) { score += band.score; break; }
  }

  // Price scoring
  if (yesPrice != null) {
    const yc = yesPrice * 100;
    const nc = noPrice != null ? noPrice * 100 : (100 - yc);
    if ((yc >= PRICE_MIDRANGE.min && yc <= PRICE_MIDRANGE.max) ||
        (nc >= PRICE_MIDRANGE.min && nc <= PRICE_MIDRANGE.max)) score += PRICE_MIDRANGE.score;
    else if (yc >= PRICE_LONGSHOT.min && yc <= PRICE_LONGSHOT.max) score += PRICE_LONGSHOT.score;
    else if (!(yc >= PRICE_EXTREME_THRESHOLD || nc >= PRICE_EXTREME_THRESHOLD)) score += PRICE_DEFAULT_SCORE;
  }

  // Days left scoring — first matching band wins, then fallback
  if (daysLeft != null) {
    let matched = false;
    for (const band of DAYS_LEFT_BANDS) {
      if (daysLeft >= band.min && daysLeft <= band.max) { score += band.score; matched = true; break; }
    }
    if (!matched) score += DAYS_LEFT_DEFAULT_SCORE;
  }

  // Spread scoring
  if (spread != null && yesPrice != null && noPrice != null) {
    const mid = (yesPrice + noPrice) / 2;
    if (mid > 0) {
      const spreadPct = (spread / mid) * 100;
      for (const band of SPREAD_BANDS) {
        if (band.strict ? spreadPct < band.maxPct : spreadPct <= band.maxPct) { score += band.score; break; }
      }
    }
  }

  // FLB bonus
  if (flb) {
    if (flb.isBiasOpportunity) score += FLB_BIAS_OPPORTUNITY_SCORE;
    else if (flb.isModerateEdge) score += FLB_MODERATE_EDGE_SCORE;
  }

  // Theta bonus
  if (theta) {
    const absDailyTheta = Math.abs(theta.bestTheta) * 100;
    if (absDailyTheta > THETA_HIGH_THRESHOLD) score += THETA_HIGH_SCORE;
    else if (absDailyTheta > THETA_MODERATE_THRESHOLD) score += THETA_MODERATE_SCORE;
    if (theta.zones.includes('THETA_CRUSH_ZONE')) score += THETA_CRUSH_ZONE_SCORE;
    if (theta.zones.includes('DEAD_MONEY')) score += THETA_DEAD_MONEY_PENALTY;
  }

  // Resolution strictness bonus
  if (resolutionAnalysis?.strictness) {
    const ss = resolutionAnalysis.strictness.score;
    const hasTouch = resolutionAnalysis.characteristics?.some((c) => c.type === 'TOUCH' && c.confidence === 'HIGH');
    if (ss > RESOLUTION_STRICT_THRESHOLD && yesPrice != null && yesPrice > RESOLUTION_STRICT_PRICE_MIN) score += RESOLUTION_STRICT_SCORE;
    else if (ss > RESOLUTION_MODERATE_THRESHOLD && yesPrice != null && yesPrice > RESOLUTION_MODERATE_PRICE_MIN) score += RESOLUTION_MODERATE_SCORE;
    if (hasTouch && yesPrice != null && yesPrice < RESOLUTION_TOUCH_PRICE_MAX) score += RESOLUTION_TOUCH_SCORE;
  }

  // Volume efficiency bonus
  if (volumeEfficiency) {
    const veScore = VOLUME_EFFICIENCY_SCORES[volumeEfficiency.priority];
    if (veScore != null) score += veScore;
  }

  // Base rate bonus
  if (baseRate) {
    if (baseRate.gapType === 'NARRATIVE_PREMIUM' && baseRate.absGapCents > BASE_RATE_GAP_LARGE && baseRate.confidence !== 'LOW') score += BASE_RATE_NARRATIVE_PREMIUM_SCORE;
    else if (baseRate.gapType === 'NARRATIVE_DISCOUNT' && baseRate.absGapCents > BASE_RATE_GAP_LARGE && baseRate.confidence !== 'LOW') score += BASE_RATE_NARRATIVE_DISCOUNT_SCORE;
    else if (baseRate.absGapCents > BASE_RATE_GAP_SMALL && baseRate.confidence !== 'LOW') score += BASE_RATE_DEFAULT_SCORE;
  }

  // Conjunction bonus
  if (conjunction) {
    score += conjunctionEdgeBonus(conjunction);
  }

  // Fee impact penalty/bonus
  const rawEdgeDecimal = flb?.bestEdge || 0;
  const rawEdgePP = rawEdgeDecimal * 100;
  if (takerFeePP > 0 && rawEdgePP > 0) {
    const feeImpact = takerFeePP / rawEdgePP;
    if (feeImpact > FEE_IMPACT_HIGH_THRESHOLD) score += FEE_IMPACT_HIGH_PENALTY;
    else if (feeImpact > FEE_IMPACT_MODERATE_THRESHOLD) score += FEE_IMPACT_MODERATE_PENALTY;
    else if (feeImpact > FEE_IMPACT_LOW_THRESHOLD) score += FEE_IMPACT_LOW_PENALTY;
  } else if (feeFree) {
    score += FEE_FREE_BONUS;
  }

  return Math.min(MAX_EDGE_SCORE, score);
}

/**
 * Enrich a processed market with base rate analysis and recalculate edge score.
 * Single source of truth — replaces the duplicated map→analyzeBaseRate→calculateEdgeScore
 * pattern that existed in useMarkets (×2), RefreshManager (×2), and useDirectLookup (×1).
 */
export function enrichWithBaseRate(market, baseRates) {
  if (!baseRates) return market;
  try {
    const br = analyzeBaseRate(market, baseRates);
    // Short-circuit: skip allocation + recalc if base rate is unchanged
    if (br === market.baseRate) return market;
    if (br && market.baseRate &&
        br.baseRate === market.baseRate.baseRate &&
        br.gapType === market.baseRate.gapType &&
        br.confidence === market.baseRate.confidence) return market;
    const newEdge = calculateEdgeScore({ ...market, baseRate: br });
    return { ...market, baseRate: br, edgeScore: newEdge, _engineFailures: market._engineFailures ? [...market._engineFailures] : [] };
  } catch (e) {
    console.warn('[enrichWithBaseRate] Failed for', market.id, e.message);
    return market;
  }
}
