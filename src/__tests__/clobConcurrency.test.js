import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  acquireClobSlot,
  hasClobSlotAvailable,
  onRateLimitHit,
  getClobConcurrencyStats,
  resetClobConcurrency,
} from '../clobConcurrency';

beforeEach(() => {
  vi.useFakeTimers();
  resetClobConcurrency();
});

afterEach(() => {
  vi.useRealTimers();
  resetClobConcurrency();
});

// ── Core semaphore ────────────────────────────────────────────────

describe('acquireClobSlot', () => {
  it('returns a release function when slots available', async () => {
    const release = await acquireClobSlot();
    expect(typeof release).toBe('function');
    expect(getClobConcurrencyStats().inFlight).toBe(1);
    release();
    expect(getClobConcurrencyStats().inFlight).toBe(0);
  });

  it('allows up to DEFAULT_MAX (5) concurrent slots', async () => {
    const releases = [];
    for (let i = 0; i < 5; i++) {
      releases.push(await acquireClobSlot());
    }
    expect(getClobConcurrencyStats().inFlight).toBe(5);
    expect(hasClobSlotAvailable()).toBe(false);
    releases.forEach(r => r());
  });

  it('blocks beyond maxConcurrent until a slot is released', async () => {
    const releases = [];
    for (let i = 0; i < 5; i++) {
      releases.push(await acquireClobSlot());
    }

    // 6th call should block
    let sixthResolved = false;
    const sixthPromise = acquireClobSlot().then(release => {
      sixthResolved = true;
      return release;
    });

    // Give microtasks a chance to run
    await vi.advanceTimersByTimeAsync(0);
    expect(sixthResolved).toBe(false);
    expect(getClobConcurrencyStats().waiting).toBe(1);

    // Release one slot — the 6th waiter should resolve
    releases[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(sixthResolved).toBe(true);

    const sixthRelease = await sixthPromise;
    sixthRelease();
    releases.slice(1).forEach(r => r());
  });

  it('release function is idempotent — double-release is a no-op', async () => {
    const release = await acquireClobSlot();
    expect(getClobConcurrencyStats().inFlight).toBe(1);
    release();
    release(); // double-release
    expect(getClobConcurrencyStats().inFlight).toBe(0); // not -1
  });

  it('waiters are served FIFO', async () => {
    const releases = [];
    for (let i = 0; i < 5; i++) {
      releases.push(await acquireClobSlot());
    }

    const order = [];
    acquireClobSlot().then(r => { order.push('A'); r(); });
    acquireClobSlot().then(r => { order.push('B'); r(); });
    acquireClobSlot().then(r => { order.push('C'); r(); });

    // Release 3 slots one at a time
    releases[0]();
    await vi.advanceTimersByTimeAsync(0);
    releases[1]();
    await vi.advanceTimersByTimeAsync(0);
    releases[2]();
    await vi.advanceTimersByTimeAsync(0);

    expect(order).toEqual(['A', 'B', 'C']);
    releases.slice(3).forEach(r => r());
  });

  it('release wakes exactly one waiter', async () => {
    const releases = [];
    for (let i = 0; i < 5; i++) {
      releases.push(await acquireClobSlot());
    }

    let aResolved = false;
    let bResolved = false;
    acquireClobSlot().then(r => { aResolved = true; return r; });
    acquireClobSlot().then(r => { bResolved = true; return r; });

    releases[0]();
    await vi.advanceTimersByTimeAsync(0);

    expect(aResolved).toBe(true);
    expect(bResolved).toBe(false);
    expect(getClobConcurrencyStats().waiting).toBe(1);

    releases.slice(1).forEach(r => r());
  });
});

// ── hasClobSlotAvailable ──────────────────────────────────────────

describe('hasClobSlotAvailable', () => {
  it('returns true when slots are free', () => {
    expect(hasClobSlotAvailable()).toBe(true);
  });

  it('returns false when all slots occupied', async () => {
    const releases = [];
    for (let i = 0; i < 5; i++) {
      releases.push(await acquireClobSlot());
    }
    expect(hasClobSlotAvailable()).toBe(false);
    releases[0]();
    expect(hasClobSlotAvailable()).toBe(true);
    releases.slice(1).forEach(r => r());
  });
});

// ── AbortSignal handling ──────────────────────────────────────────

describe('AbortSignal', () => {
  it('already-aborted signal throws AbortError immediately', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(acquireClobSlot(controller.signal)).rejects.toThrow('Aborted');
    expect(getClobConcurrencyStats().inFlight).toBe(0); // no slot acquired
  });

  it('signal abort while waiting rejects with AbortError', async () => {
    const releases = [];
    for (let i = 0; i < 5; i++) {
      releases.push(await acquireClobSlot());
    }

    const controller = new AbortController();
    const promise = acquireClobSlot(controller.signal);

    expect(getClobConcurrencyStats().waiting).toBe(1);
    controller.abort();

    await expect(promise).rejects.toThrow('Aborted');
    expect(getClobConcurrencyStats().waiting).toBe(0); // removed from queue
    expect(getClobConcurrencyStats().inFlight).toBe(5); // no slot was acquired

    releases.forEach(r => r());
  });

  it('signal abort does not affect other waiters', async () => {
    const releases = [];
    for (let i = 0; i < 5; i++) {
      releases.push(await acquireClobSlot());
    }

    const controller = new AbortController();
    const abortPromise = acquireClobSlot(controller.signal);
    let otherResolved = false;
    const otherPromise = acquireClobSlot().then(r => { otherResolved = true; return r; });

    // Abort the first waiter
    controller.abort();
    await expect(abortPromise).rejects.toThrow('Aborted');

    // Other waiter still in queue
    expect(getClobConcurrencyStats().waiting).toBe(1);

    // Release a slot — other waiter should get it
    releases[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(otherResolved).toBe(true);

    const otherRelease = await otherPromise;
    otherRelease();
    releases.slice(1).forEach(r => r());
  });
});

// ── resetClobConcurrency ──────────────────────────────────────────

describe('resetClobConcurrency', () => {
  it('clears in-flight count, wait queue, and resets maxConcurrent', async () => {
    const releases = [];
    for (let i = 0; i < 5; i++) {
      releases.push(await acquireClobSlot());
    }
    onRateLimitHit(); // drops to FLOOR=2

    resetClobConcurrency();

    const stats = getClobConcurrencyStats();
    expect(stats.inFlight).toBe(0);
    expect(stats.waiting).toBe(0);
    expect(stats.maxConcurrent).toBe(5); // back to DEFAULT_MAX
  });
});

// ── Adaptive concurrency ──────────────────────────────────────────

describe('onRateLimitHit', () => {
  it('drops maxConcurrent to FLOOR (2)', () => {
    expect(getClobConcurrencyStats().maxConcurrent).toBe(5);
    onRateLimitHit();
    expect(getClobConcurrencyStats().maxConcurrent).toBe(2);
  });

  it('hasClobSlotAvailable reflects new lower cap', async () => {
    const releases = [];
    releases.push(await acquireClobSlot());
    releases.push(await acquireClobSlot());

    // 2 in-flight, max=5 → still available
    expect(hasClobSlotAvailable()).toBe(true);

    onRateLimitHit(); // drops to 2
    // 2 in-flight, max=2 → no more available
    expect(hasClobSlotAvailable()).toBe(false);

    releases.forEach(r => r());
  });

  it('recovery timer increases maxConcurrent by 1 every 60s', () => {
    onRateLimitHit();
    expect(getClobConcurrencyStats().maxConcurrent).toBe(2);

    vi.advanceTimersByTime(60_000);
    expect(getClobConcurrencyStats().maxConcurrent).toBe(3);

    vi.advanceTimersByTime(60_000);
    expect(getClobConcurrencyStats().maxConcurrent).toBe(4);
  });

  it('recovery stops at CEILING (6)', () => {
    onRateLimitHit(); // 2
    // 4 recovery ticks to reach 6
    vi.advanceTimersByTime(60_000 * 4);
    expect(getClobConcurrencyStats().maxConcurrent).toBe(6);

    // One more tick should not go above ceiling
    vi.advanceTimersByTime(60_000);
    expect(getClobConcurrencyStats().maxConcurrent).toBe(6);
  });

  it('second onRateLimitHit during recovery resets to FLOOR', () => {
    onRateLimitHit(); // 2
    vi.advanceTimersByTime(60_000 * 2); // recovered to 4
    expect(getClobConcurrencyStats().maxConcurrent).toBe(4);

    onRateLimitHit(); // back to 2
    expect(getClobConcurrencyStats().maxConcurrent).toBe(2);

    // Recovery restarts from 2
    vi.advanceTimersByTime(60_000);
    expect(getClobConcurrencyStats().maxConcurrent).toBe(3);
  });

  it('recovery tick wakes a blocked waiter', async () => {
    onRateLimitHit(); // max=2
    const releases = [];
    releases.push(await acquireClobSlot());
    releases.push(await acquireClobSlot());

    // 3rd should block
    let thirdResolved = false;
    acquireClobSlot().then(r => { thirdResolved = true; return r; });
    await vi.advanceTimersByTimeAsync(0);
    expect(thirdResolved).toBe(false);

    // Recovery tick: max goes from 2→3
    await vi.advanceTimersByTimeAsync(60_000);
    expect(thirdResolved).toBe(true);

    releases.forEach(r => r());
  });
});
