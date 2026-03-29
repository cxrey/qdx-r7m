/**
 * Benchmark 7: Trade Flow Engine Scaling
 *
 * FIX: The prompt called computeTradeFlow(markets) which doesn't exist.
 * The actual function is analyzeTradeFlow(trades, holders, leaderboardIndex, market, walletRelevanceMap)
 * — per-market with individual inputs, not a batch function.
 *
 * What breaks if it regresses: Hover panel / expanded row detail takes too long.
 * Threshold: Under 50ms per market at any tier. Scaling from 100→5k should be < 8x.
 * When to revisit: If analyzeTradeFlow gains new sub-analyses.
 */
import { benchSync, writeResults, resultsPath } from './helpers/harness.js';
import { generateMarketsWithTradeData } from './helpers/fixtures.js';

const results = [];

// FIX: Import the actual function with correct name
const { analyzeTradeFlow } = await import('../TradeFlowEngine.js');

// Generate tiered fixtures with trade data
const tiers = [100, 500, 1_000, 2_000, 5_000].map(n => ({
  n,
  data: generateMarketsWithTradeData(n),
}));

// Build a synthetic leaderboard index
const leaderboardIndex = new Map();
for (let i = 0; i < 100; i++) {
  const addr = `0x${i.toString(16).padStart(40, '0')}`;
  leaderboardIndex.set(addr, {
    address: addr,
    rank: i + 1,
    profit: 10000 - i * 100,
    volume: 50000 - i * 500,
    markets: 50 - ((i * 0.5) | 0),
  });
}

// Pre-allocate empty Map to avoid GC noise from per-iteration allocation
const emptyRelevanceMap = new Map();

for (const { n, data } of tiers) {
  // FIX: Call analyzeTradeFlow per-market with correct signature
  results.push(benchSync(`tradeFlow-${n}`, () => {
    for (const { market, trades, holders } of data) {
      analyzeTradeFlow(trades, holders, leaderboardIndex, market, emptyRelevanceMap);
    }
  }, { iterations: n <= 1000 ? 10 : 3, warmup: 1 }));
}

// Log scaling analysis
console.log('\n--- Trade Flow Scaling ---');
const t100 = results.find(r => r.name === 'tradeFlow-100');
const t5k = results.find(r => r.name === 'tradeFlow-5000');
if (t100 && t5k && t100.median > 0) {
  const ratio = t5k.median / t100.median;
  // Linear expected: 50x. Quadratic: 2500x. Above 80x (< 8x per 10x growth) warrants investigation.
  console.log(`Scaling 100→5k: ${ratio.toFixed(1)}x (linear expected: 50x)`);
}

writeResults(results, resultsPath('tradeFlow.json'));
