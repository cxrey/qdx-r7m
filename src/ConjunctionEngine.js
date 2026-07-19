/**
 * Conjunction Probability Detector
 *
 * Detects multi-condition markets, computes compound probabilities,
 * and exposes the gap between intuitive estimates and conjunction math.
 */

// --- Helpers ---

function binomialCoeff(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return Math.round(result);
}

/**
 * Poisson binomial CDF: P(X >= k) for independent Bernoulli trials with different probs.
 * Enumerates all 2^n subsets for n <= 20, normal approximation otherwise.
 */
function poissonBinomialCDF(probs, k) {
  const n = probs.length;

  if (n > 20) {
    // Normal approximation
    const mu = probs.reduce((s, p) => s + p, 0);
    const sigma2 = probs.reduce((s, p) => s + p * (1 - p), 0);
    const sigma = Math.sqrt(sigma2);
    if (sigma === 0) return mu >= k ? 1 : 0;
    const z = (k - 0.5 - mu) / sigma;
    return 1 - normalCDF(z);
  }

  // Brute-force enumerate 2^n subsets
  const total = 1 << n;
  let prob = 0;
  for (let mask = 0; mask < total; mask++) {
    let successes = 0;
    let p = 1;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        successes++;
        p *= probs[i];
      } else {
        p *= 1 - probs[i];
      }
    }
    if (successes >= k) prob += p;
  }
  return prob;
}

function normalCDF(z) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  z = Math.abs(z) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * z);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return 0.5 * (1.0 + sign * y);
}

// --- Conjunction Type Detection ---

const ALL_OF_PATTERNS = [
  /\ball\s+of\s+the\s+following/i,
  /\beach\s+of\s+the\s+following/i,
  /\bboth\s+(?:of\s+)?the\s+following/i,
  /\bmust\s+all\b/i,
  /\bmust\s+also\b/i,
  /\bin\s+addition\s+to\b/i,
  /\bas\s+well\s+as\b/i,
  /\bsimultaneously\b/i,
];

const K_OF_N_PATTERNS = [
  /(?:at\s+least\s+)?(\d+)\s+(?:of|out\s+of)\s+(?:the\s+following\s+)?(\d+)/i,
  /(\d+)\s+or\s+more\s+of\s+(?:the\s+following\s+)?(\d+)/i,
  /(\d+)\s+or\s+more\s+of/i,
];

const ANY_OF_PATTERNS = [
  /\bany\s+of\s+the\s+following/i,
  /\bat\s+least\s+one\b/i,
  /\bany\s+one\s+of/i,
  /\beither\s+.*\bor\b/i,
];

const SEQUENTIAL_PATTERNS = [
  /\bthen\b.*\bwithin\b/i,
  /\bfollowed\s+by\b/i,
  /\bsubsequently\b/i,
  /\bwithin\s+\d+\s+days?\s+of\b/i,
  /\bafter\s+.*\bmust\b/i,
  /\bfirst\b.*\bthen\b/i,
];

const THRESHOLD_PATTERNS = [
  /(?:exceeds?|above|below|at\s+least)\s+[\d.]+%?\s+in\s+(?:at\s+least\s+)?(\d+)\s+of\s+(?:the\s+(?:next\s+)?)?(\d+)/i,
  /(\d+)\s+(?:consecutive|straight)\s+(?:quarters?|months?|weeks?|days?)/i,
];

/**
 * Extract individual conditions from the resolution text.
 */
function extractConditions(text) {
  const conditions = [];

  // Try numbered lists: 1. ... 2. ... 3. ...
  const numbered = text.match(/(?:^|\n)\s*\d+[.)]\s*[^\n]+/gm);
  if (numbered && numbered.length >= 2) {
    return numbered.map((c) => c.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
  }

  // Try lettered lists: a. ... b. ... c. ...
  const lettered = text.match(/(?:^|\n)\s*[a-z][.)]\s*[^\n]+/gm);
  if (lettered && lettered.length >= 2) {
    return lettered.map((c) => c.replace(/^\s*[a-z][.)]\s*/, '').trim()).filter(Boolean);
  }

  // Try bullet points
  const bullets = text.match(/(?:^|\n)\s*[-•*]\s*[^\n]+/gm);
  if (bullets && bullets.length >= 2) {
    return bullets.map((c) => c.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean);
  }

  // Try splitting by " and " or ";"
  const andParts = text.split(/\s+and\s+|;\s*/i).filter((p) => p.trim().length > 10);
  if (andParts.length >= 2 && andParts.length <= 8) {
    return andParts.map((p) => p.trim());
  }

  return conditions;
}

/**
 * Detect the conjunction type from market data and resolution analysis.
 */
export function detectConjunctionType(market) {
  const resolution = market.resolutionAnalysis;
  const text = [
    market.description || '',
    market.question || '',
    resolution?.rawRules || '',
  ].join(' ');

  const hasMultiCondition = resolution?.characteristics?.some(
    (c) => c.type === 'MULTI_CONDITION'
  );
  const existingConditionCount = resolution?.conditionCount || 0;

  // Check K_OF_N first (most specific)
  for (const pattern of K_OF_N_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const k = parseInt(match[1]);
      const n = match[2] ? parseInt(match[2]) : existingConditionCount || k + 2;
      if (k > 0 && n >= k) {
        const conditions = extractConditions(text);
        return {
          type: 'K_OF_N',
          conditionCount: n,
          requiredCount: k,
          conditions,
          confidence: conditions.length >= k ? 'HIGH' : n > 1 ? 'MEDIUM' : 'LOW',
          rawText: text.substring(0, 500),
        };
      }
    }
  }

  // Check THRESHOLD
  for (const pattern of THRESHOLD_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const k = parseInt(match[1]);
      const n = match[2] ? parseInt(match[2]) : k + 1;
      const conditions = extractConditions(text);
      return {
        type: 'THRESHOLD',
        conditionCount: n,
        requiredCount: k,
        conditions,
        confidence: 'MEDIUM',
        rawText: text.substring(0, 500),
      };
    }
  }

  // Check SEQUENTIAL
  for (const pattern of SEQUENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      const conditions = extractConditions(text);
      const count = conditions.length || existingConditionCount || 2;
      return {
        type: 'SEQUENTIAL',
        conditionCount: count,
        requiredCount: count,
        conditions,
        confidence: conditions.length >= 2 ? 'HIGH' : 'MEDIUM',
        rawText: text.substring(0, 500),
      };
    }
  }

  // Check ANY_OF
  for (const pattern of ANY_OF_PATTERNS) {
    if (pattern.test(text)) {
      const conditions = extractConditions(text);
      const count = conditions.length || existingConditionCount || 2;
      if (count >= 2) {
        return {
          type: 'ANY_OF',
          conditionCount: count,
          requiredCount: 1,
          conditions,
          confidence: conditions.length >= 2 ? 'HIGH' : 'MEDIUM',
          rawText: text.substring(0, 500),
        };
      }
    }
  }

  // Check ALL_OF
  for (const pattern of ALL_OF_PATTERNS) {
    if (pattern.test(text)) {
      const conditions = extractConditions(text);
      const count = conditions.length || existingConditionCount || 2;
      return {
        type: 'ALL_OF',
        conditionCount: count,
        requiredCount: count,
        conditions,
        confidence: conditions.length >= 2 ? 'HIGH' : hasMultiCondition ? 'MEDIUM' : 'LOW',
        rawText: text.substring(0, 500),
      };
    }
  }

  // Fall back to Resolution Analyzer's MULTI_CONDITION detection
  if (hasMultiCondition && existingConditionCount >= 2) {
    const conditions = extractConditions(text);
    // Check if conditions are joined by "or" (ANY_OF) vs "and" (ALL_OF)
    const orCount = (text.match(/\bor\b/gi) || []).length;
    const andCount = (text.match(/\band\b/gi) || []).length;
    const type = orCount > andCount ? 'ANY_OF' : 'ALL_OF';

    return {
      type,
      conditionCount: existingConditionCount,
      requiredCount: type === 'ANY_OF' ? 1 : existingConditionCount,
      conditions,
      confidence: conditions.length >= 2 ? 'MEDIUM' : 'LOW',
      rawText: text.substring(0, 500),
    };
  }

  return {
    type: 'SIMPLE',
    conditionCount: 1,
    requiredCount: 1,
    conditions: [],
    confidence: 'HIGH',
    rawText: '',
  };
}

// --- Compound Probability Math ---

/**
 * Calculate compound probability given individual probabilities and correlation.
 */
export function calculateCompoundProbability(type, individualProbs, correlation = 0.3, requiredCount = null) {
  if (!individualProbs || individualProbs.length === 0) return 0;
  const rho = Math.max(0, Math.min(1, correlation));

  if (type === 'ALL_OF' || type === 'SEQUENTIAL') {
    const pIndependent = individualProbs.reduce((product, p) => product * p, 1);
    const pCorrelated = Math.min(...individualProbs);
    let pAdjusted = pIndependent + rho * (pCorrelated - pIndependent);

    if (type === 'SEQUENTIAL') {
      const timeConstraintPenalty = 0.7;
      pAdjusted *= Math.pow(timeConstraintPenalty, individualProbs.length - 1);
    }

    return Math.max(0, Math.min(1, pAdjusted));
  }

  if (type === 'ANY_OF') {
    const pIndependent = 1 - individualProbs.reduce((product, p) => product * (1 - p), 1);
    const pCorrelated = Math.max(...individualProbs);
    const pAdjusted = pIndependent + rho * (pCorrelated - pIndependent);
    return Math.max(0, Math.min(1, pAdjusted));
  }

  if (type === 'K_OF_N' || type === 'THRESHOLD') {
    const n = individualProbs.length;
    const k = requiredCount ?? Math.ceil(n / 2);

    // Check if probs are roughly equal
    const avg = individualProbs.reduce((s, p) => s + p, 0) / n;
    const allClose = individualProbs.every((p) => Math.abs(p - avg) <= 0.02);

    let pIndependent;
    if (allClose) {
      // Standard binomial
      pIndependent = 0;
      for (let i = k; i <= n; i++) {
        pIndependent += binomialCoeff(n, i) * Math.pow(avg, i) * Math.pow(1 - avg, n - i);
      }
    } else {
      pIndependent = poissonBinomialCDF(individualProbs, k);
    }

    // Correlation adjustment
    const pCorrelated = k / n <= 0.5 ? Math.min(...individualProbs) : Math.max(...individualProbs);
    const pAdjusted = pIndependent + rho * (pCorrelated - pIndependent);
    return Math.max(0, Math.min(1, pAdjusted));
  }

  // SIMPLE — just return the first probability
  return individualProbs[0] ?? 0;
}

// --- Related Market Detection ---

/**
 * Find related markets in the same event whose prices can serve as condition probabilities.
 */
export function findRelatedMarkets(market, allMarkets) {
  const result = { relatedMarkets: [], hasMarketDerivedProbs: false };

  // Find markets from the same event
  const eventSlug = market.slug;
  if (!eventSlug) return result;

  const related = allMarkets.filter(
    (m) => m.id !== market.id && m.slug && m.slug === eventSlug
  );

  if (related.length === 0) return result;

  // Try to match related markets to extracted conditions
  const conditions = market._conjunction?.conditions || [];

  for (const rm of related) {
    const title = (rm.question || '').toLowerCase();
    let matchedCondition = null;
    let matchConfidence = 'LOW';

    for (const cond of conditions) {
      const condLower = cond.toLowerCase();
      // Check for significant keyword overlap
      const condWords = condLower.split(/\s+/).filter((w) => w.length > 3);
      const matchCount = condWords.filter((w) => title.includes(w)).length;
      if (matchCount >= 2 || (condWords.length <= 3 && matchCount >= 1)) {
        matchedCondition = cond;
        matchConfidence = matchCount >= 3 ? 'HIGH' : 'MEDIUM';
        break;
      }
    }

    result.relatedMarkets.push({
      marketId: rm.id,
      title: rm.question,
      yesPrice: rm.yesPrice,
      matchedCondition,
      matchConfidence,
    });
  }

  result.hasMarketDerivedProbs = result.relatedMarkets.some(
    (rm) => rm.matchedCondition && rm.matchConfidence !== 'LOW'
  );

  return result;
}

// --- Sensitivity Table ---

function buildSensitivityTable(type, conditionCount, requiredCount, correlation) {
  const testProbs = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80];
  return testProbs.map((p) => {
    const probs = new Array(conditionCount).fill(p);
    const compoundResult = calculateCompoundProbability(type, probs, correlation, requiredCount);
    return { individualProb: p, compoundResult };
  });
}

// --- Main Analysis ---

/**
 * Full conjunction analysis for a market.
 */
export function analyzeConjunction(market) {
  const detection = detectConjunctionType(market);

  if (detection.type === 'SIMPLE') {
    return {
      isConjunction: false,
      type: 'SIMPLE',
      conditionCount: 1,
      requiredCount: 1,
      conditions: [],
      confidence: 'HIGH',
      defaultProbs: [],
      compoundProb: null,
      gap: null,
      gapLabel: null,
      gapPp: null,
      impliedIndividualProb: null,
      sensitivityTable: [],
    };
  }

  const { type, conditionCount, requiredCount, conditions, confidence } = detection;
  const yesPrice = market.yesPrice ?? 0;

  // Default individual probabilities.
  //
  // ILLUSTRATIVE ONLY: these are reverse-engineered FROM the market price
  // (inverting the independence formula), so the compoundProb/gap computed
  // below deviates from the price only by the correlation adjustment and
  // type penalties — i.e. the gap is deterministic per type, an artifact of
  // the model's own assumptions, NOT detected mispricing. It exists to seed
  // the interactive ConjunctionCard, where the user supplies real
  // per-condition estimates. It must never feed edgeScore
  // (see conjunctionEdgeBonus).
  let defaultProbs;
  if (type === 'ALL_OF' || type === 'SEQUENTIAL') {
    // Inverse: what prob per condition makes the product equal the market price?
    const base = yesPrice > 0 ? Math.pow(yesPrice, 1 / conditionCount) : 0.5;
    defaultProbs = new Array(conditionCount).fill(Math.min(0.95, Math.max(0.05, base)));
  } else if (type === 'ANY_OF') {
    // Inverse: what prob per condition makes 1 - (1-p)^n = yesPrice?
    const base = yesPrice < 1 ? 1 - Math.pow(1 - yesPrice, 1 / conditionCount) : 0.5;
    defaultProbs = new Array(conditionCount).fill(Math.min(0.95, Math.max(0.05, base)));
  } else {
    // K_OF_N / THRESHOLD — use a reasonable default
    defaultProbs = new Array(conditionCount).fill(
      Math.min(0.95, Math.max(0.05, yesPrice > 0 ? Math.pow(yesPrice, 1 / requiredCount) : 0.3))
    );
  }

  // Calculate compound probability
  const compoundProb = calculateCompoundProbability(type, defaultProbs, 0.3, requiredCount);

  // Gap
  const gap = yesPrice - compoundProb;
  const gapPp = gap * 100;
  let gapLabel;
  if (Math.abs(gapPp) < 3) gapLabel = 'FAIR';
  else if (gap > 0) gapLabel = gapPp > 10 ? 'STRONG_OVERPRICED' : 'OVERPRICED';
  else gapLabel = gapPp < -10 ? 'STRONG_UNDERPRICED' : 'UNDERPRICED';

  // Implied individual probability for ALL_OF
  let impliedIndividualProb = null;
  if (type === 'ALL_OF' || type === 'SEQUENTIAL') {
    impliedIndividualProb = yesPrice > 0 ? Math.pow(yesPrice, 1 / conditionCount) : 0;
    // Rough correlation adjustment
    if (impliedIndividualProb > 0) {
      impliedIndividualProb = Math.min(0.99, impliedIndividualProb * 0.95);
    }
  }

  const sensitivityTable = buildSensitivityTable(type, conditionCount, requiredCount, 0.3);

  return {
    isConjunction: true,
    type,
    conditionCount,
    requiredCount,
    conditions,
    confidence,
    defaultProbs,
    compoundProb,
    gap,
    gapPp,
    gapLabel,
    impliedIndividualProb,
    sensitivityTable,
  };
}

// --- Edge Score Contribution ---

/**
 * Edge score bonus from conjunction analysis: always 0.
 *
 * The automatic gap is circular — the default per-condition probabilities
 * are inverted from the market price itself, so the "gap" is a deterministic
 * artifact of the correlation adjustment and type penalties (e.g. every
 * SEQUENTIAL market with 3+ extracted conditions showed ~+10pp "overpriced"
 * and collected +10 edge score). There is no non-circular automatic signal
 * available, so conjunction detection is informational only; sizing insight
 * comes from the interactive card where the user supplies real
 * per-condition probabilities.
 *
 * Kept as a function so the edge-score wiring stays in place if a
 * user-supplied-probability signal is ever routed through it.
 */
export function conjunctionEdgeBonus() {
  return 0;
}
