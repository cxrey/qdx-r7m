/**
 * PortfolioEngine.js — Pure JS utility for portfolio analysis.
 * Position fetching, correlation analysis, clustering, concentration metrics, alerts, and trade screening.
 */

import { dataApiGet, toV1Row } from './dataApi';

// ── localStorage keys (grouped at top for visibility) ──
const MANUAL_KEY = 'polymarket-portfolio-manual';
const WALLET_KEY = 'polymarket-portfolio-wallet';
const PORTFOLIO_CACHE_KEY = 'polymarket-portfolio-cache';
const DISMISSED_KEY = 'polymarket-portfolio-dismissed-alerts';

// ── Entity dictionaries for correlation detection ──

const COUNTRIES = [
  'iran', 'israel', 'russia', 'ukraine', 'china', 'taiwan', 'india', 'pakistan',
  'north korea', 'south korea', 'japan', 'germany', 'france', 'uk', 'united kingdom',
  'united states', 'us', 'usa', 'canada', 'mexico', 'brazil', 'turkey', 'syria',
  'iraq', 'afghanistan', 'saudi arabia', 'egypt', 'australia', 'poland',
];

const PEOPLE = [
  'trump', 'biden', 'harris', 'desantis', 'musk', 'putin', 'zelensky', 'xi jinping',
  'modi', 'macron', 'netanyahu', 'erdogan', 'bolsonaro', 'lula', 'trudeau',
  'bernie', 'sanders', 'pelosi', 'mcconnell', 'pence', 'obama', 'ramaswamy',
  'rfk', 'kennedy', 'newsom', 'haley', 'vivek', 'vance',
];

const ORGS = [
  'fed', 'federal reserve', 'openai', 'google', 'apple', 'microsoft', 'meta',
  'spacex', 'tesla', 'amazon', 'nvidia', 'nato', 'un', 'united nations',
  'who', 'sec', 'fbi', 'cia', 'epa', 'ftc', 'supreme court', 'congress',
  'senate', 'opec', 'ecb', 'imf', 'world bank', 'anthropic',
];

// ── Position Fetching ──

// v2 returns 100 positions per page; follow the cursor so large portfolios
// aren't truncated (20 pages = 2,000 positions, a safety cap).
const MAX_POSITION_PAGES = 20;

export async function fetchPositions(walletAddress) {
  let positions = null;

  // Data API v2: the default status filter is OPEN. Won-but-unredeemed rows
  // are a separate status (REDEEMABLE); their markets have resolved, so they
  // couldn't be matched to the scanner's open markets anyway.
  // Entry price comes from each position's avgPrice, so no trade history fetch.
  try {
    const res = await dataApiGet('/v2/positions', { user: walletAddress }, { maxPages: MAX_POSITION_PAGES });
    if (res.ok && res.rows.length > 0) positions = res.rows.map((r) => toV1Row(r, 'position'));
    if (!res.ok) console.warn(`[PortfolioEngine] /v2/positions ${res.status}${res.error ? `: ${res.error}` : ''}`);
    else if (res.incomplete) console.warn(`[PortfolioEngine] positions incomplete — a later page failed (${res.incomplete.status ?? 'network'}${res.incomplete.error ? `: ${res.incomplete.error}` : ''})`);
    else if (res.hasMore) console.warn(`[PortfolioEngine] positions truncated at ${MAX_POSITION_PAGES} pages`);
    console.debug('[PortfolioEngine] /v2/positions returned', positions?.length ?? 0, 'positions');
  } catch (e) {
    console.warn('[PortfolioEngine] /v2/positions failed:', e.message);
  }

  if (!positions) return { positions: [], error: 'Could not fetch positions from Polymarket.' };

  return { positions, error: null };
}

/**
 * Normalize raw position data into our standard format.
 * Handles various field name conventions from the API.
 */
export function normalizePosition(raw) {
  return {
    marketId: raw.market_id || raw.marketId || raw.condition_id || raw.conditionId || null,
    conditionId: raw.condition_id || raw.conditionId || null,
    tokenId: raw.token_id || raw.tokenId || raw.asset || null,
    size: parseFloat(raw.size || raw.shares || raw.amount || raw.balance || 0),
    entryPrice: raw.avg_price != null ? parseFloat(raw.avg_price) :
      raw.avgPrice != null ? parseFloat(raw.avgPrice) :
      raw.entry_price != null ? parseFloat(raw.entry_price) : null,
    side: null, // determined after matching
    currentPrice: null,
    currentValue: 0,
    unrealizedPnl: 0,
    market: null, // attached after matching
    source: 'wallet', // 'wallet' or 'manual'
  };
}

/**
 * Match positions to already-loaded scanner markets.
 */
export function matchPositionsToMarkets(positions, loadedMarkets) {
  const byCondition = new Map();
  const byId = new Map();
  const byToken = new Map();

  for (const m of loadedMarkets) {
    if (m.conditionId) byCondition.set(m.conditionId, m);
    byId.set(String(m.id), m);
    if (m.clobTokenIds) {
      for (const tid of m.clobTokenIds) {
        byToken.set(String(tid), m);
      }
    }
  }

  return positions.map((pos) => {
    let market = null;

    // Match by conditionId
    if (pos.conditionId && byCondition.has(pos.conditionId)) {
      market = byCondition.get(pos.conditionId);
    }
    // Match by market ID
    if (!market && pos.marketId && byId.has(String(pos.marketId))) {
      market = byId.get(String(pos.marketId));
    }
    // Match by token ID
    if (!market && pos.tokenId && byToken.has(String(pos.tokenId))) {
      market = byToken.get(String(pos.tokenId));
    }

    if (market) {
      // Determine side from token
      const isYes = market.clobTokenIds?.[0] && String(market.clobTokenIds[0]) === String(pos.tokenId);
      const isNo = market.clobTokenIds?.[1] && String(market.clobTokenIds[1]) === String(pos.tokenId);
      pos.side = isYes ? 'YES' : isNo ? 'NO' : (pos.side || 'YES');
      pos.currentPrice = pos.side === 'YES' ? market.yesPrice : market.noPrice;
      pos.currentValue = pos.size * (pos.currentPrice || 0);
      if (pos.entryPrice != null && pos.currentPrice != null) {
        pos.unrealizedPnl = (pos.currentPrice - pos.entryPrice) * pos.size;
      }
      pos.market = market;
    }

    return pos;
  });
}

// ── Manual positions in markets the catalog doesn't hold ──
// A manual position saves a copy of its market when added. If that market
// later leaves the loaded catalog (it resolved, or its event is under the
// volume floor), the copy's price is frozen at the day it was added. These
// helpers let the portfolio look such markets up directly and price from that.

/**
 * Prices from a raw Gamma market (as /markets/{id} returns it — closed
 * markets included, with their settled 0/1 prices).
 * @returns {{ yesPrice: number, noPrice: number, closed: boolean } | null}
 */
export function pricesFromGammaMarket(raw) {
  if (!raw) return null;
  let prices = raw.outcomePrices;
  if (typeof prices === 'string') {
    try { prices = JSON.parse(prices); } catch { return null; }
  }
  if (!Array.isArray(prices) || prices.length < 2) return null;
  const yesPrice = parseFloat(prices[0]);
  const noPrice = parseFloat(prices[1]);
  if (!Number.isFinite(yesPrice) || !Number.isFinite(noPrice)) return null;
  return { yesPrice, noPrice, closed: raw.closed === true };
}

function findLoadedMarket(mp, marketLookup) {
  return marketLookup.byId.get(String(mp.marketId))
    || (mp.conditionId && marketLookup.byCondition.get(mp.conditionId))
    || null;
}

// ── Live prices ──
// Price ticks replace a changed market's object (Immer) and leave the rest
// as-is. Positions must price from the CURRENT object, and the portfolio
// should only recompute when a market someone holds actually changed.

const EMPTY_LOOKUP = Object.freeze({ byId: new Map(), byCondition: new Map() });

/**
 * Lookup ({ byId, byCondition }) of just the markets positions are in, found
 * in one pass over the loaded markets — no full-catalog maps. With no
 * positions it does no work at all (the hook runs for every user).
 */
export function findHeldMarkets(walletPositions, manualPositions, loadedMarkets) {
  if (walletPositions.length === 0 && manualPositions.length === 0) return EMPTY_LOOKUP;
  const wantedIds = new Set();
  const wantedConditions = new Set();
  for (const p of walletPositions) if (p.market) wantedIds.add(String(p.market.id));
  for (const mp of manualPositions) {
    if (mp.marketId != null) wantedIds.add(String(mp.marketId));
    if (mp.conditionId) wantedConditions.add(mp.conditionId);
  }
  const byId = new Map();
  const byCondition = new Map();
  for (const m of loadedMarkets) {
    const id = String(m.id);
    if (!wantedIds.has(id) && !(m.conditionId && wantedConditions.has(m.conditionId))) continue;
    byId.set(id, m);
    if (m.conditionId) byCondition.set(m.conditionId, m);
  }
  return { byId, byCondition };
}

/**
 * True when both lookups hold the same market objects. Price ticks replace
 * only the markets that changed, so an unchanged held set means no held
 * price moved and the portfolio can keep its previous lookup.
 */
export function sameHeldMarkets(a, b) {
  if (a === b) return true;
  if (a.byId.size !== b.byId.size) return false;
  for (const [id, m] of b.byId) if (a.byId.get(id) !== m) return false;
  return true;
}

/**
 * What table rows need to know about holdings: market, side and size — none
 * of which change with price, so row-facing callbacks built from this stay
 * stable across price ticks.
 */
export function holdingsKey(positions) {
  return JSON.stringify(positions.map((p) => [String(p.market?.id ?? p.marketId), p.side ?? null, p.size ?? null, p.source ?? null]));
}

/**
 * What the correlation structure depends on: which markets, on which side,
 * in which order. Not size — an actively trading wallet changes sizes
 * between refreshes, and that shouldn't force the O(n²) rebuild.
 */
export function structureKey(positions) {
  return JSON.stringify(positions.map((p) => [String(p.market?.id ?? p.marketId), p.side ?? null]));
}

/**
 * Re-price a wallet position from the current object of its market. Wallet
 * positions are matched to markets once per wallet refresh (5 min); this
 * keeps them on live prices in between, without a request.
 */
export function repriceWalletPosition(pos, heldLookup) {
  const market = pos.market && heldLookup.byId.get(String(pos.market.id));
  if (!market || market === pos.market) return pos;
  const currentPrice = pos.side === 'YES' ? market.yesPrice : market.noPrice;
  return {
    ...pos,
    market,
    currentPrice,
    currentValue: pos.size * (currentPrice || 0),
    unrealizedPnl: pos.entryPrice != null && currentPrice != null
      ? (currentPrice - pos.entryPrice) * pos.size
      : 0,
  };
}

/** Market IDs of manual positions whose market isn't in the loaded catalog. */
export function unloadedManualMarketIds(manualPositions, marketLookup) {
  const ids = new Set();
  for (const mp of manualPositions) {
    if (mp.marketId != null && !findLoadedMarket(mp, marketLookup)) ids.add(String(mp.marketId));
  }
  return [...ids];
}

/**
 * Attach current prices to a manual position. Price source, in order: the
 * loaded market, then prices looked up for a market the catalog doesn't hold
 * (`lookedUp`: marketId → pricesFromGammaMarket result), then the saved copy.
 */
export function priceManualPosition(mp, marketLookup, lookedUp) {
  const loaded = findLoadedMarket(mp, marketLookup);
  const fetched = !loaded ? lookedUp?.get(String(mp.marketId)) : null;
  const market = loaded
    || (fetched && mp.market ? { ...mp.market, ...fetched } : mp.market);

  const currentPrice = mp.side === 'YES'
    ? (market?.yesPrice ?? mp.currentPrice)
    : (market?.noPrice ?? mp.currentPrice);

  return {
    ...mp,
    market,
    currentPrice,
    currentValue: (mp.size || 0) * (currentPrice || 0),
    unrealizedPnl: mp.entryPrice != null && currentPrice != null
      ? (currentPrice - mp.entryPrice) * (mp.size || 0)
      : 0,
    source: 'manual',
  };
}

// ── Entity Extraction ──

export function extractEntities(text) {
  const lower = text.toLowerCase();
  const found = { countries: new Set(), people: new Set(), orgs: new Set() };

  for (const c of COUNTRIES) {
    if (lower.includes(c)) found.countries.add(c);
  }
  for (const p of PEOPLE) {
    if (lower.includes(p)) found.people.add(p);
  }
  for (const o of ORGS) {
    if (lower.includes(o)) found.orgs.add(o);
  }
  return found;
}

// Module-level cache of each market's text features for correlation:
// entities, significant title words, lowercased description. Keyed on market
// ID — market text is immutable within a session, and price ticks replace
// market objects but keep their ID — so every pair comparison reuses them
// instead of re-extracting and re-splitting per PAIR (O(n²) string work).
// LRU-capped above the 2,000-position wallet fetch cap: at the old cap of
// 500 a large wallet evicted entries mid-pass and re-extracted every pair.
const featureCache = new Map();
const MAX_FEATURE_CACHE = 5_000;

function getMarketFeatures(market) {
  const id = market.id;
  const cached = featureCache.get(id);
  if (cached) {
    // Promote to end (true LRU)
    featureCache.delete(id);
    featureCache.set(id, cached);
    return cached;
  }
  const description = (market.description || '').toLowerCase();
  const features = {
    entities: extractEntities(market.question + ' ' + (market.description || '')),
    titleWords: (market.question || '').toLowerCase().split(/\s+/).filter((w) => w.length > 4),
    description,
  };
  featureCache.set(id, features);
  if (featureCache.size > MAX_FEATURE_CACHE) {
    featureCache.delete(featureCache.keys().next().value);
  }
  return features;
}

// ── Correlation Analysis ──

/** At least 3 of `titleWords` (duplicates count) occur in `description`. */
function mentionsKeyTerms(titleWords, description) {
  if (titleWords.length < 3 || !description) return false;
  let count = 0;
  for (const w of titleWords) {
    if (description.includes(w) && ++count >= 3) return true;
  }
  return false;
}

/**
 * Aho–Corasick matcher: finds every one of `words` occurring anywhere in a
 * text (as a substring, like String#includes) in a single pass over it.
 * Returns scan(text, onMatch(wordIndex)).
 */
function buildSubstringMatcher(words) {
  const next = [new Map()]; // state → (char code → state)
  const fail = [0];
  const out = [[]]; // state → word indices ending here (incl. via fail links)
  words.forEach((w, id) => {
    let s = 0;
    for (let k = 0; k < w.length; k++) {
      const ch = w.charCodeAt(k);
      let t = next[s].get(ch);
      if (t === undefined) {
        t = next.length;
        next.push(new Map());
        fail.push(0);
        out.push([]);
        next[s].set(ch, t);
      }
      s = t;
    }
    out[s].push(id);
  });
  const queue = [...next[0].values()];
  for (let q = 0; q < queue.length; q++) {
    const r = queue[q];
    for (const [ch, s] of next[r]) {
      queue.push(s);
      let f = fail[r];
      while (f !== 0 && !next[f].has(ch)) f = fail[f];
      fail[s] = next[f].get(ch) ?? 0;
      if (out[fail[s]].length) out[s] = out[s].concat(out[fail[s]]);
    }
  }
  return (text, onMatch) => {
    let s = 0;
    for (let k = 0; k < text.length; k++) {
      const ch = text.charCodeAt(k);
      while (s !== 0 && !next[s].has(ch)) s = fail[s];
      s = next[s].get(ch) ?? 0;
      for (const id of out[s]) onMatch(id);
    }
  };
}

/**
 * mentionsKeyTerms for every ordered pair at once: rows[a][b] = 1 when at
 * least 3 of position a's title words (duplicates count) occur in b's
 * description. Same answers as calling mentionsKeyTerms n² times, but each
 * description is scanned once (for all title words) instead of once per
 * pair — that substring work was ~70% of building the structure.
 */
function keyTermMentionRows(feats) {
  const n = feats.length;
  const wordId = new Map();
  const titleIds = feats.map((f) => (f ? f.titleWords.map((w) => {
    if (!wordId.has(w)) wordId.set(w, wordId.size);
    return wordId.get(w);
  }) : []));
  const rows = Array.from({ length: n }, () => new Uint8Array(n));
  if (wordId.size === 0) return rows;

  // postings[word] = positions whose description contains it
  const scan = buildSubstringMatcher([...wordId.keys()]);
  const postings = Array.from({ length: wordId.size }, () => []);
  const seenIn = new Int32Array(wordId.size).fill(-1);
  feats.forEach((f, b) => {
    if (!f || !f.description) return;
    scan(f.description, (id) => {
      if (seenIn[id] !== b) { seenIn[id] = b; postings[id].push(b); }
    });
  });

  const count = new Uint8Array(n);
  const touched = [];
  for (let a = 0; a < n; a++) {
    if (titleIds[a].length < 3) continue;
    for (const id of titleIds[a]) {
      for (const b of postings[id]) {
        if (count[b] === 0) touched.push(b);
        if (count[b] < 3 && ++count[b] === 3) rows[a][b] = 1;
      }
    }
    for (const b of touched) count[b] = 0;
    touched.length = 0;
  }
  return rows;
}

function entitiesOverlap(e1, e2) {
  for (const c of e1.countries) if (e2.countries.has(c)) return true;
  for (const p of e1.people) if (e2.people.has(p)) return true;
  for (const o of e1.orgs) if (e2.orgs.has(o)) return true;
  return false;
}

/**
 * calculatePairCorrelation's number, without its types/labels arrays, from
 * precomputed features — the n² hot loop of buildCorrelationStructure.
 * `mentions`: whether either market's title terms appear in the other's
 * description (from keyTermMentionRows). Must stay in step with
 * calculatePairCorrelation (a test checks they agree).
 */
function pairCorrelationValue(mA, fA, mB, fB, mentions) {
  let max = 0;
  let types = 0;
  if (mA.category && mB.category && mA.category === mB.category) { types++; max = 0.2; }
  if (entitiesOverlap(fA.entities, fB.entities)) { types++; if (max < 0.5) max = 0.5; }
  if (mA.slug && mB.slug && mA.slug === mB.slug) { types++; if (max < 0.8) max = 0.8; }
  if (mA.daysLeft != null && mB.daysLeft != null && Math.abs(mA.daysLeft - mB.daysLeft) <= 14) {
    types++; if (max < 0.1) max = 0.1;
  }
  if (mentions) { types++; if (max < 0.7) max = 0.7; }
  if (types === 0) return 0;
  if (types === 2) max += 0.1;
  else if (types >= 3) max += 0.15;
  return Math.min(0.95, max);
}

function sharedEntities(e1, e2) {
  const shared = [];
  for (const c of e1.countries) { if (e2.countries.has(c)) shared.push(c); }
  for (const p of e1.people) { if (e2.people.has(p)) shared.push(p); }
  for (const o of e1.orgs) { if (e2.orgs.has(o)) shared.push(o); }
  return shared;
}

export function calculatePairCorrelation(posA, posB) {
  const mA = posA.market;
  const mB = posB.market;
  if (!mA || !mB) return { correlation: 0, types: [], sharedLabels: [] };

  const types = [];
  const correlations = [];
  const labels = [];

  // CATEGORY_OVERLAP
  if (mA.category && mB.category && mA.category === mB.category) {
    types.push('CATEGORY');
    correlations.push(0.2);
    labels.push(mA.category);
  }

  // ENTITY_OVERLAP — cached per market to avoid O(n²) re-extraction
  const fA = getMarketFeatures(mA);
  const fB = getMarketFeatures(mB);
  const shared = sharedEntities(fA.entities, fB.entities);
  if (shared.length > 0) {
    types.push('ENTITY');
    correlations.push(0.5);
    labels.push(...shared);
  }

  // EVENT_OVERLAP (same slug = same event)
  if (mA.slug && mB.slug && mA.slug === mB.slug) {
    types.push('EVENT');
    correlations.push(0.8);
    labels.push(mA.slug);
  }

  // TEMPORAL_OVERLAP (resolution dates within 14 days)
  if (mA.daysLeft != null && mB.daysLeft != null) {
    if (Math.abs(mA.daysLeft - mB.daysLeft) <= 14) {
      types.push('TEMPORAL');
      correlations.push(0.1);
    }
  }

  // RESOLUTION_DEPENDENCY (one market mentions the other's key terms):
  // significant words from A's title in B's description, or vice versa
  if (mentionsKeyTerms(fA.titleWords, fB.description) || mentionsKeyTerms(fB.titleWords, fA.description)) {
    types.push('RESOLUTION_DEPENDENCY');
    correlations.push(0.7);
  }

  if (correlations.length === 0) return { correlation: 0, types: [], sharedLabels: [] };

  let pairCorrelation = Math.max(...correlations);
  if (types.length === 2) pairCorrelation += 0.1;
  else if (types.length >= 3) pairCorrelation += 0.15;
  pairCorrelation = Math.min(0.95, pairCorrelation);

  return { correlation: pairCorrelation, types, sharedLabels: [...new Set(labels)] };
}

// ── Clustering ──

// Clustering is split in two because only part of it depends on price:
// - buildCorrelationStructure: the correlation matrix and cluster membership,
//   names, average correlation and dominant side. Depends on market text,
//   category, event, dates and position sides — not prices. O(n²); compute
//   it when holdings change.
// - priceClusters: values, portfolio weights and risk. O(n); cheap enough to
//   redo on every price tick.

const CLUSTER_THRESHOLD = 0.4;

// Label sources, as bits. A pair of members shares label L when both have L
// from the same source: both in category L, both with entity L of the same
// type, or both in event (slug) L — exactly calculatePairCorrelation's
// sharedLabels.
const SRC_CATEGORY = 1;
const SRC_COUNTRY = 2;
const SRC_PERSON = 4;
const SRC_ORG = 8;
const SRC_SLUG = 16;

/**
 * For each label, the number of member pairs in the cluster that share it —
 * the counts the cluster name is picked from. Replaces summing per-pair
 * label lists over all k² member pairs (which needed n² stored pair objects):
 * members are bucketed by which sources give them the label, and pairs are
 * counted per bucket pair.
 *
 * Keys are inserted in the order the old pairwise loop first met each label
 * (first pair in join order; within a pair category, then the lower-indexed
 * position's entities in their order, then slug), so ties in the name pick
 * break the same way.
 */
function clusterLabelCounts(indices, positions, feats) {
  // label → { members: [[joinOrder, sourceBits], …], entityRank: Map(joinOrder → rank) }
  const byLabel = new Map();
  const note = (label, ord, bit, entityRank) => {
    let e = byLabel.get(label);
    if (!e) byLabel.set(label, (e = { bits: new Map(), entityRank: new Map() }));
    e.bits.set(ord, (e.bits.get(ord) || 0) | bit);
    if (entityRank != null && !e.entityRank.has(ord)) e.entityRank.set(ord, entityRank);
  };
  indices.forEach((pi, ord) => {
    const m = positions[pi].market;
    const f = feats[pi];
    if (!m || !f) return; // a pair with a missing market shares no labels
    if (m.category) note(m.category, ord, SRC_CATEGORY);
    let rank = 0;
    for (const c of f.entities.countries) note(c, ord, SRC_COUNTRY, rank++);
    for (const p of f.entities.people) note(p, ord, SRC_PERSON, rank++);
    for (const o of f.entities.orgs) note(o, ord, SRC_ORG, rank++);
    if (m.slug) note(m.slug, ord, SRC_SLUG);
  });

  const found = []; // [label, count, firstA, firstB, rankInPair]
  for (const [label, { bits, entityRank }] of byLabel) {
    const list = [...bits]; // ascending join order
    // Count sharing pairs from per-bitmask bucket sizes
    const sizes = new Map();
    for (const [, mask] of list) sizes.set(mask, (sizes.get(mask) || 0) + 1);
    let count = 0;
    const masks = [...sizes.keys()];
    for (let x = 0; x < masks.length; x++) {
      const cx = sizes.get(masks[x]);
      count += (cx * (cx - 1)) / 2; // same mask (non-zero) always shares
      for (let y = x + 1; y < masks.length; y++) {
        if (masks[x] & masks[y]) count += cx * sizes.get(masks[y]);
      }
    }
    if (count === 0) continue;

    // First sharing pair in join order: scan from the end, tracking the
    // nearest later member per source bit
    const nextWithBit = new Map();
    let firstA = -1;
    let firstB = -1;
    let firstMask = 0;
    for (let k = list.length - 1; k >= 0; k--) {
      const [ord, mask] = list[k];
      let b = -1;
      let shared = 0;
      for (let bit = 1; bit <= SRC_SLUG; bit <<= 1) {
        if (!(mask & bit) || !nextWithBit.has(bit)) continue;
        const cand = nextWithBit.get(bit);
        if (b === -1 || cand.ord < b) { b = cand.ord; shared = mask & cand.mask; } else if (cand.ord === b) shared |= mask & cand.mask;
      }
      if (b !== -1) { firstA = ord; firstB = b; firstMask = shared; }
      for (let bit = 1; bit <= SRC_SLUG; bit <<= 1) if (mask & bit) nextWithBit.set(bit, { ord, mask });
    }
    // Position within that pair's label list: category first, then entities
    // in the lower-indexed position's order, then slug
    const lower = indices[firstA] < indices[firstB] ? firstA : firstB;
    const rankInPair = firstMask & SRC_CATEGORY ? -1
      : firstMask & (SRC_COUNTRY | SRC_PERSON | SRC_ORG) ? entityRank.get(lower)
      : Number.MAX_SAFE_INTEGER;
    found.push([label, count, firstA, firstB, rankInPair]);
  }

  found.sort((p, q) => p[2] - q[2] || p[3] - q[3] || p[4] - q[4]);
  const labelCounts = {};
  for (const [label, count] of found) labelCounts[label] = count;
  return labelCounts;
}

/** Price-independent part of clustering (see above). */
export function buildCorrelationStructure(positions) {
  const n = positions.length;
  if (n === 0) return { matrix: [], groups: [] };

  // Features once per position (not twice per pair — at n=2,000 that was 4M
  // cache lookups with LRU promotion, a third of the build time)
  const feats = positions.map((p) => (p.market ? getMarketFeatures(p.market) : null));
  const mentionRows = keyTermMentionRows(feats);

  // Build full correlation matrix. Typed rows: n² plain numbers in nested
  // arrays (and, before, n² pair objects kept only for naming) were mostly
  // garbage-collector work.
  const matrix = Array.from({ length: n }, () => new Float64Array(n));
  // Pairs at or above the threshold, bucketed by correlation. Pair values
  // come from a handful of fixed weights, so the buckets visited in
  // descending order give the same order as a stable sort of all pairs
  // (ties stay in i,j order) without building ~n²/2 pair objects.
  const buckets = new Map(); // correlation → [i * n + j, …] in i,j order
  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1;
    const mA = positions[i].market;
    for (let j = i + 1; j < n; j++) {
      const mB = positions[j].market;
      const corr = mA && mB
        ? pairCorrelationValue(mA, feats[i], mB, feats[j], mentionRows[i][j] === 1 || mentionRows[j][i] === 1)
        : 0;
      matrix[i][j] = corr;
      matrix[j][i] = corr;
      if (corr >= CLUSTER_THRESHOLD) {
        let bucket = buckets.get(corr);
        if (!bucket) buckets.set(corr, (bucket = []));
        bucket.push(i * n + j);
      }
    }
  }

  // Greedy clustering: start with most correlated pair, expand
  const clusterOf = new Array(n).fill(-1); // position index → cluster index
  const members = []; // cluster index → position indices, in join order

  for (const corr of [...buckets.keys()].sort((a, b) => b - a)) for (const key of buckets.get(corr)) {
    const i = Math.floor(key / n);
    const j = key - i * n;
    // Both already assigned (same cluster or not) — skip
    if (clusterOf[i] !== -1 && clusterOf[j] !== -1) continue;

    // Join the assigned one's cluster, or start a new cluster
    let c = clusterOf[i] !== -1 ? clusterOf[i] : clusterOf[j];
    if (c === -1) {
      c = members.length;
      members.push([]);
    }
    for (const idx of [i, j]) {
      if (clusterOf[idx] === -1) {
        clusterOf[idx] = c;
        members[c].push(idx);
      }
    }
  }

  // Add unclustered positions as single-position clusters
  for (let i = 0; i < n; i++) {
    if (clusterOf[i] === -1) {
      clusterOf[i] = members.length;
      members.push([i]);
    }
  }

  const groups = members.map((indices, idx) => {
    const posArr = indices.map((i) => positions[i]);

    // Average intra-cluster correlation
    let sumCorr = 0;
    let countPairs = 0;
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        sumCorr += matrix[indices[a]][indices[b]];
        countPairs++;
      }
    }
    const averageCorrelation = countPairs > 0 ? sumCorr / countPairs : 0;

    // Auto-generate name from shared entities/categories
    const labelCounts = clusterLabelCounts(indices, positions, feats);
    const cats = [...new Set(posArr.map((p) => p.market?.category).filter(Boolean))];
    const topLabels = Object.entries(labelCounts).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([l]) => l);
    const name = topLabels.length > 0
      ? topLabels.map((l) => l.charAt(0).toUpperCase() + l.slice(1)).join('/') + (cats.length === 1 ? ` (${cats[0]})` : '')
      : cats.length > 0 ? cats.join('/') + ' Cluster'
      : `Cluster ${idx + 1}`;

    // Dominant side
    const yesSide = posArr.filter((p) => p.side === 'YES').length;
    const noSide = posArr.filter((p) => p.side === 'NO').length;
    const dominantSide = yesSide > noSide ? 'YES' : noSide > yesSide ? 'NO' : 'MIXED';

    return { indices, name, averageCorrelation, dominantSide };
  });

  return { matrix, groups };
}

/**
 * Price-dependent part of clustering: attach current positions, values,
 * weights and risk to a structure from buildCorrelationStructure. `positions`
 * must be the same holdings, in the same order, the structure was built from
 * (their prices may differ).
 */
export function priceClusters(positions, structure) {
  const totalValue = positions.reduce((s, p) => s + (p.currentValue || 0), 0);
  return structure.groups.map((g, idx) => {
    const posArr = g.indices.map((i) => positions[i]);
    const clusterValue = posArr.reduce((s, p) => s + (p.currentValue || 0), 0);
    const effectivePositionCount = posArr.length * (1 - g.averageCorrelation);
    const portfolioWeight = totalValue > 0 ? clusterValue / totalValue : 0;
    let risk = 'LOW';
    if (portfolioWeight > 0.4 || effectivePositionCount < 2) risk = 'HIGH';
    else if (portfolioWeight > 0.2) risk = 'MEDIUM';

    return {
      id: idx,
      name: g.name,
      positions: posArr,
      totalValue: clusterValue,
      portfolioWeight,
      averageCorrelation: g.averageCorrelation,
      effectivePositionCount: Math.max(1, effectivePositionCount),
      dominantSide: g.dominantSide,
      risk,
    };
  });
}

export function buildCorrelationClusters(positions) {
  const structure = buildCorrelationStructure(positions);
  return { clusters: priceClusters(positions, structure), correlationMatrix: structure.matrix };
}

// ── Concentration Metrics ──

export function calculateConcentration(positions, clusters) {
  const totalValue = positions.reduce((s, p) => s + (p.currentValue || 0), 0);
  if (totalValue === 0 || positions.length === 0) {
    return {
      hhi: 0, effectiveBets: 0, largestClusterWeight: 0, largestClusterName: '',
      yesExposure: 0, noExposure: 0, sideImbalance: 0,
      diversificationScore: 0, diversificationLabel: 'No Positions',
    };
  }

  // HHI
  const hhi = clusters.reduce((s, c) => s + c.portfolioWeight ** 2, 0);

  // Effective bets
  const effectiveBets = clusters.reduce((s, c) => s + c.effectivePositionCount, 0);

  // Largest cluster
  const largest = clusters.reduce((best, c) => c.portfolioWeight > best.portfolioWeight ? c : best, clusters[0]);

  // Side imbalance
  const yesExposure = positions.filter((p) => p.side === 'YES').reduce((s, p) => s + (p.currentValue || 0), 0);
  const noExposure = positions.filter((p) => p.side === 'NO').reduce((s, p) => s + (p.currentValue || 0), 0);
  const sideImbalance = (yesExposure + noExposure) > 0
    ? Math.abs(yesExposure - noExposure) / (yesExposure + noExposure) : 0;

  // Diversification score (0-100)
  let score = 100;
  // Penalize high HHI
  if (hhi > 0.5) score -= 40;
  else if (hhi > 0.25) score -= 25;
  else if (hhi > 0.15) score -= 10;

  // Penalize few effective bets
  if (effectiveBets < 2) score -= 30;
  else if (effectiveBets < 4) score -= 15;
  else if (effectiveBets < 6) score -= 5;

  // Penalize side imbalance
  if (sideImbalance > 0.8) score -= 20;
  else if (sideImbalance > 0.6) score -= 10;
  else if (sideImbalance > 0.4) score -= 5;

  score = Math.max(0, Math.min(100, score));

  let diversificationLabel = 'Well Diversified';
  if (score < 30) diversificationLabel = 'Highly Concentrated';
  else if (score < 50) diversificationLabel = 'Concentrated';
  else if (score < 80) diversificationLabel = 'Moderate Concentration';

  return {
    hhi,
    effectiveBets,
    largestClusterWeight: largest?.portfolioWeight ?? 0,
    largestClusterName: largest?.name ?? '',
    yesExposure,
    noExposure,
    sideImbalance,
    diversificationScore: Math.round(score),
    diversificationLabel,
  };
}

// ── Trade Screening ──

/**
 * Whether two markets are different outcomes of one mutually exclusive event:
 * Polymarket "negRisk" events (e.g. "Who will win the election?"), where
 * exactly one market resolves YES. Correlations are otherwise unsigned; this
 * is the one relationship whose DIRECTION is known: YES on one outcome and
 * YES on another move against each other (both can't win), so the same side
 * on two outcomes partly hedges, and opposite sides concentrate.
 * (processMarket's `slug` is the event's slug.)
 */
export function mutuallyExclusive(mA, mB) {
  return Boolean(mA && mB && mA.negRisk === true && mB.negRisk === true
    && mA.slug && mA.slug === mB.slug && String(mA.id) !== String(mB.id));
}

/**
 * Payoff correlation between two outcomes of one mutually exclusive event,
 * from their YES prices (standing in for probabilities). For exclusive
 * binary outcomes Cov(A, B) = −pA·pB, so
 *   corr(YES_A, YES_B) = −√(pA·pB / ((1−pA)(1−pB))).
 * NO = 1 − YES flips the sign, so the same side on both shares that value and
 * opposite sides get its negation. Strongly negative only when the two
 * outcomes cover most of the probability (a two-way race: −1); for two
 * longshots it's near 0, since a third outcome usually wins. Clamped to
 * [−1, 1] (listed prices can sum past 1); 0 when either is settled (0 or 1:
 * no variance left).
 */
export function exclusiveOutcomeCorrelation(pA, pB, sameSide) {
  if (!(pA > 0 && pA < 1 && pB > 0 && pB < 1)) return 0;
  const yesYes = Math.max(-1, -Math.sqrt((pA * pB) / ((1 - pA) * (1 - pB))));
  return sameSide ? yesYes : -yesYes;
}

// A correlation this strong counts as concentration (positive) or a hedge
// (negative) — the same 0.5 bar the Kelly penalty starts at
const MEANINGFUL_CORRELATION = 0.5;

export function screenNewTrade(market, portfolioPositions, clusters, simulatedSize = 50) {
  if (!market || portfolioPositions.length === 0) {
    return {
      fit: 'GOOD_FIT',
      maxCorrelation: 0,
      maxCorrelationMarket: null,
      clusterName: null,
      currentDivScore: 100,
      newDivScore: 100,
      text: 'This market is uncorrelated with your portfolio — good diversification.',
    };
  }

  // Create a fake position for the candidate market
  const candidatePos = {
    market,
    side: 'YES',
    currentValue: simulatedSize,
    size: simulatedSize,
    currentPrice: market.yesPrice,
  };

  // One pass: the candidate's correlation with every existing position.
  // Positions in this very market are "already held", not correlation — a
  // market compared with itself scores the 0.95 cap.
  const corrWith = new Map();
  const heldHere = [];
  for (const pos of portfolioPositions) {
    corrWith.set(pos, calculatePairCorrelation(candidatePos, pos).correlation);
    if (pos.market && String(pos.market.id) === String(market.id)) heldHere.push(pos);
  }
  const heldHereSet = new Set(heldHere);

  // How a bet on `betSide` here relates to your other positions: the
  // strongest correlation it would add to, and the positions it would hedge.
  // Different outcomes of one exclusive event use their exact, price-implied
  // payoff correlation (sign AND size — two longshots are nearly independent,
  // a two-way race is −1). Any other correlation is unsigned and counts as
  // adding: the conservative reading ("direction not modelled").
  // (Clustering keeps the unsigned score: it measures topical concentration
  // — "same event" — not payoff correlation.)
  const payoffView = (betSide) => {
    let best = null;
    const hedges = [];
    for (const pos of portfolioPositions) {
      if (heldHereSet.has(pos)) continue;
      const about = { market: pos.market, question: pos.market?.question ?? '', side: pos.side, size: pos.size };
      if (mutuallyExclusive(market, pos.market)) {
        const r = exclusiveOutcomeCorrelation(market.yesPrice, pos.market.yesPrice, pos.side === betSide);
        if (r <= -MEANINGFUL_CORRELATION) hedges.push({ ...about, correlation: r });
        else if (r > 0 && (!best || r > best.correlation)) best = { ...about, correlation: r, directionKnown: true };
      } else {
        const corr = corrWith.get(pos) ?? 0;
        if (corr > 0 && (!best || corr > best.correlation)) best = { ...about, correlation: corr, directionKnown: false };
      }
    }
    hedges.sort((a, b) => a.correlation - b.correlation); // strongest hedge first
    return {
      correlation: best?.correlation ?? 0,
      market: best?.market ?? null,
      question: best?.question ?? null,
      side: best?.side ?? null,
      directionKnown: best?.directionKnown ?? false,
      hedges: hedges.slice(0, 3),
    };
  };
  const sideRisk = { YES: payoffView('YES'), NO: payoffView('NO') };

  // Portfolio Impact screens buying YES here
  const yesView = sideRisk.YES;
  const maxCorr = yesView.correlation;
  const maxCorrMarket = yesView.market;

  // The cluster it would join: the first containing a position it clears the
  // clustering threshold with (a position in this market counts)
  const joinCluster = clusters.find((c) => c.positions.some((p) => (corrWith.get(p) ?? 0) >= CLUSTER_THRESHOLD)) || null;

  const currentConcentration = calculateConcentration(portfolioPositions, clusters);

  // New clusters without re-clustering everything (that was O(n²+) per call):
  // the candidate joins joinCluster — its average correlation updated with
  // the candidate's correlations to the members — or becomes a singleton;
  // every cluster's weight is rescaled to the new total.
  const newPositions = [...portfolioPositions, candidatePos];
  const newTotal = newPositions.reduce((s, p) => s + (p.currentValue || 0), 0);
  const newClusters = clusters.map((c) => {
    if (c !== joinCluster) return { ...c, portfolioWeight: newTotal > 0 ? c.totalValue / newTotal : 0 };
    const k = c.positions.length;
    const sumCorr = c.averageCorrelation * (k * (k - 1)) / 2
      + c.positions.reduce((s, p) => s + (corrWith.get(p) ?? 0), 0);
    const averageCorrelation = sumCorr / ((k + 1) * k / 2);
    const totalValue = c.totalValue + simulatedSize;
    return {
      ...c,
      positions: [...c.positions, candidatePos],
      totalValue,
      portfolioWeight: newTotal > 0 ? totalValue / newTotal : 0,
      averageCorrelation,
      effectivePositionCount: Math.max(1, (k + 1) * (1 - averageCorrelation)),
    };
  });
  if (!joinCluster) {
    newClusters.push({
      id: newClusters.length, name: market.question, positions: [candidatePos], totalValue: simulatedSize,
      portfolioWeight: newTotal > 0 ? simulatedSize / newTotal : 0, averageCorrelation: 0, effectivePositionCount: 1,
    });
  }
  const newConcentration = calculateConcentration(newPositions, newClusters);

  // Shares held in this market, per side (a wallet YES and a manual NO in
  // the same market are different exposures, not one bigger one)
  const alreadyHeld = heldHere.length > 0
    ? heldHere.reduce((acc, p) => {
      if (p.side === 'YES') acc.yes += p.size || 0;
      else if (p.side === 'NO') acc.no += p.size || 0;
      return acc;
    }, { yes: 0, no: 0 })
    : null;

  // Determine fit (for buying YES here). It opposes a position when:
  // - an exclusive outcome's payoff correlation is strongly negative (a real,
  //   price-implied hedge) and at least as strong as anything it adds to; or
  // - for other markets, the old guess: the most-correlated market is held
  //   on the other side (direction not modelled, so worded as a possibility).
  let fit, text;
  const strongestHedge = yesView.hedges[0] ?? null;
  const hedgesExclusive = Boolean(strongestHedge && -strongestHedge.correlation >= maxCorr);
  const guessOpposing = !hedgesExclusive && !yesView.directionKnown && maxCorr > MEANINGFUL_CORRELATION
    && portfolioPositions.some((p) => p.market === maxCorrMarket && p.side !== candidatePos.side);

  if (alreadyHeld) {
    fit = 'ALREADY_HELD';
    // The screen doesn't know which side you'd buy, so describe both
    const { yes, no } = alreadyHeld;
    if (yes > 0 && no > 0) {
      text = `You already hold this market on both sides (YES ${yes.toFixed(0)}, NO ${no.toFixed(0)} shares).`;
    } else if (yes > 0 || no > 0) {
      const [held, other] = yes > 0 ? ['YES', 'NO'] : ['NO', 'YES'];
      text = `You already hold this market (${held} ${(yes || no).toFixed(0)} shares). Buying more ${held} concentrates that position; buying ${other} offsets it.`;
    } else {
      text = 'You already hold this market.';
    }
  } else if (hedgesExclusive) {
    fit = 'OPPOSING';
    text = `A different outcome of the same event as your ${strongestHedge.side} position in "${strongestHedge.question.slice(0, 50)}" — at these prices they move against each other (r=${strongestHedge.correlation.toFixed(2)}), so buying YES here partly hedges it.`;
  } else if (guessOpposing) {
    fit = 'OPPOSING';
    text = `This market opposes your existing ${joinCluster?.name || 'correlated'} positions — it may act as a partial hedge, if they move together (direction not modelled).`;
  } else if (maxCorr > 0.5 && joinCluster && joinCluster.portfolioWeight > 0.3) {
    fit = 'INCREASES_CONCENTRATION';
    text = `This market is highly correlated with your ${joinCluster.name} positions (${(joinCluster.portfolioWeight * 100).toFixed(0)}% of portfolio). Adding it increases concentration risk.`;
  } else if (maxCorr > 0.3) {
    fit = 'NEUTRAL';
    text = `Moderate overlap with your ${joinCluster?.name || 'existing'} positions.`;
  } else {
    fit = 'GOOD_FIT';
    text = 'This market is uncorrelated with your portfolio — good diversification.';
  }

  return {
    fit,
    maxCorrelation: maxCorr,
    maxCorrelationMarket: maxCorrMarket,
    clusterName: joinCluster?.name ?? null,
    currentDivScore: currentConcentration.diversificationScore,
    newDivScore: newConcentration.diversificationScore,
    alreadyHeld,
    sideRisk,
    text,
  };
}

// ── Alerts ──

export function generateAlerts(positions, clusters, concentration) {
  const alerts = [];

  // OVERCONCENTRATION
  for (const c of clusters) {
    if (c.portfolioWeight > 0.4) {
      const topProfit = c.positions.reduce((best, p) =>
        (p.unrealizedPnl || 0) > (best.unrealizedPnl || 0) ? p : best, c.positions[0]);
      alerts.push({
        type: 'OVERCONCENTRATION',
        severity: 'critical',
        icon: '\uD83D\uDEA8',
        text: `Over ${(c.portfolioWeight * 100).toFixed(0)}% of your portfolio is in ${c.name}. A single adverse event could impact $${c.totalValue.toFixed(0)}.${topProfit?.market ? ` Consider taking profit on "${topProfit.market.question.slice(0, 50)}".` : ''}`,
        clusterId: c.id,
      });
    }
  }

  // CORRELATION_CREEP
  if (positions.length > 2 && concentration.effectiveBets < positions.length * 0.4) {
    alerts.push({
      type: 'CORRELATION_CREEP',
      severity: 'warning',
      icon: '\u26A0\uFE0F',
      text: `Correlation has reduced your ${positions.length} positions to ~${concentration.effectiveBets.toFixed(1)} effective independent bets. You have less diversification than it appears.`,
    });
  }

  // SIDE_IMBALANCE
  if (concentration.sideImbalance > 0.7) {
    const dominantSide = concentration.yesExposure > concentration.noExposure ? 'Yes' : 'No';
    const pct = Math.round(((Math.max(concentration.yesExposure, concentration.noExposure) / (concentration.yesExposure + concentration.noExposure)) * 100));
    alerts.push({
      type: 'SIDE_IMBALANCE',
      severity: 'warning',
      icon: '\uD83D\uDCCA',
      text: `Your portfolio is ${pct}% ${dominantSide} — heavily skewed. Consider balancing with ${dominantSide === 'Yes' ? 'No' : 'Yes'} positions.`,
    });
  }

  // THETA_DRAG
  const thetaAgainst = positions.filter((p) => {
    if (!p.market?.theta) return false;
    const bestSide = p.market.theta.bestSide;
    return bestSide && bestSide !== p.side;
  });
  if (thetaAgainst.length >= 2) {
    alerts.push({
      type: 'THETA_DRAG',
      severity: 'info',
      icon: '\u23F3',
      text: `Time decay is working against ${thetaAgainst.length} of your positions. Review theta alignment.`,
    });
  }

  // FRICTION_LOCK
  for (const p of positions) {
    if (p.market?.spread != null && p.currentValue > 0) {
      const frictionPct = (p.market.spread / (p.currentPrice || 1)) * 100;
      if (frictionPct > 10) {
        alerts.push({
          type: 'FRICTION_LOCK',
          severity: 'warning',
          icon: '\uD83D\uDD12',
          text: `"${p.market.question.slice(0, 50)}" has ${frictionPct.toFixed(0)}% exit friction — you'd lose significant value just to close this position.`,
        });
      }
    }
  }

  // EXPIRING_SOON
  for (const p of positions) {
    if (p.market?.daysLeft != null && p.market.daysLeft <= 3 && p.market.daysLeft >= 0) {
      const pnlStr = p.unrealizedPnl >= 0 ? `+$${p.unrealizedPnl.toFixed(2)}` : `-$${Math.abs(p.unrealizedPnl).toFixed(2)}`;
      alerts.push({
        type: 'EXPIRING_SOON',
        severity: 'info',
        icon: '\u23F0',
        text: `"${p.market.question.slice(0, 50)}" resolves in ${p.market.daysLeft} days. Current P&L: ${pnlStr}.`,
      });
    }
  }

  // Sort by severity
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9));

  return alerts;
}

// ── Action signals per position ──

export function getPositionSignals(position) {
  const signals = [];
  const m = position.market;
  if (!m) return signals;

  // FLB overpriced
  if (position.side === 'YES' && m.flb?.bestSide === 'NO') {
    signals.push({ type: 'flb', color: '#f59e0b', text: 'FLB says this Yes position is structurally overpriced' });
  }
  if (position.side === 'NO' && m.flb?.bestSide === 'YES') {
    signals.push({ type: 'flb', color: '#f59e0b', text: 'FLB says this No position is structurally overpriced' });
  }

  // Theta
  if (m.theta?.bestSide) {
    if (position.side === 'YES' && m.theta.bestSide === 'NO') {
      signals.push({ type: 'theta', color: '#f59e0b', text: 'Time decay is working against this position' });
    }
    if (position.side === 'NO' && m.theta.bestSide === 'NO') {
      signals.push({ type: 'theta', color: '#00d4aa', text: 'Time decay is working for you' });
    }
    if (position.side === 'YES' && m.theta.bestSide === 'YES') {
      signals.push({ type: 'theta', color: '#00d4aa', text: 'Time decay is working for you' });
    }
  }

  // Resolution strictness
  if (position.side === 'YES' && m.resolutionAnalysis?.strictness?.label === 'Very Strict') {
    signals.push({ type: 'resolution', color: '#f59e0b', text: 'Strict resolution rules favor No — reconsider' });
  }

  return signals;
}

// ── Manual Position Storage ──

export function getStoredWallet() {
  return localStorage.getItem(WALLET_KEY) || null;
}

export function setStoredWallet(address) {
  if (address) localStorage.setItem(WALLET_KEY, address);
  else localStorage.removeItem(WALLET_KEY);
}

export function getManualPositions() {
  try {
    return JSON.parse(localStorage.getItem(MANUAL_KEY) || '[]');
  } catch {
    return [];
  }
}

export function addManualPosition(position) {
  const existing = getManualPositions();
  existing.push({ ...position, source: 'manual', addedAt: Date.now() });
  localStorage.setItem(MANUAL_KEY, JSON.stringify(existing));
  return existing;
}

export function removeManualPosition(index) {
  const existing = getManualPositions();
  existing.splice(index, 1);
  localStorage.setItem(MANUAL_KEY, JSON.stringify(existing));
  return existing;
}

export function clearManualPositions() {
  localStorage.removeItem(MANUAL_KEY);
}

export function getCachedPositions() {
  try {
    const cached = JSON.parse(localStorage.getItem(PORTFOLIO_CACHE_KEY) || 'null');
    if (!cached) return null;
    // Expire after 5 minutes
    if (Date.now() - cached.ts > 5 * 60 * 1000) return null;
    return cached.data;
  } catch {
    return null;
  }
}

export function setCachedPositions(data) {
  try {
    // Strip the attached market objects — each carries the full processed
    // market (resolution analysis, engines, description), which blows the
    // localStorage quota. Markets are re-attached on load via
    // matchPositionsToMarkets anyway.
    const slim = Array.isArray(data)
      ? data.map(({ market: _market, ...rest }) => rest)
      : data;
    localStorage.setItem(PORTFOLIO_CACHE_KEY, JSON.stringify({ data: slim, ts: Date.now() }));
  } catch { /* quota exceeded — skip caching */ }
}

// ── Dismissed alerts storage ──

export function getDismissedAlerts() {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]');
  } catch {
    return [];
  }
}

export function dismissAlert(alertText) {
  const dismissed = getDismissedAlerts();
  dismissed.push(alertText);
  localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed));
}

export function resetDismissedAlerts() {
  localStorage.removeItem(DISMISSED_KEY);
}
