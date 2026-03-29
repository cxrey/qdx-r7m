/**
 * Two factory shapes for two pipeline stages:
 *
 * makeMarket()          — raw API response shape (pre-processMarket).
 *                         Used by fetch-level tests (api, backgroundFetch, etc.)
 *
 * makeProcessedMarket() — processed shape (post-processMarket).
 *                         Used by filterAndSort, UI-level tests.
 *                         Fields: yesPrice, noPrice, edgeScore, category, etc.
 */

let _counter = 0;

/**
 * makeMarket(overrides) — returns a realistic raw API market object.
 */
export function makeMarket(overrides = {}) {
  const i = _counter++;
  return {
    id: `market-${i}`,
    question: `Will event ${i} happen?`,
    slug: `will-event-${i}-happen`,
    clobTokenIds: [`token-yes-${i}`, `token-no-${i}`],
    conditionId: `cond-${i}`,
    outcomePrices: JSON.stringify([0.55, 0.45]),
    volume: 50000 + i * 1000,
    volume24hr: 5000 + i * 100,
    endDate: new Date(Date.now() + 7 * 86400000).toISOString(),
    createdAt: new Date(Date.now() - 30 * 86400000).toISOString(),
    active: true,
    closed: false,
    events: [{ slug: `event-${i}` }],
    ...overrides,
  };
}

/**
 * makeMarketList(n) — returns n markets with unique ids.
 */
export function makeMarketList(n) {
  return Array.from({ length: n }, () => makeMarket());
}

/**
 * resetCounter() — reset the auto-increment counter (call in beforeEach).
 */
export function resetCounter() {
  _counter = 0;
}

/**
 * makeProcessedMarket(overrides) — returns a processed market object
 * (the shape produced by processMarket(), consumed by filterAndSort()).
 */
export function makeProcessedMarket(overrides = {}) {
  return {
    id: overrides.id || 'mkt-1',
    question: overrides.question || 'Will it rain tomorrow?',
    description: overrides.description || 'Weather prediction market',
    volume: 10000,
    volume24hr: 500,
    yesPrice: 0.55,
    noPrice: 0.45,
    daysLeft: 30,
    category: 'Other',
    edgeScore: 50,
    flb: null,
    theta: null,
    resolutionAnalysis: null,
    volumeEfficiency: null,
    baseRate: null,
    conjunction: null,
    ...overrides,
  };
}
