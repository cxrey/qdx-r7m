/**
 * The market detail panel's data requests — its chart timeframes, cache keys
 * and fetchers — in one place, so the hover prefetch warms exactly what the
 * panel reads (same request, same cache key) instead of fetching look-alikes
 * nobody uses.
 */

import { fetchPriceHistory } from './api';

// fidelity = bucket size in minutes. The Data API's price history caps
// buckets at 1 day (1440), so the long views use daily points.
export const TIMEFRAMES = [
  { label: '1D', interval: '1d', fidelity: 60 },
  { label: '7D', interval: '1w', fidelity: 1440 },
  { label: '30D', interval: '1m', fidelity: 1440 },
  { label: '90D', useTs: true, days: 90, fidelity: 1440 },
  { label: '1Y', useTs: true, days: 365, fidelity: 1440 },
  { label: 'Max', interval: 'max', fidelity: 1440 },
];

/** The view the panel opens on (30D). */
export const DEFAULT_TIMEFRAME = TIMEFRAMES[2];

export const PRICE_CACHE_TTL = 60_000;
export const BOOK_CACHE_TTL = 30_000;

export const priceCacheKey = (tokenId, timeframe) => `price-${tokenId}-${timeframe.label}`;
export const bookCacheKey = (tokenId) => `book-${tokenId}`;

/** Price history for one chart timeframe. */
export function fetchTimeframeHistory(tokenId, timeframe, signal) {
  if (timeframe.useTs) {
    const now = Math.floor(Date.now() / 1000);
    return fetchPriceHistory(tokenId, null, timeframe.fidelity, now - timeframe.days * 86400, now, signal);
  }
  return fetchPriceHistory(tokenId, timeframe.interval, timeframe.fidelity, null, null, signal);
}
