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
    const { result } = renderHook(() => useFetchWithCache({ cacheKey: key(), fetcher, clobProtected: false }));
    await act(() => result.current.refetch());
    expect(fetcher).toHaveBeenCalled();
    expect(result.current.data).toEqual({ ok: 1 });
    isClobRateLimited.mockReturnValue(false);
  });
});
