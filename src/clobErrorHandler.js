import { triggerClobRateLimit } from './clobRateLimit';

/**
 * Check if an error is a CLOB rate limit (429/403).
 * If so, trigger the circuit breaker and return true.
 */
export function handleClobError(err) {
  if (err?.status === 429 || err?.status === 403) {
    triggerClobRateLimit(err.status);
    return true;  // was a rate limit error
  }
  return false;  // was not a rate limit error
}

/**
 * Create a rate-limit-aware error from a fetch Response.
 * Use in api.js fetch functions.
 */
export function throwIfRateLimited(res) {
  if (res.status === 429 || res.status === 403) {
    const err = new Error(res.status === 403 ? 'Forbidden' : 'Rate limited');
    err.status = res.status;
    throw err;
  }
}

/** Standard error message for rate limit state */
export function rateLimitMessage(statusCode) {
  return statusCode === 403
    ? 'CLOB API blocked — paused for 5 minutes'
    : 'CLOB API rate limited — paused for 60s';
}
