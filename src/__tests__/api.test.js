import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock fetchUtils — withTimeout returns a passthrough AbortSignal
// (avoids real timers in most tests; timeout behavior tested in fetchUtils.test.js)
vi.mock('../fetchUtils', () => ({
  withTimeout: vi.fn((callerSignal) => callerSignal || new AbortController().signal),
  TIMEOUT_GAMMA_PAGE: 10000,
}));

// Use real truncateSlugNumerics — it's a pure function with no dependencies

import {
  fetchAllMarkets, fetchOrderBook, fetchPriceHistory,
  fetchMarketById, fetchMarketBySlug,
  fetchMarketByConditionId, fetchMarketByTokenId,
} from '../api';
import { withTimeout } from '../fetchUtils';

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

describe('fetchPriceHistory', () => {
  it('uses interval param when no start/end timestamps', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ history: [] }), { status: 200 }));
    await fetchPriceHistory('tok-1', '1d', null, null, null);
    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('market=tok-1');
    expect(url).toContain('interval=1d');
    expect(url).not.toContain('startTs');
  });

  it('uses startTs and endTs when provided', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ history: [] }), { status: 200 }));
    await fetchPriceHistory('tok-1', '1d', null, 1000, 2000);
    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('startTs=1000');
    expect(url).toContain('endTs=2000');
    expect(url).not.toContain('interval=');
  });

  it('appends fidelity when provided', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    await fetchPriceHistory('tok-1', '1d', 60, null, null);
    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('fidelity=60');
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

  it('returns parsed JSON on 200', async () => {
    const data = { history: [{ t: 1, p: 0.5 }] };
    mockFetch.mockResolvedValue(new Response(JSON.stringify(data), { status: 200 }));
    const result = await fetchPriceHistory('tok-1', '1d');
    expect(result).toEqual(data);
  });
});

// ── fetchAllMarkets ────────────────────────────────────────────────

describe('fetchAllMarkets', () => {
  // Helper: make an events page with n events, each containing marketsPerEvent markets.
  // Returns the shape of a /events API response: array of event objects with nested markets.
  function makeEventsPage(nEvents, startEventId = 0, marketsPerEvent = 1) {
    return Array.from({ length: nEvents }, (_, i) => {
      const eventId = startEventId + i;
      return {
        id: `evt-${eventId}`,
        slug: `event-${eventId}`,
        tags: [{ slug: 'crypto', label: 'Crypto' }],
        markets: Array.from({ length: marketsPerEvent }, (_, j) => ({
          id: `m-${eventId}-${j}`,
          question: `Market ${eventId}-${j}`,
        })),
      };
    });
  }

  it('fetches from /events endpoint (not /markets)', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    await fetchAllMarkets(vi.fn());
    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('/events?');
    expect(url).not.toContain('/markets?');
  });

  it('flattens nested markets from events and injects parent event data', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // 1 event with 3 nested markets
        return new Response(JSON.stringify(makeEventsPage(1, 0, 3)), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const result = await fetchAllMarkets(vi.fn());
    expect(result.length).toBe(3);
    // Each market should have events[0] injected with parent event data (tags, slug)
    expect(result[0].events[0].tags[0].slug).toBe('crypto');
    expect(result[0].events[0].slug).toBe('event-0');
    // Nested markets array should NOT be on the injected event data
    expect(result[0].events[0].markets).toBeUndefined();
  });

  it('fetches in batches of 5 (CONCURRENCY)', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount <= 5) {
        return new Response(JSON.stringify(makeEventsPage(100, (callCount - 1) * 100)), { status: 200 });
      }
      // Second batch: return empty to signal done
      return new Response(JSON.stringify([]), { status: 200 });
    });
    await fetchAllMarkets(vi.fn());
    expect(callCount).toBe(10); // 2 batches of 5
  });

  it('calls onProgress with cumulative market count after each batch', async () => {
    const onProgress = vi.fn();
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount <= 5) {
        // 100 events × 1 market each = 100 markets per page
        return new Response(JSON.stringify(makeEventsPage(100, (callCount - 1) * 100)), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    await fetchAllMarkets(onProgress);
    expect(onProgress).toHaveBeenCalledWith(500); // 5 pages × 100 markets
  });

  it('stops when a 200 page returns empty array', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return new Response(JSON.stringify(makeEventsPage(100)), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const result = await fetchAllMarkets(vi.fn());
    expect(result.length).toBe(100);
  });

  it('stops when a page returns fewer events than reference', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return new Response(JSON.stringify(makeEventsPage(100, 0)), { status: 200 });
      if (callCount === 2) return new Response(JSON.stringify(makeEventsPage(100, 100)), { status: 200 });
      if (callCount === 3) return new Response(JSON.stringify(makeEventsPage(50, 200)), { status: 200 }); // partial
      if (callCount === 4) return new Response(JSON.stringify(makeEventsPage(100, 300)), { status: 200 });
      if (callCount === 5) return new Response(JSON.stringify(makeEventsPage(100, 400)), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const result = await fetchAllMarkets(vi.fn());
    // Should collect all from first batch (partial event page triggers done flag)
    expect(result.length).toBe(450);
  });

  it('collects data from ALL pages in batch even when one returns 429', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 3) return new Response(JSON.stringify([]), { status: 429 });
      if (callCount <= 5) {
        return new Response(JSON.stringify(makeEventsPage(100, (callCount - 1) * 100)), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const result = await fetchAllMarkets(vi.fn());
    // Pages 1,2,4,5 succeeded (400 markets); page 3 was 429
    expect(result.length).toBe(400);
  });

  it('stops fetching new batches after 429', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 3) return new Response(JSON.stringify([]), { status: 429 });
      return new Response(JSON.stringify(makeEventsPage(100, (callCount - 1) * 100)), { status: 200 });
    });
    await fetchAllMarkets(vi.fn());
    // Only the first batch of 5 should run — no second batch
    expect(callCount).toBe(5);
  });

  it('stops when signal is aborted', async () => {
    const controller = new AbortController();
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 3) controller.abort();
      if (callCount <= 5) {
        return new Response(JSON.stringify(makeEventsPage(100, (callCount - 1) * 100)), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    // withTimeout returns the callerSignal — so the AbortError propagates
    // But fetchAllMarkets catches AbortError and breaks
    const result = await fetchAllMarkets(vi.fn(), controller.signal);
    // All 5 concurrent pages complete before abort check; loop breaks before batch 2
    expect(result.length).toBe(500);
  });

  it('returns empty array when first page is empty', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    const result = await fetchAllMarkets(vi.fn());
    expect(result).toEqual([]);
  });

  it('handles mixed success/failure in a batch', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) return new Response('Server Error', { status: 500 });
      if (callCount === 4) throw new TypeError('network');
      if (callCount <= 5) {
        return new Response(JSON.stringify(makeEventsPage(100, (callCount - 1) * 100)), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const result = await fetchAllMarkets(vi.fn());
    // Pages 1,3,5 succeed (300 markets); page 2 is 500, page 4 throws TypeError
    expect(result.length).toBe(300);
  });

  it('handles network TypeError in a batch page', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) throw new TypeError('fetch failed');
      if (callCount <= 5) {
        return new Response(JSON.stringify(makeEventsPage(100, (callCount - 1) * 100)), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const result = await fetchAllMarkets(vi.fn());
    // Pages 1,3,4,5 succeed (400 markets); page 2 throws TypeError (0 markets)
    expect(result.length).toBe(400);
  });

  it('does NOT call onProgress when no data collected', async () => {
    const onProgress = vi.fn();
    mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    await fetchAllMarkets(onProgress);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('URL includes required query params', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    await fetchAllMarkets(vi.fn());
    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('/events?');
    expect(url).toContain('active=true');
    expect(url).toContain('closed=false');
    expect(url).toContain('volume_num_min=100');
    expect(url).toContain('limit=100');
  });

  it('uses correct offset progression across pages', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount <= 5) {
        return new Response(JSON.stringify(makeEventsPage(100, (callCount - 1) * 100)), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    await fetchAllMarkets(vi.fn());
    // First batch: offsets 0, 100, 200, 300, 400
    expect(mockFetch.mock.calls[0][0]).toContain('offset=0');
    expect(mockFetch.mock.calls[1][0]).toContain('offset=100');
    expect(mockFetch.mock.calls[2][0]).toContain('offset=200');
    expect(mockFetch.mock.calls[3][0]).toContain('offset=300');
    expect(mockFetch.mock.calls[4][0]).toContain('offset=400');
  });

  it('returns empty array without throwing on AbortError mid-batch', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async (url, opts) => {
      callCount++;
      if (callCount === 3) {
        throw new DOMException('Aborted', 'AbortError');
      }
      return new Response(JSON.stringify(makeEventsPage(100, (callCount - 1) * 100)), { status: 200 });
    });
    // Promise.all rejects on AbortError → catch breaks → no results collected
    const result = await fetchAllMarkets(vi.fn());
    expect(result).toEqual([]);
  });

  it('caps at MAX_PAGES (200) and does not loop forever', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      // Always return a full page — never triggers empty-page stop
      return new Response(JSON.stringify(makeEventsPage(100, (callCount - 1) * 100)), { status: 200 });
    });
    const result = await fetchAllMarkets(vi.fn());
    // MAX_PAGES=200, CONCURRENCY=5 → 40 iterations × 5 = 200 fetch calls
    // Key assertion: it stops, not loops forever
    expect(callCount).toBe(200);
    expect(result.length).toBe(20_000);
  });

  it('handles events with multiple markets (fan-out)', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // 10 events × 5 markets each = 50 markets
        return new Response(JSON.stringify(makeEventsPage(10, 0, 5)), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const result = await fetchAllMarkets(vi.fn());
    expect(result.length).toBe(50);
  });

  it('skips events with no markets array', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify([
          { id: 'evt-1', slug: 'no-markets' }, // missing markets array
          { id: 'evt-2', slug: 'with-markets', markets: [{ id: 'm-1' }] },
        ]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const result = await fetchAllMarkets(vi.fn());
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('m-1');
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
  it('calls correct URL with condition_id', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify([{ id: 'm1' }]), { status: 200 }));
    await fetchMarketByConditionId('cond-123');
    expect(mockFetch.mock.calls[0][0]).toContain('condition_id=cond-123');
  });

  it('returns { markets: data, event: null } for array result', async () => {
    const data = [{ id: 'm1' }, { id: 'm2' }];
    mockFetch.mockResolvedValue(new Response(JSON.stringify(data), { status: 200 }));
    const result = await fetchMarketByConditionId('cond-123');
    expect(result).toEqual({ markets: data, event: null });
  });

  it('returns null on empty array', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    const result = await fetchMarketByConditionId('cond-123');
    expect(result).toBeNull();
  });
});

describe('fetchMarketByTokenId', () => {
  it('calls correct URL with clob_token_ids', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify([{ id: 'm1' }]), { status: 200 }));
    await fetchMarketByTokenId('tok-456');
    expect(mockFetch.mock.calls[0][0]).toContain('clob_token_ids=tok-456');
  });

  it('returns null on non-200', async () => {
    mockFetch.mockResolvedValue(new Response('Not Found', { status: 404 }));
    const result = await fetchMarketByTokenId('tok-456');
    expect(result).toBeNull();
  });
});
