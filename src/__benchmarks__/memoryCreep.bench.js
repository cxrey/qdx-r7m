/**
 * Benchmark 11: Memory Creep Under Sustained Refresh
 *
 * Simulates repeated refresh cycles with cache updates and enrichment.
 * Measures heap growth after stabilization to detect per-cycle leaks.
 *
 * Requires --expose-gc (handled by run.js). Must run in its own process.
 *
 * What breaks if it regresses: Long-running browser tabs accumulate memory.
 * At 1KB/cycle with 60s refresh = ~1.4MB/day — noticeable in long sessions.
 *
 * Threshold: Per-cycle growth < 1KB after stabilization.
 * When to revisit: If refresh pipeline changes or new caches are added.
 */
import { produce } from 'immer';
import { writeResults, resultsPath } from './helpers/harness.js';
import { generateMarkets, generateBaseRates } from './helpers/fixtures.js';

const { processMarket, enrichWithBaseRate } = await import('../processMarket.js');
const { setCachedTradeFlow } = await import('../TradeFlowEngine.js');
const { SPREAD_CACHE_CAP } = await import('../uiConfig.js');

// Simulate the updateSpreadCache LRU pattern
const spreadCache = new Map();
function updateSpreadCache(marketId, value) {
  spreadCache.delete(marketId);
  spreadCache.set(marketId, value);
  if (spreadCache.size > SPREAD_CACHE_CAP) {
    spreadCache.delete(spreadCache.keys().next().value);
  }
}

function measureHeap() {
  global.gc();
  return process.memoryUsage().heapUsed;
}

// 1k markets balances signal-to-noise with iteration speed (~15s vs ~30s at 2k)
const baseMarkets = generateMarkets(1_000);
const rates = generateBaseRates(42);
const CYCLES = 100;
const STABILIZATION = 10;

// FIX: Use the correct Immer enrichment pattern (enrichMarketsUpdater style)
function simulateRefreshCycle(cycleNum) {
  // Simulate fresh data (slightly different each cycle)
  const freshMarkets = baseMarkets.map(m => ({ ...m, volume: `${parseFloat(m.volume) + cycleNum}` }));
  const processed = freshMarkets.map(m => processMarket(m));
  const enriched = produce(processed, draft => {
    for (let i = 0; i < draft.length; i++) {
      const result = enrichWithBaseRate(draft[i], rates);
      if (result !== draft[i]) {
        draft[i] = result;
      }
    }
  });

  // Simulate cache updates for visible rows (50 markets per cycle)
  for (let i = 0; i < 50; i++) {
    const m = enriched[i];
    updateSpreadCache(m.conditionId || m.id, { bid: 0.45, ask: 0.55 });
    setCachedTradeFlow(m.conditionId || m.id, {
      dataAvailable: true,
      walletImbalance: 0.1,
      totalUniqueWallets: 5,
    });
  }
}

// Run stabilization cycles (JIT warmup, initial cache fill)
for (let i = 0; i < STABILIZATION; i++) {
  simulateRefreshCycle(i);
}
const heapAfterStabilization = measureHeap();

// Run measured cycles, recording heap after each
const heapSamples = [];
for (let i = 0; i < CYCLES; i++) {
  simulateRefreshCycle(STABILIZATION + i);
  if (i % 10 === 0) heapSamples.push({ cycle: STABILIZATION + i, heap: measureHeap() });
}
const heapFinal = measureHeap();

const totalGrowth = heapFinal - heapAfterStabilization;
const perCycleGrowth = totalGrowth / CYCLES;

console.log(`Heap after stabilization: ${(heapAfterStabilization / 1024 / 1024).toFixed(1)}MB`);
console.log(`Heap after ${CYCLES} cycles: ${(heapFinal / 1024 / 1024).toFixed(1)}MB`);
console.log(`Total growth: ${(totalGrowth / 1024).toFixed(1)}KB`);
console.log(`Per-cycle growth: ${perCycleGrowth.toFixed(0)} bytes`);

for (const s of heapSamples) {
  console.log(`  cycle ${s.cycle}: ${(s.heap / 1024 / 1024).toFixed(2)}MB`);
}

const resultData = [
  { name: 'memory-creep-total-growth', median: totalGrowth, p95: 0, mean: 0, iterations: CYCLES },
  { name: 'memory-creep-per-cycle', median: perCycleGrowth, p95: 0, mean: 0, iterations: CYCLES },
  { name: 'memory-creep-final-heap', median: heapFinal, p95: 0, mean: 0, iterations: 1 },
];
writeResults(resultData, resultsPath('memoryCreep.json'));
