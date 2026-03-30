import { truncateSlugNumerics } from './utils/detectMarketLink';
import { withTimeout, TIMEOUT_GAMMA_PAGE } from './fetchUtils';
import { throwIfRateLimited } from './clobErrorHandler';
import { parseGammaMarkets, parseOrderBook } from './schemas';

const GAMMA_API = '/gamma-api';
const CLOB_API = '/clob-api';

const PAGE_SIZE = 100;
const CONCURRENCY = 5;
const MAX_PAGES = 200; // Safety cap: 200 pages × 100/page = 20K markets max

// ── Request-level timeouts ──────────────────────────────────────
// Prevents hung fetches from blocking concurrent batches indefinitely.
// TIMEOUT_GAMMA_PAGE (10s) imported from fetchUtils.js
const TIMEOUT_ORDER_BOOK = 5_000;    // 5s per order book request
const TIMEOUT_PRICE_HISTORY = 8_000; // 8s per price history request
const TIMEOUT_LOOKUP = 8_000;        // 8s per direct lookup request

export async function fetchAllMarkets(onProgress, signal) {
  const startTime = Date.now();
  let allRaw = [];
  let pageOffset = 0;
  let done = false;
  let hitRateLimit = false;

  while (!done && !hitRateLimit && pageOffset < MAX_PAGES) {
    if (signal?.aborted) break;

    // Build a batch of CONCURRENCY page fetches
    const batch = [];
    for (let i = 0; i < CONCURRENCY && (pageOffset + i) < MAX_PAGES; i++) {
      const offset = (pageOffset + i) * PAGE_SIZE;
      const url = `${GAMMA_API}/markets?limit=${PAGE_SIZE}&offset=${offset}&active=true&closed=false&order=volume&ascending=false&volume_num_min=100`;
      batch.push(
        fetch(url, { signal: withTimeout(signal, TIMEOUT_GAMMA_PAGE) })
          .then(async (res) => {
            if (res.status === 429) return { status: 429, data: [] };
            if (!res.ok) return { status: res.status, data: [] };
            const data = await res.json();
            return { status: 200, data: Array.isArray(data) ? data : [] };
          })
          .catch((err) => {
            if (err.name === 'AbortError') throw err;
            console.warn(`[fetchAllMarkets] Page ${pageOffset + i} failed:`, err.message);
            return { status: 0, data: [] };
          })
      );
    }

    // Wait for all pages in the batch to complete
    let results;
    try {
      results = await Promise.all(batch);
    } catch (err) {
      if (err.name === 'AbortError') break;
      throw err;
    }

    // Collect ALL successful data from the batch first, then check for stop conditions.
    // Do NOT break early on 429 — pages after the 429 in the batch may have succeeded
    // (all requests were already in flight). Collect everything, then stop before next batch.
    for (let i = 0; i < results.length; i++) {
      const { status, data } = results[i];

      if (status === 429) {
        hitRateLimit = true;
        // Don't break — keep collecting data from remaining successful pages in this batch
      }

      if (data.length > 0) {
        allRaw.push(...data);
      }

      if (data.length === 0 && status === 200) {
        // Empty 200 response = no more data at this offset
        done = true;
      }
    }

    // Check if any page in the batch returned fewer results than the effective page size.
    // Use the first *successful* (status 200) page's length as the reference — a failed
    // page (status 0) returning empty data must not trigger end-of-data detection.
    if (!done && !hitRateLimit && results.length > 0) {
      const refPage = results.find((r) => r.status === 200 && r.data.length > 0);
      if (!refPage) {
        // No successful non-empty page in this batch — stop
        done = true;
      } else {
        const effectivePageSize = refPage.data.length;
        for (let i = 0; i < results.length; i++) {
          if (results[i] !== refPage && results[i].data.length < effectivePageSize && results[i].status === 200) {
            done = true;
            break;
          }
        }
      }
    }

    if (hitRateLimit) {
      console.warn('[fetchAllMarkets] Rate limited — using', allRaw.length, 'markets fetched so far');
    }

    pageOffset += CONCURRENCY;

    // Report progress after each batch
    if (onProgress && allRaw.length > 0) {
      onProgress(allRaw.length);
    }
  }

  if (pageOffset >= MAX_PAGES) {
    console.warn(`[fetchAllMarkets] Hit MAX_PAGES safety cap (${MAX_PAGES}) — ${allRaw.length} markets fetched`);
  }

  console.log(`[fetchAllMarkets] Fetch complete: ${allRaw.length} markets in ${Date.now() - startTime}ms (${pageOffset} pages)`);

  return parseGammaMarkets(allRaw);
}

export async function fetchOrderBook(tokenId, signal) {
  try {
    const res = await fetch(`${CLOB_API}/book?token_id=${tokenId}`, { signal: withTimeout(signal, TIMEOUT_ORDER_BOOK) });
    throwIfRateLimited(res);
    if (!res.ok) return null;
    return parseOrderBook(await res.json());
  } catch (e) {
    if (e?.status === 429 || e?.status === 403) throw e;
    if (e.name !== 'AbortError') console.warn('[fetchOrderBook] Failed:', e.message);
    return null;
  }
}

export async function fetchPriceHistory(tokenId, interval, fidelity, startTs, endTs, signal) {
  try {
    let url = `${CLOB_API}/prices-history?market=${tokenId}`;
    if (startTs && endTs) {
      url += `&startTs=${startTs}&endTs=${endTs}`;
    } else {
      url += `&interval=${interval}`;
    }
    if (fidelity) url += `&fidelity=${fidelity}`;
    const res = await fetch(url, { signal: withTimeout(signal, TIMEOUT_PRICE_HISTORY) });
    throwIfRateLimited(res);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    if (e?.status === 429 || e?.status === 403) throw e;
    if (e.name !== 'AbortError') console.warn('[fetchPriceHistory] Failed:', e.message);
    return null;
  }
}

// --- Direct Lookup API Functions ---

/**
 * Fetch a market directly by its numeric Gamma API ID.
 */
export async function fetchMarketById(id, signal) {
  try {
    const res = await fetch(`${GAMMA_API}/markets/${id}`, { signal: withTimeout(signal, TIMEOUT_LOOKUP) });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.id ? { markets: [data], event: null } : null;
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('[fetchMarketById] Failed:', e.message);
    return null;
  }
}

/**
 * Fetch markets/events by slug. Tries events first, then markets,
 * then truncated slug variants, then text search as last resort.
 */
export async function fetchMarketBySlug(slug, signal) {
  // 1. Try events endpoint
  try {
    const res = await fetch(`${GAMMA_API}/events?slug=${encodeURIComponent(slug)}`, { signal: withTimeout(signal, TIMEOUT_LOOKUP) });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const event = data[0];
        const markets = event.markets || [];
        return { markets, event };
      }
    }
  } catch { /* continue */ }

  // 2. Try markets endpoint
  try {
    const res = await fetch(`${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`, { signal: withTimeout(signal, TIMEOUT_LOOKUP) });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        return { markets: data, event: null };
      }
    }
  } catch { /* continue */ }

  // 3. Try truncated slug (strip trailing numeric segments)
  const truncated = truncateSlugNumerics(slug);
  if (truncated) {
    try {
      const res = await fetch(`${GAMMA_API}/events?slug=${encodeURIComponent(truncated)}`, { signal: withTimeout(signal, TIMEOUT_LOOKUP) });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          return { markets: data[0].markets || [], event: data[0] };
        }
      }
    } catch { /* continue */ }

    try {
      const res = await fetch(`${GAMMA_API}/markets?slug=${encodeURIComponent(truncated)}`, { signal: withTimeout(signal, TIMEOUT_LOOKUP) });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          return { markets: data, event: null };
        }
      }
    } catch { /* continue */ }
  }

  // 4. Last resort: text search
  try {
    const searchTerm = (truncated || slug).replace(/-/g, ' ');
    const res = await fetch(`${GAMMA_API}/markets?_q=${encodeURIComponent(searchTerm)}&limit=5`, { signal: withTimeout(signal, TIMEOUT_LOOKUP) });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        console.warn(`[DirectLookup] Slug endpoint failed for "${slug}", fell back to text search`);
        return { markets: data, event: null };
      }
    }
  } catch { /* continue */ }

  return null;
}

/**
 * Fetch a market by condition_id.
 */
export async function fetchMarketByConditionId(conditionId, signal) {
  try {
    const res = await fetch(`${GAMMA_API}/markets?condition_id=${encodeURIComponent(conditionId)}`, { signal: withTimeout(signal, TIMEOUT_LOOKUP) });
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) return { markets: data, event: null };
    return null;
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('[fetchMarketByConditionId] Failed:', e.message);
    return null;
  }
}

/**
 * Fetch a market by clob_token_ids.
 */
export async function fetchMarketByTokenId(tokenId, signal) {
  try {
    const res = await fetch(`${GAMMA_API}/markets?clob_token_ids=${encodeURIComponent(tokenId)}`, { signal: withTimeout(signal, TIMEOUT_LOOKUP) });
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) return { markets: data, event: null };
    return null;
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('[fetchMarketByTokenId] Failed:', e.message);
    return null;
  }
}

