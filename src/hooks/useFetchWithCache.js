import { useState, useCallback, useRef, useEffect } from 'react';
import { isClobRateLimited } from '../clobRateLimit';
import { handleClobError, rateLimitMessage } from '../clobErrorHandler';

/**
 * Module-level TTL cache shared across all hook instances.
 * Keys are caller-provided strings; values are { data, ts, ttl }.
 */
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > entry.ttl) { cache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data, ttl) {
  cache.set(key, { data, ts: Date.now(), ttl });
}

// Export for tests / external use
export { cacheGet, cacheSet };

/**
 * useFetchWithCache — eliminates the repeated fetch+cache+loading+error pattern.
 *
 * @param {object} opts
 * @param {string}   opts.cacheKey   — cache lookup key (null to skip caching)
 * @param {number}   opts.cacheTtl   — TTL in ms (default 60000)
 * @param {function} opts.fetcher    — async () => data. Throw to signal error.
 * @param {function} [opts.onSuccess] — (data) => void, called after fetch succeeds
 * @param {boolean}  [opts.clobProtected] — CLOB requests (default true): skipped while the CLOB
 *   rate-limit breaker is open, and a 429/403 opens it. Pass false for other APIs (e.g. the
 *   Data API's price history), whose rate limits shouldn't pause CLOB requests.
 * @returns {{ data, loading, error, refetch }}
 */
export function useFetchWithCache({
  cacheKey, cacheTtl = 60000, fetcher, onSuccess, clobProtected = true,
}) {
  const [data, setData] = useState(() => cacheKey ? cacheGet(cacheKey) : null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refetch = useCallback(async () => {
    // Check cache first
    if (cacheKey) {
      const cached = cacheGet(cacheKey);
      if (cached) {
        setData(cached);
        setError(null);
        onSuccess?.(cached);
        return;
      }
    }

    // Rate limit guard
    if (clobProtected && isClobRateLimited()) {
      setError('CLOB API rate limited — try again later');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await fetcher();
      if (!mountedRef.current) return;
      setData(result);
      if (result && cacheKey) cacheSet(cacheKey, result, cacheTtl);
      onSuccess?.(result);
    } catch (err) {
      if (!mountedRef.current) return;
      if (clobProtected && handleClobError(err)) {
        setError(rateLimitMessage(err.status));
        return;
      }
      if (err?.status === 429 || err?.status === 403) {
        setError('Rate limited — try again shortly');
        return;
      }
      setError(err?.message || 'Request failed');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [cacheKey, cacheTtl, fetcher, onSuccess, clobProtected]);

  return { data, loading, error, refetch };
}
