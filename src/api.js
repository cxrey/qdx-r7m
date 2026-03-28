import { truncateSlugNumerics } from './utils/detectMarketLink';

const GAMMA_API = '/gamma-api';
const CLOB_API = '/clob-api';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const MAX_PAGES = 50;              // safety cap — 25,000 markets max
const MAX_CONSECUTIVE_EMPTY = 3;   // stop after 3 consecutive empty pages
const DELAY_MS = 50;               // ms between requests
const PAGE_SIZE = 500;

/**
 * Fetch a single page with retry logic for rate limits and transient errors.
 */
async function fetchPageWithRetry(url, signal, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (signal?.aborted) return null;
    try {
      const res = await fetch(url, { signal });

      if (res.status === 429) {
        const retryAfter = Math.max(1000, parseInt(res.headers.get('Retry-After') || '3', 10) * 1000);
        console.warn(`[fetchAllMarkets] Rate limited, waiting ${retryAfter}ms (attempt ${attempt + 1})`);
        await delay(retryAfter);
        continue;
      }

      if (!res.ok) {
        console.warn(`[fetchAllMarkets] HTTP ${res.status} on attempt ${attempt + 1}`);
        await delay(1000 * (attempt + 1));
        continue;
      }

      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') return null;
      console.warn(`[fetchAllMarkets] Fetch error on attempt ${attempt + 1}:`, err.message);
      await delay(1000 * (attempt + 1));
    }
  }
  console.error(`[fetchAllMarkets] Failed after ${maxRetries} retries: ${url}`);
  return null;
}

export async function fetchAllMarkets(onProgress, signal) {
  const markets = [];
  let offset = 0;
  let consecutiveEmpty = 0;
  let pageCount = 0;

  console.log('[fetchAllMarkets] Starting market fetch...');

  while (consecutiveEmpty < MAX_CONSECUTIVE_EMPTY && pageCount < MAX_PAGES) {
    if (signal?.aborted) break;

    const url = `${GAMMA_API}/markets?limit=${PAGE_SIZE}&offset=${offset}&active=true&closed=false&order=volume&ascending=false`;
    const data = await fetchPageWithRetry(url, signal);
    pageCount++;

    if (!data || !Array.isArray(data) || data.length === 0) {
      consecutiveEmpty++;
      console.log(`[fetchAllMarkets] Page ${pageCount}: empty (consecutive: ${consecutiveEmpty}/${MAX_CONSECUTIVE_EMPTY})`);
      offset += PAGE_SIZE;
      await delay(DELAY_MS);
      continue;
    }

    consecutiveEmpty = 0;
    markets.push(...data);
    offset += PAGE_SIZE;

    if (onProgress) onProgress(markets.length);

    // A partial page is a strong signal we've reached the end — break
    // immediately to avoid 3 extra empty-page round-trips.
    if (data.length < PAGE_SIZE) {
      console.log(`[fetchAllMarkets] Page ${pageCount}: ${data.length} markets (partial page, total: ${markets.length}) — done`);
      break;
    }

    await delay(DELAY_MS);
  }

  console.log(
    `[fetchAllMarkets] Fetch complete: ${markets.length} markets across ${pageCount} pages. ` +
    `Last offset: ${offset}. Stop reason: ${consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY ? 'consecutive empty pages' : pageCount >= MAX_PAGES ? 'max page cap' : signal?.aborted ? 'aborted' : 'done'}.`
  );

  if (pageCount >= MAX_PAGES) {
    console.warn('[fetchAllMarkets] Hit max page safety cap — there may be more markets.');
  }

  return markets;
}

export async function fetchOrderBook(tokenId, signal) {
  try {
    const res = await fetch(`${CLOB_API}/book?token_id=${tokenId}`, { signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
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
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
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
    const res = await fetch(`${GAMMA_API}/markets/${id}`, { signal });
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
    const res = await fetch(`${GAMMA_API}/events?slug=${encodeURIComponent(slug)}`, { signal });
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
    const res = await fetch(`${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`, { signal });
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
      const res = await fetch(`${GAMMA_API}/events?slug=${encodeURIComponent(truncated)}`, { signal });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          return { markets: data[0].markets || [], event: data[0] };
        }
      }
    } catch { /* continue */ }

    try {
      const res = await fetch(`${GAMMA_API}/markets?slug=${encodeURIComponent(truncated)}`, { signal });
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
    const res = await fetch(`${GAMMA_API}/markets?_q=${encodeURIComponent(searchTerm)}&limit=5`, { signal });
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
    const res = await fetch(`${GAMMA_API}/markets?condition_id=${encodeURIComponent(conditionId)}`, { signal });
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
    const res = await fetch(`${GAMMA_API}/markets?clob_token_ids=${encodeURIComponent(tokenId)}`, { signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) return { markets: data, event: null };
    return null;
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('[fetchMarketByTokenId] Failed:', e.message);
    return null;
  }
}

