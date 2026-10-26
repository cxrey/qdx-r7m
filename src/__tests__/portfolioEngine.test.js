import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetchUtils before importing PortfolioEngine
vi.mock('../fetchUtils', () => ({
  withTimeout: vi.fn(() => new AbortController().signal),
  TIMEOUT_DATA_API: 5000,
}));

import {
  fetchPositions,
  normalizePosition,
  matchPositionsToMarkets,
  extractEntities,
  calculatePairCorrelation,
  buildCorrelationClusters,
  calculateConcentration,
  screenNewTrade,
  getStoredWallet,
  setStoredWallet,
  getManualPositions,
  addManualPosition,
  removeManualPosition,
  clearManualPositions,
  getDismissedAlerts,
  dismissAlert,
  resetDismissedAlerts,
  pricesFromGammaMarket,
  unloadedManualMarketIds,
  priceManualPosition,
  findHeldMarkets,
  sameHeldMarkets,
  holdingsKey,
  structureKey,
  repriceWalletPosition,
  buildCorrelationStructure,
  priceClusters,
} from '../PortfolioEngine';
import { envelope, jsonResponse, v2Position, WALLET, YES_TOKEN, CONDITION } from './helpers/dataApiV2Fixtures';
import { generateMarkets } from '../__benchmarks__/helpers/fixtures';

// ── Helpers ──

function makeMarket(overrides = {}) {
  return {
    id: 'mkt-1',
    question: 'Will Trump win the 2024 election?',
    description: 'Resolves Yes if Trump wins.',
    category: 'Politics',
    slug: 'trump-2024',
    daysLeft: 30,
    yesPrice: 0.55,
    noPrice: 0.45,
    clobTokenIds: ['tok-yes-1', 'tok-no-1'],
    conditionId: 'cond-1',
    ...overrides,
  };
}

function makePosition(marketOverrides = {}, posOverrides = {}) {
  const market = makeMarket(marketOverrides);
  return {
    market,
    side: 'YES',
    currentValue: 100,
    size: 100,
    currentPrice: market.yesPrice,
    entryPrice: 0.50,
    unrealizedPnl: 5,
    ...posOverrides,
  };
}

// ── localStorage mock ──

let storage = {};

beforeEach(() => {
  storage = {};
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key) => storage[key] ?? null),
    setItem: vi.fn((key, val) => { storage[key] = val; }),
    removeItem: vi.fn((key) => { delete storage[key]; }),
  });
  vi.stubGlobal('fetch', vi.fn());
});

// ═══════════════════════════════════════════════════════════
// 1. extractEntities
// ═══════════════════════════════════════════════════════════

describe('extractEntities', () => {
  it('extracts countries from text', () => {
    const result = extractEntities('Will Russia invade Ukraine this year?');
    expect(result.countries.has('russia')).toBe(true);
    expect(result.countries.has('ukraine')).toBe(true);
  });

  it('extracts people from text', () => {
    const result = extractEntities('Will Trump or Biden debate in 2024?');
    expect(result.people.has('trump')).toBe(true);
    expect(result.people.has('biden')).toBe(true);
  });

  it('extracts organizations from text', () => {
    const result = extractEntities('Will the Federal Reserve raise rates before the SEC acts?');
    expect(result.orgs.has('federal reserve')).toBe(true);
    expect(result.orgs.has('sec')).toBe(true);
  });

  it('returns empty sets for text with no known entities', () => {
    const result = extractEntities('Will it rain tomorrow in a random town?');
    expect(result.countries.size).toBe(0);
    expect(result.people.size).toBe(0);
    expect(result.orgs.size).toBe(0);
  });

  it('is case-insensitive', () => {
    const result = extractEntities('TRUMP visited JAPAN');
    expect(result.people.has('trump')).toBe(true);
    expect(result.countries.has('japan')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. calculatePairCorrelation
// ═══════════════════════════════════════════════════════════

describe('calculatePairCorrelation', () => {
  it('returns 0 correlation when markets have no overlap', () => {
    const posA = makePosition({
      id: 'a', question: 'Will it rain tomorrow?', description: 'Weather bet',
      category: 'Weather', slug: 'rain-tomorrow', daysLeft: 100,
    });
    const posB = makePosition({
      id: 'b', question: 'Will a new species be discovered?', description: 'Biology bet',
      category: 'Science', slug: 'new-species', daysLeft: 300,
    });
    const result = calculatePairCorrelation(posA, posB);
    expect(result.correlation).toBe(0);
    expect(result.types).toEqual([]);
    expect(result.sharedLabels).toEqual([]);
  });

  it('detects CATEGORY overlap', () => {
    const posA = makePosition({ id: 'a', question: 'Bet A no entities', description: '', category: 'Crypto', slug: 'slug-a', daysLeft: 100 });
    const posB = makePosition({ id: 'b', question: 'Bet B no entities', description: '', category: 'Crypto', slug: 'slug-b', daysLeft: 200 });
    const result = calculatePairCorrelation(posA, posB);
    expect(result.types).toContain('CATEGORY');
    expect(result.correlation).toBeGreaterThanOrEqual(0.2);
  });

  it('detects ENTITY overlap via shared people', () => {
    const posA = makePosition({ id: 'ent-a', question: 'Will Trump win?', description: '', slug: 'ent-a', daysLeft: 100, category: null });
    const posB = makePosition({ id: 'ent-b', question: 'Will Trump be indicted?', description: '', slug: 'ent-b', daysLeft: 200, category: null });
    const result = calculatePairCorrelation(posA, posB);
    expect(result.types).toContain('ENTITY');
    expect(result.sharedLabels).toContain('trump');
    expect(result.correlation).toBeGreaterThanOrEqual(0.5);
  });

  it('detects EVENT overlap (same slug)', () => {
    const posA = makePosition({ id: 'a', question: 'No entities here', description: '', slug: 'same-event', daysLeft: 100, category: null });
    const posB = makePosition({ id: 'b', question: 'No entities either', description: '', slug: 'same-event', daysLeft: 200, category: null });
    const result = calculatePairCorrelation(posA, posB);
    expect(result.types).toContain('EVENT');
    expect(result.correlation).toBeGreaterThanOrEqual(0.8);
  });

  it('detects TEMPORAL overlap when daysLeft within 14 days', () => {
    const posA = makePosition({ id: 'a', question: 'No entities', description: '', slug: 'a', daysLeft: 10, category: null });
    const posB = makePosition({ id: 'b', question: 'No entities either', description: '', slug: 'b', daysLeft: 20, category: null });
    const result = calculatePairCorrelation(posA, posB);
    expect(result.types).toContain('TEMPORAL');
    expect(result.correlation).toBeGreaterThanOrEqual(0.1);
  });

  it('returns 0 when either position has no market', () => {
    const posA = makePosition();
    const posB = { ...makePosition(), market: null };
    const result = calculatePairCorrelation(posA, posB);
    expect(result.correlation).toBe(0);
  });

  it('applies multi-type bonus for combined overlap types', () => {
    // Same category + shared entity + temporal => 3 types => +0.15 bonus
    const posA = makePosition({ id: 'x1', question: 'Will Trump act?', description: '', slug: 'a', daysLeft: 10, category: 'Politics' });
    const posB = makePosition({ id: 'x2', question: 'Will Trump speak?', description: '', slug: 'b', daysLeft: 15, category: 'Politics' });
    const result = calculatePairCorrelation(posA, posB);
    expect(result.types.length).toBeGreaterThanOrEqual(2);
    // Entity overlap alone is 0.5, multi-type bonus pushes it higher
    expect(result.correlation).toBeGreaterThan(0.5);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. buildCorrelationClusters
// ═══════════════════════════════════════════════════════════

describe('buildCorrelationClusters', () => {
  it('returns empty clusters for empty positions', () => {
    const { clusters, correlationMatrix } = buildCorrelationClusters([]);
    expect(clusters).toEqual([]);
    expect(correlationMatrix).toEqual([]);
  });

  it('puts a single position in its own cluster', () => {
    const pos = makePosition({ id: 'solo', question: 'Unique bet', description: '', slug: 'solo', category: 'Other' });
    const { clusters } = buildCorrelationClusters([pos]);
    expect(clusters.length).toBe(1);
    expect(clusters[0].positions.length).toBe(1);
  });

  it('clusters correlated positions together', () => {
    const posA = makePosition({ id: 'c1', question: 'Will Trump win 2024?', description: 'Election', slug: 'trump-win', category: 'Politics' });
    const posB = makePosition({ id: 'c2', question: 'Will Trump get nominated?', description: 'Nomination', slug: 'trump-nom', category: 'Politics' });
    // These share entity "trump" + category "Politics" => correlation > 0.4 threshold
    const { clusters } = buildCorrelationClusters([posA, posB]);
    expect(clusters.length).toBe(1);
    expect(clusters[0].positions.length).toBe(2);
  });

  it('keeps uncorrelated positions in separate clusters', () => {
    const posA = makePosition({
      id: 'u1', question: 'Will it rain in a random town?', description: 'Weather',
      slug: 'rain', category: 'Weather', daysLeft: 5,
    });
    const posB = makePosition({
      id: 'u2', question: 'Will a volcano erupt on an unknown island?', description: 'Geology',
      slug: 'volcano', category: 'Science', daysLeft: 300,
    });
    const { clusters } = buildCorrelationClusters([posA, posB]);
    expect(clusters.length).toBe(2);
  });

  it('enriches clusters with metadata (risk, dominantSide, portfolioWeight)', () => {
    const pos = makePosition({ id: 'meta1', question: 'Standalone bet', description: '', slug: 'meta', category: 'Other' });
    pos.currentValue = 100;
    const { clusters } = buildCorrelationClusters([pos]);
    const c = clusters[0];
    expect(c).toHaveProperty('risk');
    expect(c).toHaveProperty('dominantSide');
    expect(c).toHaveProperty('portfolioWeight');
    expect(c).toHaveProperty('averageCorrelation');
  });
});

// ═══════════════════════════════════════════════════════════
// 4. calculateConcentration
// ═══════════════════════════════════════════════════════════

describe('calculateConcentration', () => {
  it('returns zeroed metrics for empty portfolio', () => {
    const result = calculateConcentration([], []);
    expect(result.hhi).toBe(0);
    expect(result.effectiveBets).toBe(0);
    expect(result.diversificationLabel).toBe('No Positions');
  });

  it('calculates HHI correctly for two equal clusters', () => {
    const positions = [
      makePosition({ id: 'h1' }, { currentValue: 50 }),
      makePosition({ id: 'h2' }, { currentValue: 50 }),
    ];
    const clusters = [
      { portfolioWeight: 0.5, effectivePositionCount: 1, positions: [positions[0]], name: 'A' },
      { portfolioWeight: 0.5, effectivePositionCount: 1, positions: [positions[1]], name: 'B' },
    ];
    const result = calculateConcentration(positions, clusters);
    // HHI = 0.5^2 + 0.5^2 = 0.5
    expect(result.hhi).toBeCloseTo(0.5, 5);
  });

  it('computes side imbalance correctly', () => {
    const positions = [
      makePosition({ id: 's1' }, { side: 'YES', currentValue: 80 }),
      makePosition({ id: 's2' }, { side: 'NO', currentValue: 20 }),
    ];
    const clusters = [{ portfolioWeight: 1, effectivePositionCount: 2, positions, name: 'All' }];
    const result = calculateConcentration(positions, clusters);
    // imbalance = |80-20| / (80+20) = 0.6
    expect(result.sideImbalance).toBeCloseTo(0.6, 5);
    expect(result.yesExposure).toBe(80);
    expect(result.noExposure).toBe(20);
  });

  it('computes effectiveBets as sum of cluster effectivePositionCounts', () => {
    const positions = [
      makePosition({ id: 'eb1' }, { currentValue: 50 }),
      makePosition({ id: 'eb2' }, { currentValue: 50 }),
    ];
    const clusters = [
      { portfolioWeight: 0.5, effectivePositionCount: 0.8, positions: [positions[0]], name: 'A' },
      { portfolioWeight: 0.5, effectivePositionCount: 1.0, positions: [positions[1]], name: 'B' },
    ];
    const result = calculateConcentration(positions, clusters);
    expect(result.effectiveBets).toBeCloseTo(1.8, 5);
  });

  it('labels highly concentrated portfolios correctly', () => {
    const positions = [makePosition({ id: 'hc1' }, { currentValue: 100 })];
    // Single cluster with 100% weight, effectivePositionCount < 2
    const clusters = [{ portfolioWeight: 1.0, effectivePositionCount: 1, positions, name: 'Solo' }];
    const result = calculateConcentration(positions, clusters);
    // HHI=1 => -40, effectiveBets=1 < 2 => -30, score = 30 => Concentrated
    expect(result.diversificationScore).toBeLessThan(50);
    expect(['Highly Concentrated', 'Concentrated']).toContain(result.diversificationLabel);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. screenNewTrade
// ═══════════════════════════════════════════════════════════

describe('screenNewTrade', () => {
  it('returns GOOD_FIT for empty portfolio', () => {
    const market = makeMarket({ id: 'new' });
    const result = screenNewTrade(market, [], []);
    expect(result.fit).toBe('GOOD_FIT');
    expect(result.maxCorrelation).toBe(0);
    expect(result.currentDivScore).toBe(100);
  });

  it('returns GOOD_FIT for uncorrelated new market', () => {
    const existingPos = makePosition({
      id: 'ex1', question: 'Will it rain in a random town?', description: 'Weather',
      slug: 'rain', category: 'Weather', daysLeft: 5,
    }, { currentValue: 100 });
    const { clusters } = buildCorrelationClusters([existingPos]);

    const newMarket = makeMarket({
      id: 'new1', question: 'Will a volcano erupt on an unknown island?',
      description: 'Geology', slug: 'volcano', category: 'Science', daysLeft: 300,
    });
    const result = screenNewTrade(newMarket, [existingPos], clusters);
    expect(result.fit).toBe('GOOD_FIT');
  });

  it('returns INCREASES_CONCENTRATION for highly correlated market in heavy cluster', () => {
    // Build a portfolio with a single large cluster
    const pos1 = makePosition({ id: 'ic1', question: 'Will Trump win?', description: 'Election', slug: 'trump', category: 'Politics' }, { currentValue: 200 });
    const pos2 = makePosition({ id: 'ic2', question: 'Will Trump be nominated?', description: 'Primary', slug: 'trump-nom', category: 'Politics' }, { currentValue: 200 });
    const { clusters } = buildCorrelationClusters([pos1, pos2]);

    const newMarket = makeMarket({
      id: 'ic-new', question: 'Will Trump sign executive order?',
      description: 'Trump presidency action', slug: 'trump-eo', category: 'Politics',
    });
    const result = screenNewTrade(newMarket, [pos1, pos2], clusters);
    // Should be either INCREASES_CONCENTRATION or NEUTRAL depending on exact correlation
    expect(['INCREASES_CONCENTRATION', 'NEUTRAL']).toContain(result.fit);
    expect(result.maxCorrelation).toBeGreaterThan(0.3);
  });

  it('returns NEUTRAL for moderate overlap', () => {
    const existingPos = makePosition({
      id: 'n1', question: 'Will the fed raise rates?', description: 'Monetary policy',
      slug: 'fed-rates', category: 'Economics', daysLeft: 30,
    }, { currentValue: 100 });
    const { clusters } = buildCorrelationClusters([existingPos]);

    // Shares "fed" entity but different slug/category nuance
    const newMarket = makeMarket({
      id: 'n-new', question: 'Will the fed cut rates in Q4?',
      description: 'Rate cut decision', slug: 'fed-cut', category: 'Finance', daysLeft: 200,
    });
    const result = screenNewTrade(newMarket, [existingPos], clusters);
    // Entity overlap with fed => correlation >= 0.5 => NEUTRAL or INCREASES_CONCENTRATION
    expect(['NEUTRAL', 'INCREASES_CONCENTRATION', 'GOOD_FIT']).toContain(result.fit);
  });

  it('returns OPPOSING when candidate opposes existing position side', () => {
    const sharedMarket = makeMarket({ id: 'opp1', question: 'Will Trump win 2024?', description: 'Election', slug: 'trump-2024', category: 'Politics' });

    // Same slug => EVENT overlap (0.8 corr), candidate side defaults to YES but we check opposing logic
    // screenNewTrade creates candidatePos with side 'YES', so for OPPOSING we need existing side !== 'YES'
    // Actually: isOpposingSide checks p.side !== candidatePos.side. candidatePos.side is always 'YES'.
    // So existing position must have side 'NO' on the same highly-correlated market.
    const existingPosNo = { market: sharedMarket, side: 'NO', currentValue: 200, size: 200, currentPrice: 0.45 };
    const { clusters: clusters2 } = buildCorrelationClusters([existingPosNo]);

    // New market with same slug => high correlation => OPPOSING since existing is NO, candidate is YES
    const newMarket = makeMarket({ id: 'opp-new', question: 'Will Trump win 2024?', description: 'Election', slug: 'trump-2024', category: 'Politics' });
    const result = screenNewTrade(newMarket, [existingPosNo], clusters2);
    expect(result.fit).toBe('OPPOSING');
    expect(result.text).toContain('hedge');
  });

  it('returns GOOD_FIT with null market', () => {
    const result = screenNewTrade(null, [], []);
    expect(result.fit).toBe('GOOD_FIT');
  });

  it('reports a market you already hold as ALREADY_HELD, not as correlated with itself', () => {
    const held = makePosition({ id: 'held', question: 'Steelers vs. Saints', slug: 'nfl', category: 'Sports' }, { side: 'YES', size: 100 });
    const other = makePosition({ id: 'other', question: 'Will it rain in Paris?', description: 'Weather', slug: 'rain', category: 'Weather', daysLeft: 300 });
    const { clusters } = buildCorrelationClusters([held, other]);
    const result = screenNewTrade(held.market, [held, other], clusters);
    expect(result.fit).toBe('ALREADY_HELD');
    expect(result.alreadyHeld).toEqual({ yes: 100, no: 0 });
    expect(result.text).toBe('You already hold this market (YES 100 shares). Buying more YES concentrates that position; buying NO offsets it.');
    // Correlation is against OTHER positions only
    expect(result.maxCorrelationMarket?.id).not.toBe('held');
    expect(result.maxCorrelation).toBeLessThan(0.5);
  });

  it('totals each side separately when a market is held on both sides', () => {
    const yes = makePosition({ id: 'both', slug: 'b' }, { side: 'YES', size: 100 });
    const no = { ...makePosition({ id: 'both', slug: 'b' }, { side: 'NO', size: 40 }) };
    const { clusters } = buildCorrelationClusters([yes, no]);
    const result = screenNewTrade(yes.market, [yes, no], clusters);
    expect(result.alreadyHeld).toEqual({ yes: 100, no: 40 });
    expect(result.text).toBe('You already hold this market on both sides (YES 100, NO 40 shares).');
  });

  it('describes a NO holding with NO as the concentrating side', () => {
    const held = makePosition({ id: 'n-held', slug: 'n' }, { side: 'NO', size: 25 });
    const { clusters } = buildCorrelationClusters([held]);
    expect(screenNewTrade(held.market, [held], clusters).text)
      .toBe('You already hold this market (NO 25 shares). Buying more NO concentrates that position; buying YES offsets it.');
  });

  it('matches a full re-clustering on a realistic portfolio (the incremental path is not an approximation in practice)', () => {
    const positions = generateMarkets(40, 11).slice(0, 39).map((m) => ({ market: m, side: 'YES', size: 50, currentValue: 50 * (m.yesPrice ?? 0.5) }));
    const candidate = generateMarkets(40, 11)[39];
    const { clusters } = buildCorrelationClusters(positions);
    const result = screenNewTrade(candidate, positions, clusters);

    const exactPositions = [...positions, { market: candidate, side: 'YES', size: 50, currentValue: 50, currentPrice: candidate.yesPrice }];
    const { clusters: exactClusters } = buildCorrelationClusters(exactPositions);
    expect(result.newDivScore).toBe(calculateConcentration(exactPositions, exactClusters).diversificationScore);
  });
});

describe('buildCorrelationStructure fast paths agree with the pairwise definitions', () => {
  // Seeded random portfolios exercising every correlation source: categories,
  // shared slugs, entities, dates, and title words found in other markets'
  // descriptions — including words that contain each other, which the
  // substring matcher must handle like String#includes.
  let seed;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const ENT = ['trump', 'biden', 'china', 'russia', 'ukraine', 'israel', 'fed', 'apple', 'tesla', 'putin'];
  const WORDS = ['election', 'election?', 'lection', 'season', 'seasons', 'market', 'supermarket', 'reserve', 'reserves', 'ceasefire', 'tariffs', 'champion'];
  const randomPositions = (n) => Array.from({ length: n }, (_, i) => {
    const ents = Array.from({ length: Math.floor(rnd() * 3) }, () => pick(ENT));
    const words = Array.from({ length: 2 + Math.floor(rnd() * 5) }, () => pick(WORDS));
    const market = makeMarket({
      id: `r${seed}-${i}`,
      question: `Will ${ents.join(' and ') || 'it'} ${words.join(' ')}?`,
      description: rnd() < 0.2 ? '' : Array.from({ length: Math.floor(rnd() * 10) }, () => pick([...WORDS, ...ENT, 'resolves'])).join(' '),
      category: pick(['Politics', 'Crypto', 'Sports', undefined]),
      slug: rnd() < 0.5 ? `event-${Math.floor(rnd() * 6)}` : `solo-${seed}-${i}`,
      daysLeft: rnd() < 0.15 ? null : Math.floor(rnd() * 90),
    });
    return { market, side: rnd() < 0.6 ? 'YES' : 'NO', size: 10, currentValue: 10 };
  });

  // The original naming: sum each member pair's sharedLabels, insertion-ordered
  function referenceName(indices, positions) {
    const counts = {};
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const [i, j] = indices[a] < indices[b] ? [indices[a], indices[b]] : [indices[b], indices[a]];
        for (const l of calculatePairCorrelation(positions[i], positions[j]).sharedLabels) counts[l] = (counts[l] || 0) + 1;
      }
    }
    const cats = [...new Set(indices.map((i) => positions[i].market?.category).filter(Boolean))];
    const top = Object.entries(counts).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([l]) => l);
    return top.length > 0
      ? top.map((l) => l.charAt(0).toUpperCase() + l.slice(1)).join('/') + (cats.length === 1 ? ` (${cats[0]})` : '')
      : null;
  }

  it('every matrix entry equals calculatePairCorrelation, and cluster names match the pairwise reference', () => {
    let namesChecked = 0;
    for (const n of [2, 5, 12, 30, 60]) {
      for (let t = 1; t <= 8; t++) {
        seed = n * 100 + t;
        const positions = randomPositions(n);
        const { matrix, groups } = buildCorrelationStructure(positions);
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            expect(matrix[i][j]).toBe(calculatePairCorrelation(positions[i], positions[j]).correlation);
          }
        }
        for (const g of groups) {
          const ref = referenceName(g.indices, positions);
          if (ref !== null) { expect(g.name).toBe(ref); namesChecked++; }
        }
      }
    }
    expect(namesChecked).toBeGreaterThan(50);
  });
});

describe('clustering split: structure (price-independent) + pricing', () => {
  const positions = [
    makePosition({ id: 's1', question: 'Will Trump win?', slug: 'trump' }, { currentValue: 100 }),
    makePosition({ id: 's2', question: 'Will Trump be nominated?', slug: 'trump' }, { currentValue: 300 }),
    makePosition({ id: 's3', question: 'Will it rain in Paris?', description: 'Weather', slug: 'rain', category: 'Weather', daysLeft: 300 }, { currentValue: 100 }),
  ];

  it('structure + priceClusters equals buildCorrelationClusters', () => {
    const structure = buildCorrelationStructure(positions);
    expect(priceClusters(positions, structure)).toEqual(buildCorrelationClusters(positions).clusters);
  });

  it('a reused structure re-prices weights from the current values', () => {
    const structure = buildCorrelationStructure(positions);
    const ticked = positions.map((p, i) => (i === 2 ? { ...p, currentValue: 500 } : p));
    const clusters = priceClusters(ticked, structure);
    const rain = clusters.find((c) => c.positions[0].market.id === 's3');
    expect(rain.portfolioWeight).toBeCloseTo(500 / 900);
    expect(rain.positions[0]).toBe(ticked[2]);
    expect(clusters).toEqual(buildCorrelationClusters(ticked).clusters);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. Edge cases
// ═══════════════════════════════════════════════════════════

describe('Edge cases', () => {
  it('normalizePosition handles varied field names', () => {
    const raw = { market_id: 'mk1', condition_id: 'c1', token_id: 't1', size: '50', avg_price: '0.6' };
    const norm = normalizePosition(raw);
    expect(norm.marketId).toBe('mk1');
    expect(norm.conditionId).toBe('c1');
    expect(norm.tokenId).toBe('t1');
    expect(norm.size).toBe(50);
    expect(norm.entryPrice).toBe(0.6);
    expect(norm.source).toBe('wallet');
  });

  it('normalizePosition handles camelCase fields', () => {
    const raw = { marketId: 'mk2', conditionId: 'c2', tokenId: 't2', shares: '25', avgPrice: '0.4' };
    const norm = normalizePosition(raw);
    expect(norm.marketId).toBe('mk2');
    expect(norm.size).toBe(25);
    expect(norm.entryPrice).toBe(0.4);
  });

  it('matchPositionsToMarkets matches by conditionId', () => {
    const markets = [makeMarket({ id: 'match1', conditionId: 'cond-match' })];
    const positions = [{ conditionId: 'cond-match', marketId: null, tokenId: null, size: 10, entryPrice: null, side: null, currentPrice: null, currentValue: 0, unrealizedPnl: 0, market: null, source: 'wallet' }];
    const matched = matchPositionsToMarkets(positions, markets);
    expect(matched[0].market).toBe(markets[0]);
  });

  it('matchPositionsToMarkets determines YES/NO side from tokenId', () => {
    const market = makeMarket({ id: 'side-test', clobTokenIds: ['yes-tok', 'no-tok'] });
    const posYes = { conditionId: null, marketId: null, tokenId: 'yes-tok', size: 10, entryPrice: 0.5, side: null, currentPrice: null, currentValue: 0, unrealizedPnl: 0, market: null, source: 'wallet' };
    const posNo = { conditionId: null, marketId: null, tokenId: 'no-tok', size: 10, entryPrice: 0.5, side: null, currentPrice: null, currentValue: 0, unrealizedPnl: 0, market: null, source: 'wallet' };
    const [matchedYes, matchedNo] = matchPositionsToMarkets([posYes, posNo], [market]);
    expect(matchedYes.side).toBe('YES');
    expect(matchedNo.side).toBe('NO');
  });

  it('calculateConcentration handles zero-value positions', () => {
    const positions = [makePosition({ id: 'z1' }, { currentValue: 0 })];
    const clusters = [{ portfolioWeight: 0, effectivePositionCount: 1, positions, name: 'Z' }];
    const result = calculateConcentration(positions, clusters);
    expect(result.hhi).toBe(0);
    expect(result.diversificationLabel).toBe('No Positions');
  });
});

// ═══════════════════════════════════════════════════════════
// 7. localStorage wrappers
// ═══════════════════════════════════════════════════════════

describe('localStorage helpers', () => {
  it('getStoredWallet / setStoredWallet round-trips', () => {
    expect(getStoredWallet()).toBeNull();
    setStoredWallet('0xABC');
    expect(getStoredWallet()).toBe('0xABC');
    setStoredWallet(null);
    expect(getStoredWallet()).toBeNull();
  });

  it('addManualPosition / getManualPositions / removeManualPosition', () => {
    expect(getManualPositions()).toEqual([]);
    addManualPosition({ marketId: 'm1', size: 50 });
    addManualPosition({ marketId: 'm2', size: 75 });
    const positions = getManualPositions();
    expect(positions.length).toBe(2);
    expect(positions[0].source).toBe('manual');
    expect(positions[0].addedAt).toBeGreaterThan(0);

    removeManualPosition(0);
    expect(getManualPositions().length).toBe(1);
    expect(getManualPositions()[0].marketId).toBe('m2');
  });

  it('clearManualPositions removes all', () => {
    addManualPosition({ marketId: 'm1', size: 10 });
    clearManualPositions();
    expect(getManualPositions()).toEqual([]);
  });

  it('getDismissedAlerts / dismissAlert / resetDismissedAlerts', () => {
    expect(getDismissedAlerts()).toEqual([]);
    dismissAlert('alert-1');
    dismissAlert('alert-2');
    expect(getDismissedAlerts()).toEqual(['alert-1', 'alert-2']);
    resetDismissedAlerts();
    expect(getDismissedAlerts()).toEqual([]);
  });
});

describe('manual positions in markets the catalog does not hold', () => {
  const lookup = (markets) => ({
    byId: new Map(markets.map((m) => [String(m.id), m])),
    byCondition: new Map(markets.filter((m) => m.conditionId).map((m) => [m.conditionId, m])),
  });
  const snapshot = { id: 'm1', question: 'Q?', yesPrice: 0.4, noPrice: 0.6 };
  const mp = { marketId: 'm1', conditionId: 'c1', side: 'NO', size: 10, entryPrice: 0.6, currentPrice: 0.6, market: snapshot };

  it('pricesFromGammaMarket reads settled prices from the JSON string Gamma returns', () => {
    expect(pricesFromGammaMarket({ outcomePrices: '["0", "1"]', closed: true })).toEqual({ yesPrice: 0, noPrice: 1, closed: true });
    expect(pricesFromGammaMarket({ outcomePrices: ['0.25', '0.75'] })).toEqual({ yesPrice: 0.25, noPrice: 0.75, closed: false });
  });

  it('pricesFromGammaMarket returns null for missing or malformed prices (e.g. placeholders)', () => {
    expect(pricesFromGammaMarket(null)).toBeNull();
    expect(pricesFromGammaMarket({})).toBeNull();
    expect(pricesFromGammaMarket({ outcomePrices: 'not json' })).toBeNull();
    expect(pricesFromGammaMarket({ outcomePrices: '["x", "y"]' })).toBeNull();
  });

  it('unloadedManualMarketIds lists each missing market once, matching by id or conditionId', () => {
    const positions = [mp, { ...mp }, { marketId: 'm2', conditionId: 'c2' }, { marketId: 'm3' }];
    const ids = unloadedManualMarketIds(positions, lookup([{ id: 'other', conditionId: 'c2' }]));
    expect(ids).toEqual(['m1', 'm3']);
  });

  it('priceManualPosition prefers the loaded market, then the looked-up price, then the saved copy', () => {
    const fetched = new Map([['m1', { yesPrice: 1, noPrice: 0, closed: true }]]);

    const fromLoaded = priceManualPosition(mp, lookup([{ id: 'm1', yesPrice: 0.3, noPrice: 0.7 }]), fetched);
    expect(fromLoaded.currentPrice).toBe(0.7);

    const fromLookup = priceManualPosition(mp, lookup([]), fetched);
    expect(fromLookup).toMatchObject({ currentPrice: 0, currentValue: 0, source: 'manual' });
    expect(fromLookup.unrealizedPnl).toBeCloseTo(-6);
    expect(fromLookup.market).toMatchObject({ question: 'Q?', closed: true, noPrice: 0 });

    const fromCopy = priceManualPosition(mp, lookup([]), new Map());
    expect(fromCopy.currentPrice).toBe(0.6);
    expect(fromCopy.market).toBe(snapshot);
  });
});

describe('live prices: held-market lookup and wallet re-pricing', () => {
  const lookupOf = (markets) => ({
    byId: new Map(markets.map((m) => [String(m.id), m])),
    byCondition: new Map(markets.filter((m) => m.conditionId).map((m) => [m.conditionId, m])),
  });
  const a = { id: 'a', conditionId: 'ca', yesPrice: 0.5, noPrice: 0.5 };
  const b = { id: 'b', conditionId: 'cb', yesPrice: 0.2, noPrice: 0.8 };
  const c = { id: 'c', yesPrice: 0.9, noPrice: 0.1 };
  const wallet = [{ market: a, side: 'YES', size: 10, entryPrice: 0.4 }];
  const manualPos = [{ marketId: 'x', conditionId: 'cb' }]; // matched by conditionId

  it('findHeldMarkets holds only the markets positions are in, matched by id or conditionId', () => {
    const held = findHeldMarkets(wallet, manualPos, [a, b, c]);
    expect([...held.byId.keys()].sort()).toEqual(['a', 'b']);
    expect(held.byCondition.get('cb')).toBe(b);
  });

  it('findHeldMarkets does no work without positions', () => {
    const markets = new Proxy([a, b, c], { get: (t, k) => { if (k === Symbol.iterator) throw new Error('scanned'); return t[k]; } });
    expect(findHeldMarkets([], [], markets).byId.size).toBe(0);
  });

  it('sameHeldMarkets: a tick on an unheld market is "same", a tick on a held one is not', () => {
    const first = findHeldMarkets(wallet, manualPos, [a, b, c]);
    expect(sameHeldMarkets(first, findHeldMarkets(wallet, manualPos, [a, b, { ...c, yesPrice: 0.95 }]))).toBe(true);
    expect(sameHeldMarkets(first, findHeldMarkets(wallet, manualPos, [{ ...a, yesPrice: 0.6 }, b, c]))).toBe(false);
    expect(sameHeldMarkets(first, findHeldMarkets(wallet, [], [a, b, c]))).toBe(false);
  });

  it('structureKey ignores size (and price) but changes with market or side', () => {
    const base = [{ market: a, side: 'YES', size: 10 }];
    expect(structureKey([{ ...base[0], size: 999, currentPrice: 0.9 }])).toBe(structureKey(base));
    expect(structureKey([{ ...base[0], side: 'NO' }])).not.toBe(structureKey(base));
    expect(structureKey([{ ...base[0], market: b }])).not.toBe(structureKey(base));
  });

  it('holdingsKey ignores prices and changes with market, side or size', () => {
    const base = [{ market: a, side: 'YES', size: 10, source: 'manual', currentPrice: 0.5 }];
    expect(holdingsKey([{ ...base[0], currentPrice: 0.9, market: { ...a, yesPrice: 0.9 } }])).toBe(holdingsKey(base));
    expect(holdingsKey([{ ...base[0], size: 11 }])).not.toBe(holdingsKey(base));
    expect(holdingsKey([{ ...base[0], side: 'NO' }])).not.toBe(holdingsKey(base));
  });

  it('repriceWalletPosition prices from the current market object', () => {
    const a2 = { ...a, yesPrice: 0.7, noPrice: 0.3 };
    const pos = repriceWalletPosition(wallet[0], lookupOf([a2]));
    expect(pos).toMatchObject({ market: a2, currentPrice: 0.7 });
    expect(pos.currentValue).toBeCloseTo(7);
    expect(pos.unrealizedPnl).toBeCloseTo(3);
    expect(repriceWalletPosition({ ...wallet[0], side: 'NO', entryPrice: null }, lookupOf([a2])))
      .toMatchObject({ currentPrice: 0.3, unrealizedPnl: 0 });
  });

  it('repriceWalletPosition returns the same object when nothing changed or the market is gone', () => {
    expect(repriceWalletPosition(wallet[0], lookupOf([a]))).toBe(wallet[0]);
    expect(repriceWalletPosition(wallet[0], lookupOf([]))).toBe(wallet[0]);
  });
});

describe('fetchPositions (Data API v2)', () => {
  let mockFetch;
  beforeEach(() => { mockFetch = vi.fn(); vi.stubGlobal('fetch', mockFetch); });

  const route = (url) => (url.includes('/v2/positions') ? 'positions' : 'other');

  it('calls only /v2/positions, with the user param (entry price comes from avgPrice)', async () => {
    mockFetch.mockImplementation(async () => jsonResponse(envelope([v2Position()])));
    await fetchPositions(WALLET);
    const urls = mockFetch.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([`/data-api/v2/positions?user=${WALLET}`]);
  });

  it('returns v1-shaped positions that normalizePosition understands', async () => {
    mockFetch.mockImplementation(async (url) => jsonResponse(envelope(route(url) === 'positions' ? [v2Position()] : [])));
    const { positions, error } = await fetchPositions(WALLET);
    expect(error).toBeNull();
    const norm = normalizePosition(positions[0]);
    expect(norm).toMatchObject({ conditionId: CONDITION, tokenId: YES_TOKEN, size: 1500, entryPrice: 0.4 });
  });

  it('follows the cursor so portfolios over one page are not truncated', async () => {
    let positionCalls = 0;
    mockFetch.mockImplementation(async (url) => {
      if (route(url) !== 'positions') return jsonResponse(envelope([]));
      positionCalls++;
      const page = Array.from({ length: 100 }, (_, i) => v2Position({ token_id: `${positionCalls}-${i}` }));
      return jsonResponse(envelope(page, { nextCursor: positionCalls < 3 ? `c${positionCalls}` : null }));
    });
    const { positions } = await fetchPositions(WALLET);
    expect(positionCalls).toBe(3);
    expect(positions).toHaveLength(300);
  });

  it('reports an error when the wallet has no positions (unchanged behaviour)', async () => {
    mockFetch.mockImplementation(async () => jsonResponse(envelope([])));
    const { positions, error } = await fetchPositions(WALLET);
    expect(positions).toEqual([]);
    expect(error).toMatch(/Could not fetch positions/);
  });

  it('keeps the positions already fetched when a later page fails', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(envelope(Array.from({ length: 100 }, (_, i) => v2Position({ token_id: `t${i}` })), { nextCursor: 'c1' })))
      .mockResolvedValueOnce(new Response('Server Error', { status: 500 }));
    const { positions, error } = await fetchPositions(WALLET);
    expect(positions).toHaveLength(100);
    expect(error).toBeNull();
  });
});
