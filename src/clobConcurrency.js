/**
 * Backward-compatible re-exports from ApiHealthManager.
 * All concurrency limiter logic now lives in ApiHealthManager.js.
 */
export {
  onRateLimitHit,
  acquireClobSlot,
  hasClobSlotAvailable,
  getClobConcurrencyStats,
  resetClobConcurrency,
} from './ApiHealthManager';
