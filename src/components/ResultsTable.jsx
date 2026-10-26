import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { List, useDynamicRowHeight } from 'react-window';
import MarketRow from './MarketRow';
import { calculateSpread } from '../SpreadFrictionEngine';
import { createHoverPrefetcher } from '../hoverPrefetchUtils';
import { peekCachedTradeFlow, setCachedTradeFlow } from '../TradeFlowEngine';
import { runSpreadBatch, runFlowBatch, runGapFill, needsSpread, needsFlow } from '../batchFetchUtils';
import { isDataApiRateLimited } from '../dataApi';
import {
  ROW_HEIGHT, HEADER_HEIGHT, FOOTER_HEIGHT, BANNER_HEIGHT, CYAN,
  SPREAD_BATCH_START, FLOW_BATCH_START,
  SPREAD_CACHE_CAP,
} from '../uiConfig';
import { isClobRateLimited, clearClobRateLimit, onClobRateLimitChange, getClobRecoverySeconds } from '../clobRateLimit';
import { acquireClobSlot, hasClobSlotAvailable } from '../clobConcurrency';

// LRU insert into spread cache Map (ref-based, no state)
function updateSpreadCache(ref, marketId, value) {
  const cache = ref.current;
  cache.delete(marketId);       // LRU promotion: move to end of iteration order
  cache.set(marketId, value);
  if (cache.size > SPREAD_CACHE_CAP) {
    cache.delete(cache.keys().next().value);  // evict oldest
  }
}

// Single source of truth for grid column layout
const GRID_COLS = '1fr 55px 55px 80px 75px 45px 60px 80px 45px 60px 70px 75px 60px 58px 58px 45px 50px 65px 75px';

// Row component for react-window v2
// In v2, rowProps are spread directly as component props (not wrapped in `data`)
function VirtualRow({
  index, style,
  marketsRef, expandedMarketId, scrollWidth,
  spreadCacheRef, priceFlashesRef,
  foundInLoadedId, isApiFetched, handleToggleExpand, handleBookData,
  handleFlowData, onLivePriceUpdate,
  filters, handleRowHover, handleRowHoverEnd,
}) {

  const m = marketsRef.current[index];
  if (!m) return null;

  const isHighlighted =
    (foundInLoadedId && m.id === foundInLoadedId) ||
    (isApiFetched && m._fromLookup);

  // Read latest values from refs — avoids rowData recreation on every cache/flash update
  const priceFlashes = priceFlashesRef.current;

  return (
    <div
      style={style}
      onMouseEnter={() => handleRowHover(m.id, m)}
      onMouseLeave={handleRowHoverEnd}
    >
      {isApiFetched && index === 0 && (
        <div className="px-3 py-1.5 text-xs" style={{ color: CYAN, background: 'rgba(0, 212, 170, 0.05)' }}>
          Direct lookup result
        </div>
      )}
      <MarketRow
        market={m}
        expanded={m.id === expandedMarketId}
        onToggle={() => handleToggleExpand(index, m.id)}
        detailWidth={scrollWidth}
        highlighted={isHighlighted}
        cachedSpread={spreadCacheRef.current.get(m.id) ?? null}
        onBookData={handleBookData}
        cachedFlow={peekCachedTradeFlow(m.id)}
        onFlowData={handleFlowData}
        onLivePriceUpdate={onLivePriceUpdate}
        filters={filters}
        gridColumns={GRID_COLS}
        priceFlash={priceFlashes?.[m.id] || null}
      />
    </div>
  );
}

export default function ResultsTable({ markets, lookupState, onClearSearch, filters, leaderboardReady, priceFlashes, onLivePriceUpdate }) {
  const listRef = useRef(null);
  const containerRef = useRef(null);
  const [scrollWidth, setScrollWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);

  // Track expansion by MARKET ID (stable across filter/sort changes)
  const [expandedMarketId, setExpandedMarketId] = useState(null);

  // Stable ref for markets — avoids recreating rowData on every Immer price tick
  const marketsRef = useRef(markets);
  marketsRef.current = markets;

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

  // Spread cache: marketId -> real absoluteSpread value (LRU Map, ref-only)
  const spreadCacheRef = useRef(new Map());
  const [, setCacheUpdateTick] = useState(0); // single tick for spread + flow batch re-renders
  const batchAbortRef = useRef(null);
  const batchQueueRef = useRef(null);

  // Trade flow cache: reads from module-level cache in TradeFlowEngine.js
  // (500 LRU, 5-min TTL — peekCachedTradeFlow for reads, setCachedTradeFlow for writes;
  //  getCachedTradeFlow with LRU promotion is used only in TradeFlowPanel for active access)
  const flowBatchAbortRef = useRef(null);
  const flowBatchQueueRef = useRef(null);

  // Refs for props that change frequently but shouldn't recreate rowData
  const priceFlashesRef = useRef(priceFlashes);
  priceFlashesRef.current = priceFlashes;

  // Hover-to-prefetch (logic extracted to hoverPrefetchUtils.js)
  const prefetcher = useMemo(() => createHoverPrefetcher({
    spreadCache: { has: (id) => spreadCacheRef.current.has(id) },
    acquireSlot: acquireClobSlot,
    hasSlotAvailable: hasClobSlotAvailable,
  }), []);

  // CLOB rate limit circuit breaker (shared module)
  const [clobRateLimited, setClobRateLimited] = useState(isClobRateLimited);

  useEffect(() => {
    return onClobRateLimitChange(setClobRateLimited);
  }, []);

  const isApiFetched = lookupState?.isLookupActive && lookupState.fetchedMarkets.length > 0;
  const foundInLoadedId = lookupState?.foundInLoadedId;

  // Handle book data from expanded row detail panels
  const handleBookData = useCallback((marketId, bookData) => {
    const spread = calculateSpread(bookData);
    if (spread) {
      updateSpreadCache(spreadCacheRef, marketId, spread.absoluteSpread);
      setCacheUpdateTick(t => t + 1);
    }
  }, []);

  // Handle trade flow data from expanded panels
  const handleFlowData = useCallback((marketId, data) => {
    setCachedTradeFlow(marketId, data);
    setCacheUpdateTick(t => t + 1);
  }, []);

  // ── Virtual list sizing ──────────────────────────────────────

  // Tracks the current visible row — updated by onRowsRendered on every scroll
  const lastVisibleStartRef = useRef(0);

  // Filter/sort fingerprint for resetting height cache and remounting the List.
  // When filters change, cached heights must be discarded since row N in the
  // old sort is a different market than row N in the new sort.
  // NOTE: markets.length is intentionally excluded — count changes are handled
  // by react-window's rowCount prop without remounting (preserves scroll position).
  const listKey = useMemo(() => JSON.stringify(filters), [filters]);

  // Dynamic row height measurement via ResizeObserver.
  // - defaultRowHeight: 44px (normal collapsed row)
  // - key: resets the height cache when filter/sort changes
  const dynamicHeight = useDynamicRowHeight({
    defaultRowHeight: ROW_HEIGHT,
    key: listKey,
  });

  // Row observation is handled natively by react-window v2's built-in layout effect,
  // which sets data-react-window-index on outer wrappers and calls observeRowElements.

  const handleToggleExpand = useCallback((index, marketId) => {
    setExpandedMarketId((prev) => prev === marketId ? null : marketId);
  }, []);

  // Collapse expanded row when sort/filter settings change.
  useEffect(() => {
    setExpandedMarketId(null);
    lastVisibleStartRef.current = 0;
  }, [filters]);

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
  const visibleRangeRef = useRef(visibleRange);
  visibleRangeRef.current = visibleRange;

  // Shared batch effect setup — spread and flow effects differ only in
  // filter predicate, batch function, cache adapter, max items, and start delay.
  // Returns a cleanup function for the useEffect return.
  function setupBatchEffect({ abortRef, queueRef, filterFn, batchFn, cacheAdapter, maxDefault, startDelay, isRateLimited }) {
    if (abortRef.current) abortRef.current.abort();
    if (queueRef.current) clearTimeout(queueRef.current);

    const controller = new AbortController();
    abortRef.current = controller;

    const { start, stop } = visibleRange;
    const visibleMarkets = marketsRef.current.slice(start, Math.min(stop + 1, marketsRef.current.length));
    const visibleCount = Math.max(1, stop - start + 1);
    const toFetch = visibleMarkets.filter(filterFn).slice(0, Math.min(visibleCount, maxDefault));

    if (toFetch.length === 0 || isRateLimited()) return () => {};

    let cancelled = false;
    const run = async () => {
      const result = await batchFn(toFetch, {
        cache: cacheAdapter,
        signal: controller.signal,
        cancelled: () => cancelled,
        acquireSlot: acquireClobSlot,
        maxItems: toFetch.length,
      });
      if (result.fetched > 0 && !cancelled) setCacheUpdateTick(t => t + 1);
    };

    queueRef.current = setTimeout(() => {
      if (!controller.signal.aborted) run();
    }, startDelay);

    return () => {
      cancelled = true;
      controller.abort();
      if (queueRef.current) clearTimeout(queueRef.current);
    };
  }

  // Background batch fetch order books for visible rows
  useEffect(() => setupBatchEffect({
    abortRef: batchAbortRef,
    queueRef: batchQueueRef,
    filterFn: (m) => needsSpread(m, (id) => spreadCacheRef.current.has(id)),
    batchFn: runSpreadBatch,
    cacheAdapter: { has: (id) => spreadCacheRef.current.has(id), set: (id, v) => updateSpreadCache(spreadCacheRef, id, v) },
    maxDefault: 25,
    startDelay: SPREAD_BATCH_START,
    isRateLimited: isClobRateLimited,
  }), [visibleRange.start, visibleRange.stop, listKey]);

  // Background batch fetch trade flow
  useEffect(() => setupBatchEffect({
    abortRef: flowBatchAbortRef,
    queueRef: flowBatchQueueRef,
    filterFn: (m) => needsFlow(m),
    batchFn: runFlowBatch,
    cacheAdapter: { has: (id) => !!peekCachedTradeFlow(id), set: () => {} }, // setCachedTradeFlow called inside wrapper
    maxDefault: 10,
    startDelay: FLOW_BATCH_START,
    isRateLimited: isDataApiRateLimited, // trade flow is a Data API request
  }), [visibleRange.start, visibleRange.stop, listKey, leaderboardReady]);

  // Gap filler: catch visible rows missing spread/flow data that appeared
  // without triggering the main fetch effects (e.g., price tick caused a
  // market to cross a filter boundary into a visible row position).
  useEffect(() => {
    let cancelled = false;
    let running = false;
    let emptyRuns = 0;
    let timerId = null;

    // Spreads are CLOB requests (breaker + free slot needed); trade flow is a
    // Data API request with its own pause. Neither blocks the other.
    const spreadBlocked = () => isClobRateLimited() || !hasClobSlotAvailable();

    const doGapFill = async () => {
      if (cancelled || running) {
        scheduleNext();
        return;
      }

      const { start, stop } = visibleRangeRef.current;
      const visible = marketsRef.current.slice(start, Math.min(stop + 1, marketsRef.current.length));

      // Pre-check for empty to track emptyRuns (runGapFill filters internally too)
      const hasSpreadMissing = !spreadBlocked() && visible.some((m) => needsSpread(m, (id) => spreadCacheRef.current.has(id)));
      const hasFlowMissing = !isDataApiRateLimited() && visible.some((m) => needsFlow(m));

      if (!hasSpreadMissing && !hasFlowMissing) {
        emptyRuns++;
        scheduleNext();
        return;
      }

      emptyRuns = 0;
      running = true;

      try {
        const result = await runGapFill(visible, {
          spreadCache: { has: (id) => spreadCacheRef.current.has(id), set: (id, v) => updateSpreadCache(spreadCacheRef, id, v) },
          flowCache: { has: (id) => !!peekCachedTradeFlow(id), set: () => {} },
          acquireSlot: acquireClobSlot,
          isRateLimited: spreadBlocked,
          cancelled: () => cancelled,
        });

        if (!cancelled && (result.spreadFetched > 0 || result.flowFetched > 0)) {
          setCacheUpdateTick(t => t + 1);
        }
      } finally {
        running = false;
        scheduleNext();
      }
    };

    function scheduleNext() {
      if (cancelled || timerId) return;
      // Back off to 15s after 3 consecutive empty checks
      const delay = emptyRuns >= 3 ? 15000 : 5000;
      timerId = setTimeout(() => { timerId = null; doGapFill(); }, delay);
    }

    scheduleNext();

    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, []);

  // Auto-expand and scroll to the found/fetched market
  useEffect(() => {
    if (isApiFetched && lookupState.fetchedMarkets.length > 0) {
      setExpandedMarketId(lookupState.fetchedMarkets[0].id);
    } else if (foundInLoadedId) {
      setExpandedMarketId(foundInLoadedId);
    }
  }, [isApiFetched, foundInLoadedId, lookupState?.fetchedMarkets]);

  // ── Hover-to-prefetch (delegates to hoverPrefetchUtils) ─────

  const handleRowHover = useCallback((marketId, market) => {
    prefetcher.hover(marketId, market);
  }, [prefetcher]);

  const handleRowHoverEnd = useCallback(() => {
    prefetcher.hoverEnd();
  }, [prefetcher]);

  // ── Row data (stable object to avoid re-creating on every render) ──
  // spreadCache and priceFlashes are read from refs
  // inside VirtualRow — NOT listed as deps here. This prevents rowData
  // recreation on every background fetch or price flash, which was the
  // primary re-render cascade source (every visible MarketRow's memo ran).

  const rowData = useMemo(() => ({
    marketsRef, expandedMarketId, scrollWidth,
    spreadCacheRef, priceFlashesRef,
    foundInLoadedId, isApiFetched, handleToggleExpand, handleBookData,
    handleFlowData, onLivePriceUpdate,
    filters, handleRowHover, handleRowHoverEnd,
  }), [expandedMarketId, scrollWidth,
       foundInLoadedId, isApiFetched, handleToggleExpand, handleBookData,
       handleFlowData, onLivePriceUpdate,
       filters, handleRowHover, handleRowHoverEnd]);

  // ── Render ───────────────────────────────────────────────────

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
        <div title="Annualized yield of the favourite (80¢+) held to resolution, if it wins (bought at ~the ask, fees included)">Yield/yr</div>
        <div>Category</div>
        <div>Edge</div>
        <div>FLB Edge</div>
        <div>Theta</div>
        <div>Rules</div>
        <div>V-P</div>
        <div>Base</div>
        <div>Spread</div>
        <div>Fee</div>
        <div>Conj</div>
        <div className="hidden md:block">FLB Side</div>
        <div className="hidden md:block">Flow</div>
      </div>

      {/* CLOB rate limit warning banner */}
      {clobRateLimited && (
        <div className="flex items-center justify-between px-4 py-2 bg-red-900/40 border-b border-red-800 text-xs shrink-0">
          <span className="text-red-300">CLOB API rate limited — background fetches paused for {getClobRecoverySeconds()}s</span>
          <button
            onClick={() => clearClobRateLimit()}
            className="text-red-400 hover:text-red-200 font-medium transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

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
            key={listKey}
            ref={listRef}
            rowComponent={VirtualRow}
            rowCount={markets.length}
            rowHeight={dynamicHeight}
            rowProps={rowData}
            onRowsRendered={(visible) => {
              lastVisibleStartRef.current = visible.startIndex;
              setVisibleRange((prev) => {
                if (prev.start === visible.startIndex && prev.stop === visible.stopIndex) return prev;
                return { start: visible.startIndex, stop: visible.stopIndex };
              });
            }}
            style={{ height: `${containerHeight - HEADER_HEIGHT - FOOTER_HEIGHT - (clobRateLimited ? BANNER_HEIGHT : 0)}px`, width: '100%' }}
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
