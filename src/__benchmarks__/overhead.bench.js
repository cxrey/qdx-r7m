/**
 * Benchmark 4: Rate Limiter Overhead
 *
 * Measures isClobRateLimited() hot path (not tripped), 10k iterations.
 * Sub-microsecond measurement — isolated process, benchSync only.
 *
 * What breaks if it regresses: Every CLOB request checks this function.
 * Threshold: Under 0.01ms per call.
 * When to revisit: If rate limiter implementation changes.
 */
import { benchSync, writeResults, resultsPath } from './helpers/harness.js';

// FIX: isClobRateLimited is in clobRateLimit.js, not clobConcurrency.js
import { isClobRateLimited } from '../clobRateLimit.js';

const results = [];

results.push(benchSync('rate-limiter-check-hot', () => {
  isClobRateLimited();
}, { iterations: 10000, warmup: 1000 }));

writeResults(results, resultsPath('overhead.json'));
