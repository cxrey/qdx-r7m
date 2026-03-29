import { useState, useCallback, useEffect, useRef } from 'react';
import { fetchAllMarkets } from '../api';
import { enrichWithBaseRate } from '../processMarket';
import { processAllInWorker, terminateAnalysisWorker } from '../workerManager';
import { fetchResolvedMarkets, computeBaseRates } from '../BaseRateEngine';

export function useMarkets() {
  const [rawMarkets, setRawMarkets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(0);
  const [lastFetch, setLastFetch] = useState(null);
  const [baseRatesLoading, setBaseRatesLoading] = useState(false);
  const [gammaRateLimited, setGammaRateLimited] = useState(false);
  const controllerRef = useRef(null);
  const baseRatesRef = useRef(null);
  const gammaTimerRef = useRef(null);

  const loadMarkets = useCallback(async () => {
    if (controllerRef.current) controllerRef.current.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setLoading(true);
    setError(null);
    setProgress(0);

    try {
      // Retry wrapper — covers total-level failures (network down, DNS)
      let raw = null;
      let fetchAttempt = 0;
      const maxFetchRetries = 2;

      while (fetchAttempt <= maxFetchRetries) {
        if (controller.signal.aborted) break;
        try {
          raw = await fetchAllMarkets(
            (count) => { if (!controller.signal.aborted) setProgress(count); },
            controller.signal
          );
          if (raw && raw.length > 0) break; // success
        } catch (e) {
          if (e.name === 'AbortError') break;
          console.warn(`[useMarkets] Fetch attempt ${fetchAttempt + 1} failed:`, e.message);
        }
        fetchAttempt++;
        if (fetchAttempt <= maxFetchRetries) {
          setProgress(0); // reset progress bar for retry
          await new Promise(r => setTimeout(r, 2000)); // 2s delay before retry
        }
      }

      if (!raw || raw.length === 0) {
        if (!controller.signal.aborted) {
          setError('Failed to fetch markets after multiple attempts. Click Refresh to try again.');
        }
        return;
      }

      if (controller.signal.aborted) return;

      // Deduplicate by market ID
      const seen = new Set();
      const deduped = raw.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });

      if (controller.signal.aborted) return;
      const allProcessed = await processAllInWorker(deduped);
      if (controller.signal.aborted) return;
      const processed = allProcessed.filter((m) => m.question);
      setRawMarkets(processed);
      setLastFetch(new Date());

      // Background: fetch resolved markets and enrich with base rates
      if (!baseRatesRef.current) {
        setBaseRatesLoading(true);
        fetchResolvedMarkets(controller.signal)
          .then(({ resolvedMarkets }) => {
            if (controller.signal.aborted) return;
            const rates = computeBaseRates(resolvedMarkets);
            baseRatesRef.current = rates;

            // Re-enrich markets with base rate data
            setRawMarkets((prev) => prev.map((m) => enrichWithBaseRate(m, rates)));
          })
          .catch((e) => {
            if (e.name !== 'AbortError') {
              if (e?.status === 429) {
                setGammaRateLimited(true);
                if (gammaTimerRef.current) clearTimeout(gammaTimerRef.current);
                gammaTimerRef.current = setTimeout(() => {
                  gammaTimerRef.current = null;
                  setGammaRateLimited(false);
                }, 30_000);
                console.warn('[useMarkets] Gamma API rate limited during base rate fetch');
              } else {
                console.warn('[useMarkets] Base rate fetch failed:', e.message);
              }
            }
          })
          .finally(() => setBaseRatesLoading(false));
      } else {
        // Already have base rates, enrich immediately
        const rates = baseRatesRef.current;
        setRawMarkets((prev) => prev.map((m) => enrichWithBaseRate(m, rates)));
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (!controller.signal.aborted) setError(err.message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMarkets();
    return () => {
      if (controllerRef.current) controllerRef.current.abort();
      if (gammaTimerRef.current) clearTimeout(gammaTimerRef.current);
      terminateAnalysisWorker();
    };
  }, [loadMarkets]);

  return { rawMarkets, setRawMarkets, loading, error, progress, lastFetch, baseRatesLoading, gammaRateLimited, refresh: loadMarkets, baseRatesRef };
}
