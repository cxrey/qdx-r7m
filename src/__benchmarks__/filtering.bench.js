/**
 * Benchmarks 3, 17: Filter/Sort Performance and Sort Comparator Scaling
 *
 * B3: filterAndSort on 2k processed markets with various filter/sort combos.
 * B17: Sort scaling at 2k/5k/10k/15k to detect O(n^2) comparators.
 *
 * What breaks if B3 regresses: Every user interaction (filter change, sort click)
 * feels sluggish. 8ms budget leaves room for React render in same frame.
 *
 * What breaks if B17 regresses: Sort at 12.5k+ causes tab freeze (historical regression).
 *
 * Threshold B3: Under 8ms per combination at 2k markets.
 * Threshold B17: Under 16ms at 10k, under 50ms at 15k. Scaling ratio < 12x from 2k to 15k.
 */
import { benchSync, writeResults, resultsPath } from './helpers/harness.js';
import { generateMarkets, defaultFilterConfig, defaultLookupState, defaultPortfolio } from './helpers/fixtures.js';

const results = [];

const { processMarket } = await import('../processMarket.js');
// FIX: Correct import path — filterAndSort is in utils/, not top-level
const { filterAndSort } = await import('../utils/filterAndSort.js');

// ── B3: Filter and Sort at 2k ──────────────────────────────────
const raw2k = generateMarkets(2_000);
const processed2k = raw2k.map(m => processMarket(m));

// No filters, default sort
results.push(benchSync('filterSort-noFilters-volume-2k', () => {
  filterAndSort({ markets: processed2k, filters: defaultFilterConfig('volume'), searchLower: '', lookupState: defaultLookupState, portfolio: defaultPortfolio });
}));

// Single filter: category
const catFilter = { ...defaultFilterConfig('volume'), categories: ['Sports'] };
results.push(benchSync('filterSort-category-volume-2k', () => {
  filterAndSort({ markets: processed2k, filters: catFilter, searchLower: '', lookupState: defaultLookupState, portfolio: defaultPortfolio });
}));

// Combined filters + sort for each major sort key
const sortKeys = ['volume', 'flbEdge', 'theta', 'strictness', 'baseRateGap', 'walletImbalance'];
const combinedBase = {
  ...defaultFilterConfig(),
  yesPriceRange: [10, 90],
  daysLeftRange: [1, 180],
  categories: ['Sports', 'Finance'],
};
for (const key of sortKeys) {
  const filters = { ...combinedBase, sortBy: key };
  results.push(benchSync(`filterSort-combined-${key}-2k`, () => {
    filterAndSort({ markets: processed2k, filters, searchLower: '', lookupState: defaultLookupState, portfolio: defaultPortfolio });
  }));
}

// Search filter (string matching — expensive)
results.push(benchSync('filterSort-search-2k', () => {
  filterAndSort({ markets: processed2k, filters: defaultFilterConfig('volume'), searchLower: 'bitcoin', lookupState: defaultLookupState, portfolio: defaultPortfolio });
}));

// ── B17: Sort comparator scaling at realistic dataset sizes ─────
// Since sort comparators are inline in filterAndSort (not exported),
// we benchmark filterAndSort with pass-through filters to isolate sort cost.
const tiers = [2_000, 5_000, 10_000, 15_000];
const tierData = {};
for (const n of tiers) {
  const raw = generateMarkets(n, 42);
  tierData[n] = raw.map(m => processMarket(m));
}

const scalingSortKeys = ['volume', 'flbEdge', 'theta', 'baseRateGap', 'walletImbalance'];
for (const key of scalingSortKeys) {
  const filters = defaultFilterConfig(key);
  for (const n of tiers) {
    results.push(benchSync(`sort-${key}-${n}`, () => {
      filterAndSort({ markets: tierData[n], filters, searchLower: '', lookupState: defaultLookupState, portfolio: defaultPortfolio });
    }, { iterations: 30 }));
  }
}

// Log scaling analysis
console.log('\n--- Scaling Analysis ---');
for (const key of scalingSortKeys) {
  const t2k = results.find(r => r.name === `sort-${key}-2000`);
  const t15k = results.find(r => r.name === `sort-${key}-15000`);
  if (t2k && t15k && t2k.median > 0) {
    const ratio = t15k.median / t2k.median;
    // O(n log n) expected ratio: (15000 * log(15000)) / (2000 * log(2000)) ~ 9.2x
    const status = ratio > 12 ? 'WARN' : 'OK';
    console.log(`${status}: ${key} scaling 2k→15k: ${ratio.toFixed(1)}x (expected ~9.2x for O(n log n))`);
  }
}

writeResults(results, resultsPath('filtering.json'));
