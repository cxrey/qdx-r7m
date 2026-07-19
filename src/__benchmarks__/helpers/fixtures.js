import { createPRNG } from './prng.js';

const CATEGORIES = ['Politics', 'Crypto', 'Finance', 'Sports', 'Geopolitics', 'Tech', 'Pop Culture', 'Science'];
const CATEGORY_KEYWORDS = {
  Politics: ['election', 'president', 'vote', 'congress', 'senate'],
  Crypto: ['bitcoin', 'ethereum', 'crypto', 'token', 'defi'],
  Finance: ['stock', 'interest rate', 'inflation', 'GDP', 'earnings'],
  Sports: ['NBA', 'NFL', 'championship', 'playoff', 'soccer'],
  Geopolitics: ['war', 'ceasefire', 'sanctions', 'military', 'tariff'],
  Tech: ['AI', 'OpenAI', 'Google', 'Apple', 'SpaceX'],
  'Pop Culture': ['movie', 'Oscar', 'Grammy', 'album', 'celebrity'],
  Science: ['climate', 'pandemic', 'vaccine', 'NASA', 'hurricane'],
};

/**
 * Generate raw market objects matching the Gamma API response shape.
 * Uses seeded PRNG for deterministic output — same seed = same fixtures.
 */
export function generateMarkets(count, seed = 42) {
  const random = createPRNG(seed);

  const randomString = (min, max) => Array.from(
    { length: min + ((random() * (max - min)) | 0) },
    () => String.fromCharCode(97 + (random() * 26) | 0)
  ).join('');

  const randomHex = (len) => Array.from(
    { length: len },
    () => ((random() * 16) | 0).toString(16)
  ).join('');

  // Fixed epoch for deterministic dates across benchmark runs.
  // Using Date.now() would make daysLeft vary by run time, affecting filter/sort results.
  const EPOCH = new Date('2026-01-01T00:00:00Z').getTime();

  return Array.from({ length: count }, (_, i) => {
    const cat = CATEGORIES[i % CATEGORIES.length];
    const keywords = CATEGORY_KEYWORDS[cat];
    const keyword = keywords[(random() * keywords.length) | 0];
    const yesPrice = 0.05 + random() * 0.9; // 0.05 to 0.95
    const noPrice = Math.max(0.01, Math.min(0.99, 1 - yesPrice + (random() * 0.06 - 0.03)));
    const futureMs = EPOCH + (1 + random() * 365) * 86400000;
    const endDate = new Date(futureMs).toISOString();
    const createdAt = new Date(EPOCH - (30 + random() * 365) * 86400000).toISOString();

    const conditionId = `0x${randomHex(40)}`;
    const tokenYes = `${((random() * 1e15) | 0).toString()}`;
    const tokenNo = `${((random() * 1e15) | 0).toString()}`;

    return {
      id: `${10000 + i}`,
      question: `Will ${keyword} event ${i} occur by ${2025 + ((random() * 5) | 0)}? ${randomString(20, 80)}`,
      title: `${keyword} market ${i}`,
      description: `Description for market ${i} about ${keyword}. ${randomString(50, 200)}`,
      conditionId,
      questionId: `0x${randomHex(40)}`,
      slug: `${keyword.toLowerCase().replace(/\s+/g, '-')}-market-${i}-${randomString(5, 10)}`,
      outcomePrices: JSON.stringify([yesPrice.toFixed(4), noPrice.toFixed(4)]),
      clobTokenIds: JSON.stringify([tokenYes, tokenNo]),
      volume: `${Math.pow(10, 2 + random() * 5).toFixed(2)}`,
      volume24hr: `${(random() * 50000).toFixed(2)}`,
      active: random() > 0.1,
      closed: random() < 0.05,
      acceptingOrders: random() > 0.15,
      endDate,
      createdAt,
      neg_risk: random() < 0.3,
      enableOrderBook: true,
      events: [{
        slug: `${keyword.toLowerCase().replace(/\s+/g, '-')}-event-${i}`,
        title: `${keyword} Event ${i}`,
      }],
      tokens: [
        { token_id: tokenYes, outcome: 'Yes', price: yesPrice },
        { token_id: tokenNo, outcome: 'No', price: noPrice },
      ],
      tags: [{ label: cat }, ...(random() > 0.5 ? [{ label: 'Trending' }] : [])],
    };
  });
}

/**
 * Generate markets and process them through processMarket.
 * Dynamically imports processMarket to avoid top-level side effects.
 */
export async function generateProcessedMarkets(count, seed = 42) {
  const { processMarket } = await import('../../processMarket.js');
  const raw = generateMarkets(count, seed);
  return raw.map(m => processMarket(m));
}

/**
 * Generate markets with synthetic trade data for analyzeTradeFlow benchmarks.
 */
export function generateMarketsWithTradeData(count, seed = 42) {
  // Use a different seed for trade data to avoid PRNG state collision with generateMarkets.
  // generateMarkets(count, seed) creates its own PRNG internally; this outer PRNG must not
  // share the same seed to avoid producing correlated sequences if either is refactored.
  const random = createPRNG(seed + 1000);
  const markets = generateMarkets(count, seed);

  return markets.map((market, i) => {
    const now = Date.now() / 1000;
    const tradeCount = 20 + ((random() * 180) | 0);

    const trades = Array.from({ length: tradeCount }, (_, j) => {
      const isBuy = random() > 0.5;
      const size = 5 + random() * 500;
      return {
        id: `trade_${i}_${j}`,
        timestamp: now - random() * 86400,
        price: 0.1 + random() * 0.8,
        size: size.toFixed(2),
        side: isBuy ? 'BUY' : 'SELL',
        outcome: random() > 0.5 ? 'Yes' : 'No',
        maker_address: `0x${((random() * 1e12) | 0).toString(16).padStart(40, '0')}`,
        taker_address: `0x${((random() * 1e12) | 0).toString(16).padStart(40, '0')}`,
        asset_id: market.tokens[0].token_id,
      };
    });

    const holderCount = 5 + ((random() * 45) | 0);
    const holders = Array.from({ length: holderCount }, () => ({
      address: `0x${((random() * 1e12) | 0).toString(16).padStart(40, '0')}`,
      balance: (10 + random() * 10000).toFixed(2),
      outcome: random() > 0.5 ? 'Yes' : 'No',
    }));

    return { market, trades, holders };
  });
}

/**
 * Generate base rate lookup table matching computeBaseRates output shape.
 * Must use the same seed as generateProcessedMarkets so keys overlap.
 */
export function generateBaseRates(seed = 42) {
  const random = createPRNG(seed);
  const rates = {};

  for (const cat of CATEGORIES) {
    rates[cat] = {};
    for (const duration of ['short', 'medium', 'long']) {
      rates[cat][duration] = {};
      for (let priceBucket = 0; priceBucket < 10; priceBucket++) {
        const key = `${priceBucket * 10}-${(priceBucket + 1) * 10}`;
        const sampleSize = 5 + ((random() * 50) | 0);
        rates[cat][duration][key] = {
          yesRate: random(),
          sampleSize,
          totalResolved: sampleSize + ((random() * 20) | 0),
        };
      }
    }
  }

  return rates;
}

/**
 * Default filter config for filterAndSort benchmarks.
 * All filters wide open — measures sort cost without filter overhead.
 */
export function defaultFilterConfig(sortBy = 'volume') {
  return {
    volumeRange: [0, 50_000_000],
    yesPriceRange: [0, 100],
    noPriceRange: [0, 100],
    daysLeftRange: [0, 365],
    categories: [],
    volPriorities: [],
    resolutionTypes: [],
    minStrictness: 0,
    minNarrativeGap: 0,
    minTheta: 0,
    minEdge: 0,
    minConjunctionGap: 0,
    flbOnly: false,
    hideDeadMoney: false,
    hideEfficient: false,
    baseRateConfidence: 'ALL',
    hideHeld: false,
    conjunctionTypes: [],
    sortBy,
    sortAsc: false,
  };
}

/**
 * Default lookupState for filterAndSort — inactive lookup.
 */
export const defaultLookupState = {
  isLookupActive: false,
  fetchedMarkets: [],
  foundInLoadedId: null,
};

/**
 * Default portfolio for filterAndSort — no portfolio.
 */
export const defaultPortfolio = {
  hasPortfolio: false,
  isMarketHeld: () => false,
};
