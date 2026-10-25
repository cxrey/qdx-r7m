import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  fetchPositions,
  normalizePosition,
  matchPositionsToMarkets,
  buildCorrelationClusters,
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

  // Pre-build lookup maps for O(1) manual position matching
  // Keyed on loadedMarkets.length — only rebuilds when markets are added/removed,
  // not on every Immer price-tick reference change (~7/sec).
  const marketLookup = useMemo(() => {
    const markets = loadedMarketsRef.current;
    const byId = new Map();
    const byCondition = new Map();
    for (const m of markets) {
      byId.set(String(m.id), m);
      if (m.conditionId) byCondition.set(m.conditionId, m);
    }
    return { byId, byCondition };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedMarkets.length]);

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

  useEffect(() => {
    // Before the catalog loads, every market would look unloaded
    if (marketLookup.byId.size === 0) return;
    const ids = unloadedManualMarketIds(manualPositions, marketLookup)
      .filter((id) => !lookedUpRef.current.get(id)?.closed);
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
  }, [manualPositions, marketLookup, lookupTick]);

  // Merge all positions (wallet + manual), match manuals to markets
  const allPositions = useMemo(() => {
    const matchedManual = manualPositions.map((mp) => priceManualPosition(mp, marketLookup, lookedUpPrices));
    return [...walletPositions, ...matchedManual].filter((p) => p.market != null);
  }, [walletPositions, manualPositions, marketLookup, lookedUpPrices]);

  // Correlation analysis
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

    const { clusters, correlationMatrix } = buildCorrelationClusters(allPositions);
    const concentration = calculateConcentration(allPositions, clusters);
    const alerts = generateAlerts(allPositions, clusters, concentration);

    // Per-position signals
    const positionSignals = new Map();
    for (let i = 0; i < allPositions.length; i++) {
      positionSignals.set(i, getPositionSignals(allPositions[i]));
    }

    return { clusters, correlationMatrix, concentration, alerts, positionSignals };
  }, [allPositions]);

  // Filter out dismissed alerts
  const activeAlerts = useMemo(() => {
    return analysis.alerts.filter((a) => !dismissedAlerts.includes(a.text));
  }, [analysis.alerts, dismissedAlerts]);

  // Dismiss an alert
  const handleDismissAlert = useCallback((alertText) => {
    dismissAlertStorage(alertText);
    setDismissedAlerts((prev) => [...prev, alertText]);
  }, []);

  // Screen a new trade
  const screenTrade = useCallback((market) => {
    return screenNewTrade(market, allPositions, analysis.clusters);
  }, [allPositions, analysis.clusters]);

  // O(1) set of held market IDs for fast filter checks
  const heldMarketIds = useMemo(() => {
    const set = new Set();
    for (const p of allPositions) {
      if (p.market) set.add(String(p.market.id));
    }
    return set;
  }, [allPositions]);

  // Check if a market is held
  const getHeldPosition = useCallback((marketId) => {
    return allPositions.find((p) => p.market && String(p.market.id) === String(marketId));
  }, [allPositions]);

  // O(1) check — use this in hot paths (filtering)
  const isMarketHeld = useCallback((marketId) => {
    return heldMarketIds.has(String(marketId));
  }, [heldMarketIds]);

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
    hasPortfolio: allPositions.length > 0,
  }), [
    walletAddress, connectWallet, disconnectWallet, loading, error,
    lastRefresh, refreshPositions, allPositions, walletPositions,
    manualPositions, addManualPosition, removeManualPosition, analysis,
    activeAlerts, handleDismissAlert, summary, screenTrade,
    getHeldPosition, isMarketHeld, heldMarketIds,
  ]);
}
