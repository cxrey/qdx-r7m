// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../api', () => ({
  fetchMarketById: vi.fn(),
  fetchMarketBySlug: vi.fn(),
  fetchMarketByConditionId: vi.fn(),
  fetchMarketByTokenId: vi.fn(),
}));

import { fetchMarketBySlug } from '../api';
import { useDirectLookup } from '../hooks/useDirectLookup';

const SLUG = 'will-something-happen-before-2027';
const URL = `https://polymarket.com/event/${SLUG}`;
const loaded = (extra = {}) => [{ id: 'm1', slug: SLUG, question: 'Will something happen before 2027?', ...extra }];

// Stable across renders, like App's baseRatesRef (a useRef)
const baseRatesRef = { current: null };

function render(markets = []) {
  return renderHook(({ markets: m }) => useDirectLookup(m, baseRatesRef), { initialProps: { markets } });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMarketBySlug.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('useDirectLookup — stable identity', () => {
  it('keeps runLookup identity across market array changes (price ticks)', () => {
    const { result, rerender } = render(loaded());
    const first = result.current.runLookup;
    rerender({ markets: loaded({ yesPrice: 0.51 }) }); // new array, same markets
    rerender({ markets: loaded({ yesPrice: 0.52 }) });
    expect(result.current.runLookup).toBe(first);
  });

  it('still matches against the latest markets', () => {
    const { result, rerender } = render([]);
    rerender({ markets: loaded() });
    act(() => result.current.runLookup(URL, false));
    expect(result.current.foundInLoadedId).toBe('m1');
    expect(fetchMarketBySlug).not.toHaveBeenCalled();
  });

  it('keeps fetchedMarkets identity when a text search clears lookup state', () => {
    const { result } = render(loaded());
    const before = result.current.fetchedMarkets;
    act(() => result.current.runLookup('bitcoin', false));
    act(() => result.current.runLookup('bitcoin price', false));
    expect(result.current.fetchedMarkets).toBe(before);
  });
});

describe('useDirectLookup — paste followed by the debounce echo', () => {
  it('does not abort or restart the paste lookup when the debounced value catches up', async () => {
    let signal;
    fetchMarketBySlug.mockImplementation((_slug, s) => { signal = s; return new Promise(() => {}); });
    // A loaded market that does NOT match the link (slug or title)
    const { result } = render(loaded({ slug: 'some-other-market', question: 'Unrelated market?' }));

    act(() => result.current.runLookup(URL, true));   // paste: immediate fetch
    expect(fetchMarketBySlug).toHaveBeenCalledTimes(1);

    act(() => result.current.runLookup(URL, false));  // debounce echo, same text
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(signal.aborted).toBe(false);
    expect(fetchMarketBySlug).toHaveBeenCalledTimes(1);
  });

  it('re-checks a link pasted during the initial load once markets arrive', () => {
    fetchMarketBySlug.mockImplementation(() => new Promise(() => {}));
    const { result, rerender } = render([]);

    act(() => result.current.runLookup(URL, true));   // pasted before load
    rerender({ markets: loaded() });                   // markets finish loading
    act(() => result.current.runLookup(URL, false));  // App's on-load re-run
    expect(result.current.foundInLoadedId).toBe('m1');
  });

  it('runs normally when the text changes after a paste', async () => {
    fetchMarketBySlug.mockImplementation(() => new Promise(() => {}));
    const { result } = render([]);
    act(() => result.current.runLookup(URL, true));
    act(() => result.current.runLookup(`${URL}-edited`, false));
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(fetchMarketBySlug).toHaveBeenCalledTimes(2);
  });

  it('forgets the paste after the search is cleared', async () => {
    fetchMarketBySlug.mockImplementation(() => new Promise(() => {}));
    const { result } = render([]);
    act(() => result.current.runLookup(URL, true));
    act(() => result.current.clearLookup());
    act(() => result.current.runLookup(URL, false)); // typed again later
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(fetchMarketBySlug).toHaveBeenCalledTimes(2);
  });
});
