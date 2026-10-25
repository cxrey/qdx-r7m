import { useState, useEffect, useRef, useCallback } from 'react';
import { RefreshManager } from '../RefreshManager';
import { mergePendingPrice } from '../utils/pendingPrices';

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
        // App.jsx's throttle drains pendingPriceUpdatesRef once per tick and
        // derives price flashes there, so a 150ms batcher flush never renders.
        for (const [marketId, update] of updates) {
          mergePendingPrice(pendingPriceUpdatesRef.current, marketId, update);
        }

        pricesDirtyRef.current = true;
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
      },

      onFullRefresh: (processed) => {
        setRawMarkets(processed);
      },

      onResolution: (marketId) => {
        // Mark closed so the row stops looking tradeable; settled prices
        // (1/0) arrive via onPriceUpdate. The next Tier-3 crawl removes it.
        // Patch only the matching row; return prev untouched when the market
        // isn't loaded so consumers keyed on rawMarkets don't recompute.
        setRawMarkets((prev) => {
          const idx = prev.findIndex((m) => m.id === marketId);
          if (idx === -1 || prev[idx].closed) return prev;
          const next = prev.slice();
          next[idx] = { ...prev[idx], closed: true, active: false };
          return next;
        });
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
    handleManualRefresh,
    pricesDirtyRef,
    pendingPriceUpdatesRef,
  };
}
