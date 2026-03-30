/**
 * Backward-compatible re-exports from ApiHealthManager.
 * All rate-limit circuit breaker logic now lives in ApiHealthManager.js.
 */
export {
  isClobRateLimited,
  triggerClobRateLimit,
  clearClobRateLimit,
  onClobRateLimitChange,
  getClobRecoverySeconds,
} from './ApiHealthManager';
