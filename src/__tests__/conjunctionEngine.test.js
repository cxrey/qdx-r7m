import { describe, it, expect } from 'vitest';
import {
  detectConjunctionType,
  calculateCompoundProbability,
  findRelatedMarkets,
  analyzeConjunction,
  conjunctionEdgeBonus,
} from '../ConjunctionEngine.js';

// ─── 1. detectConjunctionType() ───────────────────────────────────

describe('detectConjunctionType', () => {
  it('returns SIMPLE for a plain market with no conjunction language', () => {
    const market = { description: 'Will BTC hit 100k?', question: 'Bitcoin price' };
    const result = detectConjunctionType(market);
    expect(result.type).toBe('SIMPLE');
    expect(result.conditionCount).toBe(1);
    expect(result.confidence).toBe('HIGH');
  });

  it('detects ALL_OF when "all of the following" is present', () => {
    const market = {
      description: 'Resolves YES if all of the following occur: 1. GDP > 3% 2. Unemployment < 4%',
      question: 'Economy boom?',
    };
    const result = detectConjunctionType(market);
    expect(result.type).toBe('ALL_OF');
    expect(result.conditionCount).toBeGreaterThanOrEqual(2);
  });

  it('detects ALL_OF with "simultaneously" keyword', () => {
    const market = {
      description: 'Both events must occur simultaneously. 1. Event A 2. Event B',
      question: 'Test',
    };
    const result = detectConjunctionType(market);
    expect(result.type).toBe('ALL_OF');
    expect(result.conditionCount).toBeGreaterThanOrEqual(2);
  });

  it('detects ALL_OF with "as well as" keyword', () => {
    const market = {
      description: 'Candidate wins primary as well as the general election.',
      question: 'Test',
    };
    const result = detectConjunctionType(market);
    expect(result.type).toBe('ALL_OF');
    expect(result.conditionCount).toBeGreaterThanOrEqual(2);
  });

  it('detects K_OF_N pattern with explicit numbers', () => {
    const market = {
      description: 'At least 3 of the following 5 conditions must be met: 1. A 2. B 3. C 4. D 5. E',
      question: 'Multi-condition',
    };
    const result = detectConjunctionType(market);
    expect(result.type).toBe('K_OF_N');
    expect(result.requiredCount).toBe(3);
    expect(result.conditionCount).toBe(5);
  });

  it('detects K_OF_N with "or more of" pattern', () => {
    const market = {
      description: '2 or more of the following 4 must happen: 1. A 2. B 3. C 4. D',
      question: 'Test',
    };
    const result = detectConjunctionType(market);
    expect(result.type).toBe('K_OF_N');
    expect(result.requiredCount).toBe(2);
    expect(result.conditionCount).toBe(4);
  });

  it('detects THRESHOLD pattern with consecutive periods', () => {
    const market = {
      description: 'GDP exceeds 3% in 3 consecutive quarters.',
      question: 'GDP streak?',
    };
    const result = detectConjunctionType(market);
    expect(result.type).toBe('THRESHOLD');
    expect(result.requiredCount).toBe(3);
  });

  it('detects SEQUENTIAL with "followed by" language', () => {
    const market = {
      description: 'Company announces layoffs followed by stock drop; and then recovery within 30 days.',
      question: 'Sequential events?',
    };
    const result = detectConjunctionType(market);
    expect(result.type).toBe('SEQUENTIAL');
  });

  it('detects SEQUENTIAL with "first...then" language', () => {
    const market = {
      description: 'First the bill passes the House, then it passes the Senate.',
      question: 'Legislative process',
    };
    const result = detectConjunctionType(market);
    expect(result.type).toBe('SEQUENTIAL');
    expect(result.conditionCount).toBeGreaterThanOrEqual(2);
  });

  it('detects ANY_OF with "any of the following"', () => {
    const market = {
      description: 'Resolves YES if any of the following happen: 1. Rain 2. Snow 3. Sleet',
      question: 'Weather event?',
    };
    const result = detectConjunctionType(market);
    expect(result.type).toBe('ANY_OF');
    expect(result.requiredCount).toBe(1);
    expect(result.conditionCount).toBeGreaterThanOrEqual(2);
  });

  it('detects ANY_OF with "at least one"', () => {
    const market = {
      description: 'At least one of these conditions triggers payout: 1. A happens 2. B happens',
      question: 'Test',
    };
    const result = detectConjunctionType(market);
    expect(result.type).toBe('ANY_OF');
  });

  it('falls back to MULTI_CONDITION from resolutionAnalysis', () => {
    const market = {
      description: 'Complex conditions A or B or C',
      question: 'Fallback test',
      resolutionAnalysis: {
        characteristics: [{ type: 'MULTI_CONDITION' }],
        conditionCount: 3,
      },
    };
    const result = detectConjunctionType(market);
    expect(result.type).toBe('ANY_OF'); // "or" count > "and" count
    expect(result.conditionCount).toBe(3);
  });

  it('handles null/undefined resolutionAnalysis gracefully', () => {
    const market = { description: 'Simple question', question: 'Test' };
    const result = detectConjunctionType(market);
    expect(result.type).toBe('SIMPLE');
  });

  it('handles empty description and question', () => {
    const market = {};
    const result = detectConjunctionType(market);
    expect(result.type).toBe('SIMPLE');
  });

  it('extracts numbered conditions from text', () => {
    const market = {
      description: 'All of the following must happen:\n1. First thing\n2. Second thing\n3. Third thing',
      question: 'Multi-cond',
    };
    const result = detectConjunctionType(market);
    expect(result.type).toBe('ALL_OF');
    expect(result.conditions.length).toBe(3);
    expect(result.confidence).toBe('HIGH');
  });

  it('extracts bullet-point conditions', () => {
    const market = {
      description: 'All of the following:\n- Condition alpha\n- Condition beta',
      question: 'Bullets',
    };
    const result = detectConjunctionType(market);
    expect(result.conditions.length).toBe(2);
  });

  it('K_OF_N prioritized over ALL_OF when both could match', () => {
    const market = {
      description: 'At least 2 of the following 3 must all happen: 1. A 2. B 3. C',
      question: 'Priority test',
    };
    const result = detectConjunctionType(market);
    expect(result.type).toBe('K_OF_N');
  });
});

// ─── 2. calculateCompoundProbability() ────────────────────────────

describe('calculateCompoundProbability', () => {
  it('ALL_OF: product of probabilities when correlation=0', () => {
    const result = calculateCompoundProbability('ALL_OF', [0.8, 0.8], 0);
    expect(result).toBeCloseTo(0.64, 4);
  });

  it('ALL_OF: equals min(probs) when correlation=1', () => {
    const result = calculateCompoundProbability('ALL_OF', [0.8, 0.6], 1);
    expect(result).toBeCloseTo(0.6, 4);
  });

  it('ALL_OF: intermediate with default correlation 0.3', () => {
    const result = calculateCompoundProbability('ALL_OF', [0.8, 0.8], 0.3);
    // pIndependent=0.64, pCorrelated=0.8, adjusted = 0.64 + 0.3*(0.8-0.64) = 0.688
    expect(result).toBeCloseTo(0.688, 3);
  });

  it('SEQUENTIAL: applies time penalty on top of ALL_OF math', () => {
    const allOf = calculateCompoundProbability('ALL_OF', [0.8, 0.8], 0.3);
    const seq = calculateCompoundProbability('SEQUENTIAL', [0.8, 0.8], 0.3);
    expect(seq).toBeLessThan(allOf);
    // penalty = 0.7^(2-1) = 0.7
    expect(seq).toBeCloseTo(allOf * 0.7, 4);
  });

  it('ANY_OF: 1 - product of (1-p) when correlation=0', () => {
    const result = calculateCompoundProbability('ANY_OF', [0.3, 0.3], 0);
    // 1 - 0.7*0.7 = 0.51
    expect(result).toBeCloseTo(0.51, 4);
  });

  it('ANY_OF: equals max(probs) when correlation=1', () => {
    const result = calculateCompoundProbability('ANY_OF', [0.3, 0.5], 1);
    expect(result).toBeCloseTo(0.5, 4);
  });

  it('K_OF_N with equal probs uses binomial', () => {
    // 2 of 3, each p=0.5, correlation=0
    const result = calculateCompoundProbability('K_OF_N', [0.5, 0.5, 0.5], 0, 2);
    // P(X>=2) = C(3,2)*0.5^3 + C(3,3)*0.5^3 = 3*0.125 + 0.125 = 0.5
    expect(result).toBeCloseTo(0.5, 3);
  });

  it('K_OF_N with unequal probs uses Poisson binomial', () => {
    const result = calculateCompoundProbability('K_OF_N', [0.8, 0.3, 0.5], 0, 2);
    // Brute force: P(>=2) with different probs
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
  });

  it('THRESHOLD works same as K_OF_N', () => {
    const kofn = calculateCompoundProbability('K_OF_N', [0.6, 0.6, 0.6], 0.3, 2);
    const threshold = calculateCompoundProbability('THRESHOLD', [0.6, 0.6, 0.6], 0.3, 2);
    expect(threshold).toBeCloseTo(kofn, 6);
  });

  it('SIMPLE returns the first probability', () => {
    const result = calculateCompoundProbability('SIMPLE', [0.75]);
    expect(result).toBe(0.75);
  });

  it('returns 0 for empty array', () => {
    expect(calculateCompoundProbability('ALL_OF', [])).toBe(0);
  });

  it('returns 0 for null input', () => {
    expect(calculateCompoundProbability('ALL_OF', null)).toBe(0);
  });

  it('clamps correlation to [0, 1]', () => {
    const neg = calculateCompoundProbability('ALL_OF', [0.8, 0.8], -5);
    const zero = calculateCompoundProbability('ALL_OF', [0.8, 0.8], 0);
    expect(neg).toBeCloseTo(zero, 6);

    const high = calculateCompoundProbability('ALL_OF', [0.8, 0.8], 10);
    const one = calculateCompoundProbability('ALL_OF', [0.8, 0.8], 1);
    expect(high).toBeCloseTo(one, 6);
  });

  it('result is always clamped to [0, 1]', () => {
    const result = calculateCompoundProbability('ALL_OF', [0.99, 0.99, 0.99], 0.5);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });
});

// ─── 3. findRelatedMarkets() ──────────────────────────────────────

describe('findRelatedMarkets', () => {
  it('returns empty when market has no slug', () => {
    const result = findRelatedMarkets({ id: '1' }, []);
    expect(result.relatedMarkets).toEqual([]);
    expect(result.hasMarketDerivedProbs).toBe(false);
  });

  it('returns empty when no markets share the slug', () => {
    const market = { id: '1', slug: 'event-abc' };
    const allMarkets = [{ id: '2', slug: 'event-xyz' }];
    const result = findRelatedMarkets(market, allMarkets);
    expect(result.relatedMarkets).toEqual([]);
  });

  it('finds related markets with same slug but different id', () => {
    const market = { id: '1', slug: 'election-2024', _conjunction: { conditions: [] } };
    const allMarkets = [
      { id: '1', slug: 'election-2024', question: 'Main market' },
      { id: '2', slug: 'election-2024', question: 'Sub-market A', yesPrice: 0.6 },
      { id: '3', slug: 'other-event', question: 'Unrelated' },
    ];
    const result = findRelatedMarkets(market, allMarkets);
    expect(result.relatedMarkets.length).toBe(1);
    expect(result.relatedMarkets[0].marketId).toBe('2');
  });

  it('matches conditions to related market titles by keyword overlap', () => {
    const market = {
      id: '1',
      slug: 'event-x',
      _conjunction: { conditions: ['Stock price exceeds target level'] },
    };
    const allMarkets = [
      { id: '2', slug: 'event-x', question: 'Will stock price exceed the target?' },
    ];
    const result = findRelatedMarkets(market, allMarkets);
    expect(result.relatedMarkets[0].matchedCondition).toBeTruthy();
    expect(result.hasMarketDerivedProbs).toBe(true);
  });

  it('sets hasMarketDerivedProbs false when match confidence is LOW', () => {
    const market = {
      id: '1',
      slug: 'event-x',
      _conjunction: { conditions: ['Something completely different'] },
    };
    const allMarkets = [
      { id: '2', slug: 'event-x', question: 'Unrelated topic here' },
    ];
    const result = findRelatedMarkets(market, allMarkets);
    expect(result.hasMarketDerivedProbs).toBe(false);
  });
});

// ─── 4. analyzeConjunction() ──────────────────────────────────────

describe('analyzeConjunction', () => {
  it('returns isConjunction=false for simple markets', () => {
    const market = { description: 'Will it rain?', question: 'Rain', yesPrice: 0.5 };
    const result = analyzeConjunction(market);
    expect(result.isConjunction).toBe(false);
    expect(result.type).toBe('SIMPLE');
    expect(result.sensitivityTable).toEqual([]);
    expect(result.compoundProb).toBeNull();
  });

  it('returns full analysis for ALL_OF conjunction', () => {
    const market = {
      description: 'All of the following: 1. GDP growth 2. Low unemployment 3. Low inflation',
      question: 'Economic conditions',
      yesPrice: 0.3,
    };
    const result = analyzeConjunction(market);
    expect(result.isConjunction).toBe(true);
    expect(result.type).toBe('ALL_OF');
    expect(result.conditionCount).toBeGreaterThanOrEqual(2);
    expect(result.compoundProb).toBeGreaterThan(0);
    expect(result.compoundProb).toBeLessThan(1);
    expect(result.gap).toBeDefined();
    expect(result.gapPp).toBeDefined();
    expect(result.sensitivityTable.length).toBeGreaterThan(0);
  });

  it('calculates defaultProbs inversely for ALL_OF from yesPrice', () => {
    const market = {
      description: 'All of the following: 1. A happens 2. B happens',
      question: 'Test',
      yesPrice: 0.49,
    };
    const result = analyzeConjunction(market);
    // defaultProbs should be yesPrice^(1/n) = 0.49^(1/2) ~= 0.7
    expect(result.defaultProbs[0]).toBeCloseTo(Math.sqrt(0.49), 2);
  });

  it('assigns gapLabel FAIR when gap is small', () => {
    const market = {
      description: 'All of the following: 1. A 2. B',
      question: 'Test',
      yesPrice: 0.5,
    };
    const result = analyzeConjunction(market);
    // The gap should be small since defaultProbs are derived to match yesPrice
    expect(['FAIR', 'OVERPRICED', 'UNDERPRICED', 'STRONG_OVERPRICED', 'STRONG_UNDERPRICED']).toContain(result.gapLabel);
  });

  it('computes impliedIndividualProb for ALL_OF type', () => {
    const market = {
      description: 'All of the following: 1. X 2. Y 3. Z',
      question: 'Test',
      yesPrice: 0.27,
    };
    const result = analyzeConjunction(market);
    expect(result.impliedIndividualProb).not.toBeNull();
    expect(result.impliedIndividualProb).toBeGreaterThan(0);
    expect(result.impliedIndividualProb).toBeLessThan(1);
  });

  it('impliedIndividualProb is null for ANY_OF type', () => {
    const market = {
      description: 'Any of the following: 1. Alpha event 2. Beta event 3. Gamma event',
      question: 'Test',
      yesPrice: 0.6,
    };
    const result = analyzeConjunction(market);
    expect(result.impliedIndividualProb).toBeNull();
  });

  it('handles yesPrice=0 without errors', () => {
    const market = {
      description: 'All of the following: 1. Never 2. Gonna 3. Happen',
      question: 'Test',
      yesPrice: 0,
    };
    const result = analyzeConjunction(market);
    expect(result.isConjunction).toBe(true);
    expect(result.defaultProbs.every((p) => p >= 0.05)).toBe(true);
  });
});

// ─── 5. conjunctionEdgeBonus() ────────────────────────────────────

describe('conjunctionEdgeBonus', () => {
  it('returns 0 when conjunction is null', () => {
    expect(conjunctionEdgeBonus(null)).toBe(0);
  });

  it('returns 0 when isConjunction is false', () => {
    expect(conjunctionEdgeBonus({ isConjunction: false })).toBe(0);
  });

  it('returns 12 for ALL_OF with 3+ conditions and gapPp > 10', () => {
    const conj = { isConjunction: true, type: 'ALL_OF', conditionCount: 3, requiredCount: 3, gapPp: 15 };
    expect(conjunctionEdgeBonus(conj)).toBe(12);
  });

  it('returns 6 for ALL_OF with 2 conditions and gapPp > 8', () => {
    const conj = { isConjunction: true, type: 'ALL_OF', conditionCount: 2, requiredCount: 2, gapPp: 9 };
    expect(conjunctionEdgeBonus(conj)).toBe(6);
  });

  it('returns 10 for K_OF_N with requiredCount > n/2 and gapPp > 10', () => {
    const conj = { isConjunction: true, type: 'K_OF_N', conditionCount: 4, requiredCount: 3, gapPp: 12 };
    expect(conjunctionEdgeBonus(conj)).toBe(10);
  });

  it('returns 8 for K_OF_N with requiredCount <= n/2 and gapPp < -5', () => {
    const conj = { isConjunction: true, type: 'K_OF_N', conditionCount: 4, requiredCount: 2, gapPp: -7 };
    expect(conjunctionEdgeBonus(conj)).toBe(8);
  });

  it('returns 10 for ANY_OF with gapPp < -10', () => {
    const conj = { isConjunction: true, type: 'ANY_OF', conditionCount: 3, requiredCount: 1, gapPp: -12 };
    expect(conjunctionEdgeBonus(conj)).toBe(10);
  });

  it('returns 10 for SEQUENTIAL with 3+ conditions and gapPp > 10', () => {
    const conj = { isConjunction: true, type: 'SEQUENTIAL', conditionCount: 3, requiredCount: 3, gapPp: 15 };
    expect(conjunctionEdgeBonus(conj)).toBe(10);
  });

  it('returns 0 when no bonus threshold is met', () => {
    const conj = { isConjunction: true, type: 'ALL_OF', conditionCount: 2, requiredCount: 2, gapPp: 3 };
    expect(conjunctionEdgeBonus(conj)).toBe(0);
  });

  it('returns 0 when gapPp is undefined', () => {
    const conj = { isConjunction: true, type: 'ALL_OF', conditionCount: 3, requiredCount: 3 };
    expect(conjunctionEdgeBonus(conj)).toBe(0);
  });
});
