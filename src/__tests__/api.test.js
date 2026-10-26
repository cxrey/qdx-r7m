import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock fetchUtils — withTimeout returns a passthrough AbortSignal
// (avoids real timers in most tests; timeout behavior tested in fetchUtils.test.js)
vi.mock('../fetchUtils', () => ({
  withTimeout: vi.fn((callerSignal) => callerSignal || new AbortController().signal),
  TIMEOUT_GAMMA_PAGE: 10000,
  TIMEOUT_DATA_API: 8000, // price history goes through the Data API client
}));

// Use real truncateSlugNumerics — it's a pure function with no dependencies

import {
  fetchAllMarkets, fetchCatalog, fetchOrderBook, fetchPriceHistory,
  fetchMarketById, fetchMarketBySlug,
  fetchMarketByConditionId, fetchMarketByTokenId,
  flattenEventsToMarkets, isListedMarket,
} from '../api';
import { withTimeout } from '../fetchUtils';
import { CATALOG_MIN_VOLUME } from '../engineConfig';

let mockFetch;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── fetchOrderBook ─────────────────────────────────────────────────

describe('fetchOrderBook', () => {
  it('calls correct URL with token_id', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ bids: [], asks: [] }), { status: 200 }));
    await fetchOrderBook('tok-123');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('/clob-api/book?token_id=tok-123');
  });

  it('returns parsed JSON on 200', async () => {
    const bookData = { bids: [{ price: '0.55' }], asks: [{ price: '0.56' }] };
    mockFetch.mockResolvedValue(new Response(JSON.stringify(bookData), { status: 200 }));
    const result = await fetchOrderBook('tok-123');
    expect(result).toEqual(bookData);
  });

  it('returns null on 500', async () => {
    mockFetch.mockResolvedValue(new Response('Server Error', { status: 500 }));
    const result = await fetchOrderBook('tok-123');
    expect(result).toBeNull();
  });

  it('throws error with status 429', async () => {
    mockFetch.mockResolvedValue(new Response('Rate limited', { status: 429 }));
    await expect(fetchOrderBook('tok-123')).rejects.toMatchObject({ status: 429 });
  });

  it('throws error with status 403', async () => {
    mockFetch.mockResolvedValue(new Response('Forbidden', { status: 403 }));
    await expect(fetchOrderBook('tok-123')).rejects.toMatchObject({ status: 403 });
  });

  it('returns null on network TypeError', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));
    const result = await fetchOrderBook('tok-123');
    expect(result).toBeNull();
  });

  it('returns null on AbortError without throwing', async () => {
    const err = new DOMException('Aborted', 'AbortError');
    mockFetch.mockRejectedValue(err);
    const result = await fetchOrderBook('tok-123');
    expect(result).toBeNull();
  });

  it('passes signal through withTimeout with 5s timeout', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const signal = new AbortController().signal;
    await fetchOrderBook('tok-123', signal);
    expect(withTimeout).toHaveBeenCalledWith(signal, 5000);
  });
});

// ── fetchPriceHistory ──────────────────────────────────────────────

describe('fetchPriceHistory (Data API /v2/prices-history since 2026-09-04)', () => {
  const v2 = (rows, nextCursor = null) => new Response(JSON.stringify({ data: rows, pagination: { has_more: nextCursor != null, next_cursor: nextCursor } }), { status: 200 });
  const q = (call = 0) => new URL(mockFetch.mock.calls[call][0], 'http://localhost');

  it('calls the Data API route with token_id and the interval (not the CLOB route or `market`)', async () => {
    mockFetch.mockResolvedValue(v2([]));
    await fetchPriceHistory('tok-1', '1d', null, null, null);
    const url = q();
    expect(url.pathname).toBe('/data-api/v2/prices-history');
    expect(url.searchParams.get('token_id')).toBe('tok-1');
    expect(url.searchParams.get('interval')).toBe('1d');
    expect(url.searchParams.has('market')).toBe(false);
    expect(url.searchParams.has('startTs')).toBe(false);
  });

  it('maps fidelity (minutes) to bucket_seconds, clamped to 60–86,400', async () => {
    mockFetch.mockResolvedValue(v2([]));
    await fetchPriceHistory('tok-1', '1d', 60, null, null);
    await fetchPriceHistory('tok-1', 'max', 4320, null, null);
    expect(q(0).searchParams.get('bucket_seconds')).toBe('3600');
    expect(q(1).searchParams.get('bucket_seconds')).toBe('86400');
    expect(q(1).searchParams.get('interval')).toBe('all'); // 'max' → 'all'
    expect(q(0).searchParams.has('fidelity')).toBe(false);
  });

  it('sends start/end for spans of up to 15 days', async () => {
    mockFetch.mockResolvedValue(v2([]));
    await fetchPriceHistory('tok-1', null, null, 1000, 1000 + 15 * 86400);
    expect(q().searchParams.get('start')).toBe('1000');
    expect(q().searchParams.get('end')).toBe(String(1000 + 15 * 86400));
    expect(q().searchParams.has('interval')).toBe(false);
  });

  it('longer spans fetch interval=all and are trimmed to the range', async () => {
    const start = 2_000_000;
    const end = start + 90 * 86400;
    mockFetch.mockResolvedValue(v2([
      { timestamp: start - 86400, price: 0.1 }, // before the range
      { timestamp: start + 86400, price: 0.2 },
      { timestamp: end, price: 0.3 },
      { timestamp: end + 86400, price: 0.4 }, // after the range
    ]));
    const result = await fetchPriceHistory('tok-1', null, 1440, start, end);
    expect(q().searchParams.get('interval')).toBe('all');
    expect(q().searchParams.has('start')).toBe(false);
    expect(result.history).toEqual([{ t: start + 86400, p: 0.2 }, { t: end, p: 0.3 }]);
  });

  it('returns rows in the { history: [{ t, p }] } shape the chart reads, skipping malformed rows', async () => {
    mockFetch.mockResolvedValue(v2([{ timestamp: 1, price: 0.5, resolution_seconds: 60 }, { timestamp: 2 }, null]));
    expect(await fetchPriceHistory('tok-1', '1d')).toEqual({ history: [{ t: 1, p: 0.5 }] });
  });

  it('follows next_cursor across pages and joins the rows in order', async () => {
    mockFetch
      .mockResolvedValueOnce(v2([{ timestamp: 1, price: 0.1 }, { timestamp: 2, price: 0.2 }], 'c1'))
      .mockResolvedValueOnce(v2([{ timestamp: 3, price: 0.3 }]));
    const result = await fetchPriceHistory('tok-1', 'all', 1440);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(q(1).searchParams.get('cursor')).toBe('c1');
    expect(result.history.map((h) => h.t)).toEqual([1, 2, 3]);
  });

  it('a history cut short by a failed later page is not returned as complete', async () => {
    mockFetch
      .mockResolvedValueOnce(v2([{ timestamp: 1, price: 0.1 }], 'c1'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'upstream' }), { status: 502 }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await fetchPriceHistory('tok-1', 'all', 1440)).toBeNull();
  });

  it('a history that hits the page cap is not returned as complete', async () => {
    mockFetch.mockImplementation(async () => v2([{ timestamp: 1, price: 0.1 }], 'more'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await fetchPriceHistory('tok-1', 'all', 1440)).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it('returns null on a 400 (e.g. a rejected parameter)', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ error: "'start' to 'end' must span at most 15 days" }), { status: 400 }));
    expect(await fetchPriceHistory('tok-1', '1d')).toBeNull();
  });

  it('throws on 429 with .status', async () => {
    mockFetch.mockResolvedValue(new Response('Rate limited', { status: 429 }));
    await expect(fetchPriceHistory('tok-1', '1d')).rejects.toMatchObject({ status: 429 });
  });

  it('throws on 403 with .status', async () => {
    mockFetch.mockResolvedValue(new Response('Forbidden', { status: 403 }));
    await expect(fetchPriceHistory('tok-1', '1d')).rejects.toMatchObject({ status: 403 });
  });

  it('returns null on other errors', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));
    const result = await fetchPriceHistory('tok-1', '1d');
    expect(result).toBeNull();
  });

});

// ── fetchAllMarkets ────────────────────────────────────────────────

describe('fetchAllMarkets', () => {
  // volume_min of each band, in the order fetchAllMarkets lists them (highest volume first)
  const BAND_MINS = ['250000', '80000', '40000', '22000', '15000'];

  // Helper: make n events, each containing marketsPerEvent markets — the shape
  // of the `events` array in a /events/keyset response.
  function makeEvents(nEvents, startEventId = 0, marketsPerEvent = 1) {
    return Array.from({ length: nEvents }, (_, i) => {
      const eventId = startEventId + i;
      return {
        id: `evt-${eventId}`,
        slug: `event-${eventId}`,
        active: true,
        tags: [{ slug: 'crypto', label: 'Crypto' }],
        markets: Array.from({ length: marketsPerEvent }, (_, j) => ({
          id: `m-${eventId}-${j}`,
          question: `Market ${eventId}-${j}`,
          volume: '20000', // above the $15K catalog floor
        })),
      };
    });
  }

  function keysetResponse(events, nextCursor = null) {
    return new Response(JSON.stringify({ events, next_cursor: nextCursor }), { status: 200 });
  }

  const params = (url) => new URL(url, 'http://localhost').searchParams;

  // Helper: fake /events/keyset server. `bands` maps volume_min → array of pages
  // (each an events array); bands not listed are empty. Cursors are opaque
  // strings "<volume_min>/<page index>", so cursor propagation is checked for real.
  function keysetServer(bands) {
    return async (url) => {
      const p = params(url);
      const pages = bands[p.get('volume_min')] || [[]];
      const cursor = p.get('after_cursor');
      const idx = cursor ? Number(cursor.split('/')[1]) : 0;
      const next = idx + 1 < pages.length ? `${p.get('volume_min')}/${idx + 1}` : null;
      return keysetResponse(pages[idx] ?? [], next);
    };
  }

  it('fetches from /events/keyset with the catalog filters and no offset', async () => {
    mockFetch.mockImplementation(keysetServer({}));
    await fetchAllMarkets(vi.fn());
    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('/gamma-api/events/keyset?');
    const p = params(url);
    expect(p.get('limit')).toBe('100');
    expect(p.get('closed')).toBe('false');
    expect(p.get('order')).toBe('volume');
    expect(p.get('ascending')).toBe('false');
    expect(p.has('offset')).toBe(false); // keyset rejects offset with 422
    expect(p.has('after_cursor')).toBe(false); // first page of a chain has no cursor
  });

  it('starts one cursor chain per volume band, covering volume ≥ the catalog floor without gaps', async () => {
    mockFetch.mockImplementation(keysetServer({}));
    await fetchAllMarkets(vi.fn());
    expect(mockFetch).toHaveBeenCalledTimes(BAND_MINS.length);
    const bands = mockFetch.mock.calls.map(([url]) => {
      const p = params(url);
      return [Number(p.get('volume_min')), p.has('volume_max') ? Number(p.get('volume_max')) : Infinity];
    }).sort((a, b) => b[0] - a[0]);
    expect(bands[0][1]).toBe(Infinity); // top band is open-ended
    expect(bands[bands.length - 1][0]).toBe(CATALOG_MIN_VOLUME);
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i][1]).toBe(bands[i - 1][0]); // each band's max is the next band's min
    }
  });

  it('passes each next_cursor as after_cursor (URL-encoded) to the same band', async () => {
    const cursor = 'abc+/=';
    mockFetch.mockImplementation(async (url) => {
      const p = params(url);
      if (p.get('volume_min') !== '40000') return keysetResponse([]);
      if (!p.has('after_cursor')) return keysetResponse(makeEvents(100, 0), cursor);
      return keysetResponse(makeEvents(30, 100));
    });
    const result = await fetchAllMarkets(vi.fn());
    expect(result.length).toBe(130);
    const followUps = mockFetch.mock.calls.map(([url]) => url).filter((url) => url.includes('after_cursor='));
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toContain(`after_cursor=${encodeURIComponent(cursor)}`);
    expect(params(followUps[0]).get('volume_min')).toBe('40000');
  });

  it('follows each band to the end of its cursor chain and stops', async () => {
    mockFetch.mockImplementation(keysetServer({
      250000: [makeEvents(100, 0), makeEvents(100, 100), makeEvents(20, 200)],
      15000: [makeEvents(100, 1000), makeEvents(5, 1100)],
    }));
    const result = await fetchAllMarkets(vi.fn());
    // 3 pages + 2 pages + 1 empty page for each of the 3 other bands
    expect(mockFetch).toHaveBeenCalledTimes(8);
    expect(result.length).toBe(325);
  });

  it('stops a band on an empty page even if a cursor is returned', async () => {
    mockFetch.mockImplementation(async () => keysetResponse([], 'still-a-cursor'));
    const result = await fetchAllMarkets(vi.fn());
    expect(mockFetch).toHaveBeenCalledTimes(BAND_MINS.length);
    expect(result).toEqual([]);
  });

  it('returns markets in descending band order', async () => {
    mockFetch.mockImplementation(keysetServer({
      15000: [makeEvents(1, 400)],
      80000: [makeEvents(1, 100)],
      250000: [makeEvents(1, 0)],
    }));
    const result = await fetchAllMarkets(vi.fn());
    expect(result.map((m) => m.id)).toEqual(['m-0-0', 'm-100-0', 'm-400-0']);
  });

  it('flattens nested markets from events and injects parent event data', async () => {
    mockFetch.mockImplementation(keysetServer({ 250000: [makeEvents(1, 0, 3)] }));
    const result = await fetchAllMarkets(vi.fn());
    expect(result.length).toBe(3);
    // Each market should have events[0] injected with parent event data (tags, slug)
    expect(result[0].events[0].tags[0].slug).toBe('crypto');
    expect(result[0].events[0].slug).toBe('event-0');
    // Nested markets array should NOT be on the injected event data
    expect(result[0].events[0].markets).toBeUndefined();
  });

  it('dedupes an event returned by two bands (boundary / volume moved mid-crawl)', async () => {
    mockFetch.mockImplementation(keysetServer({
      250000: [makeEvents(2, 0)],
      80000: [makeEvents(2, 1)], // evt-1 overlaps
    }));
    const result = await fetchAllMarkets(vi.fn());
    expect(result.map((m) => m.id)).toEqual(['m-0-0', 'm-1-0', 'm-2-0']);
  });

  it('drops events marked inactive (keyset has no active filter)', async () => {
    const events = makeEvents(2, 0);
    events[1].active = false;
    mockFetch.mockImplementation(keysetServer({ 250000: [events] }));
    const result = await fetchAllMarkets(vi.fn());
    expect(result.map((m) => m.id)).toEqual(['m-0-0']);
  });

  it('calls onProgress with the cumulative market count across bands', async () => {
    const onProgress = vi.fn();
    mockFetch.mockImplementation(keysetServer({
      250000: [makeEvents(100, 0), makeEvents(100, 100)],
      22000: [makeEvents(50, 500, 2)],
    }));
    await fetchAllMarkets(onProgress);
    const counts = onProgress.mock.calls.map(([n]) => n);
    expect(counts).toEqual([...counts].sort((a, b) => a - b)); // monotonic
    expect(counts[counts.length - 1]).toBe(300); // 200 + 50 events × 2 markets
  });

  it('does NOT call onProgress when no data collected', async () => {
    const onProgress = vi.fn();
    mockFetch.mockImplementation(keysetServer({}));
    await fetchAllMarkets(onProgress);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('accepts a null onProgress (Tier 3 background refresh)', async () => {
    mockFetch.mockImplementation(keysetServer({ 250000: [makeEvents(3, 0)] }));
    const result = await fetchAllMarkets(null);
    expect(result.length).toBe(3);
  });

  it('on 429 stops every band and keeps what was already fetched', async () => {
    const server = keysetServer({
      250000: [makeEvents(100, 0), makeEvents(100, 100), makeEvents(100, 200)],
      80000: [makeEvents(100, 1000), makeEvents(100, 1100)],
    });
    mockFetch.mockImplementation(async (url) => {
      // The 15000 band's second page is rate limited
      if (params(url).get('after_cursor') === '80000/1') return new Response('', { status: 429 });
      return server(url);
    });
    const result = await fetchAllMarkets(vi.fn());
    // Round 1: 5 first pages; round 2: 50000/1 and 15000/1 (429). No round 3.
    expect(mockFetch).toHaveBeenCalledTimes(7);
    expect(mockFetch.mock.calls.some(([url]) => url.includes('after_cursor=250000%2F2'))).toBe(false);
    // 50000 band pages 0 and 1, 15000 band page 0
    expect(result.length).toBe(300);
    // 429 is never retried
    expect(mockFetch.mock.calls.filter(([url]) => url.includes('after_cursor=80000%2F1'))).toHaveLength(1);
  });

  it('stops on caller abort and returns the pages fetched before it', async () => {
    const controller = new AbortController();
    const server = keysetServer({
      250000: [makeEvents(100, 0), makeEvents(100, 100), makeEvents(100, 200)],
      80000: [makeEvents(100, 1000), makeEvents(100, 1100)],
    });
    mockFetch.mockImplementation(async (url, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const res = await server(url);
      if (params(url).get('after_cursor') === '250000/1') controller.abort();
      return res;
    });
    const result = await fetchAllMarkets(vi.fn(), controller.signal);
    // No band starts a page after the abort
    const afterAbort = mockFetch.mock.calls.findIndex(([url]) => url.includes('after_cursor=250000%2F1'));
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(afterAbort + 2);
    expect(mockFetch.mock.calls.some(([url]) => url.includes('after_cursor=250000%2F2'))).toBe(false);
    // Round 1 pages (50000/0 and 15000/0) survive; nothing is thrown
    expect(result.map((m) => m.id)).toContain('m-0-0');
    expect(result.map((m) => m.id)).toContain('m-1000-0');
  });

  it('returns without fetching when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    mockFetch.mockImplementation(keysetServer({ 250000: [makeEvents(1, 0)] }));
    const result = await fetchAllMarkets(vi.fn(), controller.signal);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('retries a timed-out page once (timeout abort is not a caller abort)', async () => {
    const server = keysetServer({ 250000: [makeEvents(100, 0), makeEvents(10, 100)] });
    let timedOut = false;
    mockFetch.mockImplementation(async (url) => {
      if (!timedOut && params(url).get('after_cursor') === '250000/1') {
        timedOut = true;
        throw new DOMException('signal timed out', 'AbortError');
      }
      return server(url);
    });
    const result = await fetchAllMarkets(vi.fn(), new AbortController().signal);
    expect(result.length).toBe(110);
    expect(mockFetch.mock.calls.filter(([url]) => url.includes('after_cursor=250000%2F1'))).toHaveLength(2);
  });

  it('retries a 5xx / network failure once, then ends only that band', async () => {
    const server = keysetServer({
      250000: [makeEvents(100, 0), makeEvents(100, 100)],
      15000: [makeEvents(100, 1000), makeEvents(100, 1100)],
    });
    mockFetch.mockImplementation(async (url) => {
      const cursor = params(url).get('after_cursor');
      if (cursor === '250000/1') return new Response('Server Error', { status: 500 });
      if (cursor === '15000/1' && !mockFetch.mock.calls.slice(0, -1).some(([u]) => u === url)) {
        throw new TypeError('fetch failed'); // first attempt only
      }
      return server(url);
    });
    const result = await fetchAllMarkets(vi.fn());
    expect(mockFetch.mock.calls.filter(([url]) => url.includes('after_cursor=250000%2F1'))).toHaveLength(2);
    // 50000 band: page 0 only; 100 band: both pages after the retry
    expect(result.length).toBe(300);
  });

  it('ends a band on a 4xx without retrying, other bands continue', async () => {
    const server = keysetServer({
      250000: [makeEvents(100, 0), makeEvents(100, 100)],
      15000: [makeEvents(100, 1000), makeEvents(100, 1100)],
    });
    mockFetch.mockImplementation(async (url) => {
      if (params(url).get('after_cursor') === '250000/1') {
        return new Response('{"type":"validation error"}', { status: 422 });
      }
      return server(url);
    });
    const result = await fetchAllMarkets(vi.fn());
    expect(mockFetch.mock.calls.filter(([url]) => url.includes('after_cursor=250000%2F1'))).toHaveLength(1);
    expect(result.length).toBe(300);
  });

  it('caps at MAX_PAGES (200) total across bands and does not loop forever', async () => {
    let eventId = 0;
    mockFetch.mockImplementation(async (url) => {
      // Always a full page with a cursor — never triggers end-of-band
      const events = makeEvents(100, eventId);
      eventId += 100;
      return keysetResponse(events, `${params(url).get('volume_min')}/1`);
    });
    const result = await fetchAllMarkets(vi.fn());
    expect(mockFetch).toHaveBeenCalledTimes(200);
    expect(result.length).toBe(20_000);
  });

  // ── Completeness (Tier 3 must not treat an incomplete crawl as authoritative) ──

  it('fetchCatalog reports complete when every band reaches the end of its chain', async () => {
    mockFetch.mockImplementation(keysetServer({ 250000: [makeEvents(100, 0), makeEvents(5, 100)], 15000: [makeEvents(3, 900)] }));
    const { markets, complete } = await fetchCatalog(vi.fn());
    expect(complete).toBe(true);
    expect(markets).toHaveLength(108);
  });

  it('fetchCatalog reports incomplete when a band ends on a failed page', async () => {
    const server = keysetServer({ 250000: [makeEvents(100, 0), makeEvents(100, 100)] });
    mockFetch.mockImplementation(async (url) => (params(url).get('after_cursor') === '250000/1'
      ? new Response('{"type":"validation error"}', { status: 422 })
      : server(url)));
    const { markets, complete } = await fetchCatalog(vi.fn());
    expect(complete).toBe(false);
    expect(markets).toHaveLength(100); // what it did reach is still returned
  });

  it('fetchCatalog reports incomplete when rate limited', async () => {
    const server = keysetServer({ 250000: [makeEvents(100, 0), makeEvents(100, 100)] });
    mockFetch.mockImplementation(async (url) => (params(url).get('after_cursor') === '250000/1'
      ? new Response('Too Many Requests', { status: 429 })
      : server(url)));
    expect((await fetchCatalog(vi.fn())).complete).toBe(false);
  });

  it('fetchCatalog reports incomplete when the page cap stops a band', async () => {
    mockFetch.mockImplementation(async (url) => keysetResponse(makeEvents(1, Math.random() * 1e9 | 0), `${params(url).get('volume_min')}/1`));
    expect((await fetchCatalog(vi.fn())).complete).toBe(false);
  });

  it('fetchAllMarkets still returns the markets array (unchanged contract)', async () => {
    mockFetch.mockImplementation(keysetServer({ 250000: [makeEvents(4, 0)] }));
    const markets = await fetchAllMarkets(vi.fn());
    expect(Array.isArray(markets)).toBe(true);
    expect(markets).toHaveLength(4);
  });

  it('progress never overshoots the final total (duplicates and inactive events excluded)', async () => {
    const onProgress = vi.fn();
    const shared = makeEvents(10, 0);                       // returned by two bands
    const inactive = makeEvents(5, 500).map((e) => ({ ...e, active: false }));
    mockFetch.mockImplementation(keysetServer({ 250000: [shared], 80000: [shared], 15000: [inactive] }));
    const markets = await fetchAllMarkets(onProgress);
    const last = onProgress.mock.calls.at(-1)[0];
    expect(markets).toHaveLength(10);
    expect(last).toBe(10);
    expect(Math.max(...onProgress.mock.calls.map(([n]) => n))).toBe(10);
  });

  it('pauses before retrying a failed page instead of retrying instantly', async () => {
    vi.useFakeTimers();
    try {
      const server = keysetServer({ 250000: [makeEvents(2, 0)] });
      let failed = false;
      mockFetch.mockImplementation(async (url) => {
        if (!failed && params(url).get('volume_min') === '250000') { failed = true; return new Response('err', { status: 503 }); }
        return server(url);
      });
      const done = fetchAllMarkets(vi.fn());
      await vi.advanceTimersByTimeAsync(500);
      const callsAt500 = mockFetch.mock.calls.filter(([u]) => params(u).get('volume_min') === '250000').length;
      await vi.advanceTimersByTimeAsync(600);
      const markets = await done;
      expect(callsAt500).toBe(1);                  // retry not sent yet at 500ms
      expect(markets).toHaveLength(2);             // retried after the pause and succeeded
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Catalog volume floor ──

  it('the floor is event-level: every market in a qualifying event is loaded, whatever its own volume', async () => {
    const event = {
      id: 'evt-mixed', slug: 'mixed', active: true,
      markets: [
        { id: 'big', question: 'Big', volume: '250000' },
        { id: 'small', question: 'Small', volume: '1200' },
        { id: 'none', question: 'No volume yet' },
      ],
    };
    mockFetch.mockImplementation(keysetServer({ 250000: [[event]] }));
    const markets = await fetchAllMarkets(vi.fn());
    expect(markets.map((m) => m.id)).toEqual(['big', 'small', 'none']);
  });

  it('never requests events below the floor (bottom band starts at CATALOG_MIN_VOLUME)', async () => {
    mockFetch.mockImplementation(keysetServer({}));
    await fetchAllMarkets(vi.fn());
    const mins = mockFetch.mock.calls.map(([url]) => Number(params(url).get('volume_min')));
    expect(Math.min(...mins)).toBe(CATALOG_MIN_VOLUME);
  });

  it('handles events with multiple markets (fan-out)', async () => {
    mockFetch.mockImplementation(keysetServer({ 250000: [makeEvents(10, 0, 5)] }));
    const result = await fetchAllMarkets(vi.fn());
    expect(result.length).toBe(50);
  });

  it('skips events with no markets array', async () => {
    mockFetch.mockImplementation(keysetServer({
      250000: [[
        { id: 'evt-1', slug: 'no-markets' }, // missing markets array
        { id: 'evt-2', slug: 'with-markets', markets: [{ id: 'm-1', volume: '20000' }] },
      ]],
    }));
    const result = await fetchAllMarkets(vi.fn());
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('m-1');
  });

  // ── Unlisted markets inside open events ──

  // The shapes Gamma returns inside closed=false events (Oct 2026)
  const resolved = { id: 'resolved', question: 'Resolved', volume: '900000', active: true, closed: true, acceptingOrders: false, outcomePrices: '["0", "1"]' };
  const placeholder = { id: 'person-x', question: 'Will Person X win?', active: false, closed: false, acceptingOrders: true, groupItemTitle: 'Person X' };
  const archived = { id: 'archived', question: 'Archived', active: true, closed: false, archived: true, acceptingOrders: false };
  const live = { id: 'live', question: 'Live', volume: '50000', active: true, closed: false, archived: false, acceptingOrders: true };

  it('drops resolved, placeholder and archived markets inside open events', async () => {
    const event = { id: 'evt-mixed', slug: 'mixed', active: true, markets: [resolved, placeholder, archived, live] };
    mockFetch.mockImplementation(keysetServer({ 250000: [[event]] }));
    const markets = await fetchAllMarkets(vi.fn());
    expect(markets.map((m) => m.id)).toEqual(['live']);
  });

  it('progress counts only listed markets', async () => {
    const onProgress = vi.fn();
    const event = { id: 'evt-mixed', slug: 'mixed', active: true, markets: [resolved, placeholder, live] };
    mockFetch.mockImplementation(keysetServer({ 250000: [[event]] }));
    await fetchAllMarkets(onProgress);
    expect(onProgress.mock.calls.at(-1)[0]).toBe(1);
  });

  it('flattenEventsToMarkets (also used by new-market discovery) skips unlisted markets', () => {
    const out = flattenEventsToMarkets([{ id: 'e1', slug: 'e1', markets: [{ ...resolved }, { ...placeholder }, { ...live }] }]);
    expect(out.map((m) => m.id)).toEqual(['live']);
    expect(out[0].events[0]).toMatchObject({ id: 'e1', slug: 'e1' });
  });

  it('isListedMarket keeps markets without status flags (older/partial payloads)', () => {
    expect(isListedMarket({ id: 'x' })).toBe(true);
    expect(isListedMarket(live)).toBe(true);
    expect(isListedMarket(resolved)).toBe(false);
    expect(isListedMarket(placeholder)).toBe(false);
    expect(isListedMarket(archived)).toBe(false);
  });

  it('treats a response without an events array as an empty page', async () => {
    mockFetch.mockImplementation(async () => new Response(JSON.stringify([]), { status: 200 }));
    const result = await fetchAllMarkets(vi.fn());
    expect(mockFetch).toHaveBeenCalledTimes(BAND_MINS.length);
    expect(result).toEqual([]);
  });
});

// ── fetchMarketBySlug ──────────────────────────────────────────────

describe('fetchMarketBySlug', () => {
  it('returns from /events?slug= on first try', async () => {
    const event = { slug: 'test', markets: [{ id: 'm1' }] };
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([event]), { status: 200 }));
    const result = await fetchMarketBySlug('test-slug');
    expect(result.markets).toEqual([{ id: 'm1' }]);
    expect(result.event).toEqual(event);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/events?slug=');
  });

  it('falls back to /markets?slug= when events returns empty', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 })) // events empty
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 'm1' }]), { status: 200 })); // markets
    const result = await fetchMarketBySlug('test-slug');
    expect(result.markets).toEqual([{ id: 'm1' }]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('falls back to truncated slug when full slug fails', async () => {
    // First two attempts (events + markets with full slug) fail
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 })) // events
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 })) // markets
      // Truncated slug attempt succeeds
      .mockResolvedValueOnce(new Response(JSON.stringify([{ slug: 'test', markets: [{ id: 'm1' }] }]), { status: 200 }));
    const result = await fetchMarketBySlug('test-slug-123');
    expect(result).not.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('falls back to text search as last resort', async () => {
    // All slug attempts fail — text search succeeds
    mockFetch.mockImplementation(async (url) => {
      if (url.includes('_q=')) {
        return new Response(JSON.stringify([{ id: 'found' }]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const result = await fetchMarketBySlug('no-match-slug');
    expect(result.markets).toEqual([{ id: 'found' }]);
  });

  it('returns null when all 5 fallback stages fail', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    const result = await fetchMarketBySlug('no-match-slug-123');
    expect(result).toBeNull();
    // events(full) + markets(full) + events(truncated) + markets(truncated) + text search
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it('URL-encodes the slug', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    await fetchMarketBySlug('slug with spaces');
    expect(mockFetch.mock.calls[0][0]).toContain(encodeURIComponent('slug with spaces'));
  });

  it('passes signal to all fetch calls', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    const signal = new AbortController().signal;
    await fetchMarketBySlug('test', signal);
    // withTimeout should have been called with the signal
    expect(withTimeout).toHaveBeenCalledWith(signal, expect.any(Number));
  });

  it('continues to next fallback on network error', async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError('network error'))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 'm1' }]), { status: 200 }));
    const result = await fetchMarketBySlug('test-slug');
    expect(result.markets).toEqual([{ id: 'm1' }]);
  });
});

// ── fetchMarketById, fetchMarketByConditionId, fetchMarketByTokenId ─

describe('fetchMarketById', () => {
  it('calls correct URL with market id', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ id: '42', question: 'test' }), { status: 200 }));
    await fetchMarketById('42');
    expect(mockFetch.mock.calls[0][0]).toBe('/gamma-api/markets/42');
  });

  it('wraps single market in { markets: [data], event: null }', async () => {
    const market = { id: '42', question: 'test' };
    mockFetch.mockResolvedValue(new Response(JSON.stringify(market), { status: 200 }));
    const result = await fetchMarketById('42');
    expect(result).toEqual({ markets: [market], event: null });
  });

  it('returns null when data has no .id', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ question: 'test' }), { status: 200 }));
    const result = await fetchMarketById('42');
    expect(result).toBeNull();
  });

  it('returns null on non-200', async () => {
    mockFetch.mockResolvedValue(new Response('Not Found', { status: 404 }));
    const result = await fetchMarketById('42');
    expect(result).toBeNull();
  });

  it('returns null on AbortError', async () => {
    mockFetch.mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    const result = await fetchMarketById('42');
    expect(result).toBeNull();
  });
});

describe('fetchMarketByConditionId', () => {
  const COND = '0x' + 'ab'.repeat(32);

  it('uses the condition_ids filter (Gamma silently ignores condition_id)', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify([{ id: 'm1', conditionId: COND }]), { status: 200 }));
    await fetchMarketByConditionId(COND);
    const url = new URL(mockFetch.mock.calls[0][0], 'http://localhost');
    expect(url.searchParams.get('condition_ids')).toBe(COND);
    expect(url.searchParams.has('condition_id')).toBe(false);
  });

  it('returns only markets that actually have the condition ID (never an ignored-filter dump)', async () => {
    const data = [{ id: 'm1', conditionId: COND }, { id: 'unrelated', conditionId: '0x' + 'cd'.repeat(32) }];
    mockFetch.mockResolvedValue(new Response(JSON.stringify(data), { status: 200 }));
    const result = await fetchMarketByConditionId(COND.toUpperCase().replace('0X', '0x'));
    expect(result).toEqual({ markets: [data[0]], event: null });
  });

  it('returns null when nothing returned matches', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify([{ id: 'x', conditionId: '0x' + '00'.repeat(32) }]), { status: 200 }));
    expect(await fetchMarketByConditionId(COND)).toBeNull();
  });

  it('returns null on empty array', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    const result = await fetchMarketByConditionId('cond-123');
    expect(result).toBeNull();
  });
});

describe('fetchMarketByTokenId', () => {
  const json = (body) => new Response(JSON.stringify(body), { status: 200 });

  it('calls correct URL with clob_token_ids', async () => {
    mockFetch.mockImplementation(async () => json([{ id: 'm1', clobTokenIds: '["tok-456","tok-x"]' }]));
    await fetchMarketByTokenId('tok-456');
    expect(mockFetch.mock.calls[0][0]).toContain('clob_token_ids=tok-456');
  });

  it('drops returned markets that do not hold the ID', async () => {
    mockFetch.mockImplementation(async () => json([{ id: 'unrelated', clobTokenIds: '["a","b"]' }]));
    expect(await fetchMarketByTokenId('tok-456')).toBeNull();
  });

  it('returns null on non-200', async () => {
    mockFetch.mockResolvedValue(new Response('Not Found', { status: 404 }));
    const result = await fetchMarketByTokenId('tok-456');
    expect(result).toBeNull();
  });

  it('falls back to position_ids (Protocol V2 position IDs) when no CTF token matches', async () => {
    const v2 = { id: 'm-v2', positionIds: ['pos-789', 'pos-790'] };
    mockFetch
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json([v2]));
    const result = await fetchMarketByTokenId('pos-789');
    expect(mockFetch.mock.calls[1][0]).toContain('position_ids=pos-789');
    expect(result).toEqual({ markets: [v2], event: null });
  });

  it('does not try position_ids once clob_token_ids matched', async () => {
    mockFetch.mockImplementation(async () => json([{ id: 'm1', clobTokenIds: '["tok-456","tok-x"]' }]));
    await fetchMarketByTokenId('tok-456');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
