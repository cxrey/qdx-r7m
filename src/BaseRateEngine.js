// Base Rate Engine
// Fetches resolved Polymarket markets, computes empirical base rates by
// category / duration, and compares active market prices to historical
// base rates to detect "narrative premiums".
//
// NOTE: price buckets were deliberately removed. Resolved markets only expose
// their FINAL outcomePrices (~1.0 for YES, ~0.0 for NO), so bucketing by that
// price leaks the resolution into the "base rate" and manufactures fake
// BUY_YES/BUY_NO signals at price extremes. Only dimensions observable
// before resolution (category, total lifetime) are safe to condition on.

import { inferCategory } from './categoryPatterns';
import { withTimeout, TIMEOUT_GAMMA_PAGE } from './fetchUtils';
import { GAMMA_API } from './apiConfig';
import { MS_PER_DAY, CACHE_TTL_24H, BASE_RATE_MAX_RESOLVED, BASE_RATE_MAX_PAGES, BASE_RATE_MIN_DATA_POINTS } from './engineConfig';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Cache helpers ───
// Stores COMPUTED base rates (a few KB), not the raw resolved markets —
// 5,000 raw market objects routinely blew the localStorage quota, so the
// cache silently never persisted and every session refetched everything.
// v2 suffix: invalidates old caches that held raw markets / price buckets.
const CACHE_KEY = 'polymarket_base_rates_v2';
const LEGACY_CACHE_KEY = 'polymarket_base_rates';
const CACHE_TTL = CACHE_TTL_24H;

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
// Gamma's offset pagination rejects offset > 2000 with 422, which capped the
// sample at ~2,100 markets. /markets/keyset has no offset cap. As in
// fetchAllMarkets (api.js), the crawl is split into volume bands with one
// cursor chain each, to keep the parallelism of the old offset batches. Edges
// are rough rank quantiles of resolved markets by volume (Oct 2026: rank 2000 ≈
// $5.1M, 3000 ≈ $3.5M, 4000 ≈ $2.6M). The bounded bands are crawled to the end,
// and only the open-ended bottom band stops at MAX_RESOLVED. So once they are
// concatenated in descending order and truncated, the result is the top-N by
// volume, as with the old offset crawl.
const MAX_RESOLVED = BASE_RATE_MAX_RESOLVED;
const MAX_RESOLVED_PAGES = BASE_RATE_MAX_PAGES; // shared across all bands
const RESOLVED_PAGE_SIZE = 100;
const RESOLVED_VOLUME_BANDS = [
  [5_000_000, null],
  [3_500_000, 5_000_000],
  [2_500_000, 3_500_000],
  [null, 2_500_000],
];

async function fetchResolvedPage(url, signal, maxRetries = 3) {
  let lastWas429 = false;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (signal?.aborted) return null;
    try {
      const res = await fetch(url, { signal: withTimeout(signal, TIMEOUT_GAMMA_PAGE) });
      if (res.status === 429) {
        lastWas429 = true;
        const raw = parseInt(res.headers.get('Retry-After') || '3', 10) * 1000;
        const wait = Math.min(Math.max(raw || 3000, 1000), 30000);
        await delay(wait);
        continue;
      }
      lastWas429 = false;
      if (!res.ok) {
        // A 4xx (e.g. a 422 for a rejected cursor) won't change on retry
        if (res.status < 500) {
          console.warn(`[BaseRateEngine] Page failed: HTTP ${res.status}`);
          return null;
        }
        await delay(1000 * (attempt + 1));
        continue;
      }
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') return null;
      await delay(1000 * (attempt + 1));
    }
  }
  if (lastWas429) {
    const err = new Error('Rate limited');
    err.status = 429;
    throw err;
  }
  return null;
}

// Only keep markets that have a clear resolved outcome
function isResolved(m) {
  return Boolean(m.resolutionSource || m.resolvedBy || m.outcome != null || m.resolution != null);
}

/**
 * Follow one volume band's keyset cursor chain to the end (or, for the
 * open-ended bottom band, until the crawl has MAX_RESOLVED markets).
 * Pushes into `markets` so partial results survive a stop, and shares the page
 * budget / rate-limit flag / market count with the other bands via `crawl`.
 */
async function crawlResolvedBand([volumeMin, volumeMax], markets, crawl, signal) {
  const openEnded = volumeMin == null;
  let cursor = null;
  while (crawl.pages < MAX_RESOLVED_PAGES && !crawl.rateLimited) {
    if (signal?.aborted) return;
    if (openEnded && crawl.marketCount >= MAX_RESOLVED) return;
    crawl.pages++;

    let url = `${GAMMA_API}/markets/keyset?limit=${RESOLVED_PAGE_SIZE}&closed=true&order=volumeNum&ascending=false`;
    if (volumeMin != null) url += `&volume_num_min=${volumeMin}`;
    if (volumeMax != null) url += `&volume_num_max=${volumeMax}`;
    if (cursor) url += `&after_cursor=${encodeURIComponent(cursor)}`;

    let data;
    try {
      data = await fetchResolvedPage(url, signal);
    } catch (err) {
      if (err?.status !== 429) throw err;
      crawl.rateLimited = true;
      return;
    }
    // Abort, a 4xx, or retries exhausted — a cursor chain can't skip a page
    if (data == null) return;

    const page = Array.isArray(data.markets) ? data.markets : [];
    for (const m of page) {
      if (isResolved(m)) {
        markets.push(m);
        crawl.marketCount++;
      }
    }

    cursor = data.next_cursor;
    if (!cursor || page.length === 0) return; // End of band
  }
}

export async function fetchResolvedMarkets(signal) {
  const startTime = Date.now();
  const crawl = { pages: 0, marketCount: 0, rateLimited: false };
  const bandMarkets = RESOLVED_VOLUME_BANDS.map(() => []);

  // allSettled, not all: every band must have stopped before bandMarkets is read
  const outcomes = await Promise.allSettled(
    RESOLVED_VOLUME_BANDS.map((band, i) => crawlResolvedBand(band, bandMarkets[i], crawl, signal))
  );
  const failure = outcomes.find((o) => o.status === 'rejected' && o.reason?.name !== 'AbortError');
  if (failure) throw failure.reason;

  if (crawl.rateLimited) {
    console.warn('[BaseRateEngine] Rate limited — using', crawl.marketCount, 'resolved markets fetched so far');
  }

  // Band edges are inclusive, so a market on an edge can appear in two bands
  const seen = new Set();
  const markets = bandMarkets.flat().filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  }).slice(0, MAX_RESOLVED);

  console.log(`[BaseRateEngine] Fetched ${markets.length} resolved markets across ${crawl.pages} pages in ${Date.now() - startTime}ms.`);

  return { resolvedMarkets: markets, fetchedAt: Date.now() };
}

/**
 * Main entry point: return computed base rates, from cache when fresh.
 * Fetches resolved markets and computes rates on cache miss. Only caches
 * when the sample is large enough — a rate-limited partial fetch shouldn't
 * poison the cache for 24h.
 */
export async function getBaseRates(signal) {
  try { localStorage.removeItem(LEGACY_CACHE_KEY); } catch { /* ignore */ }
  const cached = loadCache();
  if (cached?.global) return cached;

  const { resolvedMarkets } = await fetchResolvedMarkets(signal);
  const rates = computeBaseRates(resolvedMarkets);
  if (rates.global.total >= BASE_RATE_MIN_DATA_POINTS) {
    saveCache(rates);
  }
  return rates;
}

// Category inference — uses shared patterns from categoryPatterns.js

// Duration bucket from days between created & closed
function durationBucket(days) {
  if (days == null || isNaN(days)) return 'unknown';
  if (days <= 7) return '<=7d';
  if (days <= 30) return '8-30d';
  if (days <= 90) return '31-90d';
  if (days <= 180) return '91-180d';
  return '>180d';
}

// ─── Compute base rates ───
// Conditions only on pre-resolution observables: category and total lifetime.
// (Final outcomePrices are settlement values — see leakage note at top.)
export function computeBaseRates(resolvedMarkets) {
  // Tracks: { total, yesResolved } for each key
  const buckets = {
    global: { total: 0, yesResolved: 0 },
    byCategory: {},
    byDuration: {},
    byCategoryAndDuration: {},
  };

  for (const m of resolvedMarkets) {
    const resolvedYes = determineResolution(m);
    if (resolvedYes == null) continue; // ambiguous resolution, skip

    const question = m.question || m.title || '';
    const category = inferCategory(question);

    // Duration: full market lifetime (created → end)
    let duration = null;
    if (m.createdAt && m.endDate) {
      const created = new Date(m.createdAt);
      const ended = new Date(m.endDate);
      duration = Math.max(0, Math.ceil((ended - created) / MS_PER_DAY));
    }

    const durBucket = durationBucket(duration);

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
    inc(buckets.byCategoryAndDuration, `${category}|${durBucket}`);
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
  if (!baseRates || !baseRates.global || baseRates.global.total < BASE_RATE_MIN_DATA_POINTS) {
    return null;
  }

  const yesPrice = market.yesPrice;
  if (yesPrice == null) return null;

  const category = market.category || 'Other';
  // Match on FULL lifetime (created → end), the same quantity the resolved-
  // market buckets were built from — not daysLeft (time remaining).
  const durBucket = durationBucket(market.durationDays);

  // Find best matching bucket (most specific → least specific)
  const catDurKey = `${category}|${durBucket}`;
  const catDur = baseRates.byCategoryAndDuration?.[catDurKey];
  const catOnly = baseRates.byCategory?.[category];
  const durOnly = baseRates.byDuration?.[durBucket];
  const global = baseRates.global;

  // Weighted average of available base rates
  let weightedRate = 0;
  let totalWeight = 0;
  const sources = [];

  if (catDur && catDur.total >= 10) {
    const rate = catDur.yesResolved / catDur.total;
    weightedRate += rate * 3;
    totalWeight += 3;
    sources.push({ label: `${category} + ${durBucket}`, rate, n: catDur.total, weight: 3 });
  }
  if (catOnly && catOnly.total >= 15) {
    const rate = catOnly.yesResolved / catOnly.total;
    weightedRate += rate * 2;
    totalWeight += 2;
    sources.push({ label: category, rate, n: catOnly.total, weight: 2 });
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
    durationBucket: durBucket,
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
