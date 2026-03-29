/**
 * PortfolioEngine.js — Pure JS utility for portfolio analysis.
 * Position fetching, correlation analysis, clustering, concentration metrics, alerts, and trade screening.
 */

import { withTimeout, TIMEOUT_DATA_API } from './fetchUtils';

const DATA_API = '/data-api';

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

export async function fetchPositions(walletAddress) {
  let positions = null;

  // Try user param
  try {
    const res = await fetch(`${DATA_API}/positions?user=${walletAddress}`, { signal: withTimeout(null, TIMEOUT_DATA_API) });
    if (res.ok) {
      const data = await res.json();
      console.log('[PortfolioEngine] Positions API response (user=):', data);
      if (Array.isArray(data) && data.length > 0) positions = data;
      else if (data && typeof data === 'object' && !Array.isArray(data)) {
        // Might be wrapped in an object
        const arr = data.positions || data.data || data.results;
        if (Array.isArray(arr) && arr.length > 0) positions = arr;
      }
    }
  } catch (e) {
    console.warn('[PortfolioEngine] positions?user= failed:', e.message);
  }

  // Try address param as fallback
  if (!positions) {
    try {
      const res = await fetch(`${DATA_API}/positions?address=${walletAddress}`, { signal: withTimeout(null, TIMEOUT_DATA_API) });
      if (res.ok) {
        const data = await res.json();
        console.log('[PortfolioEngine] Positions API response (address=):', data);
        if (Array.isArray(data) && data.length > 0) positions = data;
        else if (data && typeof data === 'object' && !Array.isArray(data)) {
          const arr = data.positions || data.data || data.results;
          if (Array.isArray(arr) && arr.length > 0) positions = arr;
        }
      }
    } catch (e) {
      console.warn('[PortfolioEngine] positions?address= failed:', e.message);
    }
  }

  // Also try to fetch trade history for entry price data
  let trades = null;
  try {
    const res = await fetch(`${DATA_API}/trades?user=${walletAddress}`, { signal: withTimeout(null, TIMEOUT_DATA_API) });
    if (res.ok) {
      const data = await res.json();
      console.log('[PortfolioEngine] Trades API response:', data);
      if (Array.isArray(data)) trades = data;
      else if (data && (data.trades || data.data || data.results)) {
        trades = data.trades || data.data || data.results;
      }
    }
  } catch (e) {
    console.warn('[PortfolioEngine] trades fetch failed:', e.message);
  }

  if (!positions) return { positions: [], trades: [], error: 'Could not fetch positions from Polymarket.' };

  return { positions, trades: trades || [], error: null };
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

// Module-level cache for entity extraction results.
// Keyed on market ID — market text is immutable within a session,
// so extracting once per market is sufficient. Avoids O(n²) redundant
// extractions in buildCorrelationClusters (9,900 → 50 for 50 positions).
// LRU-capped to bound memory if screenNewTrade scans many candidates.
const entityCache = new Map();
const MAX_ENTITY_CACHE = 500;

function getCachedEntities(market) {
  const id = market.id;
  if (entityCache.has(id)) {
    const cached = entityCache.get(id);
    // Promote to end (true LRU)
    entityCache.delete(id);
    entityCache.set(id, cached);
    return cached;
  }
  const entities = extractEntities(market.question + ' ' + (market.description || ''));
  entityCache.set(id, entities);
  if (entityCache.size > MAX_ENTITY_CACHE) {
    const oldestKey = entityCache.keys().next().value;
    entityCache.delete(oldestKey);
  }
  return entities;
}

// ── Correlation Analysis ──

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
  const eA = getCachedEntities(mA);
  const eB = getCachedEntities(mB);
  const shared = sharedEntities(eA, eB);
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

  // RESOLUTION_DEPENDENCY (one market mentions the other's key terms)
  const titleA = mA.question.toLowerCase();
  const titleB = mB.question.toLowerCase();
  // Check if significant words from A appear in B's description or vice versa
  const wordsA = titleA.split(/\s+/).filter((w) => w.length > 4);
  const wordsB = titleB.split(/\s+/).filter((w) => w.length > 4);
  const descA = (mA.description || '').toLowerCase();
  const descB = (mB.description || '').toLowerCase();
  const depAB = wordsA.filter((w) => descB.includes(w)).length;
  const depBA = wordsB.filter((w) => descA.includes(w)).length;
  if (depAB >= 3 || depBA >= 3) {
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

export function buildCorrelationClusters(positions) {
  const n = positions.length;
  if (n === 0) return { clusters: [], correlationMatrix: [] };

  // Build full correlation matrix
  const matrix = Array.from({ length: n }, () => Array(n).fill(0));
  const pairData = Array.from({ length: n }, () => Array(n).fill(null));
  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const pair = calculatePairCorrelation(positions[i], positions[j]);
      matrix[i][j] = pair.correlation;
      matrix[j][i] = pair.correlation;
      pairData[i][j] = pair;
      pairData[j][i] = pair;
    }
  }

  // Greedy clustering: start with most correlated pair, expand
  const assigned = new Set();
  const clusters = [];
  const THRESHOLD = 0.4;

  // Collect all pairs above threshold, sorted by correlation desc
  const pairs = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (matrix[i][j] >= THRESHOLD) {
        pairs.push({ i, j, corr: matrix[i][j] });
      }
    }
  }
  pairs.sort((a, b) => b.corr - a.corr);

  for (const { i, j } of pairs) {
    if (assigned.has(i) && assigned.has(j)) {
      // Both already assigned — check if same cluster, skip if not
      continue;
    }

    // Find or create cluster
    let cluster = null;
    if (assigned.has(i)) {
      cluster = clusters.find((c) => c.indices.has(i));
    } else if (assigned.has(j)) {
      cluster = clusters.find((c) => c.indices.has(j));
    }

    if (!cluster) {
      cluster = { indices: new Set(), positions: [] };
      clusters.push(cluster);
    }

    // Add both
    for (const idx of [i, j]) {
      if (!cluster.indices.has(idx)) {
        cluster.indices.add(idx);
        cluster.positions.push(positions[idx]);
        assigned.add(idx);
      }
    }
  }

  // Add unclustered positions as single-position clusters
  for (let i = 0; i < n; i++) {
    if (!assigned.has(i)) {
      clusters.push({
        indices: new Set([i]),
        positions: [positions[i]],
      });
    }
  }

  // Compute cluster metadata
  const totalValue = positions.reduce((s, p) => s + (p.currentValue || 0), 0);

  const enrichedClusters = clusters.map((c, idx) => {
    const posArr = c.positions;
    const clusterValue = posArr.reduce((s, p) => s + (p.currentValue || 0), 0);

    // Average intra-cluster correlation
    const indices = [...c.indices];
    let sumCorr = 0;
    let countPairs = 0;
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        sumCorr += matrix[indices[a]][indices[b]];
        countPairs++;
      }
    }
    const avgCorrelation = countPairs > 0 ? sumCorr / countPairs : 0;
    const effectivePositionCount = posArr.length * (1 - avgCorrelation);

    // Auto-generate name from shared entities/categories
    const allLabels = [];
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const pd = pairData[indices[a]][indices[b]];
        if (pd) allLabels.push(...pd.sharedLabels);
      }
    }
    // Also add categories
    const cats = [...new Set(posArr.map((p) => p.market?.category).filter(Boolean))];
    const labelCounts = {};
    for (const l of allLabels) {
      labelCounts[l] = (labelCounts[l] || 0) + 1;
    }
    const topLabels = Object.entries(labelCounts).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([l]) => l);
    const name = topLabels.length > 0
      ? topLabels.map((l) => l.charAt(0).toUpperCase() + l.slice(1)).join('/') + (cats.length === 1 ? ` (${cats[0]})` : '')
      : cats.length > 0 ? cats.join('/') + ' Cluster'
      : `Cluster ${idx + 1}`;

    // Dominant side
    const yesSide = posArr.filter((p) => p.side === 'YES').length;
    const noSide = posArr.filter((p) => p.side === 'NO').length;
    const dominantSide = yesSide > noSide ? 'YES' : noSide > yesSide ? 'NO' : 'MIXED';

    const portfolioWeight = totalValue > 0 ? clusterValue / totalValue : 0;
    let risk = 'LOW';
    if (portfolioWeight > 0.4 || effectivePositionCount < 2) risk = 'HIGH';
    else if (portfolioWeight > 0.2) risk = 'MEDIUM';

    return {
      id: idx,
      name,
      positions: posArr,
      totalValue: clusterValue,
      portfolioWeight,
      averageCorrelation: avgCorrelation,
      effectivePositionCount: Math.max(1, effectivePositionCount),
      dominantSide,
      risk,
    };
  });

  return { clusters: enrichedClusters, correlationMatrix: matrix };
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

  // Find highest correlation with existing positions
  let maxCorr = 0;
  let maxCorrMarket = null;
  for (const pos of portfolioPositions) {
    const pair = calculatePairCorrelation(candidatePos, pos);
    if (pair.correlation > maxCorr) {
      maxCorr = pair.correlation;
      maxCorrMarket = pos.market;
    }
  }

  // Find which cluster it would join
  let joinCluster = null;
  for (const cluster of clusters) {
    for (const pos of cluster.positions) {
      const pair = calculatePairCorrelation(candidatePos, pos);
      if (pair.correlation >= 0.4) {
        joinCluster = cluster;
        break;
      }
    }
    if (joinCluster) break;
  }

  // Calculate current and new diversification scores
  const { clusters: currentClusters } = buildCorrelationClusters(portfolioPositions);
  const currentConcentration = calculateConcentration(portfolioPositions, currentClusters);

  const newPositions = [...portfolioPositions, candidatePos];
  const { clusters: newClusters } = buildCorrelationClusters(newPositions);
  const newConcentration = calculateConcentration(newPositions, newClusters);

  // Determine fit
  let fit, text;
  const isOpposingSide = maxCorrMarket && maxCorr > 0.5 &&
    portfolioPositions.some((p) => p.market === maxCorrMarket && p.side !== candidatePos.side);

  if (isOpposingSide) {
    fit = 'OPPOSING';
    text = `This market opposes your existing ${joinCluster?.name || 'correlated'} positions — acts as a partial hedge.`;
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
  localStorage.setItem(PORTFOLIO_CACHE_KEY, JSON.stringify({ data, ts: Date.now() }));
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
