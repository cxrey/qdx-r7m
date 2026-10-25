import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Fallback path processes on the main thread; keep it cheap and observable
vi.mock('../processMarket', () => ({
  processMarket: vi.fn((m) => ({ ...m, processedBy: 'main' })),
}));

import {
  processAllInWorker, terminateAnalysisWorker, splitIntoChunks, workerCountFor, POOL_SIZE,
} from '../workerManager';

/** Fake Worker: echoes each chunk back "processed", optionally failing. */
let created;
let behavior;
class FakeWorker {
  constructor() {
    this.listeners = { message: new Set(), error: new Set() };
    this.terminated = false;
    this.index = created.length;
    created.push(this);
  }
  addEventListener(type, fn) { this.listeners[type].add(fn); }
  removeEventListener(type, fn) { this.listeners[type].delete(fn); }
  terminate() { this.terminated = true; }
  postMessage(msg) {
    this.lastChunk = msg.markets;
    const mode = behavior(this.index, msg.markets);
    if (mode === 'hang') return;
    queueMicrotask(() => {
      if (mode === 'crash') {
        for (const fn of this.listeners.error) fn(new Error('worker crashed'));
        return;
      }
      const data = mode === 'error'
        ? { type: 'ERROR', message: 'boom', requestId: msg.requestId }
        : { type: 'COMPLETE', markets: msg.markets.map((m) => ({ ...m, processedBy: `w${this.index}` })), requestId: msg.requestId };
      for (const fn of this.listeners.message) fn({ data });
    });
  }
}

const markets = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}` }));

beforeEach(() => {
  created = [];
  behavior = () => 'ok';
  vi.stubGlobal('Worker', FakeWorker);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  terminateAnalysisWorker();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('chunking', () => {
  it('splits into contiguous near-equal chunks that cover every item once', () => {
    const items = markets(10);
    const chunks = splitIntoChunks(items, 3);
    expect(chunks.map((c) => c.length)).toEqual([4, 4, 2]);
    expect(chunks.flat()).toEqual(items);
  });

  it('uses one Worker for small batches and caps at the pool size', () => {
    expect(workerCountFor(1, 8)).toBe(1);
    expect(workerCountFor(1_999, 8)).toBe(1);
    expect(workerCountFor(4_001, 8)).toBe(3);
    expect(workerCountFor(500_000, 8)).toBe(8);
    expect(POOL_SIZE).toBeGreaterThanOrEqual(1);
    expect(POOL_SIZE).toBeLessThanOrEqual(8);
  });
});

describe('processAllInWorker', () => {
  it('returns [] for an empty batch without creating Workers', async () => {
    expect(await processAllInWorker([])).toEqual([]);
    expect(created).toHaveLength(0);
  });

  it('spreads a large batch across Workers and keeps the original order', async () => {
    const input = markets(10_000);
    const out = await processAllInWorker(input);
    expect(out.map((m) => m.id)).toEqual(input.map((m) => m.id));
    const expectedWorkers = workerCountFor(input.length);
    expect(created).toHaveLength(expectedWorkers);
    expect(new Set(out.map((m) => m.processedBy)).size).toBe(expectedWorkers);
  });

  it('reuses the pool across calls', async () => {
    await processAllInWorker(markets(10_000));
    const firstPool = created.length;
    await processAllInWorker(markets(10_000));
    expect(created).toHaveLength(firstPool);
  });

  it('falls back to the main thread for only the chunk whose Worker reports an error', async () => {
    // poolSize is injected so this runs the same on any machine (incl. 1-2 core CI)
    behavior = (index) => (index === 1 ? 'error' : 'ok');
    const out = await processAllInWorker(markets(10_000), { poolSize: 4 });
    expect(created).toHaveLength(4);
    expect(out).toHaveLength(10_000);
    const chunk1 = splitIntoChunks(markets(10_000), 4)[1];
    const fromMain = out.filter((m) => m.processedBy === 'main');
    expect(fromMain.map((m) => m.id)).toEqual(chunk1.map((m) => m.id));
  });

  it('replaces a crashed Worker and falls back for its chunk', async () => {
    behavior = (index) => (index === 0 ? 'crash' : 'ok');
    const out = await processAllInWorker(markets(3_000));
    expect(out).toHaveLength(3_000);
    expect(created[0].terminated).toBe(true);
    expect(out.some((m) => m.processedBy === 'main')).toBe(true);
  });

  it('times out a hung Worker after 30s, terminates it, and falls back', async () => {
    vi.useFakeTimers();
    behavior = () => 'hang';
    const done = processAllInWorker(markets(10));
    await vi.advanceTimersByTimeAsync(30_000);
    const out = await done;
    expect(out.every((m) => m.processedBy === 'main')).toBe(true);
    expect(created[0].terminated).toBe(true);
  });

  it('a sibling request on a killed slot falls back immediately, not after its own 30s', async () => {
    vi.useFakeTimers();
    // Batch A hangs; batch B is posted 10s later to the same slot. When A's
    // timeout kills the slot's Worker at 30s, B must fall back right then.
    behavior = () => 'hang';
    const a = processAllInWorker(markets(10), { poolSize: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    const b = processAllInWorker([{ id: 'b0' }], { poolSize: 1 });
    await vi.advanceTimersByTimeAsync(20_001); // A times out at t=30s; B's own timer (t=40s) has not fired
    // Freeze fake time: B's own timeout can now never fire, so if B resolves
    // it was the slot kill that released it.
    vi.useRealTimers();
    const outcome = await Promise.race([b, new Promise((r) => setTimeout(() => r('still waiting'), 1_000))]);
    expect(outcome).not.toBe('still waiting');
    // The fake Worker never replies here, so any result came from the
    // main-thread fallback
    expect(outcome.map((m) => m.id)).toEqual(['b0']);
    expect(outcome[0].processedBy).not.toBe('w0');
    expect((await a).map((m) => m.id)).toEqual(markets(10).map((m) => m.id));
  });

  it('resolves in-flight requests empty on shutdown instead of processing them', async () => {
    behavior = () => 'hang';
    const pendingBatch = processAllInWorker(markets(10), { poolSize: 1 });
    await Promise.resolve();
    terminateAnalysisWorker();
    expect(await pendingBatch).toEqual([]);
  });

  it('keeps concurrent calls separate (requestId routing)', async () => {
    const [a, b] = await Promise.all([processAllInWorker(markets(5)), processAllInWorker([{ id: 'x' }])]);
    expect(a.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(b.map((m) => m.id)).toEqual(['x']);
  });
});
