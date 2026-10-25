// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('../api', () => ({ fetchMarketById: vi.fn() }));

import { fetchMarketById } from '../api';
import { usePortfolio } from '../hooks/usePortfolio';

const MANUAL_KEY = 'polymarket-portfolio-manual';

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
});
afterEach(() => { vi.restoreAllMocks(); });

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
