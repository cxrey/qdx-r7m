import { analyzeConjunction, conjunctionEdgeBonus } from './ConjunctionEngine';
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

  const yesPrice = outcomePrices[0] != null ? parseFloat(outcomePrices[0]) : null;
  const noPrice = outcomePrices[1] != null ? parseFloat(outcomePrices[1]) : null;

  let endDate = market.endDate ? new Date(market.endDate) : null;
  if (endDate && isNaN(endDate.getTime())) endDate = null;
  const now = new Date();
  const daysLeft = endDate ? Math.max(0, Math.ceil((endDate - now) / (1000 * 60 * 60 * 24))) : null;

  const volume = parseFloat(market.volume || 0);
  const volume24hr = parseFloat(market.volume24hr || 0);

  const gammaBestBid = market.bestBid != null ? Number(market.bestBid) : null;
  const gammaBestAsk = market.bestAsk != null ? Number(market.bestAsk) : null;
  const gammaSpread = market.spread != null ? Number(market.spread) : null;

  // Prefer real bid-ask spread when available, fall back to overround estimate
  let spread;
  if (gammaBestBid != null && gammaBestAsk != null && gammaBestAsk > gammaBestBid) {
    spread = gammaBestAsk - gammaBestBid;
  } else if (yesPrice != null && noPrice != null) {
    spread = Math.abs(1 - yesPrice - noPrice);
  } else {
    spread = null;
  }

  const question = market.question || market.title || 'Untitled';
  const slug = market.events?.[0]?.slug || market.slug || '';
  // Prefer Gamma's own categorization when mapped, fall back to regex
  const rawCategory = market.category || null;
  const mappedCategory = rawCategory ? GAMMA_CATEGORY_MAP[rawCategory.toLowerCase()] : null;
  const category = mappedCategory || inferCategory(question, slug);

  let resolutionAnalysis = null;
  try {
    resolutionAnalysis = analyzeResolution({ ...market, yesPrice, endDate: market.endDate, end_date: market.endDate, created_at: market.createdAt });
  } catch (e) {
    console.warn('[processMarket] Resolution analysis failed for', market.id, e.message);
    _engineFailures.push('resolution');
  }

  let flb = null;
  try {
    flb = analyzeFLB({ yesPrice, noPrice, spread, resolutionAnalysis });
  } catch (e) {
    console.warn('[processMarket] FLB analysis failed for', market.id, e.message);
    _engineFailures.push('flb');
  }

  let theta = null;
  try {
    theta = analyzeTheta({ yesPrice, noPrice, daysLeft, question, description: market.description || '', resolutionAnalysis });
  } catch (e) {
    console.warn('[processMarket] Theta analysis failed for', market.id, e.message);
    _engineFailures.push('theta');
  }

  let volumeEfficiency = null;
  try {
    volumeEfficiency = analyzeVolumeEfficiency({ yesPrice, noPrice, volume, volume24hr });
  } catch (e) {
    console.warn('[processMarket] Volume efficiency analysis failed for', market.id, e.message);
    _engineFailures.push('volumeEfficiency');
  }

  // Base rate is always null here — it's injected later by consumers (useMarkets,
  // useDirectLookup, RefreshManager) after the async resolved-market fetch completes.
  const baseRate = null;

  let conjunction = null;
  try {
    conjunction = analyzeConjunction({
      question, description: market.description || '', yesPrice, noPrice,
      resolutionAnalysis,
    });
  } catch (e) {
    console.warn('[processMarket] Conjunction analysis failed for', market.id, e.message);
    _engineFailures.push('conjunction');
  }

  let edgeScore = 0;
  try {
    edgeScore = calculateEdgeScore({
      volume, yesPrice, noPrice, daysLeft, spread, flb, theta,
      resolutionAnalysis, volumeEfficiency, baseRate, conjunction,
    });
  } catch (e) {
    console.warn('[processMarket] Edge score calculation failed for', market.id, e.message);
    _engineFailures.push('edgeScore');
  }

  // ── Gamma API field extraction (no new API calls) ─────────────���───────────
  const oneDayPriceChange = market.oneDayPriceChange != null ? Number(market.oneDayPriceChange) : null;
  const lastTradePrice = market.lastTradePrice != null ? Number(market.lastTradePrice) : null;
  const liquidityClob = market.liquidityClob != null ? Number(market.liquidityClob) : null;
  const liquidityAmm = market.events?.[0]?.liquidityAmm != null ? Number(market.events[0].liquidityAmm) : null;
  const competitive = market.competitive != null ? Number(market.competitive) : null;
  const negRisk = typeof market.negRisk === 'boolean' ? market.negRisk : null;
  const commentCount = market.events?.[0]?.commentCount != null ? Number(market.events[0].commentCount) : null;
  const volume1wk = market.volume1wk != null ? Number(market.volume1wk) : null;
  const volume1mo = market.volume1mo != null ? Number(market.volume1mo) : null;
  const acceptingOrders = typeof market.acceptingOrders === 'boolean' ? market.acceptingOrders : null;
  const feesEnabled = market.feesEnabled ?? false;
  const gammaCategory = market.category || null;

  return {
    id: market.id,
    question,
    slug: market.events?.[0]?.slug || market.slug || '',
    description: market.description || '',
    yesPrice,
    noPrice,
    volume,
    volume24hr,
    daysLeft,
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
    _engineFailures,
  };
}

export function calculateEdgeScore(market) {
  const { volume, yesPrice, noPrice, daysLeft, spread, flb, theta,
          resolutionAnalysis, volumeEfficiency, baseRate, conjunction } = market;

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
