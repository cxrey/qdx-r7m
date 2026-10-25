/**
 * Benchmarks 1, 6, 12: Fetch Batching, Background Fetch Cycle, Hover Prefetch
 *
 * B1: fetchAllMarkets call count and efficiency.
 * B6: Simulated background fetch cycle structure (no runBackgroundFetchCycle exists;
 *     we simulate the sequential fetch + cache write pattern directly).
 * B12: Hover prefetch latency for a single market.
 *
 * What breaks if B1 regresses: 484-request regression (shipped once already).
 * What breaks if B6 regresses: Background refresh takes too long, stale data.
 * What breaks if B12 regresses: Hover panel feels sluggish.
 *
 * Threshold B1: <= ceil(marketCount / 100) + 5 calls for 5k markets.
 * Threshold B6: Deterministic request count across iterations.
 * Threshold B12: Under 5ms overhead (excluding network).
 */
import { benchAsync, benchAsyncManual, writeResults, resultsPath } from './helpers/harness.js';
import { generateMarkets } from './helpers/fixtures.js';

const results = [];

// ── Setup mock fetch ────────────────────────────────────────────
const PAGE_SIZE = 100;

// Mimics /events/keyset: serves `markets` (one event each) as a cursor chain on
// the lowest volume band only; the other bands fetchAllMarkets crawls are empty.
// The cursor is the next start index, so `marketsAt(start)` can build pages lazily.
function keysetPage(url, totalMarkets, marketsAt) {
  if (!url.includes('volume_min=100&')) return { events: [], next_cursor: null };
  const cursorMatch = url.match(/after_cursor=(\d+)/);
  const start = cursorMatch ? parseInt(cursorMatch[1]) : 0;
  const end = Math.min(start + PAGE_SIZE, totalMarkets);
  const events = marketsAt(start, end).map((m, i) => ({ id: `evt-${start + i}`, active: true, markets: [m] }));
  return { events, next_cursor: end < totalMarkets ? String(end) : null };
}

function createMockFetch(totalMarkets) {
  const markets = generateMarkets(totalMarkets);
  let callCount = 0;

  const mockFetch = async (url) => {
    callCount++;
    const page = keysetPage(url, totalMarkets, (start, end) => markets.slice(start, end));

    return {
      ok: true,
      status: 200,
      json: async () => page,
    };
  };

  return { mockFetch, getCallCount: () => callCount, resetCount: () => { callCount = 0; } };
}

// ── B1: Fetch batching efficiency ───────────────────────────────
const { mockFetch: mock5k, getCallCount: getCount5k, resetCount: reset5k } = createMockFetch(5_000);
const origFetch = globalThis.fetch;

try {
  globalThis.fetch = mock5k;

  const { fetchAllMarkets, fetchOrderBook } = await import('../api.js');

  // Measure and count
  reset5k();
  const fetched = await fetchAllMarkets(() => {}, new AbortController().signal);
  const callCount5k = getCount5k();

  console.log(`B1: fetchAllMarkets returned ${fetched.length} markets in ${callCount5k} calls`);
  const expectedMax = Math.ceil(5000 / PAGE_SIZE) + 5;
  console.log(`B1: Threshold: <= ${expectedMax} calls`);
  if (callCount5k > expectedMax) {
    console.warn(`WARN: Call count ${callCount5k} exceeds threshold ${expectedMax}`);
  }

  // Benchmark timing
  results.push(await benchAsync('fetchAllMarkets-5k', async () => {
    reset5k();
    await fetchAllMarkets(() => {}, new AbortController().signal);
  }, { iterations: 10, warmup: 2 }));

  // ── B6: Simulated background fetch cycle ────────────────────────
  // The real background fetch is embedded in React effects (ResultsTable.jsx).
  // We simulate the sequential fetch + cache write pattern directly.
  let cycleCallCount = 0;
  let inFlight = 0;
  let maxConcurrency = 0;
  const iterationMetrics = [];

  globalThis.fetch = async (url) => {
    cycleCallCount++;
    inFlight++;
    maxConcurrency = Math.max(maxConcurrency, inFlight);
    await new Promise(r => setTimeout(r, 2)); // Minimal async delay
    inFlight--;
    const page = keysetPage(url, 2000, (start, end) => generateMarkets(end - start, 42));
    return { ok: true, status: 200, json: async () => page };
  };

  const cycleResult = await benchAsyncManual('background-fetch-cycle-2k', async ({ warmup }) => {
    cycleCallCount = 0;
    inFlight = 0;
    maxConcurrency = 0;
    await fetchAllMarkets(() => {}, new AbortController().signal);
    if (!warmup) iterationMetrics.push({ callCount: cycleCallCount, maxConcurrency });
  }, { iterations: 10, warmup: 2 });

  results.push(cycleResult);

  if (iterationMetrics.length > 0) {
    const counts = iterationMetrics.map(m => m.callCount);
    const concurrencies = iterationMetrics.map(m => m.maxConcurrency);
    console.log(`B6 Requests: min=${Math.min(...counts)} max=${Math.max(...counts)}`);
    console.log(`B6 Max concurrency: min=${Math.min(...concurrencies)} max=${Math.max(...concurrencies)}`);
    if (Math.min(...counts) !== Math.max(...counts))
      console.warn('WARNING: Non-deterministic request count across iterations');
  }

  // ── B12: Hover prefetch latency ─────────────────────────────────
  const hoverMarket = generateMarkets(1)[0];
  const spreadCache = new Map();

  globalThis.fetch = async () => {
    await new Promise(r => setTimeout(r, 2));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        bids: [{ price: '0.45', size: '100' }],
        asks: [{ price: '0.55', size: '100' }],
      }),
    };
  };

  results.push(await benchAsync('hover-prefetch-single', async () => {
    await fetchOrderBook(hoverMarket.tokens[0].token_id);
    spreadCache.set(hoverMarket.conditionId, { bid: 0.45, ask: 0.55 });
  }, { iterations: 50, warmup: 5 }));
  writeResults(results, resultsPath('fetch.json'));
} finally {
  globalThis.fetch = origFetch;
}
