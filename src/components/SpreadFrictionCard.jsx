import { useState, useMemo } from 'react';
import {
  normalizeOrderBook,
  calculateSpread,
  simulateFill,
  calculateDepthMetrics,
  calculateFrictionScore,
  calculateEdgeSurvival,
} from '../SpreadFrictionEngine';
import { formatCents, formatPct, formatDollars } from '../formatters';
import AnalysisCard from './AnalysisCard';

const ENTRY_SIZES = [25, 50, 100, 250, 500, 1000];
const CYAN = '#00d4aa';
const PINK = '#ff4d6a';
const AMBER = '#f59e0b';

function scoreColor(score) {
  if (score >= 80) return CYAN;
  if (score >= 60) return AMBER;
  if (score >= 35) return '#ef4444';
  return '#dc2626';
}

/**
 * Compact cell for the table column.
 */
export function SpreadCell({ market, cachedSpread }) {
  const realSpread = cachedSpread;
  const estimated = market.spread;

  if (realSpread != null) {
    const cents = realSpread * 100;
    let color = '#9ca3af';
    if (cents < 1) color = CYAN;
    else if (cents < 3) color = AMBER;
    else color = '#ef4444';
    return (
      <span className="text-xs font-semibold" style={{ color }} title={`Real spread: ${cents.toFixed(1)}¢`}>
        {cents.toFixed(1)}¢
      </span>
    );
  }

  if (estimated != null) {
    const cents = estimated * 100;
    let color = '#6b7280';
    if (cents < 1) color = '#4b5563';
    else if (cents < 3) color = '#6b7280';
    else color = '#9ca3af';
    return (
      <span className="text-xs" style={{ color }} title={`Estimated from overround: ${cents.toFixed(1)}¢`}>
        ~{cents.toFixed(1)}¢
      </span>
    );
  }

  return <span className="text-gray-600 text-xs">--</span>;
}

/**
 * Full friction analysis card for the expanded detail panel.
 */
export default function SpreadFrictionCard({ market, bookData }) {
  const [selectedSize, setSelectedSize] = useState(100);

  // Normalize once — all downstream functions accept pre-normalized data
  const normalizedBook = useMemo(() => normalizeOrderBook(bookData), [bookData]);

  const spreadData = useMemo(() => calculateSpread(normalizedBook), [normalizedBook]);
  const depthMetrics = useMemo(() => calculateDepthMetrics(normalizedBook), [normalizedBook]);
  const frictionScore = useMemo(
    () => spreadData ? calculateFrictionScore(spreadData, depthMetrics, market.yesPrice) : null,
    [spreadData, depthMetrics, market.yesPrice]
  );
  const edgeSurvival = useMemo(
    () => calculateEdgeSurvival(market, spreadData),
    [market, spreadData]
  );

  const yesFill = useMemo(
    () => simulateFill(normalizedBook, 'BUY_YES', selectedSize),
    [normalizedBook, selectedSize]
  );
  const noFill = useMemo(
    () => simulateFill(normalizedBook, 'BUY_NO', selectedSize),
    [normalizedBook, selectedSize]
  );

  if (!bookData) {
    return (
      <AnalysisCard title="Spread & Friction" emptyWhen emptyMessage="Expand market to load order book data" />
    );
  }

  if (!spreadData) {
    return (
      <AnalysisCard title="Spread & Friction" emptyWhen emptyMessage="No bid/ask data available" />
    );
  }

  return (
    <AnalysisCard
      title="Spread & Friction"
      headerExtra={frictionScore ? (
        <div className="flex items-center gap-2">
          <span
            className="px-2 py-0.5 rounded text-xs font-bold"
            style={{
              color: scoreColor(frictionScore.score),
              background: `${scoreColor(frictionScore.score)}15`,
              border: `1px solid ${scoreColor(frictionScore.score)}30`,
            }}
          >
            {frictionScore.score} {frictionScore.label}
          </span>
        </div>
      ) : undefined}
    >
      {/* Spread basics */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <div>
          <div className="text-[10px] text-gray-500 uppercase">Best Bid</div>
          <div className="text-sm font-semibold" style={{ color: CYAN }}>{formatCents(spreadData.bestBid)}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 uppercase">Best Ask</div>
          <div className="text-sm font-semibold" style={{ color: PINK }}>{formatCents(spreadData.bestAsk)}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 uppercase">Spread</div>
          <div className="text-sm font-semibold text-white">{formatCents(spreadData.absoluteSpread)}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 uppercase">Midpoint</div>
          <div className="text-sm font-semibold text-gray-300">{formatCents(spreadData.midpoint)}</div>
        </div>
      </div>

      {/* Depth metrics */}
      {depthMetrics && (
        <div className="grid grid-cols-3 gap-3 mb-4 pb-3 border-b border-[#1f2937]">
          <div>
            <div className="text-[10px] text-gray-500 uppercase">Bid Depth (5¢)</div>
            <div className="text-sm text-gray-300">{formatDollars(depthMetrics.bidDepthAt5c)}</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500 uppercase">Ask Depth (5¢)</div>
            <div className="text-sm text-gray-300">{formatDollars(depthMetrics.askDepthAt5c)}</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500 uppercase">Imbalance</div>
            <div className="text-sm text-gray-300">
              {depthMetrics.depthImbalance > 0.6
                ? 'Bid heavy'
                : depthMetrics.depthImbalance < 0.4
                  ? 'Ask heavy'
                  : 'Balanced'}
              <span className="text-gray-500 ml-1">
                ({(depthMetrics.depthImbalance * 100).toFixed(0)}%)
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Fill simulation */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] text-gray-500 uppercase">Fill Simulation</div>
          <div className="flex gap-1">
            {ENTRY_SIZES.map((size) => (
              <button
                key={size}
                onClick={() => setSelectedSize(size)}
                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                  selectedSize === size
                    ? 'bg-[#1f2937] text-white'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                ${size}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {/* Buy Yes */}
          <FillResult label="Buy Yes" fill={yesFill} color={CYAN} />
          {/* Buy No */}
          <FillResult label="Buy No" fill={noFill} color={PINK} />
        </div>
      </div>

      {/* Edge survival */}
      {edgeSurvival.edges.length > 0 && (
        <div className="pt-3 border-t border-[#1f2937]">
          <div className="text-[10px] text-gray-500 uppercase mb-2">Edge Survival (vs half-spread)</div>
          <div className="space-y-1.5">
            {edgeSurvival.edges.map((e) => (
              <div key={e.source} className="flex items-center justify-between text-xs">
                <span className="text-gray-400">{e.source} ({e.side})</span>
                <div className="flex items-center gap-2">
                  <span className="text-gray-500">{(e.rawEdge * 100).toFixed(2)}¢ raw</span>
                  <span className="text-gray-600">→</span>
                  <span
                    className="font-semibold"
                    style={{ color: e.survives ? CYAN : '#ef4444' }}
                  >
                    {e.survives ? `+${(e.netEdge * 100).toFixed(2)}¢` : `${(e.netEdge * 100).toFixed(2)}¢`}
                    {e.survives ? ' ✓' : ' ✗'}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 text-xs text-gray-500">
            {edgeSurvival.survivingEdges}/{edgeSurvival.edges.length} edges survive the spread
          </div>
        </div>
      )}
    </AnalysisCard>
  );
}

function FillResult({ label, fill, color }) {
  if (!fill) {
    return (
      <div className="rounded border border-[#1f2937] p-2">
        <div className="text-[10px] font-semibold mb-1" style={{ color }}>{label}</div>
        <div className="text-xs text-gray-600">No data</div>
      </div>
    );
  }

  return (
    <div className="rounded border border-[#1f2937] p-2">
      <div className="text-[10px] font-semibold mb-1.5" style={{ color }}>{label}</div>
      <div className="space-y-1 text-xs">
        <div className="flex justify-between">
          <span className="text-gray-500">Avg fill</span>
          <span className="text-gray-200">{formatCents(fill.averageFillPrice)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">vs midpoint</span>
          <span style={{ color: fill.spreadCost > 0.005 ? AMBER : CYAN }}>
            +{formatCents(fill.spreadCost)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Slippage</span>
          <span className={fill.slippage > 0.005 ? 'text-amber-400' : 'text-gray-400'}>
            {formatCents(fill.slippage)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Friction</span>
          <span className="font-semibold" style={{ color: fill.frictionPct > 0.03 ? '#ef4444' : fill.frictionPct > 0.01 ? AMBER : CYAN }}>
            {formatPct(fill.frictionPct)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Shares</span>
          <span className="text-gray-400">{fill.totalShares.toFixed(1)}</span>
        </div>
        {fill.bookExhausted && (
          <div className="text-[10px] text-red-400 mt-1">
            Book exhausted — ${fill.unfilled.toFixed(0)} unfilled
          </div>
        )}
      </div>
    </div>
  );
}
