// @vitest-environment jsdom
/**
 * Tier 3 (full catalog refresh) concurrency: a manual Refresh aborts the
 * running crawl (resetTier3Timer) and a new run can start before the old
 * one has unwound. fetchCatalog resolves with partial results on abort
 * rather than throwing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const catalogCalls = [];
vi.mock('../api', () => ({
  fetchCatalog: vi.fn((_progress, signal) => new Promise((resolve) => catalogCalls.push({ resolve, signal }))),
  flattenEventsToMarkets: vi.fn(() => []),
}));
vi.mock('../workerManager', () => ({
  processAllInWorker: vi.fn(async (raw) => raw.map((m) => ({ ...m, question: m.question || 'Q?' }))),
}));
vi.mock('../WebSocketPriceStream', () => ({
  WebSocketPriceStream: class { connect() {} subscribe() {} unsubscribe() {} get subscribedAssets() { return new Set(); } },
}));

const { RefreshManager } = await import('../RefreshManager');

beforeEach(() => { catalogCalls.length = 0; });

describe('RefreshManager Tier 3 — abort and restart', () => {
  it('an aborted run unwinds quietly and does not clobber the run that replaced it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onFullRefresh = vi.fn();
    const mgr = new RefreshManager({ onFullRefresh, getCurrentMarkets: () => [], onStatusChange: vi.fn() });
    mgr._enabled = true;

    const runA = mgr._runTier3();
    await Promise.resolve();
    mgr.resetTier3Timer(); // manual Refresh: aborts A, nulls the controller
    expect(catalogCalls[0].signal.aborted).toBe(true);

    const runB = mgr._runTier3(); // a new crawl starts before A has unwound
    await Promise.resolve();
    expect(catalogCalls).toHaveLength(2);

    // A's crawl resolves with partial results (abort doesn't throw)
    catalogCalls[0].resolve({ markets: [{ id: 'partial' }], complete: false });
    await runA;
    expect(warn).not.toHaveBeenCalledWith('[RefreshManager] Tier 3 error:', expect.anything());
    expect(onFullRefresh).not.toHaveBeenCalled();
    // B is still the running crawl
    expect(mgr._tier3Running).toBe(true);
    expect(mgr._tier3Controller).not.toBeNull();
    expect(mgr._tier3Controller.signal).toBe(catalogCalls[1].signal);

    catalogCalls[1].resolve({ markets: [{ id: 'm1', question: 'Q?' }], complete: true });
    await runB;
    expect(onFullRefresh).toHaveBeenCalledTimes(1);
    expect(mgr._tier3Running).toBe(false);
    expect(mgr._tier3Controller).toBeNull();
    warn.mockRestore();
  });

  it('stopping auto-refresh mid-crawl does not block Tier 3 after it is turned back on', async () => {
    const mgr = new RefreshManager({ onFullRefresh: vi.fn(), getCurrentMarkets: () => [], onStatusChange: vi.fn() });
    mgr._enabled = true;

    const runA = mgr._runTier3();
    await Promise.resolve();
    mgr.stop(); // auto-refresh switched off: aborts A, nulls the controller
    expect(catalogCalls[0].signal.aborted).toBe(true);
    catalogCalls[0].resolve({ markets: [], complete: false });
    await runA;

    mgr._enabled = true; // switched back on
    mgr._runTier3();
    await Promise.resolve();
    expect(catalogCalls).toHaveLength(2);
  });
});
