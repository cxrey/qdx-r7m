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
import { ALL_CATEGORIES } from './processMarket';
import { getVolEffSortValue } from './VolumeEfficiencyEngine';
import { fetchLeaderboard, buildLeaderboardIndex } from './TradeFlowEngine';
import { perfStart, perfEnd } from './perfMonitor';

const DEFAULT_FILTERS = {
  search: '',
  volumeRange: [0, 50_000_000],
  yesPriceRange: [0, 100],
  noPriceRange: [0, 100],
  daysLeftRange: [0, 365],
  categories: [],
  sortBy: 'edgeScore',
  sortAsc: false,
  perPage: 50,
  flbOnly: false,
  minTheta: 0,
  hideDeadMoney: false,
  resolutionTypes: [],
  minStrictness: 0,
  volPriorities: [],
  hideEfficient: false,
  minEstEdge: 0,
  minNarrativeGap: 0,
  baseRateConfidence: 'any',
  conjunctionTypes: [],
  minConjunctionGap: 0,
  // Portfolio filters
  highlightHeld: true,
  hideHeld: false,
  showPortfolioFit: true,
  // Trade flow filters
  flowDirection: 'any',
  leaderboardActive: false,
  relevantExpertActive: false,
};

function App() {
  const { rawMarkets, setRawMarkets, loading, error, progress, lastFetch, baseRatesLoading, refresh, baseRatesRef } = useMarkets();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [activeTab, setActiveTab] = useState('scanner'); // 'scanner' | 'portfolio'
  const [leaderboardReady, setLeaderboardReady] = useState(false);

  // Auto-refresh system
  const {
    autoRefreshEnabled, toggleAutoRefresh, wsStatus, statusMessage,
    toasts, removeToast, priceFlashes, handleManualRefresh,
  } = useAutoRefresh({ rawMarkets, setRawMarkets, baseRatesRef, refresh });

  const debouncedSearch = useDebounce(filters.search, 300);

  // Portfolio hook
  const portfolio = usePortfolio(rawMarkets);

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

  // Direct lookup
  const lookup = useDirectLookup(rawMarkets, baseRatesRef);
  const {
    detection, fetchedMarkets, foundInLoadedId, lookupLoading, lookupError,
    isLookupActive, runLookup, clearLookup,
  } = lookup;

  // Run lookup when debounced search changes (for typed input)
  useEffect(() => {
    if (debouncedSearch) {
      runLookup(debouncedSearch, false);
    } else {
      clearLookup();
    }
  }, [debouncedSearch, runLookup, clearLookup]);

  // Immediate lookup on paste (bypasses debounce)
  const handlePaste = useCallback((cleanedValue) => {
    runLookup(cleanedValue, true);
  }, [runLookup]);

  const handleClearSearch = useCallback(() => {
    clearLookup();
    setFilters((f) => ({ ...f, search: '' }));
  }, [clearLookup]);

  // Pre-compute lowercase search text once
  const searchLower = useMemo(() => debouncedSearch?.toLowerCase() || '', [debouncedSearch]);

  // Consolidated single-pass filter + sort
  const filteredMarkets = useMemo(() => {
    // If we have fetched markets from API lookup, show only those
    if (isLookupActive && fetchedMarkets.length > 0) {
      return fetchedMarkets;
    }

    const isLookupFoundInLoaded = isLookupActive && foundInLoadedId != null;
    const hasCategories = filters.categories.length > 0;
    const hasResTypes = filters.resolutionTypes?.length > 0;
    const hasVolPriorities = filters.volPriorities?.length > 0;
    const hasConjTypes = filters.conjunctionTypes?.length > 0;
    const minEdge = filters.minEstEdge > 0 ? filters.minEstEdge / 100 : 0;
    const brAllowed = filters.baseRateConfidence === 'HIGH' ? ['HIGH'] : filters.baseRateConfidence === 'MEDIUM' ? ['HIGH', 'MEDIUM'] : null;
    const hasSearch = !isLookupActive && searchLower.length > 0;

    // Single-pass filter — cheapest checks first
    perfStart('filter-sort');
    const result = [];
    for (let i = 0; i < rawMarkets.length; i++) {
      const m = rawMarkets[i];
      const isPinned = isLookupFoundInLoaded && m.id === foundInLoadedId;

      if (!isPinned) {
        // CHEAPEST: numeric comparisons
        if (m.volume < filters.volumeRange[0] || m.volume > filters.volumeRange[1]) continue;
        if (m.yesPrice != null) {
          const yc = m.yesPrice * 100;
          if (yc < filters.yesPriceRange[0] || yc > filters.yesPriceRange[1]) continue;
        }
        if (m.noPrice != null) {
          const nc = m.noPrice * 100;
          if (nc < filters.noPriceRange[0] || nc > filters.noPriceRange[1]) continue;
        }
        if (m.daysLeft != null) {
          if (m.daysLeft < filters.daysLeftRange[0] || m.daysLeft > filters.daysLeftRange[1]) continue;
        }

        // MEDIUM: array membership
        if (hasCategories && !filters.categories.includes(m.category)) continue;
        if (hasVolPriorities && !(m.volumeEfficiency && filters.volPriorities.includes(m.volumeEfficiency.priority))) continue;

        // NUMERIC thresholds
        if (filters.minStrictness > 0 && (m.resolutionAnalysis?.strictness?.score ?? 0) < filters.minStrictness) continue;
        if (filters.minNarrativeGap > 0 && (m.baseRate?.absGapCents ?? 0) < filters.minNarrativeGap) continue;
        if (filters.minTheta > 0 && (!m.theta || Math.abs(m.theta.bestTheta) * 100 < filters.minTheta)) continue;
        if (minEdge > 0 && (m.volumeEfficiency?.estimatedEdge ?? 0) < minEdge) continue;
        if (filters.minConjunctionGap > 0 && !(m.conjunction?.isConjunction && Math.abs(m.conjunction.gapPp ?? 0) >= filters.minConjunctionGap)) continue;

        // BOOLEAN toggles
        if (filters.flbOnly && !m.flb?.isBiasOpportunity) continue;
        if (filters.hideDeadMoney && m.theta?.zones?.includes('DEAD_MONEY')) continue;
        if (filters.hideEfficient && m.volumeEfficiency?.priority === 'EFFICIENT') continue;

        // Resolution types
        if (hasResTypes) {
          if (!m.resolutionAnalysis?.characteristics) continue;
          const hasMatch = filters.resolutionTypes.some((type) =>
            m.resolutionAnalysis.characteristics.some((c) => c.type === type && c.confidence === 'HIGH')
          );
          if (!hasMatch) continue;
        }

        // Base rate confidence
        if (brAllowed && !(m.baseRate && brAllowed.includes(m.baseRate.confidence))) continue;

        // Conjunction types
        if (hasConjTypes) {
          if (filters.conjunctionTypes.includes('NONE')) {
            if (m.conjunction?.isConjunction) continue;
          } else {
            if (!(m.conjunction?.isConjunction && filters.conjunctionTypes.includes(m.conjunction.type))) continue;
          }
        }

        // Hide held — O(1) Set lookup
        if (filters.hideHeld && portfolio.hasPortfolio && portfolio.isMarketHeld(m.id)) continue;

        // MOST EXPENSIVE: string matching (last)
        if (hasSearch) {
          const qLower = m.question.toLowerCase();
          if (!qLower.includes(searchLower)) {
            const dLower = m.description.toLowerCase();
            if (!dLower.includes(searchLower)) continue;
          }
        }
      }

      result.push(m);
    }

    // Sort
    const dir = filters.sortAsc ? 1 : -1;
    result.sort((a, b) => {
      if (isLookupFoundInLoaded) {
        if (a.id === foundInLoadedId) return -1;
        if (b.id === foundInLoadedId) return 1;
      }

      let av, bv;
      switch (filters.sortBy) {
        case 'flbEdge':
          av = a.flb?.bestEdge ?? 0; bv = b.flb?.bestEdge ?? 0; break;
        case 'theta':
          av = Math.abs(a.theta?.bestTheta ?? 0); bv = Math.abs(b.theta?.bestTheta ?? 0); break;
        case 'strictness':
          av = a.resolutionAnalysis?.strictness?.score ?? 0; bv = b.resolutionAnalysis?.strictness?.score ?? 0; break;
        case 'impliedDailyRate':
          av = a.resolutionAnalysis?.temporal?.metrics?.impliedDailyRate ?? 0; bv = b.resolutionAnalysis?.temporal?.metrics?.impliedDailyRate ?? 0; break;
        case 'volEfficiency':
          av = getVolEffSortValue(a.volumeEfficiency); bv = getVolEffSortValue(b.volumeEfficiency); break;
        case 'effectiveVolume':
          av = a.volumeEfficiency?.effectiveVolume ?? 0; bv = b.volumeEfficiency?.effectiveVolume ?? 0; break;
        case 'volVelocity':
          av = a.volumeEfficiency?.recencyMultiplier ?? 0; bv = b.volumeEfficiency?.recencyMultiplier ?? 0; break;
        case 'baseRateGap':
          av = a.baseRate?.absGapCents ?? 0; bv = b.baseRate?.absGapCents ?? 0; break;
        case 'conjunctionGap':
          av = Math.abs(a.conjunction?.gapPp ?? 0); bv = Math.abs(b.conjunction?.gapPp ?? 0); break;
        case 'walletImbalance':
          av = Math.abs(a._flowImbalance ?? 0); bv = Math.abs(b._flowImbalance ?? 0); break;
        default:
          av = a[filters.sortBy] ?? 0; bv = b[filters.sortBy] ?? 0;
      }
      return (av - bv) * dir;
    });

    perfEnd('filter-sort', 50);
    return result;
  }, [rawMarkets, searchLower, filters, isLookupActive, fetchedMarkets, foundInLoadedId, portfolio.hasPortfolio, portfolio.isMarketHeld]);

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
            lookupState={lookup}
            onPaste={handlePaste}
            onClearSearch={handleClearSearch}
            hasPortfolio={portfolio.hasPortfolio}
          />
          <ResultsTable
            markets={filteredMarkets}
            lookupState={lookup}
            onClearSearch={handleClearSearch}
            portfolio={portfolio}
            filters={filters}
            leaderboardReady={leaderboardReady}
            priceFlashes={priceFlashes}
          />
        </div>
      ) : (
        <Suspense fallback={<div className="flex-1 flex items-center justify-center text-gray-500">Loading portfolio...</div>}>
          <PortfolioDashboard portfolio={portfolio} />
        </Suspense>
      )}
    </div>
  );
}

export default App;
