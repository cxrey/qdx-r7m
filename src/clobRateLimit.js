/**
 * Shared CLOB API rate limit circuit breaker.
 * Imported by ResultsTable (background fetches), MarketDetailPanel (expanded panel),
 * TradeFlowPanel (trade flow), and hover prefetch.
 *
 * When any CLOB request gets a 429 or 403, all CLOB fetching pauses.
 * 429 (soft rate limit): 60s recovery. 403 (IP block): 5min recovery.
 */

import { onRateLimitHit } from './clobConcurrency';

let rateLimited = false;
let listeners = [];
let recoveryTimer = null;
let currentRecoverySeconds = 0;

export function getClobRecoverySeconds() {
  return currentRecoverySeconds;
}

const RECOVERY_429 = 60 * 1000;      // 60s for soft rate limit
const RECOVERY_403 = 5 * 60 * 1000;  // 5min for IP block

export function isClobRateLimited() {
  return rateLimited;
}

export function triggerClobRateLimit(statusCode = 429) {
  const recoveryTime = statusCode === 403 ? RECOVERY_403 : RECOVERY_429;
  currentRecoverySeconds = recoveryTime / 1000;

  // If already tripped by a 429, a 403 must upgrade the timer.
  // If already tripped by a 403, a duplicate 403 resets the timer and re-notifies.
  // If not tripped, always proceed. Only skip re-entry for duplicate 429s.
  if (rateLimited && statusCode !== 403) return;

  rateLimited = true;

  // Notify concurrency limiter to reduce capacity
  onRateLimitHit();

  console.warn(`[CLOB] ${statusCode === 403 ? 'Forbidden' : 'Rate limited'} — all CLOB fetches paused for ${recoveryTime / 1000}s`);

  // Notify UI listeners on fresh trip or 403 upgrade
  if (statusCode === 403 || !recoveryTimer) {
    listeners.forEach(fn => fn(true));
  }

  // Clear existing timer and set new recovery window
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = setTimeout(() => {
    rateLimited = false;
    recoveryTimer = null;
    currentRecoverySeconds = 0;
    console.log('[CLOB] Rate limit recovery — resuming fetches');
    listeners.forEach(fn => fn(false));
  }, recoveryTime);
}

export function clearClobRateLimit() {
  rateLimited = false;
  currentRecoverySeconds = 0;
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
  listeners.forEach(fn => fn(false));
}

export function onClobRateLimitChange(fn) {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter(l => l !== fn);
  };
}
