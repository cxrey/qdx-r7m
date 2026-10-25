import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../fetchUtils', () => ({
  withTimeout: vi.fn(() => new AbortController().signal),
  TIMEOUT_DATA_API: 8000,
}));

import { dataApiGet, toV1Row } from '../dataApi';
import {
  WALLET, CONDITION, YES_TOKEN, NO_TOKEN, envelope, jsonResponse,
  v2Trade, v2HolderGroup, v2LeaderboardEntry, v2Activity, v2Position,
} from './helpers/dataApiV2Fixtures';

let mockFetch;
beforeEach(() => { mockFetch = vi.fn(); vi.stubGlobal('fetch', mockFetch); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('toV1Row — maps v2 rows to the v1 shape consumers read', () => {
  it('trade: snake_case → camelCase and token_id → asset', () => {
    const r = toV1Row(v2Trade(), 'trade');
    expect(r).toMatchObject({ proxyWallet: WALLET, asset: YES_TOKEN, conditionId: CONDITION, outcomeIndex: 0, eventSlug: 'test-event', transactionHash: expect.any(String) });
    expect(r.token_id).toBeUndefined();
    expect(r.tokenId).toBeUndefined();
  });

  it('activity keeps usdcSize and the trade fields', () => {
    const r = toV1Row(v2Activity(), 'activity');
    expect(r).toMatchObject({ usdcSize: 193.15, size: 199.95, price: 0.966, type: 'TRADE', asset: YES_TOKEN, proxyWallet: WALLET });
  });

  it('holder group: token_id → token, and each nested holder is mapped', () => {
    const g = toV1Row(v2HolderGroup(YES_TOKEN, [{ amount: 7000 }]), 'holderGroup');
    expect(g.token).toBe(YES_TOKEN);
    expect(g.holders[0]).toMatchObject({ proxyWallet: WALLET, amount: 7000, outcomeIndex: 0, asset: YES_TOKEN, displayUsernamePublic: true });
  });

  it('leaderboard: user_id → proxyWallet, volume → vol, verified → verifiedBadge', () => {
    const r = toV1Row(v2LeaderboardEntry(), 'leaderboard');
    expect(r).toMatchObject({ rank: 1, proxyWallet: WALLET, pnl: 125000.5, vol: 900000.25, userName: 'top-trader', verifiedBadge: true, xUsername: '' });
  });

  it('position: current_size → size, avg_price → avgPrice, current_price → curPrice', () => {
    const r = toV1Row(v2Position(), 'position');
    expect(r).toMatchObject({ size: 1500, avgPrice: 0.4, curPrice: 0.55, currentValue: 825, asset: YES_TOKEN, oppositeAsset: NO_TOKEN, conditionId: CONDITION, cashPnl: 223.8, redeemable: false, outcomeIndex: 0 });
  });

  it('passes non-objects through', () => {
    expect(toV1Row(null, 'trade')).toBeNull();
    expect(toV1Row(5, 'trade')).toBe(5);
  });
});

describe('dataApiGet', () => {
  it('builds a /v2 URL from params, dropping null/undefined', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(envelope([])));
    await dataApiGet('/v2/trades', { condition: CONDITION, limit: 200, user: undefined, cursor: null });
    const url = mockFetch.mock.calls[0][0];
    expect(url).toBe(`/data-api/v2/trades?condition=${CONDITION}&limit=200`);
  });

  it('never sends v1-only params (offset/market)', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(envelope([])));
    await dataApiGet('/v2/holders', { condition: CONDITION, limit: 20 });
    expect(mockFetch.mock.calls[0][0]).not.toMatch(/[?&](offset|market)=/);
  });

  it('unwraps the data envelope', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(envelope([v2Trade(), v2Trade()])));
    const res = await dataApiGet('/v2/trades', { condition: CONDITION });
    expect(res).toMatchObject({ ok: true, hasMore: false });
    expect(res.rows).toHaveLength(2);
  });

  it('returns only the first page by default but reports hasMore', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(envelope([v2Trade()], { nextCursor: 'c1' })));
    const res = await dataApiGet('/v2/trades', { condition: CONDITION });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(res.hasMore).toBe(true);
  });

  it('follows next_cursor up to maxPages', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(envelope([v2Position()], { nextCursor: 'c1' })))
      .mockResolvedValueOnce(jsonResponse(envelope([v2Position()], { nextCursor: 'c2' })))
      .mockResolvedValueOnce(jsonResponse(envelope([v2Position()])));
    const res = await dataApiGet('/v2/positions', { user: WALLET }, { maxPages: 5 });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[1][0]).toContain('cursor=c1');
    expect(mockFetch.mock.calls[2][0]).toContain('cursor=c2');
    expect(res.rows).toHaveLength(3);
    expect(res.hasMore).toBe(false);
  });

  it('stops at maxPages and reports the truncation', async () => {
    mockFetch.mockImplementation(async () => jsonResponse(envelope([v2Position()], { nextCursor: 'more' })));
    const res = await dataApiGet('/v2/positions', { user: WALLET }, { maxPages: 2 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(res.hasMore).toBe(true);
  });

  it('treats data: null (documented miss) as no rows', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: null, pagination: {} }));
    const res = await dataApiGet('/v2/user-stats', { user: WALLET });
    expect(res).toEqual({ ok: true, rows: [], hasMore: false });
  });

  it('returns the server error message on a 400', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "'offset' is not a query param on this API" }, 400));
    const res = await dataApiGet('/v2/trades', { condition: CONDITION });
    expect(res).toEqual({ ok: false, status: 400, error: "'offset' is not a query param on this API" });
  });

  it('handles a non-JSON error body', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }));
    expect(await dataApiGet('/v2/trades', {})).toEqual({ ok: false, status: 502, error: null });
  });

  it('throws on 429/403 with .status so rate-limit handling still works', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Rate limited', { status: 429 }));
    await expect(dataApiGet('/v2/trades', {})).rejects.toMatchObject({ status: 429 });
    mockFetch.mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
    await expect(dataApiGet('/v2/trades', {})).rejects.toMatchObject({ status: 403 });
  });
});
