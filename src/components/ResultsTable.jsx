import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { List } from 'react-window';
import MarketRow from './MarketRow';
import { fetchOrderBook } from '../api';
import { calculateSpread } from '../SpreadFrictionEngine';
import { fetchMarketTrades, getLeaderboardIndex, analyzeTradeFlow, getCachedTradeFlow, setCachedTradeFlow } from '../TradeFlowEngine';

// Single source of truth for grid column layout
const GRID_COLS = '1fr 55px 55px 80px 75px 45px 80px 45px 60px 70px 75px 60px 58px 58px 50px 65px 75px';

const ROW_HEIGHT = 44;        // normal row height in px
const EXPANDED_HEIGHT = 550;  // expanded row height in px

// Row component for react-window v2
// In v2, rowProps are spread directly as component props (not wrapped in `data`)
function VirtualRow({
  index, style, ariaAttributes,
  markets, expandedMarketId, scrollWidth, spreadCache, flowCache,
  foundInLoadedId, isApiFetched, handleToggleExpand, handleBookData,
  handleFlowData, portfolio, filters, priceFlashes, handleRowHover, handleRowHoverEnd,
}) {

  const m = markets[index];
  if (!m) return null;

  const isHighlighted =
    (foundInLoadedId && m.id === foundInLoadedId) ||
    (isApiFetched && m._fromLookup);

  return (
    <div
      style={style}
      onMouseEnter={() => handleRowHover(m.id, m)}
      onMouseLeave={handleRowHoverEnd}
    >
      {isApiFetched && index === 0 && (
        <div className="px-3 py-1.5 text-xs" style={{ color: '#00d4aa', background: 'rgba(0, 212, 170, 0.05)' }}>
          Direct lookup result
        </div>
      )}
      <MarketRow
        market={m}
        expanded={m.id === expandedMarketId}
        onToggle={() => handleToggleExpand(index, m.id)}
        detailWidth={scrollWidth}
        highlighted={isHighlighted}
        cachedSpread={spreadCache[m.id] ?? null}
        onBookData={handleBookData}
        cachedFlow={flowCache[m.id] || getCachedTradeFlow(m.id) || null}
        onFlowData={handleFlowData}
        portfolio={portfolio}
        filters={filters}
        gridColumns={GRID_COLS}
        priceFlash={priceFlashes?.[m.id] || null}
      />
    </div>
  );
}

export default function ResultsTable({ markets, lookupState, onClearSearch, portfolio, filters, leaderboardReady, priceFlashes }) {
  const listRef = useRef(null);
  const containerRef = useRef(null);
  const [scrollWidth, setScrollWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);

  // Track expansion by MARKET ID (stable across filter/sort changes)
  const [expandedMarketId, setExpandedMarketId] = useState(null);

  // Scrollbar width measurement for header alignment
  const [scrollbarWidth, setScrollbarWidth] = useState(0);
  useEffect(() => {
    const outer = document.createElement('div');
    outer.style.overflow = 'scroll';
    outer.style.width = '100px';
    outer.style.height = '100px';
    outer.style.visibility = 'hidden';
    document.body.appendChild(outer);
    const width = outer.offsetWidth - outer.clientWidth;
    setScrollbarWidth(width);
    document.body.removeChild(outer);
  }, []);

  // Spread cache: marketId -> real absoluteSpread value
  const [spreadCache, setSpreadCache] = useState({});
  const batchAbortRef = useRef(null);
  const batchQueueRef = useRef(null);

  // Trade flow cache: marketId -> flow analysis data
  const [flowCache, setFlowCache] = useState({});
  const flowBatchAbortRef = useRef(null);
  const flowBatchQueueRef = useRef(null);

  // Hover-to-prefetch
  const prefetchCache = useRef(new Map());
  const prefetchController = useRef(null);

  const isApiFetched = lookupState?.isLookupActive && lookupState.fetchedMarkets.length > 0;
  const foundInLoadedId = lookupState?.foundInLoadedId;

  // Handle book data from expanded row detail panels
  const handleBookData = useCallback((marketId, bookData) => {
    const spread = calculateSpread(bookData);
    if (spread) {
      setSpreadCache((prev) => ({ ...prev, [marketId]: spread.absoluteSpread }));
    }
  }, []);

  // Handle trade flow data from expanded panels
  const handleFlowData = useCallback((marketId, data) => {
    setFlowCache((prev) => ({ ...prev, [marketId]: data }));
  }, []);

  // ── Virtual list sizing ──────────────────────────────────────

  // react-window v2: rowHeight receives (index, rowProps) directly, not {index}
  const getItemSize = useCallback((index) => {
    const market = markets[index];
    return market?.id === expandedMarketId ? EXPANDED_HEIGHT : ROW_HEIGHT;
  }, [markets, expandedMarketId]);

  const handleToggleExpand = useCallback((index, marketId) => {
    setExpandedMarketId((prev) => prev === marketId ? null : marketId);
  }, []);

  // ── Container sizing ─────────────────────────────────────────

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) => {
      setContainerHeight(entry.contentRect.height);
      setScrollWidth(entry.contentRect.width);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // ── Background spread/flow fetching ──────────────────────────

  // Visible range tracking — state so effects re-fire when range changes
  const [visibleRange, setVisibleRange] = useState({ start: 0, stop: 0 });

  // Background batch fetch order books for visible rows
  useEffect(() => {
    if (batchAbortRef.current) batchAbortRef.current.abort();
    if (batchQueueRef.current) clearTimeout(batchQueueRef.current);

    const controller = new AbortController();
    batchAbortRef.current = controller;

    const { start, stop } = visibleRange;
    const visibleMarkets = markets.slice(start, Math.min(stop + 1, markets.length));

    const toFetch = visibleMarkets
      .filter((m) => m.clobTokenIds?.[0] && spreadCache[m.id] == null)
      .slice(0, 25);

    if (toFetch.length === 0) return;

    let cancelled = false;
    const fetchSequential = async () => {
      for (const market of toFetch) {
        if (cancelled || controller.signal.aborted) break;
        try {
          const data = await fetchOrderBook(market.clobTokenIds[0]);
          if (cancelled || controller.signal.aborted) break;
          if (data) {
            const spread = calculateSpread(data);
            if (spread) {
              setSpreadCache((prev) => ({ ...prev, [market.id]: spread.absoluteSpread }));
            }
          }
        } catch { /* skip */ }
        if (!cancelled && !controller.signal.aborted) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    };

    batchQueueRef.current = setTimeout(() => {
      if (!controller.signal.aborted) fetchSequential();
    }, 500);

    return () => {
      cancelled = true;
      controller.abort();
      if (batchQueueRef.current) clearTimeout(batchQueueRef.current);
    };
  }, [visibleRange.start, visibleRange.stop, markets.length]);

  // Background batch fetch trade flow
  useEffect(() => {
    if (flowBatchAbortRef.current) flowBatchAbortRef.current.abort();
    if (flowBatchQueueRef.current) clearTimeout(flowBatchQueueRef.current);

    const controller = new AbortController();
    flowBatchAbortRef.current = controller;

    const { start, stop } = visibleRange;
    const visibleMarkets = markets.slice(start, Math.min(stop + 1, markets.length));

    const toFetch = visibleMarkets
      .filter((m) => m.conditionId && !flowCache[m.id] && !getCachedTradeFlow(m.id))
      .slice(0, 10);

    if (toFetch.length === 0) return;

    let cancelled = false;
    const fetchSeq = async () => {
      const lbIndex = getLeaderboardIndex();
      for (const market of toFetch) {
        if (cancelled || controller.signal.aborted) break;
        try {
          const trades = await fetchMarketTrades(market.conditionId);
          if (cancelled || controller.signal.aborted) break;
          if (trades && trades.length > 0) {
            const analysis = analyzeTradeFlow(trades, null, lbIndex, market, null);
            setCachedTradeFlow(market.id, analysis);
            setFlowCache((prev) => ({ ...prev, [market.id]: analysis }));
          }
        } catch { /* skip */ }
        if (!cancelled && !controller.signal.aborted) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    };

    flowBatchQueueRef.current = setTimeout(() => {
      if (!controller.signal.aborted) fetchSeq();
    }, 1000);

    return () => {
      cancelled = true;
      controller.abort();
      if (flowBatchQueueRef.current) clearTimeout(flowBatchQueueRef.current);
    };
  }, [visibleRange.start, visibleRange.stop, markets.length, leaderboardReady]);

  // Auto-expand and scroll to the found/fetched market
  useEffect(() => {
    if (isApiFetched && lookupState.fetchedMarkets.length > 0) {
      setExpandedMarketId(lookupState.fetchedMarkets[0].id);
    } else if (foundInLoadedId) {
      setExpandedMarketId(foundInLoadedId);
    }
  }, [isApiFetched, foundInLoadedId, lookupState?.fetchedMarkets]);

  // ── Hover-to-prefetch ────────────────────────────────────────

  const handleRowHover = useCallback((marketId, market) => {
    const cached = prefetchCache.current.get(marketId);
    if (cached && Date.now() - cached.timestamp < 30000) return;

    if (prefetchController.current) prefetchController.current.abort();

    // LRU eviction
    if (prefetchCache.current.size >= 20) {
      let oldestKey = null, oldestTime = Infinity;
      for (const [key, val] of prefetchCache.current) {
        if (val.timestamp < oldestTime) { oldestTime = val.timestamp; oldestKey = key; }
      }
      if (oldestKey) prefetchCache.current.delete(oldestKey);
    }

    const controller = new AbortController();
    prefetchController.current = controller;
    const signal = controller.signal;

    const timer = setTimeout(async () => {
      if (signal.aborted) return;
      const yesTokenId = market.clobTokenIds?.[0];
      if (!yesTokenId) return;
      try {
        const [bookData, priceHistory] = await Promise.all([
          fetchOrderBook(yesTokenId).catch(() => null),
          fetch(`/clob-api/prices-history?market=${yesTokenId}&interval=1d`, { signal })
            .then((r) => r.ok ? r.json() : null).catch(() => null),
        ]);
        if (!signal.aborted) {
          prefetchCache.current.set(marketId, { bookData, priceHistory, timestamp: Date.now() });
        }
      } catch (e) {
        if (e.name !== 'AbortError') console.warn('[Prefetch] Failed:', e);
      }
    }, 150);

    signal.addEventListener('abort', () => clearTimeout(timer));
  }, []);

  const handleRowHoverEnd = useCallback(() => {
    if (prefetchController.current) {
      prefetchController.current.abort();
      prefetchController.current = null;
    }
  }, []);

  // ── Row data (stable ref to avoid re-creating on every render) ──

  const rowData = useMemo(() => ({
    markets, expandedMarketId, scrollWidth, spreadCache, flowCache,
    foundInLoadedId, isApiFetched, handleToggleExpand, handleBookData,
    handleFlowData, portfolio, filters, priceFlashes, handleRowHover, handleRowHoverEnd,
  }), [markets, expandedMarketId, scrollWidth, spreadCache, flowCache,
       foundInLoadedId, isApiFetched, handleToggleExpand, handleBookData,
       handleFlowData, portfolio, filters, priceFlashes, handleRowHover, handleRowHoverEnd]);

  // ── Render ───────────────────────────────────────────────────

  const headerHeight = 36;

  return (
    <div ref={containerRef} className="flex-1 flex flex-col min-w-0">
      {/* Sticky header — padded right to compensate for body scrollbar */}
      <div
        className="grid gap-2 px-3 py-2 bg-gray-900 border-b border-gray-700 text-xs font-semibold text-gray-400 uppercase tracking-wider z-10 shrink-0"
        style={{ gridTemplateColumns: GRID_COLS, paddingRight: `${scrollbarWidth + 12}px` }}
      >
        <div>Market</div>
        <div>Yes</div>
        <div>No</div>
        <div>Volume</div>
        <div>24hr Vol</div>
        <div>Days</div>
        <div>Category</div>
        <div>Edge</div>
        <div>FLB Edge</div>
        <div>Theta</div>
        <div>Rules</div>
        <div>V-P</div>
        <div>Base</div>
        <div>Spread</div>
        <div>Conj</div>
        <div className="hidden md:block">FLB Side</div>
        <div className="hidden md:block">Flow</div>
      </div>

      {/* Virtualized rows */}
      <div className="flex-1 min-h-0">
        {markets.length === 0 && !lookupState?.lookupLoading ? (
          <div className="text-center text-gray-500 py-12">
            {lookupState?.isLookupActive
              ? 'Looking up market...'
              : 'No markets match your filters.'}
          </div>
        ) : (
          <List
            ref={listRef}
            rowComponent={VirtualRow}
            rowCount={markets.length}
            rowHeight={getItemSize}
            rowProps={rowData}
            onRowsRendered={(visible) => {
              setVisibleRange((prev) => {
                if (prev.start === visible.startIndex && prev.stop === visible.stopIndex) return prev;
                return { start: visible.startIndex, stop: visible.stopIndex };
              });
            }}
            style={{ height: `${containerHeight - headerHeight - 32}px`, width: '100%' }}
          />
        )}
      </div>

      {/* Results count bar */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-gray-900 border-t border-gray-800 text-xs shrink-0">
        <span className="text-gray-500">
          {markets.length.toLocaleString()} results
        </span>
        {isApiFetched && onClearSearch && (
          <button
            onClick={onClearSearch}
            className="text-gray-500 hover:text-gray-300 transition-colors"
          >
            Back to all markets
          </button>
        )}
      </div>
    </div>
  );
}

export { GRID_COLS };
