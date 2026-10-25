import { truncateSlugNumerics } from './utils/detectMarketLink';
import { withTimeout, TIMEOUT_GAMMA_PAGE } from './fetchUtils';
import { throwIfRateLimited } from './clobErrorHandler';
import { parseGammaMarkets, parseOrderBook } from './schemas';

import { GAMMA_API, CLOB_API } from './apiConfig';
import { CATALOG_MIN_VOLUME } from './engineConfig';

const PAGE_SIZE = 100;
const MAX_PAGES = 200; // Safety cap across all bands: 200 pages × 100 events/page = 20K events max (markets are nested per event, so more markets)
const PAGE_ATTEMPTS = 2; // One retry for a timed-out / 5xx / network-failed page — a cursor chain can't skip a page
const RETRY_DELAY_MS = 1_000; // Pause before that retry, so a struggling server isn't hit again instantly

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Gamma's offset pagination rejects offset > 2000 with 422 ("use /events/keyset
// for deeper pagination"), which capped the catalog at ~2,100 events. The crawl
// uses /events/keyset cursors instead. A cursor chain is strictly sequential, so
// to keep the parallelism of the old 5-way offset batches, the catalog is split
// into volume bands with one cursor chain each. Edges are rough quantiles of
// active events at or above the catalog floor (Oct 2026); uneven bands only
// cost wall-clock time, never coverage. Bands are listed in descending volume,
// so concatenating them preserves the global order=volume desc ordering. The
// bottom band starts at CATALOG_MIN_VOLUME: events below it (by TOTAL event
// volume) are not loaded; all markets inside qualifying events are.
const VOLUME_BANDS = [
  [250_000, null],
  [80_000, 250_000],
  [40_000, 80_000],
  [22_000, 40_000],
  [CATALOG_MIN_VOLUME, 22_000],
];


// ── Request-level timeouts ──────────────────────────────────────
// Prevents hung fetches from blocking a band's cursor chain indefinitely.
// TIMEOUT_GAMMA_PAGE (10s) imported from fetchUtils.js
const TIMEOUT_ORDER_BOOK = 5_000;    // 5s per order book request
const TIMEOUT_PRICE_HISTORY = 8_000; // 8s per price history request
const TIMEOUT_LOOKUP = 8_000;        // 8s per direct lookup request

/**
 * Whether a market nested in an open event is actually listed for trading.
 * `closed=false` on /events filters EVENTS, not their markets. An open event
 * still carries markets that have resolved (closed, prices settled at 0/1) and
 * placeholder slots like "Person X" (inactive, never traded, no prices) — in
 * Oct 2026, 43% of the markets in qualifying events.
 */
export function isListedMarket(market) {
  return market.active !== false && market.closed !== true && market.archived !== true;
}

/**
 * Flatten an array of event objects into individual listed market objects.
 * Injects parent event metadata (tags, slug, openInterest, etc.) into each
 * nested market so processMarket can read market.events[0].tags etc.
 */
export function flattenEventsToMarkets(events) {
  const markets = [];
  for (const event of events) {
    const { markets: nestedMarkets, ...eventData } = event;
    if (!Array.isArray(nestedMarkets)) continue;
    for (const market of nestedMarkets) {
      if (!isListedMarket(market)) continue;
      market.events = [eventData];
      markets.push(market);
    }
  }
  return markets;
}

/**
 * Follow one volume band's keyset cursor chain to the end.
 * Pushes each page's events into `events` (so partial results survive a stop)
 * and shares the page budget / rate-limit flag with the other bands via `crawl`.
 *
 * @returns {Promise<boolean>} true only if the band reached the natural end of
 *   its cursor chain. false means it stopped early (failed page, rate limit,
 *   page cap, abort), so its markets are an incomplete set.
 * Throws only on caller abort.
 */
async function crawlVolumeBand([volumeMin, volumeMax], events, crawl, signal) {
  let cursor = null;
  while (crawl.pages < MAX_PAGES && !crawl.rateLimited) {
    if (signal?.aborted) return false;
    crawl.pages++;

    let url = `${GAMMA_API}/events/keyset?limit=${PAGE_SIZE}&closed=false&order=volume&ascending=false&volume_min=${volumeMin}`;
    if (volumeMax != null) url += `&volume_max=${volumeMax}`;
    if (cursor) url += `&after_cursor=${encodeURIComponent(cursor)}`;

    let data = null;
    for (let attempt = 1; attempt <= PAGE_ATTEMPTS && data == null; attempt++) {
      if (attempt > 1) await delay(RETRY_DELAY_MS);
      if (signal?.aborted) return false;
      try {
        const res = await fetch(url, { signal: withTimeout(signal, TIMEOUT_GAMMA_PAGE) });
        if (res.status === 429) {
          crawl.rateLimited = true;
          return false;
        }
        if (!res.ok) {
          console.warn(`[fetchAllMarkets] Band ≥${volumeMin} page failed: HTTP ${res.status}`);
          // A 4xx (e.g. a rejected cursor) won't change on retry — end this band
          if (res.status < 500) return false;
          continue;
        }
        data = await res.json();
      } catch (err) {
        // A caller abort ends the whole crawl; a withTimeout abort is just a failed page
        if (signal?.aborted) throw err;
        console.warn(`[fetchAllMarkets] Band ≥${volumeMin} page failed:`, err.message);
      }
    }
    if (data == null) return false; // retries exhausted

    const page = Array.isArray(data.events) ? data.events : [];
    events.push(...page);
    // Progress counts listed markets in unique, active events only — the same
    // filters applied to the final result — so the counter never overshoots.
    for (const e of page) {
      if (e.active === false || crawl.countedEvents.has(e.id)) continue;
      crawl.countedEvents.add(e.id);
      if (Array.isArray(e.markets)) crawl.marketCount += e.markets.filter(isListedMarket).length;
    }
    if (crawl.onProgress && crawl.marketCount > 0) crawl.onProgress(crawl.marketCount);

    cursor = data.next_cursor;
    if (!cursor || page.length === 0) return true; // natural end of band
  }
  return false; // page cap or rate limit stopped the band
}

/**
 * Crawl the active catalog and report whether the crawl was complete.
 *
 * @returns {Promise<{ markets: object[], complete: boolean }>}
 *   complete is false when any band stopped early. Callers that REPLACE
 *   their market set (Tier 3) must not treat markets missing from an
 *   incomplete crawl as removed — a single failed page ends its whole band.
 */
export async function fetchCatalog(onProgress, signal) {
  const startTime = Date.now();
  // Fetches from /events (not /markets) to get event-level tags for fee category resolution.
  // Each event contains nested markets which are flattened after fetch.
  const crawl = { pages: 0, marketCount: 0, countedEvents: new Set(), rateLimited: false, onProgress };
  const bandEvents = VOLUME_BANDS.map(() => []);

  // allSettled, not all: on a caller abort every band must have stopped before
  // bandEvents is read below. Aborted bands keep the pages they already fetched.
  const outcomes = await Promise.allSettled(
    VOLUME_BANDS.map((band, i) => crawlVolumeBand(band, bandEvents[i], crawl, signal))
  );
  const failure = outcomes.find((o) => o.status === 'rejected' && o.reason?.name !== 'AbortError');
  if (failure) throw failure.reason;
  const complete = outcomes.every((o) => o.status === 'fulfilled' && o.value === true);

  if (crawl.rateLimited) {
    console.warn('[fetchAllMarkets] Rate limited — using', crawl.marketCount, 'markets fetched so far');
  }
  if (crawl.pages >= MAX_PAGES) {
    console.warn(`[fetchAllMarkets] Hit MAX_PAGES safety cap (${MAX_PAGES}) — ${crawl.marketCount} markets fetched`);
  }

  // Band edges are inclusive and volumes move mid-crawl, so an event can land
  // in two bands — keep the first (higher-volume band) copy. /events/keyset has
  // no `active` filter (offset /events did), so apply it here.
  const seen = new Set();
  const events = bandEvents.flat().filter((e) => {
    if (e.active === false || seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  const allRaw = flattenEventsToMarkets(events);

  console.log(`[fetchAllMarkets] Fetch ${complete ? 'complete' : 'INCOMPLETE'}: ${allRaw.length} markets (${events.length} events) in ${Date.now() - startTime}ms (${crawl.pages} pages)`);

  return { markets: parseGammaMarkets(allRaw), complete };
}

/** Crawl the active catalog; markets only (see fetchCatalog for completeness). */
export async function fetchAllMarkets(onProgress, signal) {
  return (await fetchCatalog(onProgress, signal)).markets;
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

