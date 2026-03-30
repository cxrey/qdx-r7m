import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../fetchUtils', () => ({
  withTimeout: vi.fn(() => new AbortController().signal),
  TIMEOUT_DATA_API: 8000,
}));

vi.mock('../categoryPatterns', () => ({
  getCategoryPatterns: vi.fn(() => []),
}));

import {
  fetchMarketTrades, fetchMarketHolders,
  fetchLeaderboard, fetchWalletActivity,
} from '../TradeFlowEngine';
import { setupLocalStorageMock } from './helpers/mockLocalStorage';

let mockFetch;
let mockLocalStorage;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
  const ls = setupLocalStorageMock();
  mockLocalStorage = ls.store;
  vi.stubGlobal('localStorage', ls.mock);
});

afterEach(() => { vi.restoreAllMocks(); });

// ── fetchMarketTrades ──────────────────────────────────────────────

describe('fetchMarketTrades', () => {
  it('tries /data-api/trades?market= first', async () => {
    const trades = [{ id: 't1', price: '0.55' }];
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(trades), { status: 200 }));
    const result = await fetchMarketTrades('cond-abc');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/data-api/trades?market=cond-abc');
    expect(result).toEqual(trades);
  });

  it('falls back to conditionId= param on first failure', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 't1' }]), { status: 200 }));
    const result = await fetchMarketTrades('cond-abc');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toContain('conditionId=cond-abc');
    expect(result).toEqual([{ id: 't1' }]);
  });

  it('returns empty array when both URLs fail', async () => {
    mockFetch.mockResolvedValue(new Response('Not Found', { status: 404 }));
    const result = await fetchMarketTrades('cond-abc');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual([]);
  });

  it('throws on 429 with .status property', async () => {
    mockFetch.mockResolvedValue(new Response('Rate limited', { status: 429 }));
    await expect(fetchMarketTrades('cond-abc')).rejects.toMatchObject({ status: 429 });
  });

  it('throws on 403 with .status property', async () => {
    mockFetch.mockResolvedValue(new Response('Forbidden', { status: 403 }));
    await expect(fetchMarketTrades('cond-abc')).rejects.toMatchObject({ status: 403 });
  });
});

// ── fetchMarketHolders ─────────────────────────────────────────────

describe('fetchMarketHolders', () => {
  it('calls single holders?market= URL', async () => {
    mockFetch.mockResolvedValue(new Response('Not Found', { status: 404 }));
    await fetchMarketHolders('cond-abc');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/holders?market=cond-abc');
  });

  it('returns null on non-200 response', async () => {
    mockFetch.mockResolvedValue(new Response('Not Found', { status: 404 }));
    const result = await fetchMarketHolders('cond-abc');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it('returns parsed data on success', async () => {
    const holders = [{ wallet: '0xabc', amount: 1000 }];
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(holders), { status: 200 }));
    const result = await fetchMarketHolders('cond-abc');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual(holders);
  });

  it('throws on 429 with .status property', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Rate limited', { status: 429 }));
    const err = await fetchMarketHolders('cond-abc').catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(429);
  });

  it('throws on 403 with .status property', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
    const err = await fetchMarketHolders('cond-abc').catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(403);
  });
});

// ── fetchLeaderboard ───────────────────────────────────────────────

describe('fetchLeaderboard', () => {
  it('calls correct leaderboard URL with proper parameters', async () => {
    const data = [{ rank: '1', proxyWallet: '0xabc', pnl: 100, vol: 5000 }];
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));
    await fetchLeaderboard();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('/data-api/v1/leaderboard');
    expect(url).toContain('timePeriod=ALL');
    expect(url).toContain('orderBy=PNL');
    expect(url).toContain('limit=50');
  });

  it('returns null on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    const result = await fetchLeaderboard();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it('returns null on AbortError without throwing', async () => {
    mockFetch.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
    const result = await fetchLeaderboard();
    expect(result).toBeNull();
  });

  it('returns cached result from localStorage within 24h', async () => {
    const cached = { data: [{ rank: '1', proxyWallet: '0xabc' }], ts: Date.now() };
    mockLocalStorage['pm_leaderboard_cache'] = JSON.stringify(cached);
    const result = await fetchLeaderboard();
    expect(result).toEqual(cached.data);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('writes to localStorage on success', async () => {
    const data = [{ rank: '1', proxyWallet: '0xabc', pnl: 100 }];
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(data), { status: 200 }));
    await fetchLeaderboard();
    expect(localStorage.setItem).toHaveBeenCalledWith('pm_leaderboard_cache', expect.any(String));
  });
});

// ── fetchWalletActivity ────────────────────────────────────────────

describe('fetchWalletActivity', () => {
  it('calls correct URL with user param', async () => {
    const trades = [{ id: 't1' }];
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(trades), { status: 200 }));
    await fetchWalletActivity('0xAbCdEf');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/activity?user=0xAbCdEf');
    expect(mockFetch.mock.calls[0][0]).toContain('type=TRADE');
  });

  it('returns cached result from localStorage', async () => {
    const cached = { data: [{ id: 't1' }], ts: Date.now() };
    mockLocalStorage['pm_wallet_hist_0xabcdef'] = JSON.stringify(cached);
    const result = await fetchWalletActivity('0xAbCdEf');
    expect(result).toEqual(cached.data);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns null on failure', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Server Error', { status: 500 }));
    const result = await fetchWalletActivity('0xAbCdEf');
    expect(result).toBeNull();
  });
});
