// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../clobRateLimit', () => ({ isClobRateLimited: vi.fn(() => false) }));
vi.mock('../clobErrorHandler', () => ({
  handleClobError: vi.fn((err) => err?.status === 429 || err?.status === 403),
  rateLimitMessage: vi.fn(() => 'CLOB API rate limited — paused for 60s'),
}));

import { isClobRateLimited } from '../clobRateLimit';
import { handleClobError } from '../clobErrorHandler';
import { useFetchWithCache } from '../hooks/useFetchWithCache';

const rateLimited = () => Object.assign(new Error('Rate limited'), { status: 429 });
let n = 0;
const key = () => `k-${++n}`; // the cache is module-level

beforeEach(() => vi.clearAllMocks());

describe('useFetchWithCache refetch', () => {
  it('serves a fresh cache entry by default, and fetches anew with { force: true } (a Refresh button)', async () => {
    const k = key();
    let call = 0;
    const fetcher = vi.fn(async () => ({ version: ++call }));
    const { result } = renderHook(() => useFetchWithCache({ cacheKey: k, fetcher }));
    await act(() => result.current.refetch());
    await act(() => result.current.refetch());
    expect(fetcher).toHaveBeenCalledTimes(1); // second load came from the cache
    expect(result.current.data).toEqual({ version: 1 });

    await act(() => result.current.refetch({ force: true }));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.data).toEqual({ version: 2 });
  });

  it('an event object passed by an onClick handler is not mistaken for force', async () => {
    const k = key();
    const fetcher = vi.fn(async () => ({ ok: 1 }));
    const { result } = renderHook(() => useFetchWithCache({ cacheKey: k, fetcher }));
    await act(() => result.current.refetch());
    await act(() => result.current.refetch({ type: 'click', target: {} }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('useFetchWithCache — key changes and late responses', () => {
  it("never returns the previous key's data under a new key (e.g. YES data after switching to No)", async () => {
    const yesKey = key();
    const noKey = key();
    let resolveNo;
    const fetcher = vi.fn((k) => (k === yesKey ? Promise.resolve({ side: 'yes' }) : new Promise((r) => { resolveNo = r; })));
    const { result, rerender } = renderHook(({ k }) => useFetchWithCache({ cacheKey: k, fetcher: () => fetcher(k), clobProtected: false }), { initialProps: { k: yesKey } });
    await act(() => result.current.refetch());
    expect(result.current.data).toEqual({ side: 'yes' });

    rerender({ k: noKey });
    expect(result.current.data).toBeNull(); // not { side: 'yes' }
    const pending = act(() => result.current.refetch());
    resolveNo({ side: 'no' });
    await pending;
    expect(result.current.data).toEqual({ side: 'no' });

    rerender({ k: yesKey }); // back: the cached YES data shows at once
    expect(result.current.data).toEqual({ side: 'yes' });
  });

  it('a slow response for an earlier key does not overwrite the current one', async () => {
    const slowKey = key(); // e.g. the 1Y history
    const fastKey = key(); // e.g. 7D
    let resolveSlow;
    const { result, rerender } = renderHook(({ k }) => useFetchWithCache({
      cacheKey: k, clobProtected: false,
      fetcher: () => (k === slowKey ? new Promise((r) => { resolveSlow = r; }) : Promise.resolve({ view: '7D' })),
    }), { initialProps: { k: slowKey } });

    let slowRequest;
    act(() => { slowRequest = result.current.refetch(); });
    rerender({ k: fastKey });
    await act(() => result.current.refetch());
    expect(result.current.data).toEqual({ view: '7D' });

    await act(async () => { resolveSlow({ view: '1Y' }); await slowRequest; });
    expect(result.current.data).toEqual({ view: '7D' }); // not overwritten
    expect(result.current.loading).toBe(false);
    rerender({ k: slowKey }); // …but the 1Y result was cached for its own key
    expect(result.current.data).toEqual({ view: '1Y' });
  });
});

describe('useFetchWithCache rate-limit handling', () => {
  it('CLOB requests (default): a 429 opens the CLOB breaker', async () => {
    const { result } = renderHook(() => useFetchWithCache({ cacheKey: key(), fetcher: async () => { throw rateLimited(); } }));
    await act(() => result.current.refetch());
    expect(handleClobError).toHaveBeenCalled();
    expect(result.current.error).toBe('CLOB API rate limited — paused for 60s');
  });

  it('other APIs (clobProtected: false): a 429 does not touch the CLOB breaker', async () => {
    const { result } = renderHook(() => useFetchWithCache({ cacheKey: key(), fetcher: async () => { throw rateLimited(); }, clobProtected: false }));
    await act(() => result.current.refetch());
    expect(handleClobError).not.toHaveBeenCalled();
    expect(result.current.error).toBe('Rate limited — try again shortly');
  });

  it('other APIs still fetch while the CLOB breaker is open', async () => {
    isClobRateLimited.mockReturnValue(true);
    const fetcher = vi.fn(async () => ({ ok: 1 }));
    const k = key(); // stable across renders
    const { result } = renderHook(() => useFetchWithCache({ cacheKey: k, fetcher, clobProtected: false }));
    await act(() => result.current.refetch());
    expect(fetcher).toHaveBeenCalled();
    expect(result.current.data).toEqual({ ok: 1 });
    isClobRateLimited.mockReturnValue(false);
  });
});
