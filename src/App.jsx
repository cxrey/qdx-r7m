import { useState, useMemo, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import FilterPanel from './components/FilterPanel';
import ResultsTable from './components/ResultsTable';
import ToastContainer from './components/ToastContainer';

// Code-split heavy tab components
const PortfolioDashboard = lazy(() => import('./components/PortfolioDashboard'));
import { useMarkets } from './hooks/useMarkets';
import { useAutoRefresh } from './hooks/useAutoRefresh';
import { useDebounce } from './hooks/useDebounce';
import { useDirectLookup } from './hooks/useDirectLookup';
import { usePortfolio } from './hooks/usePortfolio';
import { PortfolioProvider } from './contexts/PortfolioContext';
import { useExecutionStyle } from './contexts/ExecutionContext';
import { ALL_CATEGORIES } from './processMarket';
import { mergePendingPrice } from './utils/pendingPrices';
import { buildIndexMap, diffPriceSnapshot, shouldRefilter } from './utils/priceSnapshot';
import { fetchLeaderboard, buildLeaderboardIndex } from './TradeFlowEngine';
import { filterAndSort } from './utils/filterAndSort';
import { produce } from 'immer';
import ErrorBoundary from './components/ErrorBoundary';
import { PRICE_THROTTLE_MS, THROTTLE_LOG_EVERY } from './uiConfig';
import { DEFAULT_FILTERS } from './filterDefaults';

const NO_FLASHES = {};
const isEmpty = (obj) => Object.keys(obj).length === 0;

function App() {
  const { rawMarkets, setRawMarkets, loading, error, progress, lastFetch, baseRatesLoading, gammaRateLimited, refresh, baseRatesRef } = useMarkets();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  // Search box text lives outside `filters`: only the debounced value affects
  // results, so keystrokes must not change `filters` (which would re-run
  // filterAndSort and collapse the expanded row on every key).
  const [searchInput, setSearchInput] = useState('');
  const { executionStyle } = useExecutionStyle();

  // Ref always points to latest markets array without triggering re-renders
  const rawMarketsRef = useRef(rawMarkets);
  rawMarketsRef.current = rawMarkets;

  // Version counter drives filteredMarkets recalculation.
  // Bumped immediately on structural changes, throttled for price ticks.
  const [marketsVersion, setMarketsVersion] = useState(0);

  // Guard against multiple version bumps in the same render commit.
  // Reset to false at the top of each render (here), checked by each
  // structural-change effect below. First effect to bump sets it true,
  // subsequent effects in the same commit skip.
  const versionBumpedRef = useRef(false);
  versionBumpedRef.current = false;
  // rawMarkets array the last filterAndSort ran on — the throttle re-filters
  // whenever the current array differs (every writer produces a new array).
  const lastFilteredSourceRef = useRef(null);
  // Live price flashes: {marketId: 'up:<seq>'|'down:<seq>'}, replaced each
  // throttle tick so they render together with the price they describe.
  const [priceFlashes, setPriceFlashes] = useState(NO_FLASHES);
  const flashSeqRef = useRef(0);
  const totalCyclesRef = useRef(0);
  const skippedCyclesRef = useRef(0);
  const [activeTab, setActiveTab] = useState('scanner'); // 'scanner' | 'portfolio'
  const [leaderboardReady, setLeaderboardReady] = useState(false);

  // Auto-refresh system
  const {
    autoRefreshEnabled, toggleAutoRefresh, wsStatus,
    toasts, removeToast, handleManualRefresh,
    pricesDirtyRef, pendingPriceUpdatesRef,
  } = useAutoRefresh({ rawMarkets, setRawMarkets, baseRatesRef, refresh });

  const debouncedSearch = useDebounce(searchInput, 300);

  // Portfolio hook
  const portfolio = usePortfolio(rawMarkets);

  // Callback for live price updates from order book / price history (detail panel)
  const handleLivePriceUpdate = useCallback((marketId, yesPrice, noPrice) => {
    mergePendingPrice(pendingPriceUpdatesRef.current, marketId, { yesPrice, noPrice });
    pricesDirtyRef.current = true;
  }, [pendingPriceUpdatesRef, pricesDirtyRef]);

  // Fetch leaderboard on app load (once)
  useEffect(() => {
    fetchLeaderboard().then((data) => {
      if (data) {
        buildLeaderboardIndex(data);
        setLeaderboardReady(true);
      }
    }).catch(() => {
      console.warn('[App] Leaderboard fetch failed — trade flow ranking disabled');
    });
  }, []);

  // ── marketsVersion: immediate bumps for structural changes ────

  // Bump marketsVersion once per render commit, for structural changes.
  // Deduped by versionBumpedRef so multiple effects in the same commit don't double-bump.
  // Pending live prices (and their dirty flag) are deliberately left alone:
  // they are newer than the structural change and the throttle applies them
  // on its next tick. Clearing them here silently dropped WS updates —
  // including resolution settlements, which never re-arrive.
  const bumpVersion = useCallback(() => {
    if (versionBumpedRef.current) return;
    versionBumpedRef.current = true;
    setMarketsVersion(v => v + 1);
  }, []);

  // Immediate re-filter when markets are added or removed
  const prevLengthRef = useRef(0);
  useEffect(() => {
    if (rawMarkets.length !== prevLengthRef.current) {
      prevLengthRef.current = rawMarkets.length;
      bumpVersion();
    }
  }, [rawMarkets.length, bumpVersion]);

  // Immediate re-filter when base rate enrichment completes
  const prevBaseRatesLoadingRef = useRef(baseRatesLoading);
  useEffect(() => {
    if (prevBaseRatesLoadingRef.current && !baseRatesLoading) {
      bumpVersion();
    }
    prevBaseRatesLoadingRef.current = baseRatesLoading;
  }, [baseRatesLoading, bumpVersion]);

  // Immediate re-filter when a full refresh completes (Tier 3 or manual Refresh)
  const prevLastFetchRef = useRef(lastFetch);
  useEffect(() => {
    if (lastFetch && lastFetch !== prevLastFetchRef.current) {
      prevLastFetchRef.current = lastFetch;
      bumpVersion();
    }
  }, [lastFetch, bumpVersion]);

  // ── marketsVersion: throttled bump for price ticks ────────────

  // Uses a ref-based interval instead of a useEffect on rawMarkets,
  // so React doesn't run effect setup/cleanup 7 times per second.
  const priceThrottleRef = useRef(null);

  useEffect(() => {
    priceThrottleRef.current = setInterval(() => {
      // Persistent skip ratio logging (once per minute)
      totalCyclesRef.current++;
      if (totalCyclesRef.current % THROTTLE_LOG_EVERY === 0) {
        console.log(`[Throttle] ${skippedCyclesRef.current}/${totalCyclesRef.current} cycles skipped`);
        totalCyclesRef.current = 0;
        skippedCyclesRef.current = 0;
      }

      // Snapshot pending updates and clear the ref BEFORE calling
      // setRawMarkets — React batches the updater, so clearing afterwards
      // would hand it an empty map.
      const snapshot = pendingPriceUpdatesRef.current;
      pendingPriceUpdatesRef.current = new Map();
      pricesDirtyRef.current = false;

      const base = rawMarketsRef.current;
      let priceChanged = false;
      if (snapshot.size > 0) {
        const baseIdx = buildIndexMap(base);
        // Flashes are computed against the displayed prices and committed in
        // the same render as the new prices (one render per tick, and the
        // cell flashes on the new value, not the old one).
        const diff = diffPriceSnapshot(base, snapshot, ++flashSeqRef.current, baseIdx);
        priceChanged = diff.priceChanged;
        const { flashes } = diff;

        if (priceChanged) {
          setRawMarkets(prev => {
            const idxMap = prev === base ? baseIdx : buildIndexMap(prev);
            let changed = false;
            const next = produce(prev, draft => {
              for (const [marketId, update] of snapshot) {
                const idx = idxMap.get(marketId);
                if (idx == null) continue;
                const m = draft[idx];
                const newYes = update.yesPrice ?? m.yesPrice;
                const newNo = update.noPrice ?? m.noPrice;
                if (newYes === m.yesPrice && newNo === m.noPrice) continue;
                changed = true;
                m.yesPrice = newYes;
                m.noPrice = newNo;
              }
            });
            return changed ? next : prev;
          });
        }
        setPriceFlashes(prev => (isEmpty(flashes) && isEmpty(prev) ? prev : flashes));
      }

      // Re-filter only when there is something new: prices just applied, or
      // the markets array changed since the last filterAndSort (Tier 3
      // replace, resolution patch, enrichment). Idle data costs nothing.
      if (shouldRefilter(priceChanged, base, lastFilteredSourceRef.current)) {
        setMarketsVersion(v => v + 1);
      } else {
        skippedCyclesRef.current++;
      }
    }, PRICE_THROTTLE_MS);

    return () => {
      if (priceThrottleRef.current) {
        clearInterval(priceThrottleRef.current);
        priceThrottleRef.current = null;
      }
    };
  }, []);

  // Direct lookup
  const lookup = useDirectLookup(rawMarkets, baseRatesRef);
  const {
    fetchedMarkets, foundInLoadedId,
    isLookupActive, runLookup, clearLookup,
  } = lookup;

  // Run lookup when debounced search changes (for typed input), and once
  // more when markets first load — a link pasted during the initial load
  // can then be matched against the loaded set. runLookup reads markets
  // through a ref, so price ticks don't re-trigger this effect.
  const marketsLoaded = rawMarkets.length > 0;
  useEffect(() => {
    if (debouncedSearch) {
      runLookup(debouncedSearch, false);
    } else {
      clearLookup();
    }
  }, [debouncedSearch, runLookup, clearLookup, marketsLoaded]);

  const handleSearchChange = useCallback((e) => {
    setSearchInput(e.target.value);
  }, []);

  const handleSearchPaste = useCallback((e) => {
    e.preventDefault();
    const pasted = (e.clipboardData || window.clipboardData).getData('text');
    const cleaned = pasted.trim().replace(/^["']+|["']+$/g, '');
    setSearchInput(cleaned);
    runLookup(cleaned, true);
  }, [runLookup]);

  const handleClearSearch = useCallback(() => {
    clearLookup();
    setSearchInput('');
  }, [clearLookup]);

  // Pre-compute lowercase search text once
  const searchLower = useMemo(() => debouncedSearch?.toLowerCase() || '', [debouncedSearch]);

  // Consolidated single-pass filter + sort (extracted to pure utility)
  const filteredMarkets = useMemo(() => {
    lastFilteredSourceRef.current = rawMarketsRef.current;
    return filterAndSort({
      markets: rawMarketsRef.current,
      filters,
      searchLower,
      lookupState: { isLookupActive, fetchedMarkets, foundInLoadedId },
      portfolio,
      executionStyle,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketsVersion, searchLower, filters, executionStyle, isLookupActive, fetchedMarkets, foundInLoadedId, portfolio.hasPortfolio, portfolio.isMarketHeld]);

  const handleFiltersChange = useCallback((updater) => {
    setFilters(updater);
  }, []);

  return (
    <div className="h-screen flex flex-col bg-gray-950 text-gray-100">
      {/* Top Bar */}
      <header className="flex items-center justify-between px-4 py-3 bg-gray-900 border-b border-gray-800">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold text-emerald-400">Polymarket Scanner</h1>
          <span className="text-xs text-gray-500">
            {rawMarkets.length} markets loaded
            {baseRatesLoading && ' \u00B7 Loading base rates...'}
          </span>
          {/* Live/Polling status indicator */}
          {autoRefreshEnabled && (
            <span className="flex items-center gap-1.5 text-xs">
              <span
                className={`w-2 h-2 rounded-full ${
                  wsStatus === 'connected' ? 'bg-emerald-400 animate-pulse' :
                  wsStatus === 'polling' ? 'bg-yellow-400 animate-pulse' :
                  wsStatus === 'connecting' ? 'bg-blue-400 animate-pulse' :
                  'bg-gray-500'
                }`}
              />
              <span className={
                wsStatus === 'connected' ? 'text-emerald-400' :
                wsStatus === 'polling' ? 'text-yellow-400' :
                wsStatus === 'connecting' ? 'text-blue-400' :
                'text-gray-500'
              }>
                {wsStatus === 'connected' ? 'Live' :
                 wsStatus === 'polling' ? 'Polling' :
                 wsStatus === 'connecting' ? 'Connecting...' :
                 'Offline'}
              </span>
            </span>
          )}
        </div>

        {/* Search Bar */}
        <div className="flex-1 max-w-2xl mx-4 relative">
          <input
            type="text"
            placeholder="Search markets or paste a Polymarket link..."
            value={searchInput}
            onChange={handleSearchChange}
            onPaste={handleSearchPaste}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 pr-8 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-emerald-500"
          />
          {searchInput && (
            <button
              onClick={handleClearSearch}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 text-sm leading-none"
              title="Clear search"
            >
              ✕
            </button>
          )}
          {lookup.isLookupActive && (
            <div className="absolute left-0 top-full mt-1">
              {lookup.lookupLoading ? (
                <span className="text-xs" style={{ color: '#00d4aa' }}>⏳ Searching Polymarket...</span>
              ) : (
                <span className="text-xs" style={{ color: '#00d4aa' }}>Market link detected</span>
              )}
            </div>
          )}
          {lookup.lookupError && (
            <div className="absolute left-0 top-full mt-1">
              <span className="text-xs" style={{ color: '#f59e0b' }}>{lookup.lookupError}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* Auto-refresh toggle */}
          <button
            onClick={toggleAutoRefresh}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
              autoRefreshEnabled
                ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-600/40 hover:bg-emerald-600/30'
                : 'bg-gray-800 text-gray-400 border border-gray-700 hover:text-gray-200 hover:border-gray-600'
            }`}
            title={autoRefreshEnabled ? 'Auto-refresh ON — click to disable' : 'Auto-refresh OFF — click to enable'}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
            </svg>
            {autoRefreshEnabled ? 'Auto' : 'Auto'}
          </button>
          {/* Tab switcher */}
          <div className="flex bg-gray-800 rounded-lg p-0.5">
            <button
              onClick={() => setActiveTab('scanner')}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                activeTab === 'scanner' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Scanner
            </button>
            <button
              onClick={() => setActiveTab('portfolio')}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors flex items-center gap-1.5 ${
                activeTab === 'portfolio' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
                <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
                <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
              </svg>
              Portfolio
              {portfolio.hasPortfolio && (
                <span className="bg-emerald-600 text-white text-[9px] px-1 rounded-full">
                  {portfolio.allPositions.length}
                </span>
              )}
            </button>
          </div>

          {lastFetch && (
            <span className="text-xs text-gray-500">
              Last refresh: {lastFetch.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={handleManualRefresh}
            disabled={loading}
            className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50 transition-colors"
          >
            {loading ? `Loading... (${progress.toLocaleString()})` : 'Refresh'}
          </button>
        </div>
      </header>

      {/* Toast notifications */}
      <ToastContainer toasts={toasts} onRemove={removeToast} />

      {gammaRateLimited && (
        <div className="px-4 py-2 bg-yellow-900/50 text-yellow-300 text-sm border-b border-yellow-800">
          Gamma API rate limited — partial data loaded. Resumes automatically in 30s.
        </div>
      )}

      {error && (
        <div className="px-4 py-2 bg-red-900/50 text-red-300 text-sm border-b border-red-800">
          Error: {error}
        </div>
      )}

      {/* Main Content */}
      {activeTab === 'scanner' ? (
        <div className="flex flex-1 overflow-hidden">
          <FilterPanel
            filters={filters}
            setFilters={handleFiltersChange}
            categories={ALL_CATEGORIES}
            hasPortfolio={portfolio.hasPortfolio}
          />
          <PortfolioProvider value={portfolio.rowContext} details={portfolio}>
            <ErrorBoundary name="ResultsTable">
              <ResultsTable
                markets={filteredMarkets}
                lookupState={lookup}
                onClearSearch={handleClearSearch}
                filters={filters}
                leaderboardReady={leaderboardReady}
                priceFlashes={priceFlashes}
                onLivePriceUpdate={handleLivePriceUpdate}
              />
            </ErrorBoundary>
          </PortfolioProvider>
        </div>
      ) : (
        <ErrorBoundary name="PortfolioDashboard">
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-gray-500">Loading portfolio...</div>}>
            <PortfolioDashboard portfolio={portfolio} />
          </Suspense>
        </ErrorBoundary>
      )}
    </div>
  );
}

export default App;
