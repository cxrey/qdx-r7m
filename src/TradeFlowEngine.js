/**
 * TradeFlowEngine.js — Pure JS utility for trade flow analysis.
 * Provides wallet-level trade flow analysis, position concentration risk,
 * and leaderboard trader tracking. No React dependencies.
 *
 * DESIGN PHILOSOPHY: This provides INFORMATIONAL data about trading activity.
 * It does NOT provide directional recommendations.
 */

import { getCategoryPatterns } from './categoryPatterns';
import { withTimeout, TIMEOUT_DATA_API } from './fetchUtils';
import { CACHE_TTL_24H, CACHE_TTL_5M } from './engineConfig';
import { throwIfRateLimited } from './clobErrorHandler';
import { parseLeaderboard } from './schemas';

const DATA_API = '/data-api';
const LEADERBOARD_CACHE_KEY = 'pm_leaderboard_cache';
const LEADERBOARD_TTL = CACHE_TTL_24H;
const WALLET_HISTORY_PREFIX = 'pm_wallet_hist_';
const WALLET_HISTORY_TTL = CACHE_TTL_24H;
const TRADE_FLOW_CACHE_PREFIX = 'pm_tradeflow_';
const TRADE_FLOW_TTL = CACHE_TTL_5M;

// ─── Data Fetching ──────────────────────────────────────────────────

export async function fetchMarketTrades(conditionId) {
  // Try multiple param names — API may accept market= or conditionId=
  const urls = [
    `${DATA_API}/trades?market=${conditionId}&limit=200`,
    `${DATA_API}/trades?conditionId=${conditionId}&limit=200`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: withTimeout(null, TIMEOUT_DATA_API) });
      throwIfRateLimited(res);
      if (!res.ok) continue;
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data?.trades || data?.data || []);
      if (list.length > 0) return list;
    } catch (e) {
      if (e?.status === 429 || e?.status === 403) throw e;
      /* try next */
    }
  }
  return [];
}

export async function fetchMarketHolders(conditionId) {
  // Try multiple param names and endpoints
  const urls = [
    `${DATA_API}/holders?market=${conditionId}&limit=20`,
    `${DATA_API}/holders?conditionId=${conditionId}&limit=20`,
    `${DATA_API}/positions?market=${conditionId}&limit=20`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: withTimeout(null, TIMEOUT_DATA_API) });
      throwIfRateLimited(res);
      if (!res.ok) continue;
      const data = await res.json();
      if (data && (Array.isArray(data) ? data.length > 0 : Object.keys(data).length > 0)) {
        return data;
      }
    } catch (e) {
      if (e?.status === 429 || e?.status === 403) throw e;
      /* try next */
    }
  }
  // Holders data not available — feature works without it
  return null;
}

export async function fetchLeaderboard() {
  // Check localStorage cache first
  try {
    const cached = localStorage.getItem(LEADERBOARD_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Date.now() - parsed.ts < LEADERBOARD_TTL) {
        return parsed.data;
      }
    }
  } catch { /* ignore */ }

  // Official endpoint: https://data-api.polymarket.com/v1/leaderboard
  // Proxy strips /data-api prefix → request path needs /v1/leaderboard
  // Params: timePeriod (not "window"), limit max 50, orderBy PNL|VOL
  const url = `${DATA_API}/v1/leaderboard?timePeriod=ALL&orderBy=PNL&limit=50`;

  try {
    const res = await fetch(url, { signal: withTimeout(null, TIMEOUT_DATA_API) });
    if (!res.ok) {
      console.warn(`[TradeFlow] Leaderboard fetch failed: ${res.status}`);
      return null;
    }
    const data = await res.json();
    const raw = Array.isArray(data) ? data : [];
    const list = raw.length > 0 ? parseLeaderboard(raw) : raw;
    if (list.length > 0) {
      try {
        localStorage.setItem(LEADERBOARD_CACHE_KEY, JSON.stringify({ data: list, ts: Date.now() }));
      } catch { /* storage full */ }
      return list;
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.warn('[TradeFlow] Leaderboard fetch error:', err.message);
    }
  }

  console.info('[TradeFlow] Leaderboard API returned no data — trade flow analysis will work without trader rankings');
  return null;
}

export async function fetchWalletActivity(walletAddress) {
  // Check localStorage cache
  const cacheKey = WALLET_HISTORY_PREFIX + walletAddress.toLowerCase();
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Date.now() - parsed.ts < WALLET_HISTORY_TTL) {
        return parsed.data;
      }
    }
  } catch { /* ignore */ }

  try {
    const res = await fetch(`${DATA_API}/activity?user=${encodeURIComponent(walletAddress)}&type=TRADE&limit=100`, { signal: withTimeout(null, TIMEOUT_DATA_API) });
    if (!res.ok) {
      console.warn(`[TradeFlow] /activity returned ${res.status} for ${walletAddress.slice(0, 10)}...`);
      return null;
    }
    const data = await res.json();
    const trades = Array.isArray(data) ? data : (data?.trades || data?.data || data?.activity || []);
    // Cache
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ data: trades, ts: Date.now() }));
    } catch { /* storage full */ }
    return trades;
  } catch (err) {
    console.warn('[TradeFlow] fetchWalletActivity error:', err.message);
    return null;
  }
}

// ─── Leaderboard Index ──────────────────────────────────────────────

let _leaderboardIndex = null;

export function buildLeaderboardIndex(leaderboardData) {
  if (!leaderboardData || !Array.isArray(leaderboardData)) {
    _leaderboardIndex = new Map();
    return _leaderboardIndex;
  }
  const index = new Map();
  leaderboardData.forEach((entry, i) => {
    // API returns: { proxyWallet, userName, rank, pnl, vol, xUsername, verifiedBadge, profileImage }
    const wallet = (entry.proxyWallet || entry.proxy_wallet || '').toLowerCase();
    if (!wallet) return;
    index.set(wallet, {
      rank: entry.rank ? Number(entry.rank) : i + 1,  // API returns rank as string
      profit: entry.pnl || entry.profit || 0,
      volume: entry.vol || entry.volume || 0,          // API uses "vol", not "volume"
      name: entry.userName || entry.name || null,       // API uses "userName", not "name"
      pseudonym: entry.xUsername || entry.pseudonym || null,
    });
  });
  _leaderboardIndex = index;
  return index;
}

export function getLeaderboardIndex() {
  return _leaderboardIndex || new Map();
}

// ─── Wallet Relevance Assessment ────────────────────────────────────

export function assessWalletRelevance(walletActivity, marketCategory, leaderboardEntry) {
  if (!walletActivity || !Array.isArray(walletActivity)) {
    return {
      categoryTradeCount: 0,
      categoryWinRate: null,
      relevanceLevel: 'NO_TRACK_RECORD',
      displayText: leaderboardEntry
        ? `Ranked #${leaderboardEntry.rank} overall, no ${marketCategory} track record`
        : `No track record in ${marketCategory}`,
    };
  }

  // Match trades to category using simple keyword matching
  // The activity items may have market names/titles we can check against category patterns
  const categoryPatterns = getCategoryPatterns(marketCategory);
  const categoryTrades = walletActivity.filter((t) => {
    const text = (t.market_slug || t.title || t.question || t.name || '').toLowerCase();
    return categoryPatterns.some((p) => p.test(text));
  });

  const categoryTradeCount = categoryTrades.length;

  // Estimate win rate if possible (very rough)
  let categoryWinRate = null;
  const resolved = categoryTrades.filter((t) => t.outcome != null || t.resolved != null);
  if (resolved.length >= 3) {
    const wins = resolved.filter((t) => {
      // Try to determine if the trader's side won
      if (t.won != null) return t.won;
      if (t.pnl != null) return t.pnl > 0;
      return false;
    }).length;
    if (resolved.length > 0) {
      categoryWinRate = wins / resolved.length;
    }
  }

  const rank = leaderboardEntry?.rank;
  let relevanceLevel, displayText;

  if (categoryTradeCount >= 10 && categoryWinRate != null && categoryWinRate > 0.55) {
    relevanceLevel = 'RELEVANT_EXPERT';
    displayText = `Ranked #${rank} overall, ${(categoryWinRate * 100).toFixed(0)}% win rate in ${marketCategory} (${categoryTradeCount} trades)`;
  } else if (categoryTradeCount >= 10) {
    relevanceLevel = 'CATEGORY_ACTIVE';
    displayText = categoryWinRate != null
      ? `Ranked #${rank} overall, active in ${marketCategory} (${categoryTradeCount} trades, ${(categoryWinRate * 100).toFixed(0)}% win rate)`
      : `Ranked #${rank} overall, active in ${marketCategory} (${categoryTradeCount} trades, win rate unknown)`;
  } else if (categoryTradeCount >= 5) {
    relevanceLevel = 'SOME_HISTORY';
    displayText = `Ranked #${rank} overall, limited ${marketCategory} history (${categoryTradeCount} trades)`;
  } else {
    relevanceLevel = 'NO_TRACK_RECORD';
    displayText = `Ranked #${rank} overall, no ${marketCategory} track record`;
  }

  return { categoryTradeCount, categoryWinRate, relevanceLevel, displayText };
}

// Category patterns imported from shared categoryPatterns.js

// ─── Main Trade Flow Analysis ───────────────────────────────────────

export function analyzeTradeFlow(trades, holders, leaderboardIndex, market, walletRelevanceMap) {
  if (!trades || trades.length === 0) {
    return {
      dataAvailable: false,
      reliabilityScore: 'VERY_LOW',
      tradeCount24h: 0,
      totalUniqueWallets: 0,
    };
  }

  const now = Date.now() / 1000;
  const oneDayAgo = now - 86400;
  const sixHoursAgo = now - 21600;
  const lbIndex = leaderboardIndex || new Map();
  const relMap = walletRelevanceMap || new Map();

  // Filter to 24h trades
  const trades24h = trades.filter((t) => {
    const ts = t.timestamp || t.created_at || t.time || 0;
    return ts >= oneDayAgo;
  });

  // If no 24h trades, use all trades but mark as stale
  const activeTrades = trades24h.length > 0 ? trades24h : trades;
  const isStaleData = trades24h.length === 0;

  // ── Step 1: Classify each trade ──
  const classifiedTrades = activeTrades.map((t) => {
    const walletLower = (t.proxyWallet || t.proxy_wallet || t.maker || t.taker || t.user || '').toLowerCase();
    const price = parseFloat(t.price || 0);
    const shares = parseFloat(t.size || t.shares || 0);
    // usdcSize may be provided directly, or calculated as shares * price
    const usdcSize = parseFloat(t.usdcSize || t.usdc_size || 0) || (shares * price);
    const ts = t.timestamp || t.created_at || t.time || 0;

    // Determine side: buying Yes or buying No
    // outcomeIndex 0 typically = Yes, 1 = No
    // Also check outcome field and side field
    let buyingYes = false;
    let buyingNo = false;
    const side = (t.side || '').toUpperCase();
    const outcome = (t.outcome || '').toLowerCase();
    const outcomeIndex = t.outcomeIndex ?? t.outcome_index;

    if (side === 'BUY') {
      if (outcomeIndex === 0 || outcome === 'yes') buyingYes = true;
      else if (outcomeIndex === 1 || outcome === 'no') buyingNo = true;
      else buyingYes = true; // default assumption for BUY
    } else if (side === 'SELL') {
      // Selling Yes is effectively buying No and vice versa
      if (outcomeIndex === 0 || outcome === 'yes') buyingNo = true;
      else if (outcomeIndex === 1 || outcome === 'no') buyingYes = true;
    } else {
      // If side not clear, try to infer from outcome
      if (outcomeIndex === 0 || outcome === 'yes') buyingYes = true;
      else if (outcomeIndex === 1 || outcome === 'no') buyingNo = true;
    }

    const leaderboardEntry = lbIndex.get(walletLower);
    const walletRelevance = relMap.get(walletLower) || null;

    return {
      ...t,
      walletLower,
      usdcSize,
      price,
      ts,
      buyingYes,
      buyingNo,
      isLargeTrade: usdcSize >= 1000,
      isWhaleTrade: usdcSize >= 5000,
      isMegaTrade: usdcSize >= 20000,
      isLeaderboardTrader: !!leaderboardEntry,
      leaderboardEntry,
      leaderboardRank: leaderboardEntry?.rank || null,
      walletRelevance,
      isRelevantExpert: walletRelevance?.relevanceLevel === 'RELEVANT_EXPERT',
      traderName: t.name || leaderboardEntry?.name || leaderboardEntry?.pseudonym || t.pseudonym || null,
    };
  });

  // ── Step 2: Wallet count imbalance ──
  const walletsBuyingYes = new Set();
  const walletsBuyingNo = new Set();
  const largeWalletsBuyingYes = new Set();
  const largeWalletsBuyingNo = new Set();

  classifiedTrades.forEach((t) => {
    if (t.buyingYes) {
      walletsBuyingYes.add(t.walletLower);
      if (t.isLargeTrade) largeWalletsBuyingYes.add(t.walletLower);
    }
    if (t.buyingNo) {
      walletsBuyingNo.add(t.walletLower);
      if (t.isLargeTrade) largeWalletsBuyingNo.add(t.walletLower);
    }
  });

  const walletCountYes = walletsBuyingYes.size;
  const walletCountNo = walletsBuyingNo.size;
  const allWallets = new Set([...walletsBuyingYes, ...walletsBuyingNo]);
  const totalUniqueWallets = allWallets.size;

  const walletTotal = walletCountYes + walletCountNo;
  const walletImbalance = walletTotal > 0 ? (walletCountYes - walletCountNo) / walletTotal : 0;

  let walletImbalanceLabel;
  if (walletImbalance > 0.4) walletImbalanceLabel = 'Strong Yes consensus';
  else if (walletImbalance > 0.15) walletImbalanceLabel = 'Lean Yes';
  else if (walletImbalance > -0.15) walletImbalanceLabel = 'Balanced';
  else if (walletImbalance > -0.4) walletImbalanceLabel = 'Lean No';
  else walletImbalanceLabel = 'Strong No consensus';

  // ── Step 3: Volume imbalance ──
  let yesBuyVolume = 0;
  let noBuyVolume = 0;
  classifiedTrades.forEach((t) => {
    if (t.buyingYes) yesBuyVolume += t.usdcSize;
    if (t.buyingNo) noBuyVolume += t.usdcSize;
  });
  const totalVolume24h = yesBuyVolume + noBuyVolume;
  const volumeImbalance = totalVolume24h > 0 ? (yesBuyVolume - noBuyVolume) / totalVolume24h : 0;

  // ── Step 4: Single wallet dominance ──
  let singleWalletDominance = false;
  let dominanceWarning = null;

  for (const direction of ['yes', 'no']) {
    const dirTrades = classifiedTrades.filter((t) => direction === 'yes' ? t.buyingYes : t.buyingNo);
    const walletVolumes = new Map();
    let dirTotal = 0;
    dirTrades.forEach((t) => {
      walletVolumes.set(t.walletLower, (walletVolumes.get(t.walletLower) || 0) + t.usdcSize);
      dirTotal += t.usdcSize;
    });

    if (dirTotal > 0) {
      let maxWalletVol = 0;
      walletVolumes.forEach((vol) => { if (vol > maxWalletVol) maxWalletVol = vol; });
      const dominancePct = maxWalletVol / dirTotal;
      if (dominancePct > 0.50) {
        singleWalletDominance = true;
        const dirLabel = direction === 'yes' ? 'Yes' : 'No';
        dominanceWarning = `One wallet accounts for ${(dominancePct * 100).toFixed(0)}% of ${dirLabel} volume. This could be a single trader, market maker, or attempt to influence price. Do not treat as consensus.`;
      }
    }
  }

  // Wash trading detection
  let washTradingFlag = false;
  let washWarning = null;

  const walletTradeTimelines = new Map();
  classifiedTrades.forEach((t) => {
    if (!walletTradeTimelines.has(t.walletLower)) walletTradeTimelines.set(t.walletLower, []);
    walletTradeTimelines.get(t.walletLower).push(t);
  });

  walletTradeTimelines.forEach((wTrades, wallet) => {
    if (washTradingFlag) return;
    const hasBuyYes = wTrades.some((t) => t.buyingYes);
    const hasBuyNo = wTrades.some((t) => t.buyingNo);
    if (hasBuyYes && hasBuyNo) {
      // Check if any YES trade is within 2 hours of any NO trade.
      // Bucket NO trade timestamps into 2h slots for O(n) lookup.
      const noSlots = new Set();
      const noTrades = [];
      for (const t of wTrades) {
        if (t.buyingNo) {
          noSlots.add(Math.floor(t.ts / 7200));
          noTrades.push(t);
        }
      }
      for (const yt of wTrades) {
        if (!yt.buyingYes) continue;
        const slot = Math.floor(yt.ts / 7200);
        // Check current and adjacent slots (covers the 2h window)
        if (noSlots.has(slot) || noSlots.has(slot - 1) || noSlots.has(slot + 1)) {
          for (const nt of noTrades) {
            if (Math.abs(yt.ts - nt.ts) < 7200) {
              washTradingFlag = true;
              const name = yt.traderName || wallet.slice(0, 10) + '...';
              washWarning = `Wallet ${name} is buying and selling rapidly — may be market making or wash trading, not directional conviction.`;
              return;
            }
          }
        }
      }
    }
  });

  // ── Step 5: Large vs Small divergence ──
  const largeTrades = classifiedTrades.filter((t) => t.isLargeTrade);
  const smallTrades = classifiedTrades.filter((t) => !t.isLargeTrade);

  let largeYesVol = 0, largeNoVol = 0, smallYesVol = 0, smallNoVol = 0;
  largeTrades.forEach((t) => { if (t.buyingYes) largeYesVol += t.usdcSize; if (t.buyingNo) largeNoVol += t.usdcSize; });
  smallTrades.forEach((t) => { if (t.buyingYes) smallYesVol += t.usdcSize; if (t.buyingNo) smallNoVol += t.usdcSize; });

  const largeTotalVol = largeYesVol + largeNoVol;
  const smallTotalVol = smallYesVol + smallNoVol;
  const largeBuyYesPct = largeTotalVol > 0 ? largeYesVol / largeTotalVol : 0.5;
  const smallBuyYesPct = smallTotalVol > 0 ? smallYesVol / smallTotalVol : 0.5;
  const divergence = largeBuyYesPct - smallBuyYesPct;
  const isDiverging = Math.abs(divergence) > 0.25 && largeTrades.length >= 3 && smallTrades.length >= 5;

  let divergenceLabel = null;
  if (isDiverging && divergence > 0) divergenceLabel = 'Large traders buying Yes, small traders buying No';
  else if (isDiverging && divergence < 0) divergenceLabel = 'Large traders buying No, small traders buying Yes';

  // ── Step 6: Leaderboard trader activity ──
  const leaderboardTrades = classifiedTrades.filter((t) => t.isLeaderboardTrader);
  let lbYesVolume = 0, lbNoVolume = 0;
  const lbWalletsYes = new Set();
  const lbWalletsNo = new Set();
  leaderboardTrades.forEach((t) => {
    if (t.buyingYes) { lbYesVolume += t.usdcSize; lbWalletsYes.add(t.walletLower); }
    if (t.buyingNo) { lbNoVolume += t.usdcSize; lbWalletsNo.add(t.walletLower); }
  });

  let leaderboardDirection;
  if (leaderboardTrades.length === 0) {
    leaderboardDirection = 'No leaderboard trader activity';
  } else if (lbWalletsYes.size > lbWalletsNo.size && lbYesVolume > lbNoVolume * 1.5) {
    leaderboardDirection = 'Leaderboard traders buying Yes';
  } else if (lbWalletsNo.size > lbWalletsYes.size && lbNoVolume > lbYesVolume * 1.5) {
    leaderboardDirection = 'Leaderboard traders buying No';
  } else {
    leaderboardDirection = 'Leaderboard traders split';
  }

  // Relevant experts
  const relevantExperts = [];
  const seenExperts = new Set();
  classifiedTrades
    .filter((t) => t.isRelevantExpert && !seenExperts.has(t.walletLower))
    .forEach((t) => {
      seenExperts.add(t.walletLower);
      relevantExperts.push({
        wallet: t.walletLower,
        rank: t.leaderboardRank,
        relevance: t.walletRelevance,
        name: t.traderName,
        trades: classifiedTrades.filter((ct) => ct.walletLower === t.walletLower),
      });
    });

  // ── Step 7: Volume acceleration ──
  const last6hTrades = classifiedTrades.filter((t) => t.ts >= sixHoursAgo);
  const last6hVolume = last6hTrades.reduce((s, t) => s + t.usdcSize, 0);
  const avg6hVolume = totalVolume24h / 4;
  const acceleration = avg6hVolume > 0 ? last6hVolume / avg6hVolume : 1;

  let accelerationLabel;
  if (acceleration > 3.0) accelerationLabel = 'Surging';
  else if (acceleration > 1.5) accelerationLabel = 'Above Average';
  else if (acceleration > 0.5) accelerationLabel = 'Normal';
  else accelerationLabel = 'Quiet';

  // ── Step 8: Data reliability ──
  const tradeCount24h = classifiedTrades.length;
  let reliabilityScore;
  if (tradeCount24h >= 50 && totalUniqueWallets >= 20) reliabilityScore = 'HIGH';
  else if (tradeCount24h >= 20 && totalUniqueWallets >= 10) reliabilityScore = 'MEDIUM';
  else if (tradeCount24h >= 5 && totalUniqueWallets >= 3) reliabilityScore = 'LOW';
  else reliabilityScore = 'VERY_LOW';

  // Downgrade for manipulation
  const levels = ['HIGH', 'MEDIUM', 'LOW', 'VERY_LOW'];
  if (singleWalletDominance) {
    const idx = levels.indexOf(reliabilityScore);
    if (idx < levels.length - 1) reliabilityScore = levels[idx + 1];
  }
  if (washTradingFlag) {
    const idx = levels.indexOf(reliabilityScore);
    if (idx < levels.length - 1) reliabilityScore = levels[idx + 1];
  }

  // Holders data
  const holderConcentration = analyzeHolderConcentration(holders, null, lbIndex, relMap);

  // Recent large trades (top 15)
  const recentLargeTrades = classifiedTrades
    .filter((t) => t.isLargeTrade)
    .sort((a, b) => b.usdcSize - a.usdcSize)
    .slice(0, 15);

  return {
    dataAvailable: true,
    isStaleData,

    // Wallet-count based (primary)
    walletCountYes,
    walletCountNo,
    totalUniqueWallets,
    walletImbalance,
    walletImbalanceLabel,
    largeWalletCountYes: largeWalletsBuyingYes.size,
    largeWalletCountNo: largeWalletsBuyingNo.size,

    // Volume based (secondary)
    totalVolume24h,
    yesBuyVolume,
    noBuyVolume,
    volumeImbalance,

    // Trade counts
    tradeCount24h,
    largeTradeCount24h: largeTrades.length,
    whaleTradeCount24h: classifiedTrades.filter((t) => t.isWhaleTrade).length,

    // Manipulation warnings
    singleWalletDominance,
    dominanceWarning,
    washTradingFlag,
    washWarning,

    // Divergence
    isDiverging,
    divergenceLabel,

    // Leaderboard
    leaderboardDirection,
    leaderboardWalletCountYes: lbWalletsYes.size,
    leaderboardWalletCountNo: lbWalletsNo.size,
    leaderboardYesVolume: lbYesVolume,
    leaderboardNoVolume: lbNoVolume,
    relevantExperts,
    leaderboardTradeCount: leaderboardTrades.length,

    // Holders
    holderConcentration,

    // Recent large trades
    recentLargeTrades,

    // Acceleration
    acceleration,
    accelerationLabel,

    // Reliability
    reliabilityScore,
  };
}

// ─── Holder Concentration Analysis ──────────────────────────────────

export function analyzeHolderConcentration(holders, orderBook, leaderboardIndex, walletRelevanceMap) {
  if (!holders) return null;

  const lbIndex = leaderboardIndex || new Map();
  const relMap = walletRelevanceMap || new Map();

  // Normalize holders data — could be array of per-token objects or flat array
  let yesHolders = [];
  let noHolders = [];

  if (Array.isArray(holders)) {
    holders.forEach((h) => {
      if (h.holders && Array.isArray(h.holders)) {
        // Per-token format: { token, holders: [...] }
        h.holders.forEach((holder) => {
          const enriched = enrichHolder(holder, lbIndex, relMap);
          if (holder.outcomeIndex === 0 || holder.outcome_index === 0) yesHolders.push(enriched);
          else if (holder.outcomeIndex === 1 || holder.outcome_index === 1) noHolders.push(enriched);
          else yesHolders.push(enriched); // default
        });
      } else {
        // Flat format: each item is a holder
        const enriched = enrichHolder(h, lbIndex, relMap);
        if (h.outcomeIndex === 0 || h.outcome_index === 0) yesHolders.push(enriched);
        else if (h.outcomeIndex === 1 || h.outcome_index === 1) noHolders.push(enriched);
        else yesHolders.push(enriched);
      }
    });
  } else if (holders && typeof holders === 'object') {
    // Could be { yes: [...], no: [...] } or { holders: [...] }
    if (holders.yes) yesHolders = (holders.yes || []).map((h) => enrichHolder(h, lbIndex, relMap));
    if (holders.no) noHolders = (holders.no || []).map((h) => enrichHolder(h, lbIndex, relMap));
    if (holders.holders) {
      holders.holders.forEach((h) => {
        const enriched = enrichHolder(h, lbIndex, relMap);
        if (h.outcomeIndex === 0) yesHolders.push(enriched);
        else noHolders.push(enriched);
      });
    }
  }

  // Sort by amount
  yesHolders.sort((a, b) => b.amount - a.amount);
  noHolders.sort((a, b) => b.amount - a.amount);

  const analyzeSide = (sideHolders) => {
    if (sideHolders.length === 0) return null;
    const top5 = sideHolders.slice(0, 5);
    const top5Total = top5.reduce((s, h) => s + h.amount, 0);
    const allTotal = sideHolders.reduce((s, h) => s + h.amount, 0);
    const concentrationPct = allTotal > 0 ? top5Total / allTotal : 0;
    const largest = sideHolders[0];
    const lbCount = sideHolders.filter((h) => h.isLeaderboardTrader).length;

    return {
      concentrationPct,
      largestHolderShares: largest.amount,
      largestHolderName: largest.displayName,
      top5Control: concentrationPct,
      leaderboardHolderCount: lbCount,
      holders: sideHolders.slice(0, 10),
    };
  };

  return {
    yes: analyzeSide(yesHolders),
    no: analyzeSide(noHolders),
  };
}

function enrichHolder(holder, lbIndex, relMap) {
  const wallet = (holder.proxyWallet || holder.proxy_wallet || holder.address || holder.wallet || '').toLowerCase();
  const amount = parseFloat(holder.amount || holder.shares || holder.balance || 0);
  const leaderboardEntry = lbIndex.get(wallet);
  const walletRelevance = relMap.get(wallet) || null;

  return {
    ...holder,
    walletLower: wallet,
    amount,
    displayName: holder.name || holder.pseudonym || leaderboardEntry?.name || leaderboardEntry?.pseudonym || (wallet ? wallet.slice(0, 6) + '...' + wallet.slice(-4) : 'Unknown'),
    isLeaderboardTrader: !!leaderboardEntry,
    leaderboardData: leaderboardEntry || null,
    categoryRelevance: walletRelevance,
  };
}

// ─── Edge Score Integration ─────────────────────────────────────────

export function tradeFlowEdgeBonus(flowData, structuralDirection) {
  if (!flowData || !flowData.dataAvailable) return 0;

  let bonus = 0;

  // structuralDirection: 'YES' | 'NO' | null
  const flowDirection = flowData.walletImbalance > 0.15 ? 'YES' : (flowData.walletImbalance < -0.15 ? 'NO' : null);

  if (flowData.reliabilityScore === 'VERY_LOW') return 0;

  // Manipulation penalty
  if (flowData.singleWalletDominance || flowData.washTradingFlag) {
    bonus -= 5;
  }

  if (flowData.reliabilityScore === 'HIGH' && flowDirection && !flowData.singleWalletDominance) {
    if (structuralDirection && flowDirection === structuralDirection) bonus += 5;
    else if (structuralDirection && flowDirection !== structuralDirection) bonus -= 3;
  }

  // Relevant expert alignment
  if (flowData.relevantExperts.length > 0) {
    const expertDirection = flowData.relevantExperts[0].trades.some((t) => t.buyingYes) ? 'YES' : 'NO';
    if (structuralDirection && expertDirection === structuralDirection) bonus += 5;
    else if (structuralDirection && expertDirection !== structuralDirection) bonus -= 2;
  }

  return bonus;
}

// ─── Cache Helpers ──────────────────────────────────────────────────

const flowCache = new Map();
const MAX_FLOW_CACHE = 500; // LRU cap — bounds memory for long sessions

/**
 * Read-only cache lookup — no LRU promotion.
 * Use in render paths (VirtualRow) to avoid mutating the Map on every frame.
 */
export function peekCachedTradeFlow(marketId) {
  const entry = flowCache.get(marketId);
  if (!entry) return null;
  if (Date.now() - entry.ts > TRADE_FLOW_TTL) {
    flowCache.delete(marketId);
    return null;
  }
  return entry.data;
}

/**
 * Cache lookup with LRU promotion (delete + re-set moves to end of iteration order).
 * Use in fetch-loop cache-miss checks where promotion accuracy matters.
 */
export function getCachedTradeFlow(marketId) {
  const entry = flowCache.get(marketId);
  if (!entry) return null;
  if (Date.now() - entry.ts > TRADE_FLOW_TTL) {
    flowCache.delete(marketId);
    return null;
  }
  // Promote to end of Map insertion order (makes eviction true LRU, not FIFO)
  flowCache.delete(marketId);
  flowCache.set(marketId, entry);
  return entry.data;
}

export function setCachedTradeFlow(marketId, data) {
  flowCache.set(marketId, { data, ts: Date.now() });

  // LRU eviction: when cache exceeds cap, evict the least-recently-used entry.
  // Map iteration order is insertion order; getCachedTradeFlow promotes on access,
  // so the first key is the least-recently-used.
  if (flowCache.size > MAX_FLOW_CACHE) {
    const oldestKey = flowCache.keys().next().value;
    flowCache.delete(oldestKey);
  }
}

// ─── Utility ────────────────────────────────────────────────────────

// Re-export from centralized formatters for backward compatibility
export { formatVolume as formatUsdcSize, formatTimeAgo } from './formatters';

export function truncateWallet(addr) {
  if (!addr || addr.length < 12) return addr || 'Unknown';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}
