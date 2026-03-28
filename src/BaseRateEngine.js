// Base Rate Engine
// Fetches resolved Polymarket markets, computes empirical base rates by
// category / structure / duration / price bucket, and compares active market
// prices to historical base rates to detect "narrative premiums".

const GAMMA_API = '/gamma-api';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Cache helpers ───
const CACHE_KEY = 'polymarket_base_rates';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.ts > CACHE_TTL) {
      localStorage.removeItem(CACHE_KEY);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

function saveCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch { /* quota exceeded – silently skip */ }
}

// ─── Fetch resolved markets ───
const MAX_RESOLVED = 5000;
const MAX_RESOLVED_PAGES = 200;
const MAX_CONSECUTIVE_EMPTY_RESOLVED = 3;

async function fetchResolvedPage(url, signal, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (signal?.aborted) return null;
    try {
      const res = await fetch(url, { signal });
      if (res.status === 429) {
        const wait = parseInt(res.headers.get('Retry-After') || '3', 10) * 1000;
        await delay(wait);
        continue;
      }
      if (!res.ok) {
        await delay(1000 * (attempt + 1));
        continue;
      }
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') return null;
      await delay(1000 * (attempt + 1));
    }
  }
  return null;
}

export async function fetchResolvedMarkets(signal) {
  const cached = loadCache();
  if (cached?.resolvedMarkets) return cached;

  const markets = [];
  let offset = 0;
  const limit = 100;
  let consecutiveEmpty = 0;
  let pageCount = 0;

  while (markets.length < MAX_RESOLVED && consecutiveEmpty < MAX_CONSECUTIVE_EMPTY_RESOLVED && pageCount < MAX_RESOLVED_PAGES) {
    if (signal?.aborted) break;
    const url = `${GAMMA_API}/markets?limit=${limit}&offset=${offset}&closed=true&order=volume&ascending=false`;
    const data = await fetchResolvedPage(url, signal);
    pageCount++;

    if (!data || !Array.isArray(data) || data.length === 0) {
      consecutiveEmpty++;
      offset += limit;
      await delay(200);
      continue;
    }

    consecutiveEmpty = 0;

    // Only keep markets that have a clear resolved outcome
    for (const m of data) {
      if (m.resolutionSource || m.resolvedBy || m.outcome != null || m.resolution != null) {
        markets.push(m);
      }
    }

    offset += limit;
    await delay(200);
  }

  console.log(`[BaseRateEngine] Fetched ${markets.length} resolved markets across ${pageCount} pages.`);

  const result = { resolvedMarkets: markets, fetchedAt: Date.now() };
  saveCache(result);
  return result;
}

// ─── Category inference (mirrors api.js) ───
const CATEGORY_RULES = [
  { category: 'Politics', patterns: [/president/i, /election/i, /trump/i, /biden/i, /congress/i, /senate/i, /governor/i, /democrat/i, /republican/i, /vote/i, /poll/i] },
  { category: 'Crypto', patterns: [/bitcoin/i, /btc/i, /ethereum/i, /eth\b/i, /crypto/i, /solana/i, /token/i, /defi/i, /nft/i, /blockchain/i] },
  { category: 'Finance', patterns: [/stock/i, /s&p/i, /nasdaq/i, /dow jones/i, /fed\b/i, /interest rate/i, /inflation/i, /gdp/i, /recession/i, /treasury/i] },
  { category: 'Sports', patterns: [/nba/i, /nfl/i, /mlb/i, /nhl/i, /soccer/i, /football/i, /basketball/i, /baseball/i, /tennis/i, /golf/i, /ufc/i, /boxing/i, /championship/i, /playoff/i, /super bowl/i] },
  { category: 'Geopolitics', patterns: [/war\b/i, /ceasefire/i, /iran/i, /russia/i, /ukraine/i, /china/i, /taiwan/i, /nato/i, /sanction/i, /tariff/i] },
  { category: 'Tech', patterns: [/\bai\b/i, /artificial intelligence/i, /openai/i, /google/i, /apple/i, /microsoft/i, /meta\b/i, /spacex/i, /tesla/i, /chatgpt/i] },
  { category: 'Pop Culture', patterns: [/movie/i, /film/i, /oscar/i, /grammy/i, /emmy/i, /album/i, /music/i, /celebrity/i, /tiktok/i, /youtube/i] },
  { category: 'Science', patterns: [/climate/i, /temperature/i, /earthquake/i, /hurricane/i, /pandemic/i, /virus/i, /vaccine/i, /covid/i, /nasa/i, /space/i] },
  { category: 'Legal', patterns: [/court/i, /lawsuit/i, /convicted/i, /trial\b/i, /judge/i, /indictment/i, /arrest/i, /guilty/i, /settlement/i, /ruling/i] },
];

function inferCat(question) {
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((p) => p.test(question))) return rule.category;
  }
  return 'Other';
}

// Duration bucket from days between created & closed
function durationBucket(days) {
  if (days == null || isNaN(days)) return 'unknown';
  if (days <= 7) return '<=7d';
  if (days <= 30) return '8-30d';
  if (days <= 90) return '31-90d';
  if (days <= 180) return '91-180d';
  return '>180d';
}

// Price bucket (initial yes price in cents)
function priceBucket(price) {
  if (price == null || isNaN(price)) return 'unknown';
  const c = price * 100;
  if (c <= 10) return '0-10¢';
  if (c <= 25) return '11-25¢';
  if (c <= 40) return '26-40¢';
  if (c <= 60) return '41-60¢';
  if (c <= 75) return '61-75¢';
  if (c <= 90) return '76-90¢';
  return '91-100¢';
}

// ─── Compute base rates ───
export function computeBaseRates(resolvedMarkets) {
  // Tracks: { total, yesResolved } for each key
  const buckets = {
    global: { total: 0, yesResolved: 0 },
    byCategory: {},
    byDuration: {},
    byPriceBucket: {},
    byCategoryAndPrice: {},
  };

  for (const m of resolvedMarkets) {
    const resolvedYes = determineResolution(m);
    if (resolvedYes == null) continue; // ambiguous resolution, skip

    const question = m.question || m.title || '';
    const category = inferCat(question);

    // Parse initial yes price
    let yesPrice = null;
    try {
      const prices = JSON.parse(m.outcomePrices || '[]');
      yesPrice = prices[0] != null ? parseFloat(prices[0]) : null;
    } catch { /* ignore */ }

    // Duration
    let duration = null;
    if (m.createdAt && m.endDate) {
      const created = new Date(m.createdAt);
      const ended = new Date(m.endDate);
      duration = Math.max(0, Math.ceil((ended - created) / (1000 * 60 * 60 * 24)));
    }

    const durBucket = durationBucket(duration);
    const pBucket = priceBucket(yesPrice);

    // Increment
    const inc = (obj, key) => {
      if (!obj[key]) obj[key] = { total: 0, yesResolved: 0 };
      obj[key].total++;
      if (resolvedYes) obj[key].yesResolved++;
    };

    buckets.global.total++;
    if (resolvedYes) buckets.global.yesResolved++;

    inc(buckets.byCategory, category);
    inc(buckets.byDuration, durBucket);
    inc(buckets.byPriceBucket, pBucket);
    inc(buckets.byCategoryAndPrice, `${category}|${pBucket}`);
  }

  return buckets;
}

/**
 * Determine if a market resolved to YES.
 * Returns true (YES), false (NO), or null (ambiguous/unknown).
 */
function determineResolution(m) {
  // Direct outcome field
  if (m.outcome === 'Yes' || m.outcome === 'YES' || m.outcome === 'yes') return true;
  if (m.outcome === 'No' || m.outcome === 'NO' || m.outcome === 'no') return false;

  // Resolution field
  if (m.resolution === 'Yes' || m.resolution === 'YES') return true;
  if (m.resolution === 'No' || m.resolution === 'NO') return false;

  // outcomePrices near 0 or 1 after resolution
  try {
    const prices = JSON.parse(m.outcomePrices || '[]');
    const yp = parseFloat(prices[0]);
    if (yp >= 0.95) return true;
    if (yp <= 0.05) return false;
  } catch { /* ignore */ }

  return null;
}

// ─── Per-market analysis ───
export function analyzeBaseRate(market, baseRates) {
  if (!baseRates || !baseRates.global || baseRates.global.total < 20) {
    return null;
  }

  const yesPrice = market.yesPrice;
  if (yesPrice == null) return null;

  const category = market.category || 'Other';
  const pBucket = priceBucket(yesPrice);
  const daysLeft = market.daysLeft;
  const durBucket = durationBucket(daysLeft);

  // Find best matching bucket (most specific → least specific)
  const catPriceKey = `${category}|${pBucket}`;
  const catPrice = baseRates.byCategoryAndPrice?.[catPriceKey];
  const catOnly = baseRates.byCategory?.[category];
  const priceOnly = baseRates.byPriceBucket?.[pBucket];
  const durOnly = baseRates.byDuration?.[durBucket];
  const global = baseRates.global;

  // Weighted average of available base rates
  let weightedRate = 0;
  let totalWeight = 0;
  const sources = [];

  if (catPrice && catPrice.total >= 10) {
    const rate = catPrice.yesResolved / catPrice.total;
    weightedRate += rate * 3;
    totalWeight += 3;
    sources.push({ label: `${category} + ${pBucket}`, rate, n: catPrice.total, weight: 3 });
  }
  if (catOnly && catOnly.total >= 15) {
    const rate = catOnly.yesResolved / catOnly.total;
    weightedRate += rate * 2;
    totalWeight += 2;
    sources.push({ label: category, rate, n: catOnly.total, weight: 2 });
  }
  if (priceOnly && priceOnly.total >= 15) {
    const rate = priceOnly.yesResolved / priceOnly.total;
    weightedRate += rate * 2;
    totalWeight += 2;
    sources.push({ label: `Price ${pBucket}`, rate, n: priceOnly.total, weight: 2 });
  }
  if (durOnly && durOnly.total >= 10) {
    const rate = durOnly.yesResolved / durOnly.total;
    weightedRate += rate * 1;
    totalWeight += 1;
    sources.push({ label: `Duration ${durBucket}`, rate, n: durOnly.total, weight: 1 });
  }

  // Fallback to global
  if (totalWeight === 0) {
    const rate = global.yesResolved / global.total;
    weightedRate = rate;
    totalWeight = 1;
    sources.push({ label: 'Global', rate, n: global.total, weight: 1 });
  } else {
    weightedRate /= totalWeight;
  }

  const baseRate = weightedRate;
  const gap = yesPrice - baseRate; // positive = market prices YES higher than history
  const gapCents = gap * 100;
  const absGapCents = Math.abs(gapCents);

  // Confidence based on sample sizes
  const totalSamples = sources.reduce((s, src) => s + src.n, 0);
  let confidence;
  if (totalSamples >= 100 && sources.length >= 3) confidence = 'HIGH';
  else if (totalSamples >= 40) confidence = 'MEDIUM';
  else confidence = 'LOW';

  // Classify gap
  let gapType;
  if (absGapCents < 3) gapType = 'FAIR';
  else if (gap > 0) gapType = 'NARRATIVE_PREMIUM'; // market overpricing YES vs history
  else gapType = 'NARRATIVE_DISCOUNT'; // market underpricing YES vs history

  // Edge direction
  let suggestion = null;
  if (gapType === 'NARRATIVE_PREMIUM' && absGapCents > 5 && confidence !== 'LOW') {
    suggestion = 'BUY_NO'; // YES is overpriced
  } else if (gapType === 'NARRATIVE_DISCOUNT' && absGapCents > 5 && confidence !== 'LOW') {
    suggestion = 'BUY_YES'; // YES is underpriced
  }

  return {
    baseRate,
    marketPrice: yesPrice,
    gap,
    gapCents,
    absGapCents,
    gapType,
    confidence,
    suggestion,
    sources,
    totalSamples,
    priceBucket: pBucket,
    category,
  };
}

// ─── Multi-outcome event analysis ───
export function analyzeMultiOutcome(markets, baseRates) {
  if (!markets || markets.length < 2 || !baseRates) return null;

  const analyses = markets
    .map((m) => ({ market: m, br: analyzeBaseRate(m, baseRates) }))
    .filter((a) => a.br != null);

  if (analyses.length < 2) return null;

  const totalMarketProb = analyses.reduce((s, a) => s + a.br.marketPrice, 0);
  const totalBaseRate = analyses.reduce((s, a) => s + a.br.baseRate, 0);

  // In multi-outcome events, probabilities should sum close to 1
  const impliedOverround = totalMarketProb;
  const baseRateSum = totalBaseRate;

  // Find the biggest narrative premium within the group
  const sorted = [...analyses].sort((a, b) => b.br.absGapCents - a.br.absGapCents);
  const biggestGap = sorted[0];

  return {
    outcomeCount: analyses.length,
    impliedOverround,
    baseRateSum,
    overround: impliedOverround - 1,
    analyses: sorted,
    biggestGap,
  };
}

// ─── Edge confidence (cross-system) ───
export function getBaseRateEdgeConfidence(baseRateAnalysis, flbAnalysis) {
  if (!baseRateAnalysis) return 'UNKNOWN';

  // Both FLB and base rate agree on direction → higher confidence
  if (flbAnalysis && baseRateAnalysis.suggestion) {
    const flbSays = flbAnalysis.bestSide === 'YES' ? 'BUY_YES' : flbAnalysis.bestSide === 'NO' ? 'BUY_NO' : null;
    if (flbSays === baseRateAnalysis.suggestion) {
      return baseRateAnalysis.confidence === 'HIGH' ? 'VERY_HIGH' : 'HIGH';
    }
    // Disagreement
    if (flbSays && flbSays !== baseRateAnalysis.suggestion) {
      return 'CONFLICTED';
    }
  }

  return baseRateAnalysis.confidence;
}
