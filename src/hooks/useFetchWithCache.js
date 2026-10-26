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
 * @returns {{ data, loading, error, refetch }} — refetch({ force: true }) skips the cache
 *   (e.g. a Refresh button); plain refetch() serves a fresh cache entry.
 */
export function useFetchWithCache({
  cacheKey, cacheTtl = 60000, fetcher, onSuccess, clobProtected = true,
}) {
  // Data is tied to the key it was fetched for. After the key changes (a
  // Yes/No or timeframe switch) the previous key's data is never returned as
  // the new key's: the new key's cache entry is shown at once if there is
  // one, otherwise null until it loads. (Returning the old data meant a
  // consumer saw the new key with the old side's prices for a moment.)
  const [entry, setEntry] = useState(() => ({ key: cacheKey, data: cacheKey ? cacheGet(cacheKey) : null }));
  const data = entry.key === cacheKey ? entry.data : (cacheKey ? cacheGet(cacheKey) : null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const mountedRef = useRef(true);
  // Only the latest refetch may update state: a slow response for an earlier
  // key (e.g. a 1Y history after the user switched to 7D) must not land on top.
  const seqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refetch = useCallback(async (opts) => {
    const seq = ++seqRef.current;
    const key = cacheKey;
    const isLatest = () => mountedRef.current && seq === seqRef.current;

    // Check cache first, unless forced. (`opts` may be a click event when
    // refetch is used directly as a handler — only an explicit force counts.)
    const force = opts?.force === true;
    if (key && !force) {
      const cached = cacheGet(key);
      if (cached) {
        setEntry({ key, data: cached });
        setError(null);
        setLoading(false); // supersedes any request still in flight
        onSuccess?.(cached);
        return;
      }
    }

    // Rate limit guard
    if (clobProtected && isClobRateLimited()) {
      setError('CLOB API rate limited — try again later');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await fetcher();
      // A result is valid for the key it was fetched for, even if it's no longer current
      if (result && key) cacheSet(key, result, cacheTtl);
      if (!isLatest()) return;
      setEntry({ key, data: result });
      onSuccess?.(result);
    } catch (err) {
      // An outdated request's rate limit is still real: record it either way
      const clobLimited = clobProtected && handleClobError(err);
      if (!isLatest()) return;
      if (clobLimited) {
        setError(rateLimitMessage(err.status));
        return;
      }
      if (err?.status === 429 || err?.status === 403) {
        setError('Rate limited — try again shortly');
        return;
      }
      setError(err?.message || 'Request failed');
    } finally {
      if (isLatest()) setLoading(false);
    }
  }, [cacheKey, cacheTtl, fetcher, onSuccess, clobProtected]);

  return { data, loading, error, refetch };
}
