import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { List, useDynamicRowHeight } from 'react-window';
import MarketRow from './MarketRow';
import { fetchOrderBook, fetchPriceHistory } from '../api';
import { calculateSpread } from '../SpreadFrictionEngine';
import { fetchMarketTrades, getLeaderboardIndex, analyzeTradeFlow, peekCachedTradeFlow, setCachedTradeFlow } from '../TradeFlowEngine';
import {
  ROW_HEIGHT, HEADER_HEIGHT, FOOTER_HEIGHT, BANNER_HEIGHT, CYAN,
  SPREAD_FETCH_DELAY, SPREAD_BATCH_START, FLOW_FETCH_DELAY, FLOW_BATCH_START,
  HOVER_DEBOUNCE_DELAY, PREFETCH_CACHE_TTL, PREFETCH_LRU_CAP, SPREAD_CACHE_CAP,
} from '../uiConfig';
import { isClobRateLimited, clearClobRateLimit, onClobRateLimitChange, getClobRecoverySeconds } from '../clobRateLimit';
import { handleClobError } from '../clobErrorHandler';
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
const GRID_COLS = '1fr 55px 55px 80px 75px 45px 80px 45px 60px 70px 75px 60px 58px 58px 45px 50px 65px 75px';

// Row component for react-window v2
// In v2, rowProps are spread directly as component props (not wrapped in `data`)
function VirtualRow({
  index, style, ariaAttributes,
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

  // Hover-to-prefetch
  const prefetchCache = useRef(new Map());
  const prefetchController = useRef(null);

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
  const listKey = useMemo(() => {
    const { search, ...filtersWithoutSearch } = filters;
    return JSON.stringify(filtersWithoutSearch);
  }, [filters]);

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

  // Background batch fetch order books for visible rows
  useEffect(() => {
    if (batchAbortRef.current) batchAbortRef.current.abort();
    if (batchQueueRef.current) clearTimeout(batchQueueRef.current);

    const controller = new AbortController();
    batchAbortRef.current = controller;

    // Read from state (not ref) — this effect re-runs when visibleRange changes
    const { start, stop } = visibleRange;
    const visibleMarkets = marketsRef.current.slice(start, Math.min(stop + 1, marketsRef.current.length));

    // Cap batch to actual visible row count — gap filler catches the rest
    const visibleCount = Math.max(1, stop - start + 1);
    const toFetch = visibleMarkets
      .filter((m) => m.clobTokenIds?.[0] && !spreadCacheRef.current.has(m.id))
      .slice(0, Math.min(visibleCount, 25));

    if (toFetch.length === 0) return;

    if (isClobRateLimited()) return;

    let cancelled = false;
    const fetchSequential = async () => {
      let fetched = 0;
      for (const market of toFetch) {
        if (cancelled || controller.signal.aborted || isClobRateLimited()) break;
        let release;
        try {
          release = await acquireClobSlot(controller.signal);
          if (cancelled || controller.signal.aborted) break;
          const data = await fetchOrderBook(market.clobTokenIds[0]);
          if (cancelled || controller.signal.aborted) break;
          if (data) {
            const spread = calculateSpread(data);
            if (spread) {
              updateSpreadCache(spreadCacheRef, market.id, spread.absoluteSpread);
              fetched++;
            }
          }
        } catch (err) {
          if (err.name === 'AbortError') break;
          if (handleClobError(err)) {
            break;
          }
          console.warn('[ResultsTable] Order book fetch failed:', err);
        } finally {
          if (release) release();
        }
        // Keep inter-request delay — paces this system independently
        if (!cancelled && !controller.signal.aborted) {
          await new Promise((r) => setTimeout(r, SPREAD_FETCH_DELAY));
        }
      }
      // Single re-render after entire batch (not per-market)
      if (fetched > 0 && !cancelled) setCacheUpdateTick(t => t + 1);
    };

    batchQueueRef.current = setTimeout(() => {
      if (!controller.signal.aborted) fetchSequential();
    }, SPREAD_BATCH_START);

    return () => {
      cancelled = true;
      controller.abort();
      if (batchQueueRef.current) clearTimeout(batchQueueRef.current);
    };
  }, [visibleRange.start, visibleRange.stop, listKey]);

  // Background batch fetch trade flow
  useEffect(() => {
    if (flowBatchAbortRef.current) flowBatchAbortRef.current.abort();
    if (flowBatchQueueRef.current) clearTimeout(flowBatchQueueRef.current);

    const controller = new AbortController();
    flowBatchAbortRef.current = controller;

    // Read from state (not ref) — this effect re-runs when visibleRange changes
    const { start, stop } = visibleRange;
    const visibleMarkets = marketsRef.current.slice(start, Math.min(stop + 1, marketsRef.current.length));

    // Cap batch to actual visible row count — gap filler catches the rest
    const visibleCount = Math.max(1, stop - start + 1);
    const toFetch = visibleMarkets
      .filter((m) => m.conditionId && !peekCachedTradeFlow(m.id))
      .slice(0, Math.min(visibleCount, 10));

    if (toFetch.length === 0) return;

    if (isClobRateLimited()) return;

    let cancelled = false;
    const fetchSeq = async () => {
      const lbIndex = getLeaderboardIndex();
      let fetched = 0;
      for (const market of toFetch) {
        if (cancelled || controller.signal.aborted || isClobRateLimited()) break;
        let release;
        try {
          release = await acquireClobSlot(controller.signal);
          if (cancelled || controller.signal.aborted) break;
          const trades = await fetchMarketTrades(market.conditionId);
          if (cancelled || controller.signal.aborted) break;
          if (trades && trades.length > 0) {
            const analysis = analyzeTradeFlow(trades, null, lbIndex, market, null);
            setCachedTradeFlow(market.id, analysis);
            fetched++;
          }
        } catch (err) {
          if (err.name === 'AbortError') break;
          if (handleClobError(err)) {
            break;
          }
          console.warn('[ResultsTable] Trade flow fetch failed:', err);
        } finally {
          if (release) release();
        }
        if (!cancelled && !controller.signal.aborted) {
          await new Promise((r) => setTimeout(r, FLOW_FETCH_DELAY));
        }
      }
      // Single re-render after entire batch (not per-market)
      if (fetched > 0 && !cancelled) setCacheUpdateTick(t => t + 1);
    };

    flowBatchQueueRef.current = setTimeout(() => {
      if (!controller.signal.aborted) fetchSeq();
    }, FLOW_BATCH_START);

    return () => {
      cancelled = true;
      controller.abort();
      if (flowBatchQueueRef.current) clearTimeout(flowBatchQueueRef.current);
    };
  }, [visibleRange.start, visibleRange.stop, listKey, leaderboardReady]);

  // Gap filler: catch visible rows missing spread/flow data that appeared
  // without triggering the main fetch effects (e.g., price tick caused a
  // market to cross a filter boundary into a visible row position).
  useEffect(() => {
    let cancelled = false;
    let running = false;
    let emptyRuns = 0;
    let timerId = null;

    const runGapFill = async () => {
      if (cancelled || running || isClobRateLimited() || !hasClobSlotAvailable()) {
        scheduleNext();
        return;
      }

      const { start, stop } = visibleRangeRef.current;
      const visible = marketsRef.current.slice(start, Math.min(stop + 1, marketsRef.current.length));

      const spreadMissing = visible
        .filter(m => m.clobTokenIds?.[0] && !spreadCacheRef.current.has(m.id))
        .slice(0, 3);
      const flowMissing = visible
        .filter(m => m.conditionId && !peekCachedTradeFlow(m.id))
        .slice(0, 2);

      if (spreadMissing.length === 0 && flowMissing.length === 0) {
        emptyRuns++;
        scheduleNext();
        return;
      }

      emptyRuns = 0;
      running = true;

      try {
        let anySpread = false;
        let anyFlow = false;

        for (const market of spreadMissing) {
          if (cancelled || isClobRateLimited()) break;
          let release;
          try {
            release = await acquireClobSlot();
            const data = await fetchOrderBook(market.clobTokenIds[0]);
            if (cancelled) break;
            if (data) {
              const spread = calculateSpread(data);
              if (spread) {
                updateSpreadCache(spreadCacheRef, market.id, spread.absoluteSpread);
                anySpread = true;
              }
            }
          } catch (err) {
            if (handleClobError(err)) {
              break;
            }
          } finally {
            if (release) release();
          }
        }

        if (!cancelled) {
          const lbIndex = getLeaderboardIndex();
          for (const market of flowMissing) {
            if (cancelled || isClobRateLimited()) break;
            let release;
            try {
              release = await acquireClobSlot();
              const trades = await fetchMarketTrades(market.conditionId);
              if (cancelled) break;
              if (trades && trades.length > 0) {
                const analysis = analyzeTradeFlow(trades, null, lbIndex, market, null);
                setCachedTradeFlow(market.id, analysis);
                anyFlow = true;
              }
            } catch (err) {
              if (handleClobError(err)) {
                break;
              }
            } finally {
              if (release) release();
            }
          }
        }

        if (!cancelled && (anySpread || anyFlow)) {
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
      timerId = setTimeout(() => { timerId = null; runGapFill(); }, delay);
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

  // ── Hover-to-prefetch ────────────────────────────────────────

  const handleRowHover = useCallback((marketId, market) => {
    const cached = prefetchCache.current.get(marketId);
    if (cached && Date.now() - cached.timestamp < PREFETCH_CACHE_TTL) return;

    if (prefetchController.current) prefetchController.current.abort();

    // LRU eviction
    if (prefetchCache.current.size >= PREFETCH_LRU_CAP) {
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
      if (isClobRateLimited()) return;
      // Non-blocking check: skip prefetch entirely if all slots are busy.
      // acquireClobSlot below would block-wait; prefetch shouldn't queue up.
      if (!hasClobSlotAvailable()) return;
      const yesTokenId = market.clobTokenIds?.[0];
      if (!yesTokenId) return;

      // Skip order book fetch if spread effect already cached it
      const hasSpread = spreadCacheRef.current.has(marketId);

      let release;
      try {
        release = await acquireClobSlot(signal);
        if (signal.aborted) return;

        const [bookData, priceHistory] = await Promise.all([
          hasSpread
            ? Promise.resolve(null)  // skip — already cached by spread effect
            : fetchOrderBook(yesTokenId).catch((err) => {
                handleClobError(err);
                return null;
              }),
          fetchPriceHistory(yesTokenId, '1d', null, null, null, signal).catch((err) => {
            handleClobError(err);
            return null;
          }),
        ]);
        if (!signal.aborted) {
          prefetchCache.current.set(marketId, { bookData, priceHistory, timestamp: Date.now() });
        }
      } catch (e) {
        if (e.name !== 'AbortError') console.warn('[Prefetch] Failed:', e);
      } finally {
        if (release) release();
      }
    }, HOVER_DEBOUNCE_DELAY);

    signal.addEventListener('abort', () => clearTimeout(timer));
  }, []);

  const handleRowHoverEnd = useCallback(() => {
    if (prefetchController.current) {
      prefetchController.current.abort();
      prefetchController.current = null;
    }
  }, []);

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
