import { useState, useEffect, useMemo } from 'react';
import { searchActiveMarkets } from '../api';
import { detectMarketLink } from '../utils/detectMarketLink';
import { processMarket, enrichWithBaseRate } from '../processMarket';

// Shorter queries match too loosely to be worth a request
export const MIN_REMOTE_QUERY = 3;
const NO_MARKETS = [];
const IDLE = { query: '', markets: NO_MARKETS, loading: false, error: null };

function processResult(raw, baseRates) {
  try {
    const processed = processMarket(raw);
    if (!processed?.question) return null;
    const enriched = baseRates ? enrichWithBaseRate(processed, baseRates) : processed;
    return { ...enriched, _fromSearch: true };
  } catch (err) {
    console.warn('[RemoteSearch] processMarket failed for', raw?.id, err);
    return null;
  }
}

/**
 * Text search across ALL of Polymarket's active markets, not just the loaded
 * catalog: events below the catalog's volume floor are never loaded, so a
 * search of the loaded set alone can't find them. The results are processed
 * like loaded markets and are meant to be filtered together with them — the
 * same text match and the same filters apply.
 *
 * Links and IDs are not searched here (useDirectLookup handles those).
 *
 * @param {string} query — the debounced search text
 * @param {{ current: object|null }} baseRatesRef
 * @returns {{ query: string, markets: object[], loading: boolean, error: string|null }}
 */
export function useRemoteSearch(query, baseRatesRef) {
  // The last finished search: { query, markets, error }. Loading and idle
  // states are derived from the current query, not stored.
  const [result, setResult] = useState(null);
  const q = (query ?? '').trim();
  const active = q.length >= MIN_REMOTE_QUERY && detectMarketLink(q).type === 'TEXT';

  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    const failed = { query: q, markets: NO_MARKETS, error: 'Polymarket search failed — showing loaded markets only' };
    searchActiveMarkets(q, controller.signal)
      .then((raw) => {
        if (controller.signal.aborted) return;
        if (raw == null) { setResult(failed); return; }
        const baseRates = baseRatesRef?.current ?? null;
        const markets = raw.map((m) => processResult(m, baseRates)).filter(Boolean);
        setResult({ query: q, markets, error: null });
      })
      .catch((err) => {
        if (err?.name === 'AbortError' || controller.signal.aborted) return;
        setResult(failed);
      });
    return () => controller.abort();
  }, [q, active, baseRatesRef]);

  return useMemo(() => {
    if (!active) return IDLE;
    if (!result || result.query !== q) return { query: q, markets: NO_MARKETS, loading: true, error: null };
    return { ...result, loading: false };
  }, [active, q, result]);
}
