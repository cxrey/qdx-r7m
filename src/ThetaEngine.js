// Theta Decay Engine — models how time alone affects binary market prices
// Analogous to options theta: No bets appreciate passively as the clock ticks

/**
 * Infer the daily hazard rate from market-implied probability and days remaining.
 * h = 1 - (1 - p)^(1/d)
 */
export function inferHazardRate(yesPrice, daysRemaining) {
  if (yesPrice == null || daysRemaining == null) return null;
  if (daysRemaining < 0.5) return null;
  if (yesPrice > 0.95 || yesPrice < 0.02) return null;

  const p = Math.max(0.001, Math.min(0.999, yesPrice));
  const h = 1 - Math.pow(1 - p, 1 / daysRemaining);
  return Math.max(0.0001, Math.min(0.5, h));
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
  if (yesPrice == null || daysRemaining == null || daysRemaining < 0.5) return null;
  if (yesPrice > 0.95 || yesPrice < 0.02) return null;

  let dailyYesTheta, dailyNoTheta, impliedHazardRate;

  if (marketStructure === 'TOUCH_CUMULATIVE') {
    // Touch markets: time helps Yes (more time = more chances to trigger)
    // Model as inverse of standard: yesTheta is POSITIVE
    const h = inferHazardRate(yesPrice, daysRemaining);
    if (h == null) return null;

    const pToday = 1 - Math.pow(1 - h, daysRemaining);
    const pTomorrow = 1 - Math.pow(1 - h, daysRemaining - 1);
    // For touch, we flip: more time gone = more chances used, so p_tomorrow < p_today in standard
    // But the VALUE of the position increases as time passes without trigger... actually for touch:
    // Each day that passes without the touch happening, the remaining time shrinks,
    // BUT touch markets have already "banked" all prior days as chances.
    // Net: yesTheta = -(pTomorrow - pToday) = positive (time favors Yes having more tries)
    dailyYesTheta = -(pTomorrow - pToday); // positive
    dailyNoTheta = -dailyYesTheta; // negative
    impliedHazardRate = h;
  } else if (marketStructure === 'CUMULATIVE') {
    // Each passing day INCREASES yes probability
    const q = 1 - Math.pow(yesPrice, 1 / daysRemaining);
    const pTomorrow = Math.pow(1 - q, daysRemaining - 1);
    dailyYesTheta = pTomorrow - yesPrice;
    dailyNoTheta = -dailyYesTheta;
    impliedHazardRate = q; // daily disruption probability
  } else {
    // STANDARD: yes decays over time
    let h = inferHazardRate(yesPrice, daysRemaining);
    if (h == null) return null;

    // Daily close correction: continuous hazard overestimates for daily-check markets
    if (measurementFrequency === 'DAILY_CLOSE') {
      h = h * 0.85;
    }

    const pToday = 1 - Math.pow(1 - h, daysRemaining);
    const pTomorrow = 1 - Math.pow(1 - h, daysRemaining - 1);
    dailyYesTheta = pTomorrow - pToday; // negative for standard
    dailyNoTheta = -dailyYesTheta;
    impliedHazardRate = h;
  }

  // Theta acceleration: compare theta today vs theta 7 days from now
  let thetaAcceleration = 0;
  const futureDays = daysRemaining - 7;
  if (futureDays >= 1 && Math.abs(dailyYesTheta) > 0.00001) {
    let futureTheta;
    if (marketStructure === 'CUMULATIVE') {
      const q = 1 - Math.pow(yesPrice, 1 / daysRemaining);
      const pFuture = Math.pow(1 - q, futureDays);
      const pFutureMinus1 = Math.pow(1 - q, futureDays - 1);
      futureTheta = pFutureMinus1 - pFuture;
    } else if (marketStructure === 'TOUCH_CUMULATIVE') {
      const h = impliedHazardRate;
      const pFuture = 1 - Math.pow(1 - h, futureDays);
      const pFutureMinus1 = 1 - Math.pow(1 - h, futureDays - 1);
      futureTheta = -(pFutureMinus1 - pFuture);
    } else {
      const h = impliedHazardRate;
      const pFuture = 1 - Math.pow(1 - h, futureDays);
      const pFutureMinus1 = 1 - Math.pow(1 - h, futureDays - 1);
      futureTheta = pFutureMinus1 - pFuture;
    }
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
    projectionDays = [7, 14, 21, 28].filter((d) => d < daysRemaining);
  }

  const points = [];

  if (marketStructure === 'CUMULATIVE') {
    const q = 1 - Math.pow(yesPrice, 1 / daysRemaining);

    for (const k of projectionDays) {
      const dFuture = daysRemaining - k;
      if (dFuture <= 0) continue;

      const projectedYes = Math.pow(1 - q, dFuture);
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

      let projectedYes;
      if (marketStructure === 'TOUCH_CUMULATIVE') {
        // Touch: cumulative probability of triggering rises as time left increases
        // With fewer days left, fewer chances → projected p is lower going forward
        // But from NOW's perspective looking forward, p_future = 1 - (1-h)^dFuture
        projectedYes = 1 - Math.pow(1 - h, dFuture);
      } else {
        projectedYes = 1 - Math.pow(1 - h, dFuture);
      }
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

  // THETA CRUSH ZONE: 25-75¢ and < 7 days
  if (yesPrice >= 0.25 && yesPrice <= 0.75 && daysRemaining < 7) {
    zones.push('THETA_CRUSH_ZONE');
  }

  // DEAD MONEY: 35-65¢ and > 120 days
  if (yesPrice >= 0.35 && yesPrice <= 0.65 && daysRemaining > 120) {
    zones.push('DEAD_MONEY');
  }

  // THETA ACCELERATION: acceleration > 50%
  if (theta && theta.thetaAcceleration > 0.5) {
    zones.push('THETA_ACCELERATION');
  }

  // THETA EXHAUSTED: near extreme with lots of time left
  if ((yesPrice < 0.05 || yesPrice > 0.95) && daysRemaining > 14) {
    zones.push('THETA_EXHAUSTED');
  }

  return zones;
}

/**
 * Full theta analysis for a market — called from processMarket.
 * Returns everything needed for table display (no price history needed).
 */
export function analyzeTheta(market) {
  const { yesPrice, noPrice, daysLeft, question, description, resolutionAnalysis } = market;

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

  // Best theta: the positive side
  let bestTheta, bestSide;
  if (structure.type === 'CUMULATIVE' || structure.type === 'TOUCH_CUMULATIVE') {
    bestTheta = theta.dailyYesTheta;
    bestSide = 'YES';
  } else {
    bestTheta = theta.dailyNoTheta;
    bestSide = 'NO';
  }

  return {
    ...theta,
    structureType: structure.type,
    structureConfidence: structure.confidence,
    bestTheta,
    bestSide,
    zones,
  };
}
