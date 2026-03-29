/**
 * Benchmarks 10, 13, 14, 16: Pipeline, JSON.parse, localStorage, Worker Serialization
 *
 * B10: End-to-end pipeline from raw markets to render-ready data.
 * B13: JSON.parse cost on API response payloads.
 * B14: localStorage serialization cost (JSON.stringify/JSON.parse).
 * B16: structuredClone cost — measures the CURRENT Worker architecture's transfer tax
 *      (the Worker is already in production via workerManager.js, not hypothetical).
 *
 * What breaks if B10 regresses: User waits longer on initial load.
 * What breaks if B13 regresses: Parse cost silently doubles if market objects grow.
 * What breaks if B14 regresses: localStorage cache writes block main thread.
 * What breaks if B16 regresses: Worker round-trip serialization exceeds main-thread savings.
 *
 * Threshold B10: Sum of individual stages + 20% overhead margin.
 * Threshold B13: No fixed threshold — measurement benchmark.
 * Threshold B14: Under 10ms for large write (stringify ~5MB).
 * Threshold B16: Outbound clone under 50ms.
 */
import { produce } from 'immer';
import { benchSync, writeResults, resultsPath } from './helpers/harness.js';
import { generateMarkets, generateBaseRates, defaultFilterConfig, defaultLookupState, defaultPortfolio } from './helpers/fixtures.js';

const results = [];

const { processMarket, enrichWithBaseRate } = await import('../processMarket.js');
const { filterAndSort } = await import('../utils/filterAndSort.js');

// ── B10: Initial load pipeline ──────────────────────────────────
const rawMarkets = generateMarkets(2_000);
const rates = generateBaseRates(42);
const defaultFilters = defaultFilterConfig('volume');

// Full pipeline: process → enrich → filter/sort
// FIX: Use correct enrichment pattern (enrichMarketsUpdater style, not broken draft mutation)
results.push(benchSync('pipeline-full-2k', () => {
  const processed = rawMarkets.map(m => processMarket(m));
  const enriched = produce(processed, draft => {
    for (let i = 0; i < draft.length; i++) {
      const result = enrichWithBaseRate(draft[i], rates);
      if (result !== draft[i]) {
        draft[i] = result;
      }
    }
  });
  filterAndSort({ markets: enriched, filters: defaultFilters, searchLower: '', lookupState: defaultLookupState, portfolio: defaultPortfolio });
}, { iterations: 10, warmup: 2 }));

// Pipeline without enrichment to isolate its contribution
results.push(benchSync('pipeline-no-enrich-2k', () => {
  const processed = rawMarkets.map(m => processMarket(m));
  filterAndSort({ markets: processed, filters: defaultFilters, searchLower: '', lookupState: defaultLookupState, portfolio: defaultPortfolio });
}, { iterations: 10, warmup: 2 }));

// ── B13: JSON.parse cost ────────────────────────────────────────
const onePage = generateMarkets(100);
const onePageJSON = JSON.stringify(onePage);

results.push(benchSync('json-parse-1-page', () => {
  JSON.parse(onePageJSON);
}));

const pages = Array.from({ length: 50 }, () => onePageJSON);
results.push(benchSync('json-parse-50-pages-sequential', () => {
  for (const page of pages) JSON.parse(page);
}, { iterations: 20, warmup: 3 }));

console.log(`B13: 1-page payload: ${(onePageJSON.length / 1024).toFixed(1)}KB`);
console.log(`B13: 50-page total: ${(onePageJSON.length * 50 / 1024).toFixed(1)}KB`);

// ── B14: localStorage serialization cost ────────────────────────
// Node doesn't have localStorage — Map simulates string storage.
// Measures JSON.stringify + Map.set (CPU-bound serialization cost only).
const smallData = { timestamp: Date.now(), data: generateMarkets(100) };
const largeData = { timestamp: Date.now(), data: generateMarkets(5_000) };
const store = new Map();

console.log(`B14: Small data: ~${(JSON.stringify(smallData).length / 1024).toFixed(1)}KB`);
console.log(`B14: Large data: ~${(JSON.stringify(largeData).length / 1024 / 1024).toFixed(2)}MB`);

results.push(benchSync('localStorage-write-small', () => {
  store.set('baseRateCache', JSON.stringify(smallData));
}, { iterations: 1000 }));

results.push(benchSync('localStorage-read-small', () => {
  const raw = store.get('baseRateCache');
  if (raw) JSON.parse(raw);
}, { iterations: 1000 }));

results.push(benchSync('localStorage-write-large', () => {
  store.set('baseRateCache', JSON.stringify(largeData));
}, { iterations: 100 }));

results.push(benchSync('localStorage-read-large', () => {
  const raw = store.get('baseRateCache');
  if (raw) JSON.parse(raw);
}, { iterations: 100 }));

// ── B16: Worker postMessage serialization cost ──────────────────
// FIX: The Worker architecture is CURRENT (workerManager.js → analysisWorker.js),
// not hypothetical. This measures the real transfer tax.
const markets12k = generateMarkets(12_000);
const processed12k = markets12k.map(m => processMarket(m));

// Outbound: main → Worker (raw markets)
results.push(benchSync('structuredClone-raw-12k', () => {
  structuredClone(markets12k);
}, { iterations: 10, warmup: 2 }));

// Return: Worker → main (processed markets)
results.push(benchSync('structuredClone-processed-12k', () => {
  structuredClone(processed12k);
}, { iterations: 10, warmup: 2 }));

// Round-trip
results.push(benchSync('structuredClone-roundtrip-12k', () => {
  structuredClone(markets12k);
  structuredClone(processed12k);
}, { iterations: 10, warmup: 2 }));

// Smaller tier for scaling analysis
const markets2k = generateMarkets(2_000);
results.push(benchSync('structuredClone-raw-2k', () => {
  structuredClone(markets2k);
}, { iterations: 50, warmup: 5 }));

// Log scaling
const clone2k = results.find(r => r.name === 'structuredClone-raw-2k');
const clone12k = results.find(r => r.name === 'structuredClone-raw-12k');
if (clone2k && clone12k && clone2k.median > 0) {
  const ratio = clone12k.median / clone2k.median;
  console.log(`B16: structuredClone scaling 2k→12k: ${ratio.toFixed(1)}x (linear expected: 6x)`);
}

writeResults(results, resultsPath('pipeline.json'));
