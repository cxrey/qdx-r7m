/**
 * Benchmark 9b: Cache Eviction and Cap Performance
 *
 * Measures LRU Map per-insert time at capacity, lookup time at capacity,
 * and lookup time at low fill. Compares to detect degradation at capacity.
 *
 * What breaks if it regresses: Spread/flow cache updates slow down batch effects.
 * Threshold: Under 0.01ms per operation.
 * When to revisit: If cache implementation or cap changes.
 */
import { benchSync, writeResults, resultsPath } from './helpers/harness.js';
import { SPREAD_CACHE_CAP } from '../uiConfig.js';

const results = [];

// Simulate the updateSpreadCache LRU pattern
function updateCache(cache, key, value, cap) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > cap) {
    cache.delete(cache.keys().next().value);
  }
}

// Pre-fill cache to capacity
const cache = new Map();
for (let i = 0; i < SPREAD_CACHE_CAP; i++) {
  cache.set(`market-${i}`, { bid: 0.45, ask: 0.55 });
}

// Lookup at capacity
results.push(benchSync('cache-lookup-at-capacity', () => {
  cache.get(`market-${SPREAD_CACHE_CAP / 2 | 0}`);
}, { iterations: 10000, warmup: 1000 }));

// Insert at capacity (triggers eviction every time)
let insertIdx = SPREAD_CACHE_CAP;
results.push(benchSync('cache-insert-at-capacity', () => {
  updateCache(cache, `market-new-${insertIdx++}`, { bid: 0.45, ask: 0.55 }, SPREAD_CACHE_CAP);
}, { iterations: 10000, warmup: 100 }));

// Lookup at low fill for comparison
const smallCache = new Map();
for (let i = 0; i < 10; i++) {
  smallCache.set(`market-${i}`, { bid: 0.45, ask: 0.55 });
}

results.push(benchSync('cache-lookup-low-fill', () => {
  smallCache.get('market-5');
}, { iterations: 10000, warmup: 1000 }));

writeResults(results, resultsPath('cache.json'));
