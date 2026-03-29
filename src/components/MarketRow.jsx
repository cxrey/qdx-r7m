import { useState, useCallback, useRef, useEffect, memo, lazy, Suspense } from 'react';
const MarketDetailPanel = lazy(() => import('./MarketDetailPanel'));
import { RulesCell } from './ResolutionCard';
import { VolPriceCell } from './VolumeEfficiencyCard';
import { BaseRateCell } from './BaseRateCard';
import { SpreadCell } from './SpreadFrictionCard';
import { ConjunctionCell } from './ConjunctionCard';
import { FlowCell } from './TradeFlowPanel';
import { ROW_HEIGHT, CYAN, PINK, AMBER } from '../uiConfig';

// Pre-warm: download + parse chunk during idle time so first expand is instant
if (typeof window !== 'undefined') {
  const preWarm = () => import('./MarketDetailPanel');
  if ('requestIdleCallback' in window) {
    requestIdleCallback(preWarm, { timeout: 4000 });
  } else {
    setTimeout(preWarm, 2000);
  }
}

function EdgeBadge({ score }) {
  let color = 'bg-red-900 text-red-300';
  if (score >= 70) color = 'bg-emerald-900 text-emerald-300';
  else if (score >= 40) color = 'bg-yellow-900 text-yellow-300';

  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${color}`}>
      {score}
    </span>
  );
}

function formatVolume(v) {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function formatPrice(p) {
  if (p == null) return '\u2014';
  return `${(p * 100).toFixed(1)}\u00A2`;
}

function FLBEdgeCell({ flb }) {
  if (!flb || flb.bestEdge == null) return <span className="text-gray-600 text-xs">--</span>;
  const edgePp = flb.bestEdgeAfterSpread * 100;
  const rawPp = flb.bestEdge * 100;
  let colorClass = 'text-gray-500';
  if (edgePp > 3) colorClass = 'text-emerald-400';
  else if (edgePp > 1.5) colorClass = 'text-yellow-400';

  if (flb.spreadKillsEdge) {
    return (
      <span className="text-gray-500 text-xs line-through" title="Spread eats edge">
        {rawPp.toFixed(1)}pp
      </span>
    );
  }

  return (
    <span className={`text-xs font-semibold ${colorClass}`}>
      {edgePp.toFixed(1)}pp
    </span>
  );
}

function ThetaCell({ theta }) {
  if (!theta || theta.bestTheta == null) return <span className="text-gray-600 text-xs">--</span>;
  const cents = Math.abs(theta.bestTheta) * 100;
  const sign = theta.bestTheta >= 0 ? '+' : '-';
  let color = '#4b5563';
  if (cents > 0.5) color = CYAN;
  else if (cents > 0.2) color = AMBER;
  else if (cents > 0.05) color = '#9ca3af';

  return (
    <span
      className="text-xs font-semibold"
      style={{ color }}
      title={`Time decay moves this market ~${cents.toFixed(2)} cents/day toward ${theta.bestSide === 'YES' ? 'Yes' : 'No'}`}
    >
      {sign}{cents.toFixed(1)}&cent;/d
    </span>
  );
}

function FLBSideCell({ flb }) {
  if (!flb || flb.recommendation === 'NO_EDGE' || flb.recommendation === 'SPREAD_EATS_EDGE') {
    return <span className="text-gray-600 text-xs">--</span>;
  }
  if (flb.bestSide === 'YES') {
    return <span className="text-xs font-semibold" style={{ color: CYAN }}>Buy Yes</span>;
  }
  if (flb.bestSide === 'NO') {
    return <span className="text-xs font-semibold" style={{ color: PINK }}>Buy No</span>;
  }
  return <span className="text-gray-600 text-xs">--</span>;
}

// ── Add to Portfolio Popover ──
function AddToPortfolioPopover({ market, onAdd, onClose, anchorRef }) {
  const [side, setSide] = useState('YES');
  const [shares, setShares] = useState('10');
  const [entryPrice, setEntryPrice] = useState(
    market.yesPrice != null ? (market.yesPrice * 100).toFixed(1) : ''
  );

  const handleSubmit = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onAdd({
      marketId: market.id,
      conditionId: market.conditionId,
      tokenId: side === 'YES' ? market.clobTokenIds?.[0] : market.clobTokenIds?.[1],
      side,
      size: parseFloat(shares) || 0,
      entryPrice: entryPrice ? parseFloat(entryPrice) / 100 : null,
      currentPrice: side === 'YES' ? market.yesPrice : market.noPrice,
      market,
    });
    onClose();
  };

  const rect = anchorRef?.current?.getBoundingClientRect();
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const fixedStyle = rect
    ? { position: 'fixed', top: rect.bottom + 4, left: Math.min(Math.max(8, rect.right - 220), vw - 228), zIndex: 9999 }
    : { position: 'fixed', top: 100, right: 20, zIndex: 9999 };

  return (
    <div
      className="rounded-lg border border-gray-700 p-3 shadow-xl"
      style={{ ...fixedStyle, background: '#1a1f2e', width: 220 }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="text-xs text-gray-400 mb-2 font-semibold">Add to Portfolio</div>
      <form onSubmit={handleSubmit} className="space-y-2">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => {
              setSide('YES');
              setEntryPrice(market.yesPrice != null ? (market.yesPrice * 100).toFixed(1) : '');
            }}
            className={`flex-1 px-2 py-1 rounded text-xs font-semibold transition-colors ${
              side === 'YES' ? 'border text-white' : 'text-gray-500 border border-transparent'
            }`}
            style={side === 'YES' ? { borderColor: CYAN, background: 'rgba(0,212,170,0.1)', color: CYAN } : {}}
          >
            Yes
          </button>
          <button
            type="button"
            onClick={() => {
              setSide('NO');
              setEntryPrice(market.noPrice != null ? (market.noPrice * 100).toFixed(1) : '');
            }}
            className={`flex-1 px-2 py-1 rounded text-xs font-semibold transition-colors ${
              side === 'NO' ? 'border text-white' : 'text-gray-500 border border-transparent'
            }`}
            style={side === 'NO' ? { borderColor: PINK, background: 'rgba(255,77,106,0.1)', color: PINK } : {}}
          >
            No
          </button>
        </div>
        <div>
          <label className="text-[10px] text-gray-500">Shares</label>
          <input
            type="number"
            min="0"
            step="1"
            value={shares}
            onChange={(e) => setShares(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 focus:outline-none focus:border-emerald-500"
          />
        </div>
        <div>
          <label className="text-[10px] text-gray-500">Entry Price (cents)</label>
          <input
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={entryPrice}
            onChange={(e) => setEntryPrice(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 focus:outline-none focus:border-emerald-500"
          />
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            className="flex-1 px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-xs font-medium text-white transition-colors"
          >
            Add
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-xs text-gray-300 transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Portfolio indicator dot ──
function PortfolioDot({ marketId, hasPortfolio, isMarketHeld, getHeldPosition }) {
  if (!hasPortfolio) return null;

  const isHeld = isMarketHeld(marketId);
  if (!isHeld) return null;

  const held = getHeldPosition(marketId);
  return (
    <span
      className="inline-block w-2 h-2 rounded-full shrink-0"
      style={{ background: CYAN }}
      title={`Held: ${held?.side || '?'} ${held?.size?.toFixed(1) || ''} shares`}
    />
  );
}

// ── MarketRow with React.memo ──
const MarketRow = memo(function MarketRow({ market, expanded, onToggle, detailWidth, highlighted, cachedSpread, onBookData, cachedFlow, onFlowData, hasPortfolio, isMarketHeld, getHeldPosition, addManualPosition, portfolio, filters, gridColumns, priceFlash }) {
  const [showAddPopover, setShowAddPopover] = useState(false);
  const addBtnRef = useRef(null);

  // Price flash animation via direct DOM manipulation
  const yesPriceCellRef = useRef(null);
  const noPriceCellRef = useRef(null);
  const flashTimerRef = useRef(null);

  useEffect(() => {
    if (!priceFlash) return;

    const yesCell = yesPriceCellRef.current;
    const noCell = noPriceCellRef.current;
    if (!yesCell || !noCell) return;

    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    yesCell.classList.remove('price-flash-up', 'price-flash-down');
    noCell.classList.remove('price-flash-up', 'price-flash-down');

    const upClass = 'price-flash-up';
    const downClass = 'price-flash-down';

    if (priceFlash === 'up') {
      void yesCell.offsetWidth; // force reflow
      yesCell.classList.add(upClass);
      noCell.classList.add(downClass);
    } else {
      void yesCell.offsetWidth;
      yesCell.classList.add(downClass);
      noCell.classList.add(upClass);
    }

    flashTimerRef.current = setTimeout(() => {
      yesCell.classList.remove('price-flash-up', 'price-flash-down');
      noCell.classList.remove('price-flash-up', 'price-flash-down');
      flashTimerRef.current = null;
    }, 1000);

    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, [priceFlash]);

  const polymarketUrl = market.slug
    ? `https://polymarket.com/event/${encodeURIComponent(market.slug)}`
    : `https://polymarket.com`;

  const isHeld = hasPortfolio && isMarketHeld(market.id);
  const showHighlightHeld = filters?.highlightHeld !== false && isHeld;

  const rowStyle = {};
  if (highlighted) {
    rowStyle.borderLeft = `3px solid ${CYAN}`;
  } else if (showHighlightHeld) {
    rowStyle.borderLeft = '3px solid rgba(0, 212, 170, 0.4)';
  }

  const handleAddToPortfolio = useCallback((pos) => {
    if (addManualPosition) {
      addManualPosition(pos);
    }
  }, [addManualPosition]);

  return (
    <div className="border-b border-gray-800 market-row" style={rowStyle}>
      <div
        className={`grid gap-2 px-3 cursor-pointer items-center text-sm transition-colors ${
          expanded ? 'bg-gray-800/70' : 'hover:bg-gray-800/50'
        }`}
        style={{ gridTemplateColumns: gridColumns, height: ROW_HEIGHT, overflow: 'hidden' }}
        onClick={onToggle}
      >
        <div className="truncate pr-2 flex items-center gap-1.5 whitespace-nowrap overflow-hidden">
          <PortfolioDot marketId={market.id} hasPortfolio={hasPortfolio} isMarketHeld={isMarketHeld} getHeldPosition={getHeldPosition} />
          <a
            href={polymarketUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-100 hover:text-[#00d4aa] transition-colors truncate"
            onClick={(e) => e.stopPropagation()}
          >
            {market.question}
          </a>
          <div className="shrink-0">
            <button
              ref={addBtnRef}
              onClick={(e) => { e.stopPropagation(); setShowAddPopover(!showAddPopover); }}
              className="w-5 h-5 flex items-center justify-center rounded text-gray-600 hover:text-emerald-400 hover:bg-gray-700/50 transition-colors text-xs"
              title="Add to portfolio"
            >
              +
            </button>
            {showAddPopover && (
              <AddToPortfolioPopover
                market={market}
                onAdd={handleAddToPortfolio}
                onClose={() => setShowAddPopover(false)}
                anchorRef={addBtnRef}
              />
            )}
          </div>
        </div>
        <div
          ref={yesPriceCellRef}
          className={market.yesPrice != null && market.yesPrice > 0.5 ? 'text-[#00d4aa]' : 'text-gray-400'}
        >
          {formatPrice(market.yesPrice)}
        </div>
        <div
          ref={noPriceCellRef}
          className={market.noPrice != null && market.noPrice > 0.5 ? 'text-[#ff4d6a]' : 'text-gray-400'}
        >
          {formatPrice(market.noPrice)}
        </div>
        <div className="text-gray-400">{formatVolume(market.volume)}</div>
        <div className="text-gray-400">{formatVolume(market.volume24hr)}</div>
        <div className="text-gray-400">{market.daysLeft ?? '\u2014'}</div>
        <div className="truncate text-xs text-gray-500">{market.category || '\u2014'}</div>
        <div><EdgeBadge score={market.edgeScore} /></div>
        <div>
          <FLBEdgeCell flb={market.flb} />
        </div>
        <div>
          <ThetaCell theta={market.theta} />
        </div>
        <div>
          <RulesCell resolution={market.resolutionAnalysis} />
        </div>
        <div>
          <VolPriceCell ve={market.volumeEfficiency} />
        </div>
        <div>
          <BaseRateCell baseRate={market.baseRate} />
        </div>
        <div>
          <SpreadCell market={market} cachedSpread={cachedSpread} />
        </div>
        <div>
          <ConjunctionCell conjunction={market.conjunction} />
        </div>
        <div className="hidden md:block">
          <FLBSideCell flb={market.flb} />
        </div>
        <div className="hidden md:block">
          <FlowCell flowData={cachedFlow} />
        </div>
      </div>

      {expanded && (
        <div className="sticky left-0" style={{ width: detailWidth || '100%' }}>
          <Suspense fallback={<div className="h-20 animate-pulse bg-gray-800/50 rounded" />}>
            <MarketDetailPanel market={market} onBookData={onBookData} onFlowData={onFlowData} portfolio={portfolio} />
          </Suspense>
        </div>
      )}
    </div>
  );
}, (prevProps, nextProps) => {
  // Custom comparator: return true if props are EQUAL (skip re-render)
  if (prevProps.expanded !== nextProps.expanded) return false;
  if (prevProps.highlighted !== nextProps.highlighted) return false;
  if (prevProps.cachedSpread !== nextProps.cachedSpread) return false;
  if (prevProps.cachedFlow !== nextProps.cachedFlow) return false;
  if (prevProps.priceFlash !== nextProps.priceFlash) return false;
  // Portfolio: compare stable primitives instead of the full object.
  // hasPortfolio is a boolean, isMarketHeld is a useCallback ref —
  // both only change when positions actually change.
  if (prevProps.hasPortfolio !== nextProps.hasPortfolio) return false;
  if (prevProps.isMarketHeld !== nextProps.isMarketHeld) return false;
  if (prevProps.filters?.highlightHeld !== nextProps.filters?.highlightHeld) return false;
  const prev = prevProps.market;
  const next = nextProps.market;
  if (prev === next) return true; // same object reference

  return (
    prev.yesPrice === next.yesPrice &&
    prev.noPrice === next.noPrice &&
    prev.edgeScore === next.edgeScore &&
    prev.volume === next.volume &&
    prev.volume24hr === next.volume24hr &&
    prev.daysLeft === next.daysLeft &&
    prev.category === next.category &&
    prev.question === next.question &&
    prev.flb?.bestEdge === next.flb?.bestEdge &&
    prev.flb?.bestSide === next.flb?.bestSide &&
    prev.theta?.bestTheta === next.theta?.bestTheta &&
    prev.resolutionAnalysis?.strictness?.score === next.resolutionAnalysis?.strictness?.score &&
    prev.volumeEfficiency?.priority === next.volumeEfficiency?.priority &&
    prev.baseRate?.absGapCents === next.baseRate?.absGapCents &&
    prev.conjunction?.type === next.conjunction?.type
  );
});

// Re-export for any consumers that imported ROW_HEIGHT_PX
export { ROW_HEIGHT as ROW_HEIGHT_PX };

export default MarketRow;
