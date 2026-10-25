// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('../api', () => ({ fetchMarketById: vi.fn() }));
vi.mock('../dataApi', async (importOriginal) => ({ ...(await importOriginal()), dataApiGet: vi.fn() }));

import { fetchMarketById } from '../api';
import { dataApiGet } from '../dataApi';
import { usePortfolio } from '../hooks/usePortfolio';

const MANUAL_KEY = 'polymarket-portfolio-manual';
const WALLET_KEY = 'polymarket-portfolio-wallet';

// Manual positions save a copy of their market (with its price) when added
const manual = (marketId, snapshotYes, extra = {}) => ({
  marketId, side: 'YES', size: 100, entryPrice: 0.4, currentPrice: snapshotYes,
  market: { id: marketId, question: `Market ${marketId}?`, yesPrice: snapshotYes, noPrice: 1 - snapshotYes },
  ...extra,
});
const loaded = (id, yesPrice) => ({ id, question: `Market ${id}?`, yesPrice, noPrice: 1 - yesPrice });
const gamma = (id, outcomePrices, closed) => ({ markets: [{ id, outcomePrices, closed }] });

const positionFor = (result, id) => result.current.allPositions.find((p) => String(p.marketId) === id);

beforeEach(() => {
  localStorage.clear();
  fetchMarketById.mockReset();
  dataApiGet.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('usePortfolio — positions follow live price ticks', () => {
  // A price tick replaces only the changed market's object (Immer); the
  // array keeps its length and order.
  const tick = (markets, id, yesPrice) => markets.map((m) => (m.id === id ? { ...m, yesPrice, noPrice: 1 - yesPrice } : m));

  it('a manual position follows a price tick on its loaded market', async () => {
    localStorage.setItem(MANUAL_KEY, JSON.stringify([manual('live', 0.3)]));
    const before = [loaded('live', 0.6), loaded('other', 0.5)];
    const { result, rerender } = renderHook(({ markets }) => usePortfolio(markets), { initialProps: { markets: before } });
    expect(positionFor(result, 'live').currentPrice).toBe(0.6);

    rerender({ markets: tick(before, 'live', 0.7) });
    const pos = positionFor(result, 'live');
    expect(pos.currentPrice).toBe(0.7);
    expect(pos.currentValue).toBeCloseTo(70);
    expect(pos.unrealizedPnl).toBeCloseTo(30);
  });

  it('a wallet position follows a price tick, not just the 5-minute wallet refresh', async () => {
    localStorage.setItem(WALLET_KEY, '0x' + '1'.repeat(40));
    dataApiGet.mockResolvedValue({ ok: true, hasMore: false, rows: [{ token_id: 'live-yes', condition_id: 'c-live', current_size: 10, avg_price: 0.5 }] });
    const live = { ...loaded('live', 0.6), conditionId: 'c-live', clobTokenIds: ['live-yes', 'live-no'] };
    const before = [live, loaded('other', 0.5)];
    const { result, rerender } = renderHook(({ markets }) => usePortfolio(markets), { initialProps: { markets: before } });
    await waitFor(() => expect(result.current.walletPositions).toHaveLength(1));
    const walletPos = () => result.current.allPositions.find((p) => p.source === 'wallet');
    expect(walletPos().currentPrice).toBe(0.6);

    rerender({ markets: tick(before, 'live', 0.8) });
    expect(walletPos().currentPrice).toBe(0.8);
    expect(walletPos().currentValue).toBeCloseTo(8);
    expect(walletPos().unrealizedPnl).toBeCloseTo(3);
    expect(dataApiGet).toHaveBeenCalledTimes(1); // re-priced locally, no extra request
  });

  it('a tick on a market nobody holds leaves the portfolio untouched (no re-render work)', () => {
    localStorage.setItem(MANUAL_KEY, JSON.stringify([manual('live', 0.3)]));
    const before = [loaded('live', 0.6), loaded('other', 0.5)];
    const { result, rerender } = renderHook(({ markets }) => usePortfolio(markets), { initialProps: { markets: before } });
    const portfolioBefore = result.current;

    rerender({ markets: tick(before, 'other', 0.9) });
    expect(result.current.allPositions).toBe(portfolioBefore.allPositions);
    expect(result.current).toBe(portfolioBefore);
  });

  it('the row context stays the same object when a HELD market ticks (rows need side/size, not price)', () => {
    localStorage.setItem(MANUAL_KEY, JSON.stringify([manual('live', 0.3)]));
    const before = [loaded('live', 0.6), loaded('other', 0.5)];
    const { result, rerender } = renderHook(({ markets }) => usePortfolio(markets), { initialProps: { markets: before } });
    const rowBefore = result.current.rowContext;

    rerender({ markets: tick(before, 'live', 0.7) });
    expect(positionFor(result, 'live').currentPrice).toBe(0.7); // the full portfolio did update
    expect(result.current.rowContext).toBe(rowBefore);
    expect(result.current.rowContext.getHeldPosition('live')).toMatchObject({ marketId: 'live', side: 'YES', size: 100 });
    expect(result.current.rowContext.isMarketHeld('live')).toBe(true);
    expect(result.current.rowContext.isMarketHeld('other')).toBe(false);
  });

  it('the row context changes when holdings change', async () => {
    const before = [loaded('live', 0.6), loaded('other', 0.5)];
    const { result } = renderHook(() => usePortfolio(before));
    const rowBefore = result.current.rowContext;
    expect(rowBefore.hasPortfolio).toBe(false);

    act(() => result.current.addManualPosition(manual('other', 0.5)));
    expect(result.current.rowContext).not.toBe(rowBefore);
    expect(result.current.rowContext.hasPortfolio).toBe(true);
    expect(result.current.rowContext.isMarketHeld('other')).toBe(true);
  });

  it('a held-price tick re-prices the analysis without rebuilding its correlation structure', () => {
    localStorage.setItem(MANUAL_KEY, JSON.stringify([manual('live', 0.3), manual('other', 0.5)]));
    const before = [loaded('live', 0.6), loaded('other', 0.5)];
    const { result, rerender } = renderHook(({ markets }) => usePortfolio(markets), { initialProps: { markets: before } });
    const matrixBefore = result.current.analysis.correlationMatrix;
    const valueBefore = result.current.analysis.clusters.reduce((s, c) => s + c.totalValue, 0);

    rerender({ markets: tick(before, 'live', 0.9) });
    expect(result.current.analysis.correlationMatrix).toBe(matrixBefore); // structure reused
    expect(result.current.analysis.clusters.reduce((s, c) => s + c.totalValue, 0)).toBeCloseTo(valueBefore + 30);
  });

  it('screenTrade is computed once per market until the portfolio changes', () => {
    localStorage.setItem(MANUAL_KEY, JSON.stringify([manual('live', 0.3)]));
    const before = [loaded('live', 0.6), loaded('other', 0.5)];
    const { result, rerender } = renderHook(({ markets }) => usePortfolio(markets), { initialProps: { markets: before } });
    const first = result.current.screenTrade(loaded('other', 0.5));
    expect(result.current.screenTrade(loaded('other', 0.5))).toBe(first);

    rerender({ markets: tick(before, 'live', 0.7) }); // held price moved → portfolio changed
    expect(result.current.screenTrade(loaded('other', 0.5))).not.toBe(first);
  });

  it('price ticks do not re-trigger lookups for unloaded markets', async () => {
    localStorage.setItem(MANUAL_KEY, JSON.stringify([manual('under-floor', 0.2)]));
    fetchMarketById.mockResolvedValue(gamma('under-floor', '["0.25", "0.75"]', false));
    const before = [loaded('a', 0.5)];
    const { result, rerender } = renderHook(({ markets }) => usePortfolio(markets), { initialProps: { markets: before } });
    await waitFor(() => expect(positionFor(result, 'under-floor').currentPrice).toBe(0.25));

    rerender({ markets: tick(before, 'a', 0.55) });
    rerender({ markets: tick(before, 'a', 0.6) });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMarketById).toHaveBeenCalledTimes(1);
  });
});

describe('usePortfolio — manual positions in markets the catalog does not hold', () => {
  it('prices a resolved market from a direct lookup, not the copy saved when it was added', async () => {
    localStorage.setItem(MANUAL_KEY, JSON.stringify([manual('live', 0.3), manual('resolved', 0.4)]));
    fetchMarketById.mockResolvedValue(gamma('resolved', '["1", "0"]', true));

    const { result } = renderHook(() => usePortfolio([loaded('live', 0.6)]));

    await waitFor(() => expect(positionFor(result, 'resolved').currentPrice).toBe(1));
    const resolved = positionFor(result, 'resolved');
    expect(resolved.currentValue).toBe(100);
    expect(resolved.unrealizedPnl).toBeCloseTo(60);
    expect(resolved.market).toMatchObject({ closed: true, question: 'Market resolved?' });
    // The loaded market is priced from the catalog and never looked up
    expect(positionFor(result, 'live').currentPrice).toBe(0.6);
    expect(fetchMarketById).toHaveBeenCalledTimes(1);
    expect(fetchMarketById.mock.calls[0][0]).toBe('resolved');
  });

  it('does not look anything up before the catalog has loaded', async () => {
    localStorage.setItem(MANUAL_KEY, JSON.stringify([manual('resolved', 0.4)]));
    renderHook(() => usePortfolio([]));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMarketById).not.toHaveBeenCalled();
  });

  it('keeps the saved price when the lookup fails', async () => {
    localStorage.setItem(MANUAL_KEY, JSON.stringify([manual('gone', 0.4)]));
    fetchMarketById.mockResolvedValue(null);
    const { result } = renderHook(() => usePortfolio([loaded('other', 0.5)]));
    await waitFor(() => expect(fetchMarketById).toHaveBeenCalled());
    expect(positionFor(result, 'gone').currentPrice).toBe(0.4);
  });

  it('re-fetches open unloaded markets but never settled ones', async () => {
    localStorage.setItem(MANUAL_KEY, JSON.stringify([manual('resolved', 0.4), manual('under-floor', 0.2)]));
    fetchMarketById.mockImplementation(async (id) => (id === 'resolved'
      ? gamma('resolved', '["0", "1"]', true)
      : gamma('under-floor', '["0.25", "0.75"]', false)));

    const { result, rerender } = renderHook(({ markets }) => usePortfolio(markets), {
      initialProps: { markets: [loaded('a', 0.5)] },
    });
    await waitFor(() => expect(positionFor(result, 'under-floor').currentPrice).toBe(0.25));
    expect(positionFor(result, 'resolved').currentPrice).toBe(0);

    fetchMarketById.mockClear();
    rerender({ markets: [loaded('a', 0.5), loaded('b', 0.5)] }); // catalog changed → lookups re-run
    await waitFor(() => expect(fetchMarketById).toHaveBeenCalled());
    expect(fetchMarketById.mock.calls.map(([id]) => id)).toEqual(['under-floor']);
  });
});
