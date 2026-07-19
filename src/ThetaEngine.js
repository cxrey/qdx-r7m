// Theta Decay Engine — models how time alone affects binary market prices
// Analogous to options theta: No bets appreciate passively as the clock ticks

import {
  PRICE_VALID_MIN, PRICE_VALID_MAX, PRICE_CLAMP_MIN, PRICE_CLAMP_MAX,
  MIN_DAYS_REMAINING, HAZARD_RATE_MIN, HAZARD_RATE_MAX,
  DAILY_CLOSE_CORRECTION_FACTOR, THETA_ACCELERATION_LOOKAHEAD_DAYS,
  THETA_CRUSH_ZONE, DEAD_MONEY_ZONE, THETA_EXHAUSTED_ZONE, PROJECTION_DAYS,
} from './engineConfig';

/**
 * Infer the daily hazard rate from market-implied probability and days remaining.
 * h = 1 - (1 - p)^(1/d)
 */
export function inferHazardRate(yesPrice, daysRemaining) {
  if (yesPrice == null || daysRemaining == null) return null;
  if (daysRemaining < MIN_DAYS_REMAINING) return null;
  if (yesPrice > PRICE_VALID_MAX || yesPrice < PRICE_VALID_MIN) return null;

  const p = Math.max(PRICE_CLAMP_MIN, Math.min(PRICE_CLAMP_MAX, yesPrice));
  const h = 1 - Math.pow(1 - p, 1 / daysRemaining);
  return Math.max(HAZARD_RATE_MIN, Math.min(HAZARD_RATE_MAX, h));
}

const CUMULATIVE_PATTERNS = [
  /consecutive/i, /continuous/i, /uninterrupted/i, /streak/i,
  /without any/i, /no qualifying/i, /quiet period/i,
  /days? of no/i, /days? without/i, /remain below/i,
  /stay under/i, /stay above/i, /maintain/i,
];

/**
 * Detect whether this is a STANDARD, CUMULATIVE, or TOUCH_CUMULATIVE market.
 */
export function classifyMarketStructure(market) {
  // Check resolution analysis first — more reliable than keyword matching
  if (market.resolutionAnalysis?.isContinuous) {
    return { type: 'CUMULATIVE', confidence: 'HIGH' };
  }

  // Temporal precision: INSTANTANEOUS/touch markets with long horizons → TOUCH_CUMULATIVE
  const temporal = market.resolutionAnalysis?.temporal;
  if (temporal?.windowType === 'INSTANTANEOUS') {
    return { type: 'TOUCH_CUMULATIVE', confidence: 'HIGH' };
  }

  // Rolling window → CUMULATIVE
  if (temporal?.windowType === 'ROLLING_WINDOW') {
    return { type: 'CUMULATIVE', confidence: 'HIGH' };
  }

  const text = `${market.question || ''} ${market.description || ''}`;
  const matches = CUMULATIVE_PATTERNS.filter((p) => p.test(text));

  if (matches.length >= 2) {
    return { type: 'CUMULATIVE', confidence: 'HIGH' };
  }
  if (matches.length === 1) {
    return { type: 'CUMULATIVE', confidence: 'LOW' };
  }
  return { type: 'STANDARD', confidence: 'HIGH' };
}

/**
 * Calculate daily theta — expected price change per day from time decay alone.
 * marketStructure can be 'STANDARD', 'CUMULATIVE', or 'TOUCH_CUMULATIVE'.
 * measurementFrequency is optional — used for daily close correction.
 */
export function calculateTheta(yesPrice, daysRemaining, marketStructure, measurementFrequency) {
  if (yesPrice == null || daysRemaining == null || daysRemaining < MIN_DAYS_REMAINING) return null;
  if (yesPrice > PRICE_VALID_MAX || yesPrice < PRICE_VALID_MIN) return null;

  let dailyYesTheta, dailyNoTheta, impliedHazardRate;

  if (marketStructure === 'TOUCH_CUMULATIVE') {
    // Touch markets: YES = P(event triggers at least once before deadline)
    // = 1 - (1-h)^d. A day passing WITHOUT a touch removes one remaining
    // chance, so P declines — same decay direction as STANDARD. (The market
    // price already conditions on "no touch yet": a touched market resolves.
    // "More time = more chances" is a cross-sectional comparison between
    // markets, not the direction of time decay within one market.)
    const h = inferHazardRate(yesPrice, daysRemaining);
    if (h == null) return null;

    const pToday = 1 - Math.pow(1 - h, daysRemaining);
    const pTomorrow = 1 - Math.pow(1 - h, daysRemaining - 1);
    dailyYesTheta = pTomorrow - pToday; // negative: fewer chances left
    dailyNoTheta = -dailyYesTheta;
    impliedHazardRate = h;
  } else if (marketStructure === 'CUMULATIVE') {
    // Cumulative event model: YES = probability event occurs within remaining days.
    // Model: yesPrice = 1 - (1-q)^d  where q = daily disruption rate.
    // Solve for q: (1-q)^d = 1 - yesPrice  →  q = 1 - (1 - yesPrice)^(1/d)
    const noPrice = 1 - yesPrice;
    const q = 1 - Math.pow(noPrice, 1 / daysRemaining);
    const pToday = 1 - Math.pow(1 - q, daysRemaining);       // = yesPrice
    const pTomorrow = 1 - Math.pow(1 - q, daysRemaining - 1); // YES prob with one fewer day
    dailyYesTheta = pTomorrow - pToday; // negative: fewer days = lower YES prob
    dailyNoTheta = -dailyYesTheta;
    impliedHazardRate = q; // daily disruption probability
  } else {
    // STANDARD: yes decays over time
    let h = inferHazardRate(yesPrice, daysRemaining);
    if (h == null) return null;

    // Daily close correction: continuous hazard overestimates for daily-check markets
    if (measurementFrequency === 'DAILY_CLOSE') {
      h = h * DAILY_CLOSE_CORRECTION_FACTOR;
    }

    const pToday = 1 - Math.pow(1 - h, daysRemaining);
    const pTomorrow = 1 - Math.pow(1 - h, daysRemaining - 1);
    dailyYesTheta = pTomorrow - pToday; // negative for standard
    dailyNoTheta = -dailyYesTheta;
    impliedHazardRate = h;
  }

  // Theta acceleration: compare theta today vs theta 7 days from now.
  // All structures share the same survival-model form, so one formula
  // works with the structure's implied daily rate.
  let thetaAcceleration = 0;
  const futureDays = daysRemaining - THETA_ACCELERATION_LOOKAHEAD_DAYS;
  if (futureDays >= 1 && Math.abs(dailyYesTheta) > 0.00001) {
    const rate = impliedHazardRate;
    const pFuture = 1 - Math.pow(1 - rate, futureDays);
    const pFutureMinus1 = 1 - Math.pow(1 - rate, futureDays - 1);
    const futureTheta = pFutureMinus1 - pFuture;
    thetaAcceleration = (Math.abs(futureTheta) - Math.abs(dailyYesTheta)) / Math.abs(dailyYesTheta);
  }

  return {
    dailyYesTheta,
    dailyNoTheta,
    weeklyYesTheta: dailyYesTheta * 7,
    weeklyNoTheta: dailyNoTheta * 7,
    impliedHazardRate,
    thetaAcceleration,
    marketStructure,
  };
}

/**
 * Project where the price will be at future dates if NO new information arrives.
 */
export function projectDecayCurve(yesPrice, daysRemaining, marketStructure, projectionDays) {
  if (yesPrice == null || daysRemaining == null || daysRemaining < 1) return [];

  if (!projectionDays) {
    projectionDays = PROJECTION_DAYS.filter((d) => d < daysRemaining);
  }

  const points = [];

  if (marketStructure === 'CUMULATIVE') {
    // q = 1 - (1 - yesPrice)^(1/d): daily disruption rate
    const q = 1 - Math.pow(1 - yesPrice, 1 / daysRemaining);

    for (const k of projectionDays) {
      const dFuture = daysRemaining - k;
      if (dFuture <= 0) continue;

      const projectedYes = 1 - Math.pow(1 - q, dFuture);
      const bandWidth = 0.05 * Math.sqrt(k / 7);
      points.push({
        day: k,
        projectedYes,
        projectedNo: 1 - projectedYes,
        upper: Math.min(projectedYes + bandWidth, 0.99),
        lower: Math.max(projectedYes - bandWidth, 0.01),
      });
    }
  } else {
    // STANDARD and TOUCH_CUMULATIVE both use hazard rate model
    const h = inferHazardRate(yesPrice, daysRemaining);
    if (h == null) return [];

    for (const k of projectionDays) {
      const dFuture = daysRemaining - k;
      if (dFuture <= 0) continue;

      // STANDARD and TOUCH_CUMULATIVE share the hazard model:
      // fewer days left → fewer chances → lower projected YES.
      const projectedYes = 1 - Math.pow(1 - h, dFuture);
      const bandWidth = 0.05 * Math.sqrt(k / 7);
      points.push({
        day: k,
        projectedYes,
        projectedNo: 1 - projectedYes,
        upper: Math.min(projectedYes + bandWidth, 0.99),
        lower: Math.max(projectedYes - bandWidth, 0.01),
      });
    }
  }

  return points;
}

/**
 * Generate a dense decay curve for charting (day-by-day).
 */
export function projectDecayCurveDense(yesPrice, daysRemaining, marketStructure, maxDays) {
  if (yesPrice == null || daysRemaining == null || daysRemaining < 1) return [];

  const limit = Math.min(maxDays || 60, Math.floor(daysRemaining));
  const days = [];
  for (let i = 0; i <= limit; i++) days.push(i);

  return projectDecayCurve(yesPrice, daysRemaining, marketStructure, days);
}

/**
 * Separate actual price movement into theta component vs information component.
 */
export function calculateInformationResidual(currentPrice, priceNDaysAgo, expectedDailyTheta, nDays) {
  if (currentPrice == null || priceNDaysAgo == null || expectedDailyTheta == null) return null;

  const actualMove = currentPrice - priceNDaysAgo;
  const thetaMove = expectedDailyTheta * nDays;
  const informationMove = actualMove - thetaMove;

  let momentum = 'NEUTRAL';
  if (Math.abs(informationMove) < 0.01) {
    momentum = 'NEUTRAL';
  } else if (Math.sign(informationMove) === Math.sign(thetaMove)) {
    momentum = 'WITH_THETA';
  } else {
    momentum = 'AGAINST_THETA';
  }

  return {
    actualMove,
    thetaComponent: thetaMove,
    informationComponent: informationMove,
    thetaDominant: Math.abs(thetaMove) > Math.abs(informationMove),
    momentum,
  };
}

/**
 * Detect special theta zone flags for a market.
 */
export function detectThetaZones(yesPrice, daysRemaining, theta) {
  const zones = [];

  if (yesPrice == null || daysRemaining == null) return zones;

  // THETA CRUSH ZONE
  if (yesPrice >= THETA_CRUSH_ZONE.priceLow && yesPrice <= THETA_CRUSH_ZONE.priceHigh && daysRemaining < THETA_CRUSH_ZONE.maxDays) {
    zones.push('THETA_CRUSH_ZONE');
  }

  // DEAD MONEY
  if (yesPrice >= DEAD_MONEY_ZONE.priceLow && yesPrice <= DEAD_MONEY_ZONE.priceHigh && daysRemaining > DEAD_MONEY_ZONE.minDays) {
    zones.push('DEAD_MONEY');
  }

  // THETA ACCELERATION: acceleration > 50%
  if (theta && theta.thetaAcceleration > 0.5) {
    zones.push('THETA_ACCELERATION');
  }

  // THETA EXHAUSTED: near extreme with lots of time left
  if ((yesPrice < THETA_EXHAUSTED_ZONE.priceLow || yesPrice > THETA_EXHAUSTED_ZONE.priceHigh) && daysRemaining > THETA_EXHAUSTED_ZONE.minDays) {
    zones.push('THETA_EXHAUSTED');
  }

  return zones;
}

/**
 * Full theta analysis for a market — called from processMarket.
 * Returns everything needed for table display (no price history needed).
 */
export function analyzeTheta(market) {
  const { yesPrice, daysLeft, question, description, resolutionAnalysis } = market;

  if (daysLeft == null || daysLeft < 0) {
    return null;
  }

  const structure = classifyMarketStructure({
    question: question || '',
    description: description || '',
    resolutionAnalysis,
  });

  // Pass measurement frequency from temporal analysis for daily close correction
  const measurementFrequency = resolutionAnalysis?.temporal?.measurement?.frequency || null;
  const theta = calculateTheta(yesPrice, daysLeft, structure.type, measurementFrequency);

  if (!theta) return null;

  const zones = detectThetaZones(yesPrice, daysLeft, theta);

  // Best theta: the positive side (time decay benefits this side).
  // For every structure — STANDARD, CUMULATIVE, and TOUCH_CUMULATIVE —
  // a day passing without the event lowers the YES probability, so time
  // decay always benefits NO. (Touch markets are no exception: each day
  // without a touch removes a remaining chance.)
  const bestTheta = theta.dailyNoTheta;
  const bestSide = 'NO';

  return {
    ...theta,
    structureType: structure.type,
    structureConfidence: structure.confidence,
    bestTheta,
    bestSide,
    zones,
  };
}
