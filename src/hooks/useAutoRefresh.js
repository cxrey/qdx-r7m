import { useState, useEffect, useRef, useCallback } from 'react';
import { produce } from 'immer';
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
    try { return localStorage.getItem(LS_KEY) === 'true'; } catch { return false; }
  });
  const [wsStatus, setWsStatus] = useState('disconnected'); // 'connecting'|'connected'|'disconnected'|'polling'|'error'
  const [toasts, setToasts] = useState([]);                  // [{id, type, message, ts}]
  const [priceFlashes, setPriceFlashes] = useState({});      // {marketId: 'up'|'down'}
  const [statusMessage, setStatusMessage] = useState(null);

  const managerRef = useRef(null);
  const marketsRef = useRef(rawMarkets);
  marketsRef.current = rawMarkets;

  // Index map: marketId → array index for O(1) price update lookups
  const indexMapRef = useRef(new Map());

  // Toast management
  const addToast = useCallback((toast) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-4), { ...toast, id, ts: Date.now() }]);
    // Auto-remove after 5 seconds
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Price flash management
  const triggerFlash = useCallback((marketId, direction) => {
    setPriceFlashes((prev) => ({ ...prev, [marketId]: direction }));
    setTimeout(() => {
      setPriceFlashes((prev) => {
        const next = { ...prev };
        delete next[marketId];
        return next;
      });
    }, 800);
  }, []);

  // Initialize manager
  useEffect(() => {
    const manager = new RefreshManager({
      onPriceUpdate: (updates) => {
        // updates: Map<marketId, {yesPrice?, noPrice?}>
        setRawMarkets((prev) => {
          // Rebuild index map if stale (different array length or first use)
          const idxMap = indexMapRef.current;
          if (idxMap.size === 0 || idxMap.size !== prev.length) {
            idxMap.clear();
            for (let i = 0; i < prev.length; i++) {
              idxMap.set(prev[i].id, i);
            }
          }

          // Use Immer for structural sharing — only touched entries create new refs
          let changed = false;
          const next = produce(prev, (draft) => {
            for (const [marketId, update] of updates) {
              const idx = idxMap.get(marketId);
              if (idx == null) continue;

              const m = draft[idx];
              const newYes = update.yesPrice ?? m.yesPrice;
              const newNo = update.noPrice ?? m.noPrice;

              if (newYes === m.yesPrice && newNo === m.noPrice) continue;

              changed = true;
              if (newYes !== m.yesPrice) {
                triggerFlash(marketId, newYes > m.yesPrice ? 'up' : 'down');
              }
              m.yesPrice = newYes;
              m.noPrice = newNo;
            }
          });
          return changed ? next : prev;
        });
      },

      onNewMarkets: (newMarkets) => {
        const prev = marketsRef.current;
        const existingIds = new Set(prev.map((m) => m.id));
        const toAdd = newMarkets.filter((m) => !existingIds.has(m.id));
        if (toAdd.length === 0) return;

        setRawMarkets((prevState) => [...prevState, ...toAdd]);

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
  };
}
