import { useState, useCallback, useEffect, useRef } from 'react';
import { fetchAllMarkets } from '../api';
import { enrichWithBaseRate } from '../processMarket';
import { processAllInWorker, terminateAnalysisWorker } from '../workerManager';
import { fetchResolvedMarkets, computeBaseRates } from '../BaseRateEngine';

// Plain map + identity check: enrichWithBaseRate returns the same reference
// when base rate is unchanged (short-circuit), so we only create a new array
// when at least one market was actually enriched.
function enrichMarketsUpdater(rates) {
  return (prev) => {
    let changed = false;
    const result = prev.map(m => {
      const enriched = enrichWithBaseRate(m, rates);
      if (enriched !== m) changed = true;
      return enriched;
    });
    return changed ? result : prev;
  };
}

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
      // Start base rate fetch in parallel with market fetch
      const baseRatePromise = !baseRatesRef.current
        ? fetchResolvedMarkets(controller.signal)
            .then(({ resolvedMarkets }) => computeBaseRates(resolvedMarkets))
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
              return null;
            })
        : Promise.resolve(baseRatesRef.current);

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

      // Wait for base rates (with a timeout so we don't block forever)
      const raceResult = await Promise.race([
        baseRatePromise,
        new Promise(resolve => setTimeout(() => resolve(null), 5000))  // 5s timeout
      ]);

      if (controller.signal.aborted) return;

      if (raceResult) {
        // Base rates arrived in time — enrich before first render
        baseRatesRef.current = raceResult;
        const enriched = processed.map(m => enrichWithBaseRate(m, raceResult));
        setRawMarkets(enriched);
        setLastFetch(new Date());
        setBaseRatesLoading(false);
      } else {
        // Fallback: display immediately, enrich when base rates arrive
        setRawMarkets(processed);
        setLastFetch(new Date());
        setBaseRatesLoading(true);
        baseRatePromise.then(rates => {
          // Use controllerRef.current (not captured `controller`) to avoid
          // stale closure if loadMarkets was called again while pending.
          if (rates && controllerRef.current === controller && !controller.signal.aborted) {
            baseRatesRef.current = rates;
            setRawMarkets(enrichMarketsUpdater(rates));
            setBaseRatesLoading(false);
          }
        });
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
