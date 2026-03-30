import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import { fetchPriceHistory, fetchOrderBook } from '../api';
import { useFetchWithCache } from '../hooks/useFetchWithCache';
import PriceChart from './PriceChart';
import DepthChart from './DepthChart';
import OrderBookTable from './OrderBookTable';
import FLBCard from './FLBCard';
import ThetaCard from './ThetaCard';
import ResolutionCard from './ResolutionCard';
import VolumeEfficiencyCard from './VolumeEfficiencyCard';
import BaseRateCard from './BaseRateCard';
import SpreadFrictionCard from './SpreadFrictionCard';
import ConjunctionCard from './ConjunctionCard';
import PortfolioImpact from './PortfolioImpact';
import TradeFlowPanel from './TradeFlowPanel';
import { formatVolume } from '../formatters';
import { computeRoundTripCostPP } from '../feeCalculator';

// Code-split heavy components
const KellyCalculator = lazy(() => import('./KellyCalculator'));
const LazyFallback = <div className="text-gray-500 text-xs p-2">Loading...</div>;

const CYAN = '#00d4aa';
const PINK = '#ff4d6a';

const TIMEFRAMES = [
  { label: '1D', interval: '1d', fidelity: 60 },
  { label: '7D', interval: '1w', fidelity: 1440 },
  { label: '30D', interval: '1m', fidelity: 1440 },
  { label: '90D', useTs: true, days: 90, fidelity: 4320 },
  { label: '1Y', useTs: true, days: 365, fidelity: 4320 },
  { label: 'Max', interval: 'max', fidelity: 4320 },
];

// Cache helpers moved to useFetchWithCache hook

function formatTimeRemaining(days) {
  if (days == null) return 'N/A';
  if (days <= 0) return 'Expired';
  const d = Math.floor(days);
  const h = Math.floor((days - d) * 24);
  return `${d}d ${h}h`;
}

function EdgeBadge({ score }) {
  let cls = 'bg-red-900/60 text-red-300';
  if (score >= 70) cls = 'bg-emerald-900/60 text-emerald-300';
  else if (score >= 40) cls = 'bg-yellow-900/60 text-yellow-300';
  return <span className={`px-2 py-0.5 rounded text-xs font-bold ${cls}`}>{score}</span>;
}

function Skeleton({ className }) {
  return <div className={`animate-pulse bg-gray-800 rounded ${className}`} />;
}

export default function MarketDetailPanel({ market, onBookData, onFlowData, onLivePriceUpdate, portfolio }) {
  const [side, setSide] = useState('yes'); // 'yes' or 'no'
  const [timeframe, setTimeframe] = useState(TIMEFRAMES[2]); // default 30D

  const yesTokenId = market.clobTokenIds?.[0];
  const noTokenId = market.clobTokenIds?.[1];
  const tokenId = side === 'yes' ? yesTokenId : noTokenId;

  const polymarketUrl = market.slug
    ? `https://polymarket.com/event/${market.slug}`
    : 'https://polymarket.com';

  // Fetch price history via shared hook
  const priceFetcher = useCallback(async () => {
    if (!tokenId) return null;
    if (timeframe.useTs) {
      const now = Math.floor(Date.now() / 1000);
      const start = now - timeframe.days * 86400;
      return fetchPriceHistory(tokenId, null, timeframe.fidelity, start, now);
    }
    return fetchPriceHistory(tokenId, timeframe.interval, timeframe.fidelity);
  }, [tokenId, timeframe]);

  const {
    data: priceData, loading: priceLoading, error: priceError, refetch: loadPriceHistory,
  } = useFetchWithCache({
    cacheKey: tokenId ? `price-${tokenId}-${timeframe.label}` : null,
    cacheTtl: 60000,
    fetcher: priceFetcher,
  });

  // Fetch order book via shared hook
  const bookOnSuccess = useCallback((data) => {
    if (data && onBookData) onBookData(market.id, data);
  }, [market.id, onBookData]);

  const bookFetcher = useCallback(async () => {
    if (!tokenId) return null;
    return fetchOrderBook(tokenId);
  }, [tokenId]);

  const {
    data: bookData, loading: bookLoading, error: bookError, refetch: loadOrderBook,
  } = useFetchWithCache({
    cacheKey: tokenId ? `book-${tokenId}` : null,
    cacheTtl: 30000,
    fetcher: bookFetcher,
    onSuccess: bookOnSuccess,
  });

  useEffect(() => {
    loadPriceHistory();
    loadOrderBook();
  }, [loadPriceHistory, loadOrderBook]);

  // Push live prices from CLOB price history up to parent (updates table row)
  useEffect(() => {
    if (!onLivePriceUpdate || !priceData?.history?.length) return;
    const lastPrice = priceData.history[priceData.history.length - 1].p;
    if (lastPrice == null) return;
    const yesPrice = side === 'yes' ? lastPrice : 1 - lastPrice;
    const noPrice = 1 - yesPrice;
    onLivePriceUpdate(market.id, yesPrice, noPrice);
  }, [priceData, side, market.id, onLivePriceUpdate]);

  const refreshBook = loadOrderBook;

  // Price delta
  const history = priceData?.history || [];
  const currentPrice = history.length > 0 ? history[history.length - 1].p * 100 : null;
  const firstPrice = history.length > 0 ? history[0].p * 100 : null;
  const delta = currentPrice != null && firstPrice != null ? currentPrice - firstPrice : null;

  // Live prices from CLOB price history — overrides stale Gamma outcomePrices.
  // NOTE: Order book midpoint is NOT a reliable price source on Polymarket — books
  // can have huge spreads (e.g. bid 0.1¢, ask 99.9¢ → midpoint 50¢) on illiquid markets.
  // Price history's last data point is the most recent trade/quote and is authoritative.
  const liveCurrentSide = currentPrice != null ? currentPrice / 100 : null;
  const liveYesPrice = liveCurrentSide != null
    ? (side === 'yes' ? liveCurrentSide : 1 - liveCurrentSide)
    : null;
  const liveNoPrice = liveYesPrice != null ? 1 - liveYesPrice : null;

  // Display prices: prefer live CLOB prices over stale Gamma prices
  const displayYesPrice = liveYesPrice ?? market.yesPrice;
  const displayNoPrice = liveNoPrice ?? market.noPrice;

  const sideColor = side === 'yes' ? CYAN : PINK;

  return (
    <div className="border-t border-[#1f2937]" style={{ background: '#0a0e17' }}>
      {/* Top Bar */}
      <div className="px-5 py-4 border-b border-[#1f2937]">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-2">
              <h2 className="text-lg font-bold text-white truncate">{market.question}</h2>
              <span className={`shrink-0 px-2 py-0.5 rounded-full text-xs font-semibold ${
                market.active && !market.closed
                  ? 'bg-emerald-900/50 text-emerald-400 border border-emerald-700/50'
                  : 'bg-gray-800 text-gray-400 border border-gray-700'
              }`}>
                {market.active && !market.closed ? 'Active' : 'Closed'}
              </span>
            </div>
            <div className="flex items-center gap-4 text-xs text-[#9ca3af] flex-wrap">
              <span>Closes: <span className="text-gray-300">{market.endDate}</span></span>
              <span>Yes: <span style={{ color: CYAN }}>{displayYesPrice != null ? `${(displayYesPrice * 100).toFixed(1)}¢` : '—'}</span></span>
              <span>No: <span style={{ color: PINK }}>{displayNoPrice != null ? `${(displayNoPrice * 100).toFixed(1)}¢` : '—'}</span></span>
              <span>Volume: <span className="text-gray-300">{formatVolume(market.volume)}</span></span>
              <span>Time left: <span className="text-gray-300">{formatTimeRemaining(market.daysLeft)}</span></span>
            </div>
          </div>
          <a href={polymarketUrl} target="_blank" rel="noopener noreferrer"
            className="shrink-0 text-xs hover:text-white transition-colors" style={{ color: CYAN }}>
            View on Polymarket →
          </a>
        </div>
      </div>

      {/* Two Column Layout */}
      <div className="flex flex-col md:flex-row">
        {/* LEFT COLUMN */}
        <div className="flex-[3] min-w-0 p-5 space-y-5 border-r border-[#1f2937]">
          {/* Price Chart Section */}
          <div className="rounded-lg border border-[#1f2937]" style={{ background: '#111827' }}>
            <div className="px-4 pt-4 pb-2">
              {/* Yes/No Toggle + Timeframe */}
              <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                <div className="flex gap-1">
                  <button onClick={() => setSide('yes')}
                    className={`px-3 py-1 rounded text-xs font-semibold transition-colors ${
                      side === 'yes'
                        ? 'text-white border' : 'text-gray-500 border border-transparent hover:text-gray-300'
                    }`} style={side === 'yes' ? { borderColor: CYAN, background: 'rgba(0,212,170,0.1)', color: CYAN } : {}}>
                    Yes
                  </button>
                  <button onClick={() => setSide('no')}
                    className={`px-3 py-1 rounded text-xs font-semibold transition-colors ${
                      side === 'no'
                        ? 'text-white border' : 'text-gray-500 border border-transparent hover:text-gray-300'
                    }`} style={side === 'no' ? { borderColor: PINK, background: 'rgba(255,77,106,0.1)', color: PINK } : {}}>
                    No
                  </button>
                </div>
                <div className="flex gap-1">
                  {TIMEFRAMES.map((tf) => (
                    <button key={tf.label} onClick={() => setTimeframe(tf)}
                      className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                        timeframe.label === tf.label
                          ? 'bg-[#1f2937] text-white'
                          : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800/50'
                      }`}>
                      {tf.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Current Price + Delta */}
              <div className="flex items-baseline gap-3 mb-2">
                {currentPrice != null ? (
                  <>
                    <span className="text-2xl font-bold text-white">{currentPrice.toFixed(1)}¢</span>
                    {delta != null && (
                      <span className={`text-sm font-semibold ${delta >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {delta >= 0 ? '+' : ''}{delta.toFixed(1)}¢
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-2xl font-bold text-gray-600">—</span>
                )}
              </div>
            </div>

            {/* Chart */}
            <div className="px-2 pb-3" style={{ height: 280 }}>
              {priceLoading ? (
                <div className="flex items-center justify-center h-full">
                  <Skeleton className="w-full h-full" />
                </div>
              ) : priceError ? (
                <div className="flex items-center justify-center h-full">
                  <button onClick={loadPriceHistory} className="text-xs text-gray-500 hover:text-gray-300">
                    {priceError} — click to retry
                  </button>
                </div>
              ) : (
                <PriceChart data={history} color={sideColor} />
              )}
            </div>
          </div>

          {/* Depth Chart */}
          <div className="rounded-lg border border-[#1f2937]" style={{ background: '#111827' }}>
            <div className="flex items-center justify-between px-4 pt-3 pb-2">
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold text-gray-400 uppercase">Market Depth</span>
                <span className="flex items-center gap-1 text-xs text-gray-500">
                  <span className="w-2 h-2 rounded-full" style={{ background: CYAN }} /> Bids
                </span>
                <span className="flex items-center gap-1 text-xs text-gray-500">
                  <span className="w-2 h-2 rounded-full" style={{ background: PINK }} /> Asks
                </span>
              </div>
              <button onClick={refreshBook} title="Refresh"
                className="text-gray-500 hover:text-gray-300 text-sm transition-colors">↻</button>
            </div>
            <div className="px-2 pb-3" style={{ height: 200 }}>
              {bookLoading ? (
                <Skeleton className="w-full h-full" />
              ) : bookError ? (
                <div className="flex items-center justify-center h-full">
                  <button onClick={loadOrderBook} className="text-xs text-gray-500 hover:text-gray-300">
                    {bookError} — click to retry
                  </button>
                </div>
              ) : bookData ? (
                <DepthChart bids={bookData.bids || []} asks={bookData.asks || []} />
              ) : (
                <div className="flex items-center justify-center h-full text-xs text-gray-600">
                  No depth data available
                </div>
              )}
            </div>
          </div>

          {/* Trade Flow & Position Intelligence */}
          <TradeFlowPanel market={market} bookData={bookData} />

          {/* Order Book Table */}
          <div className="rounded-lg border border-[#1f2937]" style={{ background: '#111827' }}>
            <div className="flex items-center justify-between px-4 pt-3 pb-2">
              <span className="text-xs font-semibold text-gray-400 uppercase">Order Book</span>
            </div>
            {bookLoading ? (
              <div className="px-4 pb-4"><Skeleton className="w-full h-40" /></div>
            ) : bookError ? (
              <div className="px-4 pb-4 text-xs text-gray-500">Failed to load order book</div>
            ) : bookData ? (
              <OrderBookTable bids={bookData.bids || []} asks={bookData.asks || []} />
            ) : (
              <div className="px-4 pb-4 text-xs text-gray-600">No order book data</div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN */}
        <div className="flex-[2] min-w-0 p-5 space-y-4">
          {/* Share Price Card */}
          <div className="rounded-lg border border-[#1f2937] p-4" style={{ background: '#111827' }}>
            <div className="text-xs font-semibold text-gray-400 uppercase mb-3">Share Price</div>
            <div className="flex gap-6">
              <div>
                <div className="text-xs text-gray-500 mb-1">Yes</div>
                <div className="text-xl font-bold" style={{ color: CYAN }}>
                  {displayYesPrice != null ? `${(displayYesPrice * 100).toFixed(1)}¢` : '—'}
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">No</div>
                <div className="text-xl font-bold" style={{ color: PINK }}>
                  {displayNoPrice != null ? `${(displayNoPrice * 100).toFixed(1)}¢` : '—'}
                </div>
              </div>
            </div>
          </div>

          {/* Details Card */}
          <div className="rounded-lg border border-[#1f2937] p-4" style={{ background: '#111827' }}>
            <div className="text-xs font-semibold text-gray-400 uppercase mb-3">Details</div>
            <div className="space-y-2 text-sm">
              <Row label="Resolution" value={market.endDate} />
              <Row label="Spread" value={
                market.spread != null
                  ? `${(market.spread * 100).toFixed(2)}¢ (${displayYesPrice != null && displayNoPrice != null
                    ? `${((market.spread / ((displayYesPrice + displayNoPrice) / 2)) * 100).toFixed(1)}%`
                    : 'N/A'})`
                  : 'N/A'
              } />
              <Row label="Category" value={market.category || 'N/A'} />
              <Row label="Volume" value={formatVolume(market.volume)} />
              <Row label="24hr Volume" value={formatVolume(market.volume24hr)} />
              <Row label="Edge Score">
                <EdgeBadge score={market.edgeScore} />
              </Row>
              <Row label="Book Depth" value={
                bookData
                  ? `${bookData.bids?.length || 0} bids / ${bookData.asks?.length || 0} asks`
                  : bookLoading ? 'Loading...' : 'N/A'
              } />
            </div>
          </div>

          {/* FLB Analysis */}
          <FLBCard flb={market.flb} yesPrice={market.yesPrice} noPrice={market.noPrice} />

          {/* Theta Time Decay */}
          <ThetaCard theta={market.theta} market={market} priceHistory={priceData} />

          {/* Volume-Price Efficiency */}
          <VolumeEfficiencyCard market={market} bookData={bookData} />

          {/* Spread & Friction */}
          <SpreadFrictionCard market={market} bookData={bookData} />

          {/* Trading Costs */}
          <TradingCostsCard market={market} />

          {/* Base Rate Analysis */}
          <BaseRateCard baseRate={market.baseRate} flb={market.flb} />

          {/* Resolution Analysis */}
          <ResolutionCard resolution={market.resolutionAnalysis} yesPrice={market.yesPrice} />

          {/* Conjunction Analysis */}
          <ConjunctionCard conjunction={market.conjunction} market={market} />

          {/* Kelly Position Sizer */}
          <Suspense fallback={LazyFallback}>
            <KellyCalculator market={market} portfolio={portfolio} />
          </Suspense>

          {/* Portfolio Impact */}
          {portfolio?.hasPortfolio && (
            <PortfolioImpact screening={portfolio.screenTrade(market)} />
          )}

          {/* Description */}
          <div className="rounded-lg border border-[#1f2937] p-4" style={{ background: '#111827' }}>
            <div className="text-xs font-semibold text-gray-400 uppercase mb-2">Description & Resolution</div>
            <div className="text-sm text-gray-300 max-h-52 overflow-y-auto whitespace-pre-wrap leading-relaxed">
              {market.description || 'No description available.'}
            </div>
          </div>

          {/* CTA */}
          <a href={polymarketUrl} target="_blank" rel="noopener noreferrer"
            className="block w-full text-center py-2.5 rounded-lg text-sm font-semibold transition-colors border"
            style={{ borderColor: CYAN, color: CYAN, background: 'rgba(0,212,170,0.08)' }}
            onMouseEnter={(e) => { e.target.style.background = 'rgba(0,212,170,0.18)'; }}
            onMouseLeave={(e) => { e.target.style.background = 'rgba(0,212,170,0.08)'; }}>
            View on Polymarket →
          </a>
        </div>
      </div>
    </div>
  );
}

function TradingCostsCard({ market }) {
  if (market.feeFree) {
    return (
      <div className="rounded-lg border border-[#1f2937] p-4" style={{ background: '#111827' }}>
        <div className="text-xs font-semibold text-gray-400 uppercase mb-2">Trading Costs</div>
        <div className="text-sm text-emerald-400 font-semibold">Fee-Free Market &#x2713;</div>
        {market.spread != null && (
          <div className="mt-2 text-xs text-gray-500">
            Spread cost only: {(market.spread * 100).toFixed(2)}pp round-trip
          </div>
        )}
      </div>
    );
  }

  const rt = computeRoundTripCostPP(market.yesPrice, market.spread, market.gammaCategory, market.feesEnabled);
  const rawEdgePP = market.flb?.bestEdge != null ? market.flb.bestEdge * 100 : null;
  const netAfterCosts = rawEdgePP != null ? rawEdgePP - rt.totalCostPP : null;

  return (
    <div className="rounded-lg border border-[#1f2937] p-4" style={{ background: '#111827' }}>
      <div className="text-xs font-semibold text-gray-400 uppercase mb-2">Trading Costs</div>
      <div className="space-y-1 text-sm font-mono">
        <div className="flex justify-between">
          <span className="text-gray-500">Entry Fee</span>
          <span className="text-gray-300">{rt.entryFeePP.toFixed(2)}pp <span className="text-gray-600">({(market.effectiveTakerFee * 100).toFixed(2)}%)</span></span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Exit Fee</span>
          <span className="text-gray-300">{rt.exitFeePP.toFixed(2)}pp</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Spread Cost</span>
          <span className="text-gray-300">{rt.spreadCostPP.toFixed(2)}pp</span>
        </div>
        <div className="flex justify-between pt-1 border-t border-gray-700">
          <span className="text-gray-400 font-semibold">Total Cost</span>
          <span className="text-gray-200 font-semibold">{rt.totalCostPP.toFixed(2)}pp</span>
        </div>
        {rawEdgePP != null && (
          <>
            <div className="flex justify-between">
              <span className="text-gray-500">Edge</span>
              <span className="text-gray-300">{rawEdgePP.toFixed(2)}pp</span>
            </div>
            <div className="flex justify-between font-semibold">
              <span className="text-gray-400">Net After Costs</span>
              <span style={{ color: netAfterCosts > 0 ? '#00d4aa' : '#ef4444' }}>
                {netAfterCosts.toFixed(2)}pp
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, children }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[#9ca3af]">{label}</span>
      {children || <span className="text-gray-200">{value}</span>}
    </div>
  );
}
