/**
 * TradeFlowPanel — Full trade flow & position intelligence panel
 * for the expanded market detail view.
 *
 * DESIGN PHILOSOPHY: Informational only. No directional recommendations.
 * All signals are one data point among many.
 */
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  fetchMarketTrades, fetchMarketHolders, fetchWalletActivity,
  getLeaderboardIndex, analyzeTradeFlow, assessWalletRelevance,
  getCachedTradeFlow, setCachedTradeFlow,
  formatUsdcSize, formatTimeAgo, truncateWallet,
} from '../TradeFlowEngine';
import { isClobRateLimited, triggerClobRateLimit } from '../clobRateLimit';

const CYAN = '#00d4aa';
const PINK = '#ff4d6a';
const PURPLE = '#a78bfa';
const AMBER = '#f59e0b';
const RED = '#ef4444';

const RELIABILITY_CONFIG = {
  HIGH: { color: CYAN, bg: 'rgba(0,212,170,0.08)', border: 'rgba(0,212,170,0.3)', label: 'High Reliability' },
  MEDIUM: { color: AMBER, bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.3)', label: 'Moderate Reliability' },
  LOW: { color: AMBER, bg: 'rgba(245,158,11,0.06)', border: 'rgba(245,158,11,0.2)', label: 'Low Reliability' },
  VERY_LOW: { color: RED, bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.3)', label: 'Insufficient Data' },
};

const RELEVANCE_COLORS = {
  RELEVANT_EXPERT: CYAN,
  CATEGORY_ACTIVE: '#60a5fa',
  SOME_HISTORY: '#9ca3af',
  NO_TRACK_RECORD: AMBER,
};

function Skeleton({ className }) {
  return <div className={`animate-pulse bg-gray-800 rounded ${className}`} />;
}

// ─── Main Component ─────────────────────────────────────────────────

export default function TradeFlowPanel({ market, bookData }) {
  const [flowData, setFlowData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const mountedRef = useRef(true);

  const loadData = useCallback(async () => {
    if (!market.conditionId) {
      setError('No condition ID available');
      setLoading(false);
      return;
    }

    // Check cache
    const cached = getCachedTradeFlow(market.id);
    if (cached) {
      setFlowData(cached);
      setLoading(false);
      return;
    }

    if (isClobRateLimited()) {
      setError('CLOB API rate limited — try again later');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Step 1: Fetch trades and holders in parallel
      const [trades, holders] = await Promise.all([
        fetchMarketTrades(market.conditionId),
        fetchMarketHolders(market.conditionId),
      ]);

      if (!mountedRef.current) return;

      if ((!trades || trades.length === 0) && !holders) {
        setFlowData({ dataAvailable: false, reliabilityScore: 'VERY_LOW', tradeCount24h: 0, totalUniqueWallets: 0 });
        setLoading(false);
        return;
      }

      const lbIndex = getLeaderboardIndex();

      // Step 2: Identify leaderboard wallets with large trades
      const walletRelevanceMap = new Map();

      if (lbIndex.size > 0 && trades.length > 0) {
        const largeLbWallets = [];
        const seen = new Set();
        trades
          .filter((t) => {
            const w = (t.proxyWallet || t.proxy_wallet || t.maker || t.taker || t.user || '').toLowerCase();
            const size = parseFloat(t.usdcSize || t.usdc_size || t.size || 0);
            return size >= 1000 && lbIndex.has(w) && !seen.has(w);
          })
          .sort((a, b) => parseFloat(b.usdcSize || b.size || 0) - parseFloat(a.usdcSize || a.size || 0))
          .forEach((t) => {
            const w = (t.proxyWallet || t.proxy_wallet || t.maker || t.taker || t.user || '').toLowerCase();
            if (!seen.has(w)) {
              seen.add(w);
              largeLbWallets.push({ address: w, entry: lbIndex.get(w) });
            }
          });

        // Step 3: Fetch category history for top 5 (with stagger)
        const top5 = largeLbWallets.slice(0, 5);
        const historyPromises = top5.map((w, i) =>
          new Promise((resolve) => {
            setTimeout(async () => {
              try {
                const activity = await fetchWalletActivity(w.address);
                if (!mountedRef.current) { resolve(null); return; }
                const relevance = assessWalletRelevance(activity, market.category, w.entry);
                resolve({ wallet: w.address, relevance });
              } catch {
                resolve({ wallet: w.address, relevance: assessWalletRelevance(null, market.category, w.entry) });
              }
            }, i * 100);
          })
        );

        const results = await Promise.all(historyPromises);
        if (!mountedRef.current) return;

        results.forEach((r) => {
          if (r) walletRelevanceMap.set(r.wallet, r.relevance);
        });
      }

      // Step 4: Run analysis
      const analysis = analyzeTradeFlow(trades, holders, lbIndex, market, walletRelevanceMap);

      if (!mountedRef.current) return;

      // Cache and set
      setCachedTradeFlow(market.id, analysis);
      setFlowData(analysis);
    } catch (err) {
      if (err?.status === 429 || err?.status === 403) {
        triggerClobRateLimit(err.status);
        if (mountedRef.current) setError('CLOB API rate limited — paused for 60s');
        return;
      }
      if (mountedRef.current) {
        console.warn('[TradeFlowPanel] Error:', err);
        setError('Failed to load trade flow data');
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [market.id, market.conditionId, market.category]);

  useEffect(() => {
    mountedRef.current = true;
    loadData();
    return () => { mountedRef.current = false; };
  }, [loadData]);

  if (loading) {
    return (
      <div className="rounded-lg border border-[#1f2937] p-4" style={{ background: '#111827' }}>
        <div className="text-xs font-semibold text-gray-400 uppercase mb-3">Trade Flow & Position Intelligence</div>
        <div className="space-y-3">
          <Skeleton className="h-8 w-full" />
          <div className="grid grid-cols-4 gap-3">
            <Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" />
          </div>
          <Skeleton className="h-16 w-full" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-[#1f2937] p-4" style={{ background: '#111827' }}>
        <div className="text-xs font-semibold text-gray-400 uppercase mb-2">Trade Flow & Position Intelligence</div>
        <div className="text-xs text-gray-500">{error}</div>
        <button onClick={loadData} className="mt-2 text-xs text-emerald-400 hover:text-emerald-300">Retry</button>
      </div>
    );
  }

  if (!flowData || !flowData.dataAvailable) {
    return (
      <div className="rounded-lg border border-[#1f2937] p-4" style={{ background: '#111827' }}>
        <div className="text-xs font-semibold text-gray-400 uppercase mb-2">Trade Flow & Position Intelligence</div>
        <div className="text-xs text-gray-500">No trade data available for this market.</div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[#1f2937] p-4" style={{ background: '#111827' }}>
      <div className="text-xs font-semibold text-gray-400 uppercase mb-3">Trade Flow & Position Intelligence</div>

      {/* Reliability Badge */}
      <ReliabilityBadge flowData={flowData} />

      {/* Manipulation Warnings */}
      <ManipulationWarnings flowData={flowData} />

      {/* VERY_LOW: stop here */}
      {flowData.reliabilityScore === 'VERY_LOW' ? (
        <div className="text-xs text-gray-500 mt-3">
          Not enough trading activity for flow analysis. This market has had {flowData.tradeCount24h} trade{flowData.tradeCount24h !== 1 ? 's' : ''} from {flowData.totalUniqueWallets} wallet{flowData.totalUniqueWallets !== 1 ? 's' : ''}.
        </div>
      ) : (
        <>
          {/* Section A: Flow Summary */}
          <FlowSummary flowData={flowData} />

          {/* Section C: Divergence */}
          <DivergenceSection flowData={flowData} />

          {/* Section D: Leaderboard Activity */}
          <LeaderboardSection flowData={flowData} category={market.category} />

          {/* Section E: Holder Concentration */}
          <HolderSection flowData={flowData} />

          {/* Section F: Recent Large Trades */}
          <LargeTradesSection flowData={flowData} category={market.category} />

          {/* Section G: Context Summary */}
          <ContextSummary flowData={flowData} market={market} />
        </>
      )}
    </div>
  );
}

// ─── Sub-Components ─────────────────────────────────────────────────

function ReliabilityBadge({ flowData }) {
  const config = RELIABILITY_CONFIG[flowData.reliabilityScore] || RELIABILITY_CONFIG.VERY_LOW;
  const desc = {
    HIGH: `${flowData.tradeCount24h} trades from ${flowData.totalUniqueWallets} unique wallets in 24h`,
    MEDIUM: `${flowData.tradeCount24h} trades from ${flowData.totalUniqueWallets} wallets. Interpret with caution.`,
    LOW: `Limited trading activity. Signals may be noise.`,
    VERY_LOW: `Under 5 trades in 24h. No meaningful flow analysis possible.`,
  };

  return (
    <div
      className="rounded px-3 py-2 mb-3 border text-xs"
      style={{ background: config.bg, borderColor: config.border }}
    >
      <span className="font-semibold" style={{ color: config.color }}>{config.label}</span>
      <span className="text-gray-400 ml-2">{desc[flowData.reliabilityScore]}</span>
    </div>
  );
}

function ManipulationWarnings({ flowData }) {
  if (!flowData.singleWalletDominance && !flowData.washTradingFlag) return null;

  return (
    <div className="space-y-2 mb-3">
      {flowData.dominanceWarning && (
        <div className="rounded px-3 py-2 border text-xs" style={{ background: 'rgba(239,68,68,0.06)', borderColor: 'rgba(239,68,68,0.3)' }}>
          <span className="font-semibold" style={{ color: RED }}>Single Wallet Dominance: </span>
          <span className="text-gray-300">{flowData.dominanceWarning}</span>
        </div>
      )}
      {flowData.washWarning && (
        <div className="rounded px-3 py-2 border text-xs" style={{ background: 'rgba(245,158,11,0.06)', borderColor: 'rgba(245,158,11,0.3)' }}>
          <span className="font-semibold" style={{ color: AMBER }}>Rapid Buy/Sell Activity: </span>
          <span className="text-gray-300">{flowData.washWarning}</span>
        </div>
      )}
    </div>
  );
}

function FlowSummary({ flowData }) {
  const { walletCountYes, walletCountNo, totalUniqueWallets, totalVolume24h, yesBuyVolume, noBuyVolume,
    largeTradeCount24h, whaleTradeCount24h, largeWalletCountYes, largeWalletCountNo,
    accelerationLabel, acceleration, singleWalletDominance } = flowData;

  const yesPct = totalVolume24h > 0 ? (yesBuyVolume / totalVolume24h) * 100 : 50;

  const accelColor = accelerationLabel === 'Surging' ? CYAN
    : accelerationLabel === 'Above Average' ? '#60a5fa'
    : accelerationLabel === 'Quiet' ? AMBER : '#9ca3af';

  return (
    <div className="grid grid-cols-4 gap-3 mb-4">
      {/* Wallet Consensus */}
      <div className="rounded border border-[#1f2937] p-2.5">
        <div className="text-[10px] text-gray-500 uppercase mb-1.5">Wallet Consensus</div>
        <div className="text-sm font-semibold">
          <span style={{ color: CYAN }}>{walletCountYes}</span>
          <span className="text-gray-600 mx-1">:</span>
          <span style={{ color: PINK }}>{walletCountNo}</span>
          <span className="text-gray-500 text-xs ml-1">
            {walletCountYes > walletCountNo ? 'Yes' : walletCountNo > walletCountYes ? 'No' : ''}
          </span>
        </div>
        <div className="text-[10px] text-gray-500 mt-1">{totalUniqueWallets} unique wallets in 24h</div>
      </div>

      {/* Volume Flow */}
      <div className="rounded border border-[#1f2937] p-2.5">
        <div className="text-[10px] text-gray-500 uppercase mb-1.5">Volume Flow</div>
        <div className="flex h-3 rounded overflow-hidden mb-1.5">
          <div style={{ width: `${yesPct}%`, background: CYAN, opacity: 0.7 }} />
          <div style={{ width: `${100 - yesPct}%`, background: PINK, opacity: 0.7 }} />
        </div>
        <div className="flex justify-between text-[10px]">
          <span style={{ color: CYAN }}>{yesPct.toFixed(0)}% Yes</span>
          <span style={{ color: PINK }}>{(100 - yesPct).toFixed(0)}% No</span>
        </div>
        <div className="text-[10px] text-gray-500 mt-1">{formatUsdcSize(totalVolume24h)} total</div>
        {singleWalletDominance && (
          <div className="text-[10px] mt-0.5" style={{ color: RED }}>Dominated by 1 wallet</div>
        )}
      </div>

      {/* Large Trader Activity */}
      <div className="rounded border border-[#1f2937] p-2.5">
        <div className="text-[10px] text-gray-500 uppercase mb-1.5">Large Traders</div>
        <div className="text-sm text-gray-200">
          {largeTradeCount24h} &gt;$1K{whaleTradeCount24h > 0 ? `, ${whaleTradeCount24h} >$5K` : ''}
        </div>
        <div className="text-[10px] text-gray-500 mt-1">
          {largeWalletCountYes} wallets Yes, {largeWalletCountNo} wallets No
        </div>
      </div>

      {/* Volume Trend */}
      <div className="rounded border border-[#1f2937] p-2.5">
        <div className="text-[10px] text-gray-500 uppercase mb-1.5">Volume Trend</div>
        <div className="text-sm font-semibold" style={{ color: accelColor }}>{accelerationLabel}</div>
        <div className="text-[10px] text-gray-500 mt-1">{acceleration.toFixed(1)}x average rate</div>
      </div>
    </div>
  );
}

function DivergenceSection({ flowData }) {
  if (flowData.reliabilityScore === 'LOW' || flowData.reliabilityScore === 'VERY_LOW') return null;

  if (!flowData.isDiverging) {
    return (
      <div className="text-[11px] text-gray-600 mb-3">
        No significant divergence between large and small traders
      </div>
    );
  }

  return (
    <div className="rounded px-3 py-2 mb-3 border text-xs" style={{ background: 'rgba(245,158,11,0.06)', borderColor: 'rgba(245,158,11,0.2)' }}>
      <div className="font-semibold mb-1" style={{ color: AMBER }}>Large/Small Trader Divergence</div>
      <div className="text-gray-300 mb-2">{flowData.divergenceLabel}</div>
      <div className="text-gray-500 text-[11px] leading-relaxed">
        This pattern can indicate informed trading, but can also reflect market makers rebalancing (not directional),
        a single large trader skewing the data, or large traders being wrong. Weigh against structural analysis before acting.
      </div>
    </div>
  );
}

function LeaderboardSection({ flowData, category }) {
  if (flowData.leaderboardTradeCount === 0) {
    return (
      <div className="mb-3">
        <div className="text-[10px] text-gray-500 uppercase mb-1.5">Leaderboard Trader Activity</div>
        <div className="text-xs text-gray-600">No top-100 leaderboard traders have traded this market in the last 24 hours.</div>
      </div>
    );
  }

  // Build unique leaderboard trader cards from recent large trades
  const lbTraders = [];
  const seen = new Set();
  flowData.recentLargeTrades
    .filter((t) => t.isLeaderboardTrader)
    .forEach((t) => {
      if (seen.has(t.walletLower)) return;
      seen.add(t.walletLower);
      lbTraders.push(t);
    });

  const expertCount = flowData.relevantExperts.length;
  const noTrackCount = lbTraders.filter((t) =>
    !t.walletRelevance || t.walletRelevance.relevanceLevel === 'NO_TRACK_RECORD'
  ).length;

  return (
    <div className="mb-4">
      <div className="text-[10px] text-gray-500 uppercase mb-2">Leaderboard Trader Activity</div>

      {/* Trader cards */}
      <div className="space-y-2 mb-3">
        {lbTraders.slice(0, 5).map((t, i) => {
          const relevance = t.walletRelevance;
          const relColor = RELEVANCE_COLORS[relevance?.relevanceLevel] || '#9ca3af';
          return (
            <div key={i} className="rounded border border-[#1f2937] px-3 py-2 text-xs">
              <div className="flex items-center gap-2 mb-1">
                <span style={{ color: PURPLE }} className="font-semibold">Rank #{t.leaderboardRank}</span>
                <span className="text-gray-300">{t.traderName || truncateWallet(t.walletLower)}</span>
              </div>
              <div className="text-gray-400 mb-1">
                {t.buyingYes ? 'Bought Yes' : 'Bought No'},{' '}
                {formatUsdcSize(t.usdcSize)} at {(t.price * 100).toFixed(1)}c,{' '}
                {formatTimeAgo(t.ts)}
              </div>
              {relevance && (
                <div style={{ color: relColor }} className="text-[11px]">
                  {category} track record: {relevance.displayText?.replace(/^Ranked #\d+ overall, /, '') || 'Unknown'}
                </div>
              )}
              {!relevance && (
                <div className="text-[11px] text-gray-500">{category} track record: Category history unavailable</div>
              )}
            </div>
          );
        })}
      </div>

      {/* Summary */}
      <div className="text-xs text-gray-500">
        {lbTraders.length} leaderboard trader{lbTraders.length !== 1 ? 's' : ''} active.
        {expertCount > 0 ? ` ${expertCount} with relevant ${category} expertise.` : ''}
        {noTrackCount > 0 ? ` ${noTrackCount} with no ${category} track record.` : ''}
      </div>

      {/* Expert note */}
      {expertCount > 0 && (
        <div className="text-[11px] mt-2 leading-relaxed" style={{ color: `${CYAN}cc` }}>
          Trader(s) with demonstrated {category} expertise are active in this market. Their track record suggests category-specific skill, though past performance does not guarantee future accuracy.
        </div>
      )}

      {/* No track record note */}
      {expertCount === 0 && lbTraders.length > 0 && (
        <div className="text-[11px] mt-2 leading-relaxed" style={{ color: `${AMBER}cc` }}>
          Leaderboard traders are active but none have demonstrated expertise in {category}. Their overall ranking is based on performance in other categories — treat their activity as general attention, not informed signal.
        </div>
      )}
    </div>
  );
}

function HolderSection({ flowData }) {
  const hc = flowData.holderConcentration;
  if (!hc) return null;

  const hasSomeData = (hc.yes && hc.yes.holders.length > 0) || (hc.no && hc.no.holders.length > 0);
  if (!hasSomeData) return null;

  return (
    <div className="mb-4">
      <div className="text-[10px] text-gray-500 uppercase mb-2">Position Concentration Risk</div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <HolderTable side="Yes" color={CYAN} data={hc.yes} />
        <HolderTable side="No" color={PINK} data={hc.no} />
      </div>

      {/* Concentration metrics */}
      <div className="text-xs space-y-1 text-gray-400">
        {hc.yes && (
          <div>
            Yes side: Top 5 control{' '}
            <ConcentrationText pct={hc.yes.top5Control} />
          </div>
        )}
        {hc.no && (
          <div>
            No side: Top 5 control{' '}
            <ConcentrationText pct={hc.no.top5Control} />
          </div>
        )}
      </div>
    </div>
  );
}

function HolderTable({ side, color, data }) {
  if (!data || data.holders.length === 0) {
    return (
      <div>
        <div className="text-xs font-semibold mb-1" style={{ color }}>{side} Holders</div>
        <div className="text-[11px] text-gray-600">No holder data</div>
      </div>
    );
  }

  return (
    <div>
      <div className="text-xs font-semibold mb-1.5" style={{ color }}>{side} Holders</div>
      <div className="space-y-0.5">
        <div className="grid grid-cols-[24px_1fr_60px_50px] gap-1 text-[10px] text-gray-500 font-semibold pb-0.5 border-b border-gray-800">
          <div>#</div>
          <div>Holder</div>
          <div className="text-right">Shares</div>
          <div className="text-right">Rank</div>
        </div>
        {data.holders.slice(0, 5).map((h, i) => (
          <div key={i} className="grid grid-cols-[24px_1fr_60px_50px] gap-1 text-[10px] text-gray-400 py-0.5">
            <div>{i + 1}</div>
            <div className="truncate">{h.displayName}</div>
            <div className="text-right">{formatShares(h.amount)}</div>
            <div className="text-right">
              {h.isLeaderboardTrader ? (
                <span style={{ color: PURPLE }}>#{h.leaderboardData?.rank} &#9670;</span>
              ) : (
                <span className="text-gray-600">--</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConcentrationText({ pct }) {
  const pctVal = pct * 100;
  let color = CYAN;
  let label = 'Well distributed';
  if (pctVal > 70) { color = RED; label = 'High concentration — price vulnerable to single-holder exit'; }
  else if (pctVal > 40) { color = AMBER; label = 'Moderate concentration'; }

  return (
    <span style={{ color }}>
      {pctVal.toFixed(0)}% — {label}
    </span>
  );
}

function LargeTradesSection({ flowData, category }) {
  const trades = flowData.recentLargeTrades;
  if (!trades || trades.length === 0) {
    return (
      <div className="mb-4">
        <div className="text-[10px] text-gray-500 uppercase mb-1.5">Recent Large Trades (24h)</div>
        <div className="text-xs text-gray-600">No trades over $1,000 in the last 24 hours</div>
      </div>
    );
  }

  return (
    <div className="mb-4">
      <div className="text-[10px] text-gray-500 uppercase mb-2">Recent Large Trades (24h)</div>
      <div className="space-y-0.5">
        <div className="grid grid-cols-[55px_1fr_65px_60px_50px_50px] gap-1 text-[10px] text-gray-500 font-semibold pb-1 border-b border-gray-800">
          <div>Time</div>
          <div>Trader</div>
          <div>Side</div>
          <div className="text-right">Size</div>
          <div className="text-right">Price</div>
          <div className="text-right">Rank</div>
        </div>
        {trades.slice(0, 15).map((t, i) => (
          <div key={i} className="grid grid-cols-[55px_1fr_65px_60px_50px_50px] gap-1 text-[10px] text-gray-400 py-0.5">
            <div>{formatTimeAgo(t.ts)}</div>
            <div className="truncate">{t.traderName || truncateWallet(t.walletLower)}</div>
            <div style={{ color: t.buyingYes ? CYAN : PINK }}>
              {t.buyingYes ? 'Buy Yes' : 'Buy No'}
            </div>
            <div className="text-right text-gray-200">{formatUsdcSize(t.usdcSize)}</div>
            <div className="text-right">{(t.price * 100).toFixed(1)}c</div>
            <div className="text-right">
              {t.isLeaderboardTrader ? (
                <span style={{ color: PURPLE }}>#{t.leaderboardRank} &#9670;</span>
              ) : (
                <span className="text-gray-600">--</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ContextSummary({ flowData, market }) {
  // Determine structural direction from market analysis
  const flbSide = market.flb?.bestSide; // 'YES' or 'NO'
  const structuralDir = flbSide === 'YES' ? 'Yes' : flbSide === 'NO' ? 'No' : null;

  // Trade flow direction
  const flowDir = flowData.walletImbalance > 0.15 ? 'Yes' : flowData.walletImbalance < -0.15 ? 'No' : null;

  const agree = structuralDir && flowDir && structuralDir === flowDir;
  const disagree = structuralDir && flowDir && structuralDir !== flowDir;

  return (
    <div className="pt-3 border-t border-[#1f2937]">
      <div className="text-[10px] text-gray-500 uppercase mb-2">Context Summary</div>
      <div className="text-xs space-y-1 text-gray-400">
        <div>
          Trade flow (wallet activity):{' '}
          <span className="text-gray-200">{flowData.walletCountYes} wallets buying Yes, {flowData.walletCountNo} buying No</span>
        </div>
        {flowData.leaderboardTradeCount > 0 && (
          <div>
            Leaderboard traders:{' '}
            <span className="text-gray-200">{flowData.leaderboardDirection}</span>
          </div>
        )}
      </div>

      {agree && (
        <div className="text-[11px] text-gray-500 mt-2 leading-relaxed">
          Structural analysis and trade flow point in the same direction. This may reflect the same underlying signal, not two independent confirmations.
        </div>
      )}
      {disagree && (
        <div className="text-[11px] mt-2 leading-relaxed" style={{ color: `${AMBER}cc` }}>
          Structural analysis and trade flow disagree. Leaderboard traders may have information not captured by structural models, or structural models may be capturing something traders have not priced in. Neither is automatically correct.
        </div>
      )}

      <div className="text-[11px] text-gray-600 mt-2 leading-relaxed italic">
        Note: Trade flow often reflects the same information captured by structural analysis — traders read prices too. Wallet activity is additional context, not independent confirmation. Use alongside — not as a substitute for — your own analysis.
      </div>
    </div>
  );
}

// ─── Table Cell (for ResultsTable FLOW column) ──────────────────────

export function FlowCell({ flowData }) {
  if (!flowData || !flowData.dataAvailable) {
    return <span className="text-gray-600 text-xs">--</span>;
  }

  if (flowData.reliabilityScore === 'VERY_LOW') {
    return <span className="text-gray-600 text-xs">--</span>;
  }

  const { walletCountYes, walletCountNo, isDiverging, leaderboardTradeCount, singleWalletDominance, walletImbalance } = flowData;

  // Determine color for wallet count
  let countColor = '#6b7280';
  let dirLabel = '';
  if (walletImbalance > 0.15) { countColor = CYAN; dirLabel = 'Yes'; }
  else if (walletImbalance < -0.15) { countColor = PINK; dirLabel = 'No'; }

  // Build tooltip
  const tooltipLines = [
    `Wallets: ${walletCountYes} buying Yes, ${walletCountNo} buying No`,
    `Volume: ${formatUsdcSize(flowData.totalVolume24h)} total (Yes ${formatUsdcSize(flowData.yesBuyVolume)} / No ${formatUsdcSize(flowData.noBuyVolume)})`,
    `Large traders (>$1K): ${flowData.largeWalletCountYes} wallets Yes, ${flowData.largeWalletCountNo} wallets No`,
    `Leaderboard traders: ${leaderboardTradeCount} active`,
  ];
  if (flowData.dominanceWarning) tooltipLines.push(flowData.dominanceWarning);
  if (flowData.divergenceLabel) tooltipLines.push(flowData.divergenceLabel);
  tooltipLines.push(`Data reliability: ${flowData.reliabilityScore}`);

  return (
    <span className="text-xs font-semibold whitespace-nowrap" style={{ color: countColor }} title={tooltipLines.join('\n')}>
      {walletCountYes}:{walletCountNo}
      {dirLabel && <span className="ml-0.5">{dirLabel}</span>}
      {isDiverging && <span style={{ color: AMBER }} className="ml-0.5">!</span>}
      {leaderboardTradeCount > 0 && <span style={{ color: PURPLE }} className="ml-0.5">&#9670;</span>}
      {singleWalletDominance && <span style={{ color: RED }} className="ml-0.5">&#9888;</span>}
    </span>
  );
}

// ─── Utility ────────────────────────────────────────────────────────

function formatShares(v) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
}
