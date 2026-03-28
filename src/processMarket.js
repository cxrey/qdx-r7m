import { analyzeConjunction, conjunctionEdgeBonus } from './ConjunctionEngine';
import { analyzeFLB } from './FLBEngine';
import { analyzeTheta } from './ThetaEngine';
import { analyzeResolution } from './ResolutionAnalyzer';
import { analyzeVolumeEfficiency } from './VolumeEfficiencyEngine';
import { analyzeBaseRate } from './BaseRateEngine';

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

export function processMarket(market) {
  let outcomePrices = [];
  try { if (market.outcomePrices) outcomePrices = JSON.parse(market.outcomePrices); } catch { /* malformed */ }
  let clobTokenIds = [];
  try { if (market.clobTokenIds) clobTokenIds = JSON.parse(market.clobTokenIds); } catch { /* malformed */ }

  const yesPrice = outcomePrices[0] != null ? parseFloat(outcomePrices[0]) : null;
  const noPrice = outcomePrices[1] != null ? parseFloat(outcomePrices[1]) : null;

  let endDate = market.endDate ? new Date(market.endDate) : null;
  if (endDate && isNaN(endDate.getTime())) endDate = null;
  const now = new Date();
  const daysLeft = endDate ? Math.max(0, Math.ceil((endDate - now) / (1000 * 60 * 60 * 24))) : null;

  const volume = parseFloat(market.volume || 0);
  const volume24hr = parseFloat(market.volume24hr || 0);

  const spread = (yesPrice != null && noPrice != null)
    ? Math.abs(1 - yesPrice - noPrice)
    : null;

  const question = market.question || market.title || 'Untitled';
  const slug = market.events?.[0]?.slug || market.slug || '';
  const category = inferCategory(question, slug);

  const _engineFailures = [];

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
    _engineFailures,
  };
}

export function calculateEdgeScore(market) {
  const { volume, yesPrice, noPrice, daysLeft, spread, flb, theta,
          resolutionAnalysis, volumeEfficiency, baseRate, conjunction } = market;

  let score = 0;

  // Volume scoring
  if (volume >= 1_000_000 && volume <= 5_000_000) score += 25;
  else if ((volume >= 500_000 && volume < 1_000_000) || (volume > 5_000_000 && volume <= 10_000_000)) score += 15;
  else if (volume >= 100_000 && volume < 500_000) score += 10;

  // Price scoring
  if (yesPrice != null) {
    const yc = yesPrice * 100;
    const nc = noPrice != null ? noPrice * 100 : (100 - yc);
    if ((yc >= 25 && yc <= 75) || (nc >= 25 && nc <= 75)) score += 25;
    else if (yc >= 5 && yc <= 15) score += 15;
    else if (!(yc >= 90 || nc >= 90)) score += 5; // extreme prices (>=90c) get no bonus
  }

  // Days left scoring
  if (daysLeft != null) {
    if (daysLeft >= 14 && daysLeft <= 56) score += 25;
    else if ((daysLeft >= 0 && daysLeft < 14) || (daysLeft > 56 && daysLeft <= 120)) score += 15;
    else if (daysLeft > 180) score += 5;
    else score += 10;
  }

  // Spread scoring
  if (spread != null && yesPrice != null && noPrice != null) {
    const mid = (yesPrice + noPrice) / 2;
    if (mid > 0) {
      const spreadPct = (spread / mid) * 100;
      if (spreadPct < 2) score += 25;
      else if (spreadPct <= 5) score += 15;
      else if (spreadPct <= 10) score += 10;
    }
  }

  // FLB bonus
  if (flb) {
    if (flb.isBiasOpportunity) score += 15;
    else if (flb.isModerateEdge) score += 8;
  }

  // Theta bonus
  if (theta) {
    const absDailyTheta = Math.abs(theta.bestTheta) * 100;
    if (absDailyTheta > 0.5) score += 10;
    else if (absDailyTheta > 0.2) score += 5;
    if (theta.zones.includes('THETA_CRUSH_ZONE')) score += 8;
    if (theta.zones.includes('DEAD_MONEY')) score -= 5;
  }

  // Resolution strictness bonus
  if (resolutionAnalysis?.strictness) {
    const ss = resolutionAnalysis.strictness.score;
    const hasTouch = resolutionAnalysis.characteristics?.some((c) => c.type === 'TOUCH' && c.confidence === 'HIGH');
    if (ss > 75 && yesPrice != null && yesPrice > 0.30) score += 12;
    else if (ss > 60 && yesPrice != null && yesPrice > 0.25) score += 6;
    if (hasTouch && yesPrice != null && yesPrice < 0.15) score += 8;
  }

  // Volume efficiency bonus
  if (volumeEfficiency) {
    if (volumeEfficiency.priority === 'SWEET_SPOT') score += 15;
    else if (volumeEfficiency.priority === 'OPPORTUNITY') score += 8;
    else if (volumeEfficiency.priority === 'MARGINAL') score += 3;
    else if (volumeEfficiency.priority === 'LOW_LIQUIDITY') score -= 5;
  }

  // Base rate bonus
  if (baseRate) {
    if (baseRate.gapType === 'NARRATIVE_PREMIUM' && baseRate.absGapCents > 8 && baseRate.confidence !== 'LOW') score += 10;
    else if (baseRate.gapType === 'NARRATIVE_DISCOUNT' && baseRate.absGapCents > 8 && baseRate.confidence !== 'LOW') score += 8;
    else if (baseRate.absGapCents > 5 && baseRate.confidence !== 'LOW') score += 5;
  }

  // Conjunction bonus
  if (conjunction) {
    score += conjunctionEdgeBonus(conjunction);
  }

  return Math.min(100, score);
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
