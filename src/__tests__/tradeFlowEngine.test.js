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
import { envelope, jsonResponse, v2Trade, v2HolderGroup, v2LeaderboardEntry, v2Activity, YES_TOKEN, NO_TOKEN, WALLET } from './helpers/dataApiV2Fixtures';

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
  it('calls /v2/trades?condition= and returns v1-shaped trades', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(envelope([v2Trade({ price: 0.55 })])));
    const result = await fetchMarketTrades('cond-abc');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('/data-api/v2/trades?condition=cond-abc&limit=200');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ proxyWallet: WALLET, price: 0.55, asset: YES_TOKEN, outcomeIndex: 0 });
  });

  it('returns empty array on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    const result = await fetchMarketTrades('cond-abc');
    expect(mockFetch).toHaveBeenCalledTimes(1);
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
  it('calls /v2/holders?condition= (v2 rejects the v1 market param)', async () => {
    mockFetch.mockResolvedValue(new Response('Not Found', { status: 404 }));
    await fetchMarketHolders('cond-abc');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('/data-api/v2/holders?condition=cond-abc&limit=20');
  });

  it('returns null on non-200 response', async () => {
    mockFetch.mockResolvedValue(new Response('Not Found', { status: 404 }));
    const result = await fetchMarketHolders('cond-abc');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it('returns v1-shaped holder groups on success', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(envelope([
      v2HolderGroup(YES_TOKEN, [{ amount: 1000 }]),
      v2HolderGroup(NO_TOKEN, [{ amount: 400 }]),
    ])));
    const result = await fetchMarketHolders('cond-abc');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.map((g) => g.token)).toEqual([YES_TOKEN, NO_TOKEN]);
    expect(result[0].holders[0]).toMatchObject({ proxyWallet: WALLET, amount: 1000, outcomeIndex: 0 });
    expect(result[1].holders[0]).toMatchObject({ amount: 400, outcomeIndex: 1 });
  });

  it('returns null when v2 reports no holders', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(envelope([])));
    expect(await fetchMarketHolders('cond-abc')).toBeNull();
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
  it('calls /v2/leaderboard with proper parameters', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(envelope([v2LeaderboardEntry()])));
    await fetchLeaderboard();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('/data-api/v2/leaderboard');
    expect(url).toContain('timePeriod=ALL');
    expect(url).toContain('orderBy=PNL');
    expect(url).toContain('limit=50');
  });

  it('maps v2 entries to the v1 shape (user_id → proxyWallet, volume → vol)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(envelope([v2LeaderboardEntry({ rank: 3, pnl: 42, volume: 99 })])));
    const result = await fetchLeaderboard();
    expect(result[0]).toMatchObject({ rank: 3, proxyWallet: WALLET, pnl: 42, vol: 99 });
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
    mockFetch.mockResolvedValueOnce(jsonResponse(envelope([v2LeaderboardEntry()])));
    await fetchLeaderboard();
    expect(localStorage.setItem).toHaveBeenCalledWith('pm_leaderboard_cache', expect.any(String));
  });
});

// ── fetchWalletActivity ────────────────────────────────────────────

describe('fetchWalletActivity', () => {
  it('calls /v2/activity with user param and returns v1-shaped rows', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(envelope([v2Activity()])));
    const result = await fetchWalletActivity('0xAbCdEf');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/data-api/v2/activity?user=0xAbCdEf');
    expect(mockFetch.mock.calls[0][0]).toContain('type=TRADE');
    expect(result[0]).toMatchObject({ usdcSize: 193.15, conditionId: expect.any(String), outcomeIndex: 0, asset: YES_TOKEN });
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
