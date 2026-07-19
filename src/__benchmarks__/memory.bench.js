/**
 * Benchmark 5: Memory Profile
 *
 * Heap snapshots under load — measures per-market memory cost for raw fixtures,
 * processing overhead, and Immer enrichment delta.
 *
 * Requires --expose-gc (handled by run.js). Must run in its own process.
 *
 * What breaks if it regresses: App memory footprint grows, long sessions OOM.
 * When to revisit: If market object shape changes or new engines add fields.
 *
 * Caveat: Node V8 heap differs from browser. Directionally correct, not identical.
 */
import { produce } from 'immer';
import { writeResults, resultsPath } from './helpers/harness.js';
import { generateMarkets, generateBaseRates } from './helpers/fixtures.js';

const { processMarket, enrichWithBaseRate } = await import('../processMarket.js');

function measureHeap(label) {
  global.gc();
  const usage = process.memoryUsage();
  console.log(`${label}: heapUsed=${(usage.heapUsed / 1024 / 1024).toFixed(1)}MB`);
  return usage.heapUsed;
}

const baseline = measureHeap('baseline');

// Raw fixture generation
let markets = generateMarkets(5_000);
const afterGen = measureHeap('after-generation');

// Processing
const processed = markets.map(m => processMarket(m));
const afterProc = measureHeap('after-processing');

// Release raw fixtures
markets = null;
global.gc();
const procOnly = measureHeap('processed-only');

console.log(`Per-market raw: ${((afterGen - baseline) / 5000).toFixed(0)} bytes`);
console.log(`Per-market processing overhead: ${((afterProc - afterGen) / 5000).toFixed(0)} bytes`);
console.log(`Per-market total: ${((afterProc - baseline) / 5000).toFixed(0)} bytes`);

// Immer enrichment delta
const rates = generateBaseRates(42);
const heapBeforeEnrich = measureHeap('before-enrichment');
// Retained in a variable so the heap measurement below sees the allocation
const _enriched = produce(processed, draft => {
  for (let i = 0; i < draft.length; i++) {
    const result = enrichWithBaseRate(draft[i], rates);
    if (result !== draft[i]) {
      draft[i] = result;
    }
  }
});
const heapAfterEnrich = measureHeap('after-enrichment');
console.log(`Enrichment delta: ${((heapAfterEnrich - heapBeforeEnrich) / 1024).toFixed(1)}KB`);
console.log(`Per-market enrichment: ${((heapAfterEnrich - heapBeforeEnrich) / 5000).toFixed(0)} bytes`);

// Cache at capacity
const { SPREAD_CACHE_CAP } = await import('../uiConfig.js');
const cacheMap = new Map();
for (let i = 0; i < SPREAD_CACHE_CAP; i++) {
  cacheMap.set(`market-${i}`, { bid: 0.45, ask: 0.55 });
}
const heapWithCache = measureHeap('with-spread-cache-at-cap');
console.log(`Spread cache at cap (${SPREAD_CACHE_CAP}): ${((heapWithCache - heapAfterEnrich) / 1024).toFixed(1)}KB`);

const resultData = [
  { name: 'memory-per-market-raw', median: (afterGen - baseline) / 5000, p95: 0, mean: 0, iterations: 1 },
  { name: 'memory-per-market-processing', median: (afterProc - afterGen) / 5000, p95: 0, mean: 0, iterations: 1 },
  { name: 'memory-per-market-total', median: (afterProc - baseline) / 5000, p95: 0, mean: 0, iterations: 1 },
  { name: 'memory-processed-only', median: procOnly - baseline, p95: 0, mean: 0, iterations: 1 },
  { name: 'memory-enrichment-delta', median: heapAfterEnrich - heapBeforeEnrich, p95: 0, mean: 0, iterations: 1 },
  { name: 'memory-spread-cache-at-cap', median: heapWithCache - heapAfterEnrich, p95: 0, mean: 0, iterations: 1 },
];
writeResults(resultData, resultsPath('memory.json'));
