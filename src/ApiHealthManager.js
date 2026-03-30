/**
 * ApiHealthManager — unified rate-limit, concurrency, and backoff management.
 *
 * Consolidates three previously separate systems:
 *   1. Circuit breaker (formerly clobRateLimit.js) — pauses all CLOB fetches
 *      on 429 (60s) or 403 (5min)
 *   2. Adaptive concurrency (formerly clobConcurrency.js) — queue-based
 *      semaphore that self-tunes request parallelism
 *   3. Exponential backoff multiplier (formerly RefreshManager._rateLimitMultiplier)
 *      — slows refresh intervals on repeated rate limits
 *
 * Single entry point: handleRateLimit(statusCode) triggers all three.
 *
 * Backward-compatible: clobRateLimit.js and clobConcurrency.js re-export
 * from this module so existing imports continue to work.
 */

// ─── Constants ────────────────────────────────────────────────────

// Circuit breaker recovery times
const RECOVERY_429 = 60 * 1000;       // 60s for soft rate limit
const RECOVERY_403 = 5 * 60 * 1000;   // 5min for IP block

// Concurrency limits
const CONCURRENCY_DEFAULT = 5;
const CONCURRENCY_FLOOR = 2;
const CONCURRENCY_CEILING = 6;
const CONCURRENCY_RECOVERY_INTERVAL = 60_000; // +1 slot every 60s

// Backoff multiplier
const BACKOFF_MAX = 8;
const BACKOFF_RECOVERY_MS = 5 * 60 * 1000; // halves every 5min

// ═══════════════════════════════════════════════════════════════════
// 1. Circuit Breaker
// ═══════════════════════════════════════════════════════════════════

let rateLimited = false;
let rateLimitListeners = [];
let circuitRecoveryTimer = null;
let currentRecoverySeconds = 0;

export function isClobRateLimited() {
  return rateLimited;
}

export function getClobRecoverySeconds() {
  return currentRecoverySeconds;
}

/**
 * @returns {boolean} true if the breaker actually tripped (or upgraded),
 *   false if suppressed as a duplicate 429.
 */
function _tripCircuitBreaker(statusCode) {
  const recoveryTime = statusCode === 403 ? RECOVERY_403 : RECOVERY_429;
  currentRecoverySeconds = recoveryTime / 1000;

  // If already tripped by a 429, a 403 must upgrade the timer.
  // If already tripped by a 403, a duplicate 403 resets the timer and re-notifies.
  // If not tripped, always proceed. Only skip re-entry for duplicate 429s.
  if (rateLimited && statusCode !== 403) return false;

  rateLimited = true;

  console.warn(
    `[CLOB] ${statusCode === 403 ? 'Forbidden' : 'Rate limited'} — all CLOB fetches paused for ${recoveryTime / 1000}s`
  );

  // Notify UI listeners on fresh trip or 403 upgrade
  if (statusCode === 403 || !circuitRecoveryTimer) {
    rateLimitListeners.forEach(fn => fn(true));
  }

  // Clear existing timer and set new recovery window
  if (circuitRecoveryTimer) clearTimeout(circuitRecoveryTimer);
  circuitRecoveryTimer = setTimeout(() => {
    rateLimited = false;
    circuitRecoveryTimer = null;
    currentRecoverySeconds = 0;
    console.log('[CLOB] Rate limit recovery — resuming fetches');
    rateLimitListeners.forEach(fn => fn(false));
  }, recoveryTime);

  return true;
}

export function clearClobRateLimit() {
  rateLimited = false;
  currentRecoverySeconds = 0;
  if (circuitRecoveryTimer) {
    clearTimeout(circuitRecoveryTimer);
    circuitRecoveryTimer = null;
  }
  rateLimitListeners.forEach(fn => fn(false));
}

export function onClobRateLimitChange(fn) {
  rateLimitListeners.push(fn);
  return () => {
    rateLimitListeners = rateLimitListeners.filter(l => l !== fn);
  };
}

// Legacy alias — clobRateLimit.js re-exports this as triggerClobRateLimit
export function triggerClobRateLimit(statusCode = 429) {
  handleRateLimit(statusCode);
}

// ═══════════════════════════════════════════════════════════════════
// 2. Adaptive Concurrency Semaphore
// ═══════════════════════════════════════════════════════════════════

let maxConcurrent = CONCURRENCY_DEFAULT;
let inFlight = 0;
let waitQueue = [];              // array of { waiter, onAbort, signal }
let concurrencyRecoveryTimer = null;

/**
 * Called internally when a rate limit is detected.
 * Drops concurrency to FLOOR and starts recovery timer.
 */
export function onRateLimitHit() {
  const oldMax = maxConcurrent;
  maxConcurrent = CONCURRENCY_FLOOR;

  if (concurrencyRecoveryTimer) clearInterval(concurrencyRecoveryTimer);
  concurrencyRecoveryTimer = setInterval(() => {
    if (maxConcurrent < CONCURRENCY_CEILING) {
      maxConcurrent++;
      drainQueue();
    } else {
      clearInterval(concurrencyRecoveryTimer);
      concurrencyRecoveryTimer = null;
    }
  }, CONCURRENCY_RECOVERY_INTERVAL);

  if (oldMax !== CONCURRENCY_FLOOR) {
    console.log(
      `[ClobConcurrency] Rate limit hit — reduced from ${oldMax} to ${CONCURRENCY_FLOOR} concurrent. Recovery: +1 every ${CONCURRENCY_RECOVERY_INTERVAL / 1000}s up to ${CONCURRENCY_CEILING}`
    );
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
 */
export async function acquireClobSlot(signal) {
  if (inFlight < maxConcurrent) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    inFlight++;
    return createRelease();
  }

  // Check abort BEFORE entering the queue to eliminate the race window
  // between push and listener attachment.
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  return new Promise((resolve, reject) => {
    const entry = {
      waiter: () => {
        inFlight++;
        resolve(createRelease());
      },
      onAbort: null,
      signal: null,
    };

    if (signal) {
      const onAbort = () => {
        const idx = waitQueue.indexOf(entry);
        if (idx !== -1) waitQueue.splice(idx, 1);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      entry.onAbort = onAbort;
      entry.signal = signal;
      signal.addEventListener('abort', onAbort, { once: true });
    }

    // Push AFTER listener is attached — no race window
    waitQueue.push(entry);
  });
}

function createRelease() {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight = Math.max(0, inFlight - 1);
    drainQueue();
  };
}

/**
 * Check if a slot is available without blocking.
 */
export function hasClobSlotAvailable() {
  return inFlight < maxConcurrent;
}

/**
 * Get current utilization for logging/debugging.
 */
export function getClobConcurrencyStats() {
  return {
    inFlight,
    waiting: waitQueue.length,
    maxConcurrent,
    ceiling: CONCURRENCY_CEILING,
    floor: CONCURRENCY_FLOOR,
  };
}

/**
 * Reset concurrency state (for tests).
 */
export function resetClobConcurrency() {
  inFlight = 0;
  waitQueue = [];
  maxConcurrent = CONCURRENCY_DEFAULT;
  if (concurrencyRecoveryTimer) {
    clearInterval(concurrencyRecoveryTimer);
    concurrencyRecoveryTimer = null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// 3. Exponential Backoff Multiplier
// ═══════════════════════════════════════════════════════════════════

let backoffMultiplier = 1;
let backoffRecoveryTimer = null;
let backoffListeners = [];

/**
 * Current backoff multiplier (1 = normal, up to BACKOFF_MAX).
 * RefreshManager uses this to scale tier 2/3 intervals.
 */
export function getBackoffMultiplier() {
  return backoffMultiplier;
}

/**
 * Subscribe to backoff multiplier changes.
 * Callback receives the new multiplier value.
 * Returns an unsubscribe function.
 */
export function onBackoffChange(fn) {
  backoffListeners.push(fn);
  return () => {
    backoffListeners = backoffListeners.filter(l => l !== fn);
  };
}

function _escalateBackoff() {
  const oldMultiplier = backoffMultiplier;
  backoffMultiplier = Math.min(backoffMultiplier * 2, BACKOFF_MAX);

  console.warn(`[ApiHealthManager] Backoff multiplier now ${backoffMultiplier}x`);

  // Schedule recovery: halve after 5 minutes
  if (backoffRecoveryTimer) clearTimeout(backoffRecoveryTimer);
  backoffRecoveryTimer = setTimeout(() => {
    backoffMultiplier = Math.max(1, backoffMultiplier / 2);
    backoffRecoveryTimer = null;
    console.log(`[ApiHealthManager] Backoff recovery — multiplier now ${backoffMultiplier}x`);
    backoffListeners.forEach(fn => fn(backoffMultiplier));
  }, BACKOFF_RECOVERY_MS);

  // Always notify — even if already at max, the recovery timer was reset
  // and consumers need to know a rate limit event occurred.
  backoffListeners.forEach(fn => fn(backoffMultiplier));
}

/**
 * Reset backoff state (for tests).
 */
export function resetBackoff() {
  backoffMultiplier = 1;
  if (backoffRecoveryTimer) {
    clearTimeout(backoffRecoveryTimer);
    backoffRecoveryTimer = null;
  }
  // Notify listeners of reset rather than destroying them
  backoffListeners.forEach(fn => fn(1));
}

// ═══════════════════════════════════════════════════════════════════
// Unified Entry Point
// ═══════════════════════════════════════════════════════════════════

/**
 * Single entry point for rate limit events. Triggers all three systems:
 *   1. Circuit breaker — pauses all CLOB fetches
 *   2. Concurrency reduction — drops to floor
 *   3. Backoff escalation — doubles refresh interval multiplier
 *
 * @param {number} statusCode — HTTP status code (429 or 403)
 */
export function handleRateLimit(statusCode = 429) {
  const tripped = _tripCircuitBreaker(statusCode);
  if (!tripped) return; // duplicate 429 while already rate-limited — no-op
  onRateLimitHit();
  _escalateBackoff();
}
