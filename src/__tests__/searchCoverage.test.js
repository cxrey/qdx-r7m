// @vitest-environment jsdom
/**
 * Search and filter coverage: slider tops mean "no upper limit", search
 * matches event titles, and the Polymarket-search hook only runs for text
 * and returns processed markets that the same filters then apply to.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { filterAndSort, matchesSearch, searchRegex } from '../utils/filterAndSort';
import { DEFAULT_FILTERS, VOLUME_FILTER_MAX, DAYS_FILTER_MAX } from '../filterDefaults';
import { makeProcessedMarket } from './helpers/marketFixtures';

vi.mock('../api', () => ({ searchActiveMarkets: vi.fn() }));
const { searchActiveMarkets } = await import('../api');
const { useRemoteSearch } = await import('../hooks/useRemoteSearch');

const run = (markets, filters = {}, searchLower = '') => filterAndSort({
  markets,
  filters: { ...DEFAULT_FILTERS, volumeRange: [0, VOLUME_FILTER_MAX], ...filters },
  searchLower,
  lookupState: { isLookupActive: false, fetchedMarkets: [], foundInLoadedId: null },
  portfolio: { hasPortfolio: false, isMarketHeld: () => false },
}).map((m) => m.id);

describe('slider tops mean no upper limit', () => {
  it('a market above $50M volume is shown at the default range', () => {
    const big = makeProcessedMarket({ id: 'big', volume: 80_000_000 });
    expect(run([big])).toEqual(['big']);
    // A lowered top still cuts off
    expect(run([big], { volumeRange: [0, 10_000_000] })).toEqual([]);
  });

  it('a market more than 365 days out is shown at the default range', () => {
    const far = makeProcessedMarket({ id: 'far', daysLeft: 700 });
    expect(DEFAULT_FILTERS.daysLeftRange[1]).toBe(DAYS_FILTER_MAX);
    expect(run([far])).toEqual(['far']);
    expect(run([far], { daysLeftRange: [0, 200] })).toEqual([]);
  });
});

describe('search matches the event title', () => {
  it('a prop market is found by the fighters named only in its event title', () => {
    const prop = makeProcessedMarket({
      id: 'prop', question: 'Fight to Go the Distance?', description: 'Resolves YES if…',
      eventTitle: 'UFC Fight Night: Randy Brown vs. Jacobe Smith',
    });
    expect(matchesSearch(prop, searchRegex('randy brown'))).toBe(true);
    expect(run([prop], {}, 'randy brown')).toEqual(['prop']);
  });

  it('search results still obey the filters', () => {
    const small = makeProcessedMarket({ id: 'small', volume: 164, eventTitle: 'Randy Brown vs. Jacobe Smith' });
    expect(run([small], { volumeRange: [15_000, VOLUME_FILTER_MAX] }, 'randy brown')).toEqual([]);
    expect(run([small], { volumeRange: [0, VOLUME_FILTER_MAX] }, 'randy brown')).toEqual(['small']);
  });
});

describe('useRemoteSearch', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  const rawMarket = {
    id: 'm1', question: 'Fight to Go the Distance?', outcomePrices: '["0.4","0.6"]', volume: '164',
    clobTokenIds: '["1","2"]', events: [{ title: 'Randy Brown vs. Jacobe Smith', tags: [{ slug: 'sports' }] }],
  };

  it('does not search links or short text', () => {
    renderHook(() => useRemoteSearch('ab', { current: null }));
    renderHook(() => useRemoteSearch('https://polymarket.com/sports/ufc/ufc-ran3-jac21-2026-10-31', { current: null }));
    expect(searchActiveMarkets).not.toHaveBeenCalled();
  });

  it('returns processed markets marked as search results', async () => {
    searchActiveMarkets.mockResolvedValue([rawMarket]);
    const { result } = renderHook(() => useRemoteSearch('randy brown', { current: null }));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.markets).toHaveLength(1);
    expect(result.current.markets[0]).toMatchObject({ id: 'm1', _fromSearch: true, eventTitle: 'Randy Brown vs. Jacobe Smith' });
  });

  it('reports a failed search', async () => {
    searchActiveMarkets.mockResolvedValue(null);
    const { result } = renderHook(() => useRemoteSearch('randy brown', { current: null }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/search failed/);
    expect(result.current.markets).toEqual([]);
  });
});
