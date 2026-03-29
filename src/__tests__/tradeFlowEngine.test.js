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
  it('tries 3 endpoint variants in sequential order', async () => {
    mockFetch.mockResolvedValue(new Response('Not Found', { status: 404 }));
    await fetchMarketHolders('cond-abc');
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // Verify sequential ordering: holders?market → holders?conditionId → positions?market
    const urls = mockFetch.mock.calls.map((c) => c[0]);
    expect(urls[0]).toContain('/holders?market=cond-abc');
    expect(urls[1]).toContain('/holders?conditionId=cond-abc');
    expect(urls[2]).toContain('/positions?market=cond-abc');
  });

  it('returns null when all variants fail', async () => {
    mockFetch.mockResolvedValue(new Response('Not Found', { status: 404 }));
    const result = await fetchMarketHolders('cond-abc');
    expect(result).toBeNull();
  });

  it('returns parsed data on first success and short-circuits', async () => {
    const holders = [{ wallet: '0xabc', amount: 1000 }];
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(holders), { status: 200 }));
    const result = await fetchMarketHolders('cond-abc');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual(holders);
  });

  it('does NOT throw on 429 — continues to next variant', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('Rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('Rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('Rate limited', { status: 429 }));
    // Should not throw — returns null
    const result = await fetchMarketHolders('cond-abc');
    expect(result).toBeNull();
  });
});

// ── fetchLeaderboard ───────────────────────────────────────────────

describe('fetchLeaderboard', () => {
  it('tries 3 endpoint URLs sequentially', async () => {
    mockFetch.mockResolvedValue(new Response('Not Found', { status: 404 }));
    await fetchLeaderboard();
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[0][0]).toContain('/leaderboard');
    expect(mockFetch.mock.calls[1][0]).toContain('/rankings');
    expect(mockFetch.mock.calls[2][0]).toContain('/top-traders');
  });

  it('returns null when all return 404', async () => {
    mockFetch.mockResolvedValue(new Response('Not Found', { status: 404 }));
    const result = await fetchLeaderboard();
    expect(result).toBeNull();
  });

  it('returns cached result from localStorage within 24h', async () => {
    const cached = { data: [{ rank: 1, name: 'trader1' }], ts: Date.now() };
    mockLocalStorage['pm_leaderboard_cache'] = JSON.stringify(cached);
    const result = await fetchLeaderboard();
    expect(result).toEqual(cached.data);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('writes to localStorage on success', async () => {
    const data = [{ rank: 1, name: 'top' }];
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
