/**
 * Benchmarks 2, 8, 15: Market Processing, Immer Enrichment, Batched Price Updates
 *
 * B2: processMarket throughput on 10k markets.
 * B8: Immer produce() enrichment cost — three variants compared.
 * B15: Batched price update throughput (1Hz throttle interval, not WebSocket).
 *
 * What breaks if B2 regresses: Initial load time increases.
 * What breaks if B8 regresses: Base rate enrichment blocks main thread.
 * What breaks if B15 regresses: Price updates consume frame budget at 1Hz throttle.
 *
 * Threshold B2: Under 100ms for 10k. Within 2x of baseline.
 * Threshold B8: Document relative costs of the three approaches.
 * Threshold B15: Under 8ms per update at 12k markets (half of 16ms frame budget).
 */
import assert from 'node:assert';
import { produce } from 'immer';
import { benchSync, writeResults, resultsPath } from './helpers/harness.js';
import { generateMarkets, generateBaseRates } from './helpers/fixtures.js';

const results = [];

// ── Dynamic imports (avoid top-level side effects) ──────────────
const { processMarket, enrichWithBaseRate } = await import('../processMarket.js');

// ── B2: processMarket throughput ────────────────────────────────
const raw10k = generateMarkets(10_000);

results.push(benchSync('processMarket-10k', () => {
  for (const m of raw10k) processMarket(m);
}, { iterations: 10, warmup: 2 }));

// ── B8: Immer enrichment cost — three variants ─────────────────
// Use 2k processed markets for enrichment benchmarks
const raw2k = generateMarkets(2_000);
const markets2k = raw2k.map(m => processMarket(m));
const rates = generateBaseRates(42);

// Sentinel integrity check — detect source mutation
const sentinelIndices = [0, 500, 1999];
const sentinels = sentinelIndices.map(i => JSON.stringify(markets2k[i]));
function checkIntegrity(label) {
  for (let j = 0; j < sentinelIndices.length; j++) {
    const i = sentinelIndices[j];
    assert(JSON.stringify(markets2k[i]) === sentinels[j],
      `Source mutated at index ${i} after ${label}.`);
  }
}

// Variant 1: Production pattern — single produce(), enrichWithBaseRate per market
// This is what enrichMarketsUpdater uses. enrichWithBaseRate returns same ref on
// short-circuit, so Immer only copies changed entries.
results.push(benchSync('enrich-single-produce', () => {
  produce(markets2k, draft => {
    for (let i = 0; i < draft.length; i++) {
      const enriched = enrichWithBaseRate(draft[i], rates);
      if (enriched !== draft[i]) {
        draft[i] = enriched;
      }
    }
  });
}, { iterations: 50, warmup: 5 }));
checkIntegrity('single-produce');

// Variant 2: Per-market produce() — expensive, creates N proxies
results.push(benchSync('enrich-per-market-produce', () => {
  markets2k.map(m => {
    return produce(m, draft => {
      const enriched = enrichWithBaseRate(draft, rates);
      if (enriched !== draft) {
        return enriched;
      }
    });
  });
}, { iterations: 50, warmup: 5 }));
checkIntegrity('per-market-produce');

// Variant 3: Manual spread (no Immer) — baseline comparison
results.push(benchSync('enrich-manual-spread', () => {
  markets2k.map(m => enrichWithBaseRate(m, rates));
}, { iterations: 50, warmup: 5 }));
checkIntegrity('manual-spread');

// ── B15: Batched price update throughput ────────────────────────
// The app accumulates price updates in a Map and applies them in one Immer
// pass every PRICE_THROTTLE_MS (1000ms). NOT a WebSocket at 7/sec.
// Threshold: under 8ms per update (half of 16ms frame budget).
// Reuse raw10k + 2k more to build 12k without regenerating from scratch.
const raw12k_extra = generateMarkets(2_000, 99);
const markets12k = [...raw10k, ...raw12k_extra].map(m => processMarket(m));

// Simulate 5 scattered price updates (common case)
const indicesToUpdate = [42, 1337, 5000, 8192, 11999];

results.push(benchSync('price-update-5-of-12k', () => {
  produce(markets12k, draft => {
    for (const idx of indicesToUpdate) {
      draft[idx].yesPrice = 0.55;
      draft[idx].noPrice = 0.45;
    }
  });
}, { iterations: 50, warmup: 5 }));

// Single-market update (most common case)
results.push(benchSync('price-update-1-of-12k', () => {
  produce(markets12k, draft => {
    draft[42].yesPrice = 0.55;
    draft[42].noPrice = 0.45;
  });
}, { iterations: 50, warmup: 5 }));

// Manual spread alternative for comparison
results.push(benchSync('price-update-1-of-12k-spread', () => {
  markets12k.map((m, i) => i === 42
    ? { ...m, yesPrice: 0.55, noPrice: 0.45 }
    : m
  );
}, { iterations: 50, warmup: 5 }));

writeResults(results, resultsPath('processing.json'));
