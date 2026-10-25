import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  fetchPositions,
  normalizePosition,
  matchPositionsToMarkets,
  buildCorrelationStructure,
  priceClusters,
  calculateConcentration,
  generateAlerts,
  getPositionSignals,
  getStoredWallet,
  setStoredWallet,
  getManualPositions,
  addManualPosition as addManualPosStorage,
  removeManualPosition as removeManualPosStorage,
  getCachedPositions,
  setCachedPositions,
  getDismissedAlerts,
  dismissAlert as dismissAlertStorage,
  screenNewTrade,
  pricesFromGammaMarket,
  unloadedManualMarketIds,
  priceManualPosition,
  findHeldMarkets,
  sameHeldMarkets,
  holdingsKey,
  structureKey,
  repriceWalletPosition,
} from '../PortfolioEngine';
import { fetchMarketById } from '../api';

const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

export function usePortfolio(loadedMarkets) {
  const [walletAddress, setWalletAddress] = useState(getStoredWallet);
  const [walletPositions, setWalletPositions] = useState([]);
  const [manualPositions, setManualPositions] = useState(getManualPositions);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [dismissedAlerts, setDismissedAlerts] = useState(getDismissedAlerts);
  const refreshTimerRef = useRef(null);
  const loadedMarketsRef = useRef(loadedMarkets);
  loadedMarketsRef.current = loadedMarkets;

  // Connect wallet
  const connectWallet = useCallback((address) => {
    setStoredWallet(address);
    setWalletAddress(address);
    setError(null);
  }, []);

  // Disconnect wallet
  const disconnectWallet = useCallback(() => {
    setStoredWallet(null);
    setWalletAddress(null);
    setWalletPositions([]);
    setError(null);
  }, []);

  // Fetch positions from API
  const refreshPositions = useCallback(async () => {
    if (!walletAddress) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchPositions(walletAddress);
      if (result.error) {
        setError(result.error);
        setWalletPositions([]);
      } else {
        const normalized = result.positions.map(normalizePosition);
        const matched = matchPositionsToMarkets(normalized, loadedMarketsRef.current);
        setWalletPositions(matched);
        setCachedPositions(matched);
      }
      setLastRefresh(new Date());
    } catch (e) {
      setError(e.message || 'Failed to fetch positions');
      setWalletPositions([]);
    } finally {
      setLoading(false);
    }
  }, [walletAddress]);

  // Load cached on mount, then refresh
  useEffect(() => {
    if (!walletAddress) return;
    const cached = getCachedPositions();
    if (cached && loadedMarkets.length > 0) {
      // Re-match cached positions with current loaded markets
      const rematched = matchPositionsToMarkets(cached, loadedMarkets);
      setWalletPositions(rematched);
    }
    if (loadedMarkets.length > 0) {
      refreshPositions();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress, loadedMarkets.length]);

  // Auto-refresh timer
  useEffect(() => {
    if (!walletAddress) return;
    refreshTimerRef.current = setInterval(() => {
      refreshPositions();
    }, REFRESH_INTERVAL);
    return () => clearInterval(refreshTimerRef.current);
  }, [walletAddress, refreshPositions]);

  // Add manual position
  const addManualPosition = useCallback((position) => {
    const updated = addManualPosStorage(position);
    setManualPositions([...updated]);
  }, []);

  // Remove manual position
  const removeManualPosition = useCallback((index) => {
    const updated = removeManualPosStorage(index);
    setManualPositions([...updated]);
  }, []);

  // The CURRENT objects of just the markets positions are in. Price ticks
  // (at most once a second) replace changed market objects (Immer), so this
  // is re-found whenever the markets array changes — one pass, and no work
  // at all without positions.
  // Keeps the previous lookup while no held market changed, so a tick on a
  // market nobody holds leaves allPositions and the analysis untouched.
  // A ref, not state adjusted during render: that loops forever if a caller
  // passes a fresh markets array each render. Worst case for the ref (a
  // discarded render) is reusing an equivalent lookup.
  const heldLookupRef = useRef(null);
  const heldLookup = useMemo(() => {
    const found = findHeldMarkets(walletPositions, manualPositions, loadedMarkets);
    const prev = heldLookupRef.current;
    heldLookupRef.current = prev && sameHeldMarkets(prev, found) ? prev : found;
    return heldLookupRef.current;
  }, [walletPositions, manualPositions, loadedMarkets]);

  // Manual positions whose market isn't in the catalog (resolved, or in an
  // event under the volume floor) would show the price saved when they were
  // added. Look those markets up directly instead: /markets/{id} returns
  // closed markets too. Settled prices are final, so fetched once; open
  // markets are re-fetched on the portfolio refresh interval.
  const [lookedUpPrices, setLookedUpPrices] = useState(() => new Map());
  const lookedUpRef = useRef(lookedUpPrices);
  lookedUpRef.current = lookedUpPrices;
  const [lookupTick, setLookupTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setLookupTick((n) => n + 1), REFRESH_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  // A string, so only a change in WHICH markets are unloaded re-runs the
  // lookup effect below
  const unloadedIdsKey = useMemo(
    () => unloadedManualMarketIds(manualPositions, heldLookup).join('\n'),
    [manualPositions, heldLookup],
  );
  const catalogSize = loadedMarkets.length;

  useEffect(() => {
    // Before the catalog loads, every market would look unloaded
    if (catalogSize === 0 || !unloadedIdsKey) return;
    const ids = unloadedIdsKey.split('\n').filter((id) => !lookedUpRef.current.get(id)?.closed);
    if (ids.length === 0) return;

    const ctrl = new AbortController();
    Promise.all(ids.map((id) => fetchMarketById(id, ctrl.signal)
      .then((res) => [id, pricesFromGammaMarket(res?.markets?.[0])])))
      .then((results) => {
        if (ctrl.signal.aborted) return;
        const found = results.filter(([, prices]) => prices);
        if (found.length === 0) return;
        setLookedUpPrices((prev) => {
          const next = new Map(prev);
          for (const [id, prices] of found) next.set(id, prices);
          return next;
        });
      });
    return () => ctrl.abort();
  }, [unloadedIdsKey, catalogSize, lookupTick]);

  // Merge all positions (wallet + manual), each priced from its market's current object
  const allPositions = useMemo(() => {
    const pricedWallet = walletPositions.map((p) => repriceWalletPosition(p, heldLookup));
    const matchedManual = manualPositions.map((mp) => priceManualPosition(mp, heldLookup, lookedUpPrices));
    return [...pricedWallet, ...matchedManual].filter((p) => p.market != null);
  }, [walletPositions, manualPositions, heldLookup, lookedUpPrices]);

  // Holdings as table rows see them: market, side, size. Keyed by content, so
  // the row-facing values below keep their identity across price ticks —
  // rows re-render when what you hold changes, not when its price moves.
  const holdingsJson = useMemo(() => holdingsKey(allPositions), [allPositions]);
  const holdings = useMemo(
    () => JSON.parse(holdingsJson).map(([marketId, side, size, source]) => ({ marketId, side, size, source })),
    [holdingsJson],
  );

  // Which markets on which side — what the correlation structure depends on
  // (not size: see structureKey)
  const structureJson = useMemo(() => structureKey(allPositions), [allPositions]);

  // Correlation analysis. The O(n²) part (correlation matrix and cluster
  // membership) doesn't depend on price or size, so it's rebuilt only when
  // the held markets or sides change; a price tick only re-prices (O(n)). Ref-cached for the
  // same reason as heldLookup above. Also rebuilt on a new day: its
  // date-proximity term reads daysLeft, which a long session would leave stale.
  const structureRef = useRef({ key: null, structure: null });
  const analysis = useMemo(() => {
    if (allPositions.length === 0) {
      return {
        clusters: [],
        correlationMatrix: [],
        concentration: {
          hhi: 0, effectiveBets: 0, largestClusterWeight: 0, largestClusterName: '',
          yesExposure: 0, noExposure: 0, sideImbalance: 0,
          diversificationScore: 0, diversificationLabel: 'No Positions',
        },
        alerts: [],
        positionSignals: new Map(),
      };
    }

    const key = `${structureJson}|${Math.floor(Date.now() / 86_400_000)}`;
    if (structureRef.current.key !== key) {
      structureRef.current = { key, structure: buildCorrelationStructure(allPositions) };
    }
    const { structure } = structureRef.current;
    const clusters = priceClusters(allPositions, structure);
    const concentration = calculateConcentration(allPositions, clusters);
    const alerts = generateAlerts(allPositions, clusters, concentration);

    // Per-position signals
    const positionSignals = new Map();
    for (let i = 0; i < allPositions.length; i++) {
      positionSignals.set(i, getPositionSignals(allPositions[i]));
    }

    return { clusters, correlationMatrix: structure.matrix, concentration, alerts, positionSignals };
  }, [allPositions, structureJson]);

  // Filter out dismissed alerts
  const activeAlerts = useMemo(() => {
    return analysis.alerts.filter((a) => !dismissedAlerts.includes(a.text));
  }, [analysis.alerts, dismissedAlerts]);

  // Dismiss an alert
  const handleDismissAlert = useCallback((alertText) => {
    dismissAlertStorage(alertText);
    setDismissedAlerts((prev) => [...prev, alertText]);
  }, []);

  // Screen a new trade. The detail panel and the Kelly calculator both ask
  // for the market on every render; results are cached per market until the
  // portfolio changes (each call is O(positions), but renders are frequent).
  // (analysis.clusters is rebuilt whenever allPositions changes, so it keys the cache.)
  const screenCacheRef = useRef({ clusters: null, byMarket: new Map() });
  const screenTrade = useCallback((market) => {
    if (screenCacheRef.current.clusters !== analysis.clusters) {
      screenCacheRef.current = { clusters: analysis.clusters, byMarket: new Map() };
    }
    // No ID → nothing safe to cache under (every such market would share 'undefined')
    if (market?.id == null) return screenNewTrade(market, allPositions, analysis.clusters);
    const { byMarket } = screenCacheRef.current;
    const key = String(market.id);
    if (!byMarket.has(key)) byMarket.set(key, screenNewTrade(market, allPositions, analysis.clusters));
    return byMarket.get(key);
  }, [allPositions, analysis.clusters]);

  // O(1) set of held market IDs for fast filter checks
  const heldMarketIds = useMemo(() => new Set(holdings.map((h) => h.marketId)), [holdings]);

  // A held market's side and size (not prices — use allPositions for those)
  const getHeldPosition = useCallback((marketId) => {
    return holdings.find((h) => h.marketId === String(marketId)) || null;
  }, [holdings]);

  // O(1) check — use this in hot paths (filtering)
  const isMarketHeld = useCallback((marketId) => {
    return heldMarketIds.has(String(marketId));
  }, [heldMarketIds]);

  const hasPortfolio = allPositions.length > 0;

  // What table rows read from PortfolioContext. Stable across price ticks
  // (see holdings above); the full portfolio, which does change with
  // prices, goes to the detail panel through its own context.
  const rowContext = useMemo(() => ({
    hasPortfolio, isMarketHeld, getHeldPosition, addManualPosition,
  }), [hasPortfolio, isMarketHeld, getHeldPosition, addManualPosition]);

  // Summary stats
  const summary = useMemo(() => {
    const totalValue = allPositions.reduce((s, p) => s + (p.currentValue || 0), 0);
    const totalPnl = allPositions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
    const inProfit = allPositions.filter((p) => (p.unrealizedPnl || 0) > 0).length;
    const winRate = allPositions.length > 0 ? (inProfit / allPositions.length) * 100 : 0;

    let largestPos = null;
    let largestValue = 0;
    for (const p of allPositions) {
      if ((p.currentValue || 0) > largestValue) {
        largestValue = p.currentValue;
        largestPos = p;
      }
    }

    return {
      totalPositions: allPositions.length,
      totalValue,
      totalPnl,
      winRate,
      largestPosition: largestPos,
      largestValue,
      isConcentrated: largestValue > 0 && totalValue > 0 && (largestValue / totalValue) > 0.25,
    };
  }, [allPositions]);

  // Memoize the return object so PortfolioContext consumers don't re-render
  // when the parent re-renders but no portfolio data actually changed.
  // Every field below is already reference-stable (useState, useCallback, useMemo).
  return useMemo(() => ({
    walletAddress,
    connectWallet,
    disconnectWallet,
    loading,
    error,
    lastRefresh,
    refreshPositions,
    allPositions,
    walletPositions,
    manualPositions,
    addManualPosition,
    removeManualPosition,
    analysis,
    activeAlerts,
    handleDismissAlert,
    summary,
    screenTrade,
    getHeldPosition,
    isMarketHeld,
    heldMarketIds,
    hasPortfolio,
    rowContext,
  }), [
    walletAddress, connectWallet, disconnectWallet, loading, error,
    lastRefresh, refreshPositions, allPositions, walletPositions,
    manualPositions, addManualPosition, removeManualPosition, analysis,
    activeAlerts, handleDismissAlert, summary, screenTrade,
    getHeldPosition, isMarketHeld, heldMarketIds, hasPortfolio, rowContext,
  ]);
}
