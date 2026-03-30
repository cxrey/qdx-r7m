import { useState, useEffect, useRef, useCallback } from 'react';
import { RefreshManager } from '../RefreshManager';

const LS_KEY = 'polymarket-scanner-auto-refresh';

/**
 * useAutoRefresh — React hook that wires RefreshManager into the app.
 *
 * @param {object} opts
 * @param {object[]} opts.rawMarkets       — current market array
 * @param {function} opts.setRawMarkets    — state setter for markets
 * @param {object}   opts.baseRatesRef     — ref to base rates data
 * @param {function} opts.refresh          — manual refresh function (for Tier 3 timer reset)
 */
export function useAutoRefresh({ rawMarkets, setRawMarkets, baseRatesRef, refresh }) {
  const [enabled, setEnabled] = useState(() => {
    try {
      const saved = localStorage.getItem(LS_KEY);
      return saved !== null ? saved === 'true' : true; // default ON if no saved preference
    } catch { return true; }
  });
  const [wsStatus, setWsStatus] = useState('disconnected'); // 'connecting'|'connected'|'disconnected'|'polling'|'error'
  const [toasts, setToasts] = useState([]);                  // [{id, type, message, ts}]
  const [priceFlashes, setPriceFlashes] = useState({});      // {marketId: 'up'|'down'}
  const [statusMessage, setStatusMessage] = useState(null);

  const managerRef = useRef(null);
  const marketsRef = useRef(rawMarkets);
  marketsRef.current = rawMarkets;

  // Dirty flag: set true when a price update arrives.
  // Read by App.jsx's throttle to skip filterAndSort when idle.
  const pricesDirtyRef = useRef(false);

  // Accumulated price updates — written by onPriceUpdate, drained by App.jsx throttle.
  // Avoids Immer produce() on every 150ms batcher flush (was the primary memory leak).
  const pendingPriceUpdatesRef = useRef(new Map());

  // Index map: marketId → array index for O(1) flash direction lookups
  const indexMapRef = useRef(new Map());

  // Toast management — track timeout IDs for cleanup on unmount
  const toastTimersRef = useRef(new Set());
  const addToast = useCallback((toast) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-4), { ...toast, id, ts: Date.now() }]);
    const timer = setTimeout(() => {
      toastTimersRef.current.delete(timer);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
    toastTimersRef.current.add(timer);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Initialize manager
  useEffect(() => {
    const manager = new RefreshManager({
      onPriceUpdate: (updates) => {
        // Accumulate into ref — no Immer, no setRawMarkets, no re-render.
        // App.jsx's throttle drains pendingPriceUpdatesRef once per tick.
        const flashBatch = {};

        for (const [marketId, update] of updates) {
          // Determine flash direction BEFORE accumulating.
          // Compare against pending ref first (captures intra-window changes),
          // then fall back to current displayed price.
          if (update.yesPrice != null) {
            const pending = pendingPriceUpdatesRef.current.get(marketId);
            const currentYes = pending?.yesPrice
              ?? marketsRef.current[indexMapRef.current.get(marketId)]?.yesPrice;

            if (currentYes != null && update.yesPrice !== currentYes) {
              flashBatch[marketId] = update.yesPrice > currentYes ? 'up' : 'down';
            }
          }

          // Accumulate into pending ref — no state update, no Immer
          const existing = pendingPriceUpdatesRef.current.get(marketId);
          if (existing) {
            if (update.yesPrice != null) existing.yesPrice = update.yesPrice;
            if (update.noPrice != null) existing.noPrice = update.noPrice;
          } else {
            pendingPriceUpdatesRef.current.set(marketId, { ...update });
          }
        }

        pricesDirtyRef.current = true;

        // One setPriceFlashes call for the entire batch
        if (Object.keys(flashBatch).length > 0) {
          setPriceFlashes(prev => ({ ...prev, ...flashBatch }));

          // One setTimeout to clear this entire batch
          const flashIds = Object.keys(flashBatch);
          setTimeout(() => {
            setPriceFlashes(prev => {
              const next = { ...prev };
              for (const id of flashIds) {
                delete next[id];
              }
              return next;
            });
          }, 800);
        }
      },

      onNewMarkets: (newMarkets) => {
        const prev = marketsRef.current;
        const existingIds = new Set(prev.map((m) => m.id));
        const toAdd = newMarkets.filter((m) => !existingIds.has(m.id));
        if (toAdd.length === 0) return;

        setRawMarkets((prevState) => [...prevState, ...toAdd]);

        // Immediately update ref so getCurrentMarkets() sees new markets
        // before React re-renders. Prevents duplicate Tier 2 discovery.
        marketsRef.current = [...marketsRef.current, ...toAdd];

        // Append to index map immediately (don't clear + wait for rebuild)
        const idxMap = indexMapRef.current;
        const baseIndex = prev.length;
        toAdd.forEach((m, offset) => {
          if (m.id) idxMap.set(m.id, baseIndex + offset);
        });
      },

      onFullRefresh: (processed) => {
        const idxMap = indexMapRef.current;
        idxMap.clear();
        for (let i = 0; i < processed.length; i++) {
          idxMap.set(processed[i].id, i);
        }
        setRawMarkets(processed);
      },

      onResolution: (marketId) => {
        // Could remove or mark — for now, just log
        console.log(`[AutoRefresh] Market resolved: ${marketId}`);
      },

      onStatusChange: ({ ws, message }) => {
        setWsStatus(ws);
        setStatusMessage(message);
      },

      onToast: addToast,

      getCurrentMarkets: () => marketsRef.current,
      baseRatesRef,
    });

    managerRef.current = manager;

    return () => {
      manager.destroy();
      managerRef.current = null;
      // Cancel pending toast auto-remove timers
      for (const t of toastTimersRef.current) clearTimeout(t);
      toastTimersRef.current.clear();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Start/stop based on enabled state
  useEffect(() => {
    const manager = managerRef.current;
    if (!manager) return;

    if (enabled) {
      manager.start();
      // Rebuild asset index with current markets
      manager.rebuildAssetIndex(marketsRef.current);
    } else {
      manager.stop();
    }
  }, [enabled]);

  // Rebuild asset index when markets change significantly (new load)
  const prevMarketCountRef = useRef(0);
  useEffect(() => {
    const manager = managerRef.current;
    if (!manager || !enabled) return;

    // Only rebuild if market count changed by more than 10 (new load, not incremental)
    const countDiff = Math.abs(rawMarkets.length - prevMarketCountRef.current);
    if (countDiff > 10) {
      manager.rebuildAssetIndex(rawMarkets);
    }
    prevMarketCountRef.current = rawMarkets.length;
  }, [rawMarkets.length, enabled]);

  // Toggle auto-refresh
  const toggleEnabled = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      try { localStorage.setItem(LS_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Reset Tier 3 timer when manual refresh is triggered
  const handleManualRefresh = useCallback(() => {
    if (managerRef.current && enabled) {
      managerRef.current.resetTier3Timer();
    }
    refresh();
  }, [refresh, enabled]);

  return {
    autoRefreshEnabled: enabled,
    toggleAutoRefresh: toggleEnabled,
    wsStatus,
    statusMessage,
    toasts,
    removeToast,
    priceFlashes,
    handleManualRefresh,
    pricesDirtyRef,
    pendingPriceUpdatesRef,
  };
}
