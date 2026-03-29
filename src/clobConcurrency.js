/**
 * Global CLOB API concurrency limiter with adaptive capacity.
 *
 * All background fetch systems (spread, flow, gap filler, hover prefetch)
 * must acquire a slot before making a CLOB request and release it when done.
 *
 * Uses a queue-based semaphore — waiters are notified directly when a slot
 * opens, no polling required.
 *
 * Adaptive behavior:
 *   - Starts at DEFAULT_MAX (5 concurrent)
 *   - On 429/403: drops to FLOOR (2) immediately
 *   - Every RECOVERY_INTERVAL (60s) without errors: increases by 1, up to CEILING (6)
 *   - On another 429/403: drops back to FLOOR
 *
 * This self-tunes to the fastest throughput that doesn't trigger rate limits.
 *
 * Note on dual recovery timers:
 *   clobRateLimit.js manages a separate recovery timer (60s for 429, 5min for
 *   403) that controls isClobRateLimited() — a global "stop all requests" flag.
 *   THIS module's recovery timer controls concurrency capacity (how many
 *   requests can fly at once). Both are triggered by the same 429/403 event
 *   (clobRateLimit calls onRateLimitHit()), but they recover independently:
 *   clobRateLimit recovers to "allow requests" first, then clobConcurrency
 *   gradually ramps capacity back up. This is intentional — the rate-limit
 *   flag is the circuit breaker; concurrency is the throttle.
 */

const DEFAULT_MAX = 5;
const FLOOR = 2;
const CEILING = 6;
const RECOVERY_INTERVAL = 60_000;

let maxConcurrent = DEFAULT_MAX;
let inFlight = 0;
let waitQueue = [];          // array of { waiter, onAbort, signal } objects
let recoveryTimer = null;

/**
 * Called when a 429/403 is detected anywhere in the app.
 * Drops concurrency to FLOOR and starts recovery timer.
 */
export function onRateLimitHit() {
  const oldMax = maxConcurrent;
  maxConcurrent = FLOOR;

  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = setInterval(() => {
    if (maxConcurrent < CEILING) {
      maxConcurrent++;
      // Wake any waiters that can now proceed under the new cap
      drainQueue();
    } else {
      // At ceiling — stop recovering
      clearInterval(recoveryTimer);
      recoveryTimer = null;
    }
  }, RECOVERY_INTERVAL);

  if (oldMax !== FLOOR) {
    console.log(`[ClobConcurrency] Rate limit hit — reduced from ${oldMax} to ${FLOOR} concurrent. Recovery: +1 every ${RECOVERY_INTERVAL / 1000}s up to ${CEILING}`);
  } else {
    console.debug('[ClobConcurrency] Rate limit hit while already at floor — recovery timer restarted');
  }
}

function drainQueue() {
  while (waitQueue.length > 0 && inFlight < maxConcurrent) {
    const next = waitQueue.shift();
    if (next.signal && next.onAbort) {
      next.signal.removeEventListener('abort', next.onAbort);
    }
    next.waiter();
  }
}

/**
 * Wait until a slot is available, then reserve it.
 * Returns a release function that MUST be called when the request completes.
 *
 * @param {AbortSignal} [signal] — optional; if provided, rejects with
 *   AbortError when the signal fires while waiting in the queue.
 *
 * Usage:
 *   let release;
 *   try {
 *     release = await acquireClobSlot(controller.signal);
 *     const data = await fetchOrderBook(tokenId);
 *   } catch (err) {
 *     if (err.name === 'AbortError') break;  // effect cleaned up
 *   } finally {
 *     if (release) release();
 *   }
 */
export async function acquireClobSlot(signal) {
  // Fast path: slot available, no waiting
  if (inFlight < maxConcurrent) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    inFlight++;
    return createRelease();
  }

  // Slow path: wait in queue until a slot opens or signal aborts
  return new Promise((resolve, reject) => {
    const entry = {
      waiter: () => {
        inFlight++;
        resolve(createRelease());
      },
      onAbort: null,
      signal: null,
    };

    waitQueue.push(entry);

    if (signal) {
      const onAbort = () => {
        const idx = waitQueue.indexOf(entry);
        if (idx !== -1) waitQueue.splice(idx, 1);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      entry.onAbort = onAbort;
      entry.signal = signal;

      if (signal.aborted) {
        const idx = waitQueue.indexOf(entry);
        if (idx !== -1) waitQueue.splice(idx, 1);
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function createRelease() {
  let released = false;
  return () => {
    if (released) return;  // idempotent — double-release is a no-op
    released = true;
    inFlight = Math.max(0, inFlight - 1);
    drainQueue();
  };
}

/**
 * Check if a slot is available without blocking.
 * Use for early bailout in gap filler and hover prefetch (which shouldn't wait).
 */
export function hasClobSlotAvailable() {
  return inFlight < maxConcurrent;
}

/**
 * Get current utilization for logging/debugging.
 */
export function getClobConcurrencyStats() {
  return { inFlight, waiting: waitQueue.length, maxConcurrent, ceiling: CEILING, floor: FLOOR };
}

/**
 * Reset state (for tests).
 */
export function resetClobConcurrency() {
  inFlight = 0;
  waitQueue = [];
  maxConcurrent = DEFAULT_MAX;
  if (recoveryTimer) { clearInterval(recoveryTimer); recoveryTimer = null; }
}
