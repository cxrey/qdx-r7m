import { useState, useCallback, useRef, useEffect } from 'react';
import { detectMarketLink } from '../utils/detectMarketLink';
import {
  fetchMarketById,
  fetchMarketBySlug,
  fetchMarketByConditionId,
  fetchMarketByTokenId,
} from '../api';
import { processMarket, enrichWithBaseRate } from '../processMarket';

/**
 * Hook that manages direct market lookup by URL/slug/ID.
 *
 * @param {Array} rawMarkets - The loaded markets array
 * @param {Object|null} baseRatesRef - Ref to base rates data (or null)
 * @returns {Object} lookup state and actions
 */
export function useDirectLookup(rawMarkets, baseRatesRef) {
  // Detection result from the last input
  const [detection, setDetection] = useState(null);
  // Fetched markets from API (not found in loaded data)
  const [fetchedMarkets, setFetchedMarkets] = useState([]);
  // The ID of a market found in loaded data
  const [foundInLoadedId, setFoundInLoadedId] = useState(null);
  // Loading state
  const [lookupLoading, setLookupLoading] = useState(false);
  // Error message
  const [lookupError, setLookupError] = useState(null);

  const abortRef = useRef(null);
  const debounceRef = useRef(null);

  /**
   * Search loaded markets for a match.
   */
  const searchLoaded = useCallback(
    (det) => {
      const { type, extracted } = det;

      for (const m of rawMarkets) {
        // Slug matching
        if (
          type === 'EVENT_URL' ||
          type === 'MARKET_URL' ||
          type === 'SCAN_URL' ||
          type === 'SLUG'
        ) {
          const slug = extracted.toLowerCase();
          // Exact slug match
          if (m.slug && m.slug.toLowerCase() === slug) return m;
          // Partial: loaded slug is prefix of pasted slug (trailing numeric IDs)
          if (m.slug && slug.startsWith(m.slug.toLowerCase())) return m;
          // Partial: pasted slug is prefix of loaded slug
          if (m.slug && m.slug.toLowerCase().startsWith(slug)) return m;
          // Sanitized title match
          const sanitized = m.question
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '-');
          if (sanitized === slug || slug.startsWith(sanitized)) return m;
        }

        // Market ID matching
        if (type === 'MARKET_ID') {
          if (String(m.id) === extracted) return m;
        }

        // Token ID / Condition ID matching
        if (type === 'TOKEN_ID') {
          if (m.conditionId && String(m.conditionId) === extracted) return m;
          if (m.condition_id && String(m.condition_id) === extracted) return m;
          if (
            m.clobTokenIds &&
            m.clobTokenIds.some((t) => String(t) === extracted)
          )
            return m;
        }
      }

      return null;
    },
    [rawMarkets]
  );

  /**
   * Process raw API market through the full pipeline with graceful fallback.
   */
  const processApiMarket = useCallback(
    (raw) => {
      try {
        const processed = processMarket(raw);
        // Enrich with base rate if available
        if (baseRatesRef?.current) {
          try {
            const enriched = enrichWithBaseRate(processed, baseRatesRef.current);
            return { ...enriched, _fromLookup: true };
          } catch {
            // Defense-in-depth: if enrichWithBaseRate throws despite its
            // own try-catch, fall through to return the un-enriched market.
          }
        }
        return { ...processed, _fromLookup: true };
      } catch (err) {
        console.warn('[DirectLookup] processMarket failed for', raw.id, err);
        // Return a minimal object so we can still display something
        return {
          id: raw.id,
          question: raw.question || raw.title || 'Untitled',
          slug: raw.slug || '',
          description: raw.description || '',
          yesPrice: null,
          noPrice: null,
          volume: parseFloat(raw.volume || 0),
          volume24hr: parseFloat(raw.volume24hr || 0),
          daysLeft: null,
          endDate: 'N/A',
          category: 'Other',
          edgeScore: 0,
          spread: null,
          flb: null,
          theta: null,
          resolutionAnalysis: null,
          volumeEfficiency: null,
          baseRate: null,
          clobTokenIds: [],
          active: raw.active,
          closed: raw.closed,
          _fromLookup: true,
        };
      }
    },
    [baseRatesRef]
  );

  /**
   * Fetch from API based on detection type.
   */
  const fetchFromApi = useCallback(
    async (det, signal) => {
      const { type, extracted } = det;

      if (type === 'MARKET_ID') {
        return fetchMarketById(extracted, signal);
      }
      if (
        type === 'EVENT_URL' ||
        type === 'MARKET_URL' ||
        type === 'SCAN_URL' ||
        type === 'SLUG'
      ) {
        return fetchMarketBySlug(extracted, signal);
      }
      if (type === 'TOKEN_ID') {
        // Try condition_id first, then token_id
        const result = await fetchMarketByConditionId(extracted, signal);
        if (result) return result;
        return fetchMarketByTokenId(extracted, signal);
      }
      return null;
    },
    []
  );

  /**
   * Run the full detection + lookup pipeline.
   * Called immediately on paste, or after debounce on typing.
   */
  const runLookup = useCallback(
    (inputValue, immediate = false) => {
      // Cancel any in-flight request
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }

      // Clear state if input is empty
      if (!inputValue || !inputValue.trim()) {
        setDetection(null);
        setFetchedMarkets([]);
        setFoundInLoadedId(null);
        setLookupLoading(false);
        setLookupError(null);
        return;
      }

      const det = detectMarketLink(inputValue);

      // Not a link — clear lookup state, let normal search handle it
      if (det.type === 'TEXT') {
        setDetection(null);
        setFetchedMarkets([]);
        setFoundInLoadedId(null);
        setLookupLoading(false);
        setLookupError(null);
        return;
      }

      setDetection(det);
      setLookupError(null);

      // Step 1: search loaded data
      const found = searchLoaded(det);
      if (found) {
        setFoundInLoadedId(found.id);
        setFetchedMarkets([]);
        setLookupLoading(false);
        return;
      }

      setFoundInLoadedId(null);

      // Step 2: fetch from API (with debounce for rapid input, immediate for paste)
      const doFetch = async () => {
        const controller = new AbortController();
        abortRef.current = controller;
        setLookupLoading(true);
        setFetchedMarkets([]);

        try {
          const result = await fetchFromApi(det, controller.signal);
          if (controller.signal.aborted) return;

          if (result && result.markets && result.markets.length > 0) {
            const processed = result.markets.map((m) => processApiMarket(m));
            setFetchedMarkets(processed);
            setLookupError(null);
          } else {
            setFetchedMarkets([]);
            setLookupError(
              'No market found for this link. It may have been removed or the URL may be incorrect.'
            );
          }
        } catch (err) {
          if (err.name === 'AbortError') return;
          setLookupError('Failed to look up market. Please try again.');
        } finally {
          if (!controller.signal.aborted) setLookupLoading(false);
        }
      };

      if (immediate) {
        doFetch();
      } else {
        debounceRef.current = setTimeout(doFetch, 500);
      }
    },
    [searchLoaded, fetchFromApi, processApiMarket]
  );

  /**
   * Clear all lookup state (called when search bar is cleared).
   */
  const clearLookup = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setDetection(null);
    setFetchedMarkets([]);
    setFoundInLoadedId(null);
    setLookupLoading(false);
    setLookupError(null);
  }, []);

  // Cleanup on unmount — cancel pending debounce/fetch
  useEffect(() => clearLookup, [clearLookup]);

  return {
    // State
    detection,         // { type, extracted, outcomeId } or null
    fetchedMarkets,    // Array of processed markets from API
    foundInLoadedId,   // ID of market found in loaded data, or null
    lookupLoading,     // Boolean
    lookupError,       // String or null
    isLookupActive: detection !== null,

    // Actions
    runLookup,
    clearLookup,
  };
}
