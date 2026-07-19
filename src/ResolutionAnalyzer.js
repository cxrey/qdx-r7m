// Resolution Rule Analyzer — parses market resolution rules and flags structural mispricing

// ─── Keyword Constants ───

const DATA_DRIVEN_SOURCES = [
  /\bIMF\b/, /\bPortWatch\b/, /Bureau of Labor Statistics/i, /\bBLS\b/,
  /CoinGecko/i, /CoinMarketCap/i, /Bloomberg/i, /Reuters/i,
  /official statistics/i, /Federal Reserve/i, /\bFRED\b/, /TradingView/i,
  /closing price/i, /settlement price/i, /official data/i, /\bAPI\b/,
  /https?:\/\/\S+/,
  /trading at/i, /\breaches\b/i, /closes above/i, /closes below/i, /spot price/i,
];

const DATA_DRIVEN_PATTERNS = [
  /resolves?\s+(based on|according to|using|via|per|from)\s+/i,
];

const CONSENSUS_PATTERNS_HIGH = [/credible/i, /consensus of/i];
const CONSENSUS_PATTERNS_MED = [
  /reported by/i, /confirmed by/i, /major news outlets/i,
  /generally accepted/i, /widely reported/i, /multiple sources confirm/i,
  /acknowledged by/i, /official announcement/i, /publicly confirmed/i,
  /credible reporting/i, /credible sources/i,
];

const MULTI_CONDITION_STRONG = [
  /all of the following/i, /\bboth\b/i, /each of/i, /must also/i,
  /in addition to/i, /as well as/i, /simultaneously/i,
];

const EXCLUSIONARY_PATTERNS = [
  /will NOT resolve/i, /does not count/i, /does not qualify/i,
  /does not include/i, /\bexcludes\b/i, /\bexcluded\b/i,
  /not considered/i, /not sufficient/i, /\binformal\b/i,
  /\bunofficial\b/i, /\btemporary\b/i, /\bpartial\b/i,
  /would not/i, /is not defined as/i, /is not considered/i,
];

const CONTINUOUS_PATTERNS = [
  /consecutive/i, /\bcontinuous\b/i, /uninterrupted/i, /\bsustained\b/i,
  /for a period of/i, /for at least \d+\s*days?/i, /must continue/i,
  /must remain/i, /throughout the/i, /at no point during/i,
  /\d+[\s-]*day\b/i, /\d+[\s-]*week/i,
];

const CONTINUOUS_DURATION_RE = /(\d+)[\s-]*(day|week|hour|month)s?/i;

const TOUCH_PATTERNS = [
  /at any point/i, /at any time/i, /at least once/i, /ever reaches/i,
  /\btouches\b/i, /\bhits\b/i, /\bbreaches\b/i,
  /crosses above/i, /crosses below/i, /\bintraday\b/i,
];

const QUALIFYING_PATTERNS = [
  /\bmust\b/i, /\brequired\b/i, /only if/i, /provided that/i,
  /condition/i, /criteria/i, /qualify/i,
];

// ─── Helpers ───

function splitSentences(text) {
  if (!text) return [];
  return text
    .split(/(?<=\.)\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function countAndMatches(text) {
  // Count " and " appearing in resolution-style clauses
  const matches = text.match(/\band\b/gi);
  return matches ? matches.length : 0;
}

function detectEnumeratedList(text) {
  const numbered = text.match(/(?:^|\n)\s*\d+\.\s/gm);
  const lettered = text.match(/(?:^|\n)\s*[a-d]\)\s/gm);
  return (numbered?.length || 0) + (lettered?.length || 0);
}

// ─── Main Functions ───

export function classifyResolution(market) {
  const parts = [
    market.description || '',
    market.resolutionSource || '',
    market.rules || '',
    market.resolution || '',
  ];
  const ruleText = parts.filter(Boolean).join('\n\n');

  if (!ruleText.trim()) {
    return {
      characteristics: [],
      annotatedRules: [],
      rawRules: '',
    };
  }

  const characteristics = [];

  // ── DATA_DRIVEN ──
  const sourceMatches = DATA_DRIVEN_SOURCES.filter((p) => p.test(ruleText)).length;
  const patternMatches = DATA_DRIVEN_PATTERNS.filter((p) => p.test(ruleText)).length;
  const dataTotal = sourceMatches + patternMatches;
  if (dataTotal >= 2) {
    characteristics.push({ type: 'DATA_DRIVEN', confidence: 'HIGH', detail: `${dataTotal} data source indicators` });
  } else if (dataTotal === 1) {
    characteristics.push({ type: 'DATA_DRIVEN', confidence: 'MEDIUM', detail: '1 data source indicator' });
  }

  // ── CONSENSUS_BASED ──
  const consensusHigh = CONSENSUS_PATTERNS_HIGH.some((p) => p.test(ruleText));
  const consensusMed = CONSENSUS_PATTERNS_MED.some((p) => p.test(ruleText));
  if (consensusHigh) {
    characteristics.push({ type: 'CONSENSUS_BASED', confidence: 'HIGH', detail: 'Resolves on credible reporting' });
  } else if (consensusMed) {
    characteristics.push({ type: 'CONSENSUS_BASED', confidence: 'MEDIUM', detail: 'Resolution depends on reported sources' });
  }

  // ── MULTI_CONDITION ──
  const strongMulti = MULTI_CONDITION_STRONG.some((p) => p.test(ruleText));
  const andCount = countAndMatches(ruleText);
  const enumCount = detectEnumeratedList(ruleText);
  const conditionCount = Math.max(enumCount, strongMulti ? 3 : andCount >= 3 ? andCount : 0);
  if (conditionCount >= 3 || strongMulti) {
    characteristics.push({
      type: 'MULTI_CONDITION', confidence: 'HIGH',
      conditionCount: Math.max(conditionCount, 3),
      detail: `${Math.max(conditionCount, 3)} conditions required`,
    });
  } else if (conditionCount === 2 || andCount >= 2) {
    characteristics.push({
      type: 'MULTI_CONDITION', confidence: 'MEDIUM',
      conditionCount: 2,
      detail: '2 conditions required',
    });
  }

  // ── EXCLUSIONARY ──
  const sentences = splitSentences(ruleText);
  const exclusions = [];
  for (const s of sentences) {
    if (EXCLUSIONARY_PATTERNS.some((p) => p.test(s))) {
      exclusions.push(s);
    }
  }
  if (exclusions.length >= 2) {
    characteristics.push({
      type: 'EXCLUSIONARY', confidence: 'HIGH',
      exclusions, detail: `${exclusions.length} exclusionary clauses`,
    });
  } else if (exclusions.length === 1) {
    characteristics.push({
      type: 'EXCLUSIONARY', confidence: 'MEDIUM',
      exclusions, detail: '1 exclusionary clause',
    });
  }

  // ── CONTINUOUS ──
  const hasContinuous = CONTINUOUS_PATTERNS.some((p) => p.test(ruleText));
  if (hasContinuous) {
    const durationMatch = ruleText.match(CONTINUOUS_DURATION_RE);
    const duration = durationMatch
      ? { value: parseInt(durationMatch[1]), unit: durationMatch[2].toLowerCase() }
      : null;
    characteristics.push({
      type: 'CONTINUOUS',
      confidence: duration ? 'HIGH' : 'MEDIUM',
      duration,
      detail: duration ? `${duration.value}-${duration.unit} continuous period required` : 'Continuous period required',
    });
  }

  // ── TOUCH ──
  const hasTouch = TOUCH_PATTERNS.some((p) => p.test(ruleText));
  if (hasTouch) {
    const specific = TOUCH_PATTERNS.filter((p) => p.test(ruleText)).length;
    characteristics.push({
      type: 'TOUCH',
      confidence: specific >= 2 ? 'HIGH' : 'MEDIUM',
      detail: 'Touch/threshold — only needs one qualifying moment',
    });
  }

  const annotatedRules = buildAnnotatedRules(ruleText);

  return {
    characteristics,
    annotatedRules,
    rawRules: ruleText,
  };
}

export function buildAnnotatedRules(ruleText) {
  if (!ruleText) return [];
  const sentences = splitSentences(ruleText);
  return sentences.map((text) => {
    if (EXCLUSIONARY_PATTERNS.some((p) => p.test(text))) {
      return { text, type: 'exclusionary', highlightType: 'EXCLUSIONARY' };
    }
    if (CONTINUOUS_PATTERNS.some((p) => p.test(text))) {
      return { text, type: 'continuous', highlightType: 'CONTINUOUS' };
    }
    if (TOUCH_PATTERNS.some((p) => p.test(text))) {
      return { text, type: 'touch', highlightType: 'TOUCH' };
    }
    if (QUALIFYING_PATTERNS.some((p) => p.test(text))) {
      return { text, type: 'qualifying', highlightType: 'QUALIFYING' };
    }
    return { text, type: 'neutral' };
  });
}

export function calculateStrictnessScore(characteristics, yesPrice) {
  let penaltyMultiplier = 1.0;
  const penaltyBreakdown = [];

  for (const c of characteristics) {
    if (c.type === 'MULTI_CONDITION') {
      const count = c.conditionCount || 2;
      const m = 1 + 0.15 * count;
      penaltyMultiplier *= m;
      penaltyBreakdown.push({ factor: `${count} conditions required`, multiplier: m, icon: '🔗' });
    }
    if (c.type === 'EXCLUSIONARY') {
      const count = c.exclusions?.length || 1;
      const m = 1 + 0.12 * count;
      penaltyMultiplier *= m;
      penaltyBreakdown.push({ factor: `${count} exclusionary clause${count > 1 ? 's' : ''}`, multiplier: m, icon: '🚫' });
    }
    if (c.type === 'CONTINUOUS') {
      let m;
      if (c.duration) {
        let days = c.duration.value;
        if (c.duration.unit === 'week') days *= 7;
        if (c.duration.unit === 'month') days *= 30;
        m = 1 + days * 0.02;
        penaltyBreakdown.push({ factor: `${c.duration.value}-${c.duration.unit} continuous period`, multiplier: m, icon: '⏱' });
      } else {
        m = 1.20;
        penaltyBreakdown.push({ factor: 'Continuous period (unknown duration)', multiplier: m, icon: '⏱' });
      }
      penaltyMultiplier *= m;
    }
    if (c.type === 'CONSENSUS_BASED') {
      const m = 1.10;
      penaltyMultiplier *= m;
      penaltyBreakdown.push({ factor: 'Consensus-based resolution', multiplier: m, icon: '📰' });
    }
    if (c.type === 'TOUCH') {
      const m = 0.75;
      penaltyMultiplier *= m;
      penaltyBreakdown.push({ factor: 'Touch market (easier for Yes)', multiplier: m, icon: '👆' });
    }
    if (c.type === 'DATA_DRIVEN') {
      const m = 0.95;
      penaltyMultiplier *= m;
      penaltyBreakdown.push({ factor: 'Data-driven resolution', multiplier: m, icon: '📊' });
    }
  }

  // Cap multiplier at 2.0 to keep scores meaningful when many penalties cascade
  penaltyMultiplier = Math.min(penaltyMultiplier, 2.0);
  const rawScore = 50 * penaltyMultiplier;
  const score = Math.min(Math.round(rawScore), 100);

  let label;
  if (score >= 80) label = 'Very Strict';
  else if (score >= 65) label = 'Strict';
  else if (score >= 45) label = 'Moderate';
  else if (score >= 30) label = 'Lenient';
  else label = 'Very Lenient';

  let mispricingFlag = 'NEUTRAL';
  let mispricingEstimate = 0;
  if (score > 70 && yesPrice != null && yesPrice > 0.30) {
    mispricingFlag = 'YES_LIKELY_OVERPRICED';
    mispricingEstimate = (score - 50) * 0.001;
  } else if (score < 35 && yesPrice != null && yesPrice < 0.20) {
    mispricingFlag = 'YES_LIKELY_UNDERPRICED';
  }

  return {
    score,
    label,
    mispricingFlag,
    mispricingEstimate,
    penaltyBreakdown,
  };
}

// ─── Temporal Precision Constants ───

const WINDOW_FIXED_DEADLINE = [
  /by\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}/i,
  /before\s+(end of|the end of)?\s*(Q[1-4]|year|month)/i,
  /by\s+\d{1,2}\/\d{1,2}\/\d{2,4}/i,
  /by\s+(the\s+)?end\s+of/i,
  /deadline/i,
];

const WINDOW_ROLLING = [
  /(\d+)[\s-]*(consecutive|continuous|uninterrupted)\s*(day|week|hour|month)s?/i,
  /(\d+)[\s-]*day\s+period/i,
  /rolling\s+\d+/i,
];

const WINDOW_CHECKPOINT = [
  /at\s+(end of|close of|market close|the close)/i,
  /on\s+the\s+(first|last|1st|15th|\d+th)/i,
  /at\s+market\s+close\s+on/i,
  /end of (each|every) (trading )?day/i,
];

const WINDOW_INSTANTANEOUS = [
  /at any point/i, /at any time/i, /at any time during/i,
  /ever reaches/i, /\btouches\b/i, /\bhits\b/i,
  /\bbreaches\b/i, /crosses (above|below)/i,
];

const WINDOW_DURATION_AT_LEVEL = [
  /(closes?|remains?|stays?)\s+(above|below|at)\s+.*for\s+(\d+)\s+(day|week)/i,
];

const FREQ_CONTINUOUS = [/at any time/i, /at any point during/i, /24\/7/i, /real[\s-]*time/i, /at any moment/i];
const FREQ_DAILY = [/closing price/i, /end of day/i, /\bdaily\b/i, /at the close/i, /daily close/i];
const FREQ_WEEKLY = [/\bweekly\b/i, /end of week/i, /friday close/i];
const FREQ_SINGLE = [/on\s+\w+\s+\d{1,2}/i, /at resolution/i, /at expiry/i];
const FREQ_EVENT = [/upon announcement/i, /when declared/i, /following confirmation/i, /once confirmed/i];

const TZ_RE = /\b(ET|EST|EDT|CT|CST|CDT|MT|MST|MDT|PT|PST|PDT|UTC|GMT)\b/;
const TIME_RE = /(\d{1,2}:\d{2}\s*(AM|PM)?\s*(ET|EST|EDT|UTC|PT|PST|GMT)?)/i;
const DATE_RE = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s*\d{4}/i;
const DATE_NUMERIC_RE = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/;

const MONTH_MAP = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

function parseDateFromText(text) {
  const m = text.match(DATE_RE);
  if (m) {
    const parts = m[0].replace(',', '').split(/\s+/);
    const month = MONTH_MAP[parts[0].toLowerCase()];
    const day = parseInt(parts[1]);
    const year = parseInt(parts[2]);
    if (month != null && day && year) return new Date(year, month, day);
  }
  const n = text.match(DATE_NUMERIC_RE);
  if (n) {
    let year = parseInt(n[3]);
    if (year < 100) year += 2000;
    return new Date(year, parseInt(n[1]) - 1, parseInt(n[2]));
  }
  return null;
}

/**
 * Analyze the temporal structure of market resolution rules.
 */
export function analyzeTemporalStructure(market) {
  const title = market.question || market.title || '';
  const desc = market.description || '';
  const rules = market.rules || market.resolutionSource || '';
  const ruleText = `${title}\n${desc}\n${rules}`;
  const endDate = market.endDate ? new Date(market.endDate) : (market.end_date ? new Date(market.end_date) : null);
  const createdAt = market.createdAt ? new Date(market.createdAt) : (market.created_at ? new Date(market.created_at) : null);
  const now = new Date();
  const daysRemaining = endDate ? Math.max(0, (endDate - now) / (1000 * 60 * 60 * 24)) : null;
  const yesPrice = market.yesPrice != null ? market.yesPrice : null;

  // A. Window Classification
  let windowType = 'FIXED_DEADLINE';
  let windowLength = null;
  let deadlineDate = null;

  const rollingMatch = ruleText.match(/(\d+)[\s-]*(consecutive|continuous|uninterrupted)\s*(day|week|hour|month)s?/i);
  const durationAtLevelMatch = ruleText.match(/(closes?|remains?|stays?)\s+(above|below|at)\s+.*for\s+(\d+)\s+(day|week)/i);

  if (WINDOW_INSTANTANEOUS.some((p) => p.test(ruleText))) {
    windowType = 'INSTANTANEOUS';
  } else if (durationAtLevelMatch) {
    windowType = 'DURATION_AT_LEVEL';
    windowLength = { value: parseInt(durationAtLevelMatch[3]), unit: durationAtLevelMatch[4].toLowerCase() };
  } else if (rollingMatch) {
    windowType = 'ROLLING_WINDOW';
    windowLength = { value: parseInt(rollingMatch[1]), unit: rollingMatch[3].toLowerCase() };
  } else if (WINDOW_CHECKPOINT.some((p) => p.test(ruleText))) {
    windowType = 'CHECKPOINT';
  } else {
    // Default: FIXED_DEADLINE
    deadlineDate = parseDateFromText(ruleText) || endDate;
  }

  // B. Measurement Frequency
  let frequency = 'EVENT_TRIGGERED';
  let frequencyDetail = null;

  if (FREQ_CONTINUOUS.some((p) => p.test(ruleText))) {
    frequency = 'CONTINUOUS_MONITORING';
    frequencyDetail = 'Checked continuously';
  } else if (FREQ_DAILY.some((p) => p.test(ruleText))) {
    frequency = 'DAILY_CLOSE';
    const timeMatch = ruleText.match(TIME_RE);
    frequencyDetail = timeMatch ? `Checked at ${timeMatch[1]}` : 'Checked at daily close';
  } else if (FREQ_WEEKLY.some((p) => p.test(ruleText))) {
    frequency = 'WEEKLY';
    frequencyDetail = 'Checked weekly';
  } else if (FREQ_SINGLE.some((p) => p.test(ruleText))) {
    frequency = 'SINGLE_CHECK';
    frequencyDetail = 'Checked once at resolution';
  } else if (FREQ_EVENT.some((p) => p.test(ruleText))) {
    frequency = 'EVENT_TRIGGERED';
    frequencyDetail = 'Triggers on discrete event';
  }

  // C. Timezone and Boundary Extraction
  const tzMatch = ruleText.match(TZ_RE);
  const timezone = tzMatch ? tzMatch[1] : null;
  const timeMatch = ruleText.match(TIME_RE);
  const boundaryTime = timeMatch ? timeMatch[1].trim() : null;

  // Extract start/end boundaries
  const startMatch = ruleText.match(/beginning\s+(on|at|from)\s+([^,.]+)/i);
  const endMatch = ruleText.match(/ending\s+(on|at)\s+([^,.]+)/i);
  const startBoundary = startMatch ? startMatch[2].trim() : (createdAt ? 'Market creation' : null);
  const endBoundary = endMatch ? endMatch[2].trim() : (endDate ? endDate.toLocaleDateString() : null);

  let boundaryAmbiguity = 'MEDIUM';
  if (timezone && boundaryTime && endDate) {
    boundaryAmbiguity = 'LOW';
  } else if (!timezone && !boundaryTime) {
    boundaryAmbiguity = 'HIGH';
  }
  // Vague language check
  if (/mid[\s-]?(april|march|may|june|july|august|september|october|november|december|january|february)/i.test(ruleText)) {
    boundaryAmbiguity = 'HIGH';
  }

  // D. Temporal Probability Metrics
  const effectiveTimeWindow = windowType === 'ROLLING_WINDOW' && windowLength
    ? windowLength.value * (windowLength.unit === 'week' ? 7 : windowLength.unit === 'month' ? 30 : 1)
    : daysRemaining;

  let impliedDailyRate = null;
  let dailySurvivalRate = null;
  if (yesPrice != null && daysRemaining != null && daysRemaining > 0) {
    if (windowType === 'ROLLING_WINDOW' && windowLength) {
      const wDays = windowLength.value * (windowLength.unit === 'week' ? 7 : windowLength.unit === 'month' ? 30 : 1);
      dailySurvivalRate = Math.pow(yesPrice, 1 / wDays);
      impliedDailyRate = 1 - dailySurvivalRate;
    } else {
      impliedDailyRate = daysRemaining > 0 ? 1 - Math.pow(1 - yesPrice, 1 / daysRemaining) : null;
    }
  }

  const probabilityPerDay = (yesPrice != null && daysRemaining > 0)
    ? yesPrice / daysRemaining
    : null;

  const timeNormalizedPrice = (yesPrice != null && daysRemaining > 0)
    ? yesPrice / Math.sqrt(daysRemaining)
    : null;

  // Temporal Edge flags
  const temporalEdges = [];
  if (windowType === 'ROLLING_WINDOW' && yesPrice > 0.30 && windowLength && effectiveTimeWindow > 10) {
    temporalEdges.push({
      type: 'ROLLING_OVERPRICED',
      color: '#f59e0b',
      icon: '⚠️',
      text: 'Rolling windows are harder than traders think — each day is an independent failure point. Yes may be overpriced.',
    });
  }
  if (windowType === 'INSTANTANEOUS' && yesPrice < 0.15 && daysRemaining > 30) {
    temporalEdges.push({
      type: 'TOUCH_UNDERPRICED',
      color: '#00d4aa',
      icon: '🎯',
      text: 'Touch markets with long time windows are often underpriced — lots of chances to trigger.',
    });
  }
  if (frequency === 'DAILY_CLOSE' && yesPrice > 0.20 && yesPrice < 0.80) {
    temporalEdges.push({
      type: 'DAILY_CLOSE_GAP',
      color: '#60a5fa',
      icon: '📅',
      text: 'Daily close measurement ignores intraday spikes — may underprice the probability vs continuous monitoring.',
    });
  }
  if (boundaryAmbiguity === 'HIGH') {
    temporalEdges.push({
      type: 'BOUNDARY_AMBIGUITY',
      color: '#9ca3af',
      icon: '❓',
      text: 'Resolution boundary is ambiguous — this creates risk for both sides. Edge goes to whoever reads the rules.',
    });
  }

  // Lifecycle progress
  let lifecycleProgress = null;
  if (createdAt && endDate && endDate > createdAt) {
    const totalSpan = endDate - createdAt;
    const elapsed = now - createdAt;
    lifecycleProgress = {
      elapsedPct: Math.max(0, Math.min(100, (elapsed / totalSpan) * 100)),
      remainingPct: Math.max(0, Math.min(100, ((endDate - now) / totalSpan) * 100)),
      createdDate: createdAt.toLocaleDateString(),
      endDateStr: endDate.toLocaleDateString(),
    };
  }

  return {
    windowType,
    windowLength,
    deadlineDate,
    measurement: { frequency, detail: frequencyDetail },
    timezone: { timezone, boundaryTime, startBoundary, endBoundary, boundaryAmbiguity },
    metrics: {
      effectiveTimeWindow,
      impliedDailyRate,
      dailySurvivalRate,
      probabilityPerDay,
      timeNormalizedPrice,
      daysRemaining,
    },
    temporalEdges,
    lifecycleProgress,
  };
}

/**
 * Full resolution analysis for a market — called from processMarket.
 */
export function analyzeResolution(market) {
  const result = classifyResolution(market);

  if (!result.rawRules && result.characteristics.length === 0) {
    return null;
  }

  const characteristics = result.characteristics;

  // Run temporal analysis and feed into strictness
  const temporal = analyzeTemporalStructure(market);

  const strictness = calculateStrictnessScoreWithTemporal(characteristics, market.yesPrice, temporal);

  // Extract continuous duration for cross-system use
  const continuousChar = characteristics.find((c) => c.type === 'CONTINUOUS');
  const isContinuous = !!continuousChar;
  const continuousDuration = continuousChar?.duration || null;

  // Extract condition count for FLB amplifier
  const multiChar = characteristics.find((c) => c.type === 'MULTI_CONDITION');
  const conditionCount = multiChar?.conditionCount || 0;

  return {
    ...result,
    strictness,
    temporal,
    isContinuous,
    continuousDuration,
    conditionCount,
  };
}

/**
 * Strictness score with temporal penalty adjustments.
 */
function calculateStrictnessScoreWithTemporal(characteristics, yesPrice, temporal) {
  // Get base strictness calculation
  const base = calculateStrictnessScore(characteristics, yesPrice);

  if (!temporal) return base;

  // Apply temporal adjustments to the penalty multiplier
  let temporalMultiplier = 1.0;
  const temporalBreakdown = [];

  // Rolling window penalty
  if (temporal.windowType === 'ROLLING_WINDOW' && temporal.windowLength) {
    let wDays = temporal.windowLength.value;
    if (temporal.windowLength.unit === 'week') wDays *= 7;
    if (temporal.windowLength.unit === 'month') wDays *= 30;
    if (wDays > 7) {
      const m = 1 + wDays * 0.015;
      temporalMultiplier *= m;
      temporalBreakdown.push({ factor: `${temporal.windowLength.value}-${temporal.windowLength.unit} rolling window`, multiplier: m, icon: '🔄' });
    }
  }

  // Instantaneous discount
  if (temporal.windowType === 'INSTANTANEOUS') {
    const m = 0.80;
    temporalMultiplier *= m;
    temporalBreakdown.push({ factor: 'Touch/instantaneous (easier for Yes)', multiplier: m, icon: '⚡' });
  }

  // Boundary ambiguity
  if (temporal.timezone?.boundaryAmbiguity === 'HIGH') {
    const m = 1.08;
    temporalMultiplier *= m;
    temporalBreakdown.push({ factor: 'Ambiguous resolution boundary', multiplier: m, icon: '❓' });
  }

  // Continuous monitoring + must persist
  const hasContinuous = characteristics.some((c) => c.type === 'CONTINUOUS');
  if (temporal.measurement?.frequency === 'CONTINUOUS_MONITORING' && hasContinuous) {
    const m = 1.12;
    temporalMultiplier *= m;
    temporalBreakdown.push({ factor: '24/7 monitoring + persistence required', multiplier: m, icon: '👁' });
  }

  // Apply temporal multiplier to base score
  const adjustedScore = Math.min(100, Math.round(base.score * temporalMultiplier));

  let label;
  if (adjustedScore >= 80) label = 'Very Strict';
  else if (adjustedScore >= 65) label = 'Strict';
  else if (adjustedScore >= 45) label = 'Moderate';
  else if (adjustedScore >= 30) label = 'Lenient';
  else label = 'Very Lenient';

  // Recalculate mispricing with adjusted score
  let mispricingFlag = 'NEUTRAL';
  let mispricingEstimate = 0;
  if (adjustedScore > 70 && yesPrice != null && yesPrice > 0.30) {
    mispricingFlag = 'YES_LIKELY_OVERPRICED';
    mispricingEstimate = (adjustedScore - 50) * 0.001;
  } else if (adjustedScore < 35 && yesPrice != null && yesPrice < 0.20) {
    mispricingFlag = 'YES_LIKELY_UNDERPRICED';
  }

  return {
    score: adjustedScore,
    label,
    mispricingFlag,
    mispricingEstimate,
    penaltyBreakdown: [...base.penaltyBreakdown, ...temporalBreakdown],
  };
}
