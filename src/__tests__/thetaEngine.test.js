import { describe, it, expect } from 'vitest';
import {
  inferHazardRate,
  classifyMarketStructure,
  calculateTheta,
  projectDecayCurve,
  detectThetaZones,
  analyzeTheta,
} from '../ThetaEngine';

// ─── Constants (mirrored from engineConfig for clarity) ───────────────
const PRICE_VALID_MIN = 0.02;
const PRICE_VALID_MAX = 0.95;
const MIN_DAYS_REMAINING = 0.5;
const HAZARD_RATE_MIN = 0.0001;
const HAZARD_RATE_MAX = 0.5;
const DAILY_CLOSE_CORRECTION_FACTOR = 0.85;

// ─── inferHazardRate ──────────────────────────────────────────────────

describe('inferHazardRate', () => {
  it('returns correct hazard rate for a mid-price, mid-duration market', () => {
    // h = 1 - (1 - p)^(1/d), p=0.50, d=30
    const h = inferHazardRate(0.50, 30);
    const expected = 1 - Math.pow(0.50, 1 / 30);
    expect(h).toBeCloseTo(expected, 10);
  });

  it('returns correct hazard rate for low price', () => {
    const h = inferHazardRate(0.10, 60);
    const expected = 1 - Math.pow(0.90, 1 / 60);
    expect(h).toBeCloseTo(expected, 10);
  });

  it('returns null when yesPrice is null', () => {
    expect(inferHazardRate(null, 30)).toBeNull();
  });

  it('returns null when daysRemaining is null', () => {
    expect(inferHazardRate(0.50, null)).toBeNull();
  });

  it('returns null when daysRemaining < MIN_DAYS_REMAINING', () => {
    expect(inferHazardRate(0.50, 0.3)).toBeNull();
  });

  it('returns null when yesPrice exceeds PRICE_VALID_MAX', () => {
    expect(inferHazardRate(0.96, 30)).toBeNull();
  });

  it('returns null when yesPrice is below PRICE_VALID_MIN', () => {
    expect(inferHazardRate(0.01, 30)).toBeNull();
  });

  it('clamps result to HAZARD_RATE_MIN for very low-price short-horizon', () => {
    // Very low price + lots of days => tiny hazard rate
    const h = inferHazardRate(PRICE_VALID_MIN, 365);
    expect(h).toBeGreaterThanOrEqual(HAZARD_RATE_MIN);
  });

  it('clamps result to HAZARD_RATE_MAX for high-price short-horizon', () => {
    // High price + very few days => large hazard rate
    const h = inferHazardRate(0.94, 1);
    expect(h).toBeLessThanOrEqual(HAZARD_RATE_MAX);
  });

  it('accepts boundary daysRemaining = 0.5', () => {
    const h = inferHazardRate(0.50, 0.5);
    expect(h).not.toBeNull();
    expect(typeof h).toBe('number');
  });
});

// ─── classifyMarketStructure ──────────────────────────────────────────

describe('classifyMarketStructure', () => {
  it('returns STANDARD for a plain market with no keywords', () => {
    const result = classifyMarketStructure({
      question: 'Will BTC exceed $100k?',
      description: 'Resolves Yes if BTC trades above $100k.',
    });
    expect(result).toEqual({ type: 'STANDARD', confidence: 'HIGH' });
  });

  it('returns CUMULATIVE HIGH when resolutionAnalysis.isContinuous is true', () => {
    const result = classifyMarketStructure({
      question: 'Something',
      description: '',
      resolutionAnalysis: { isContinuous: true },
    });
    expect(result).toEqual({ type: 'CUMULATIVE', confidence: 'HIGH' });
  });

  it('returns TOUCH_CUMULATIVE HIGH for INSTANTANEOUS windowType', () => {
    const result = classifyMarketStructure({
      question: 'Will BTC touch $100k?',
      description: '',
      resolutionAnalysis: { temporal: { windowType: 'INSTANTANEOUS' } },
    });
    expect(result).toEqual({ type: 'TOUCH_CUMULATIVE', confidence: 'HIGH' });
  });

  it('returns CUMULATIVE HIGH for ROLLING_WINDOW windowType', () => {
    const result = classifyMarketStructure({
      question: 'Will it stay above?',
      description: '',
      resolutionAnalysis: { temporal: { windowType: 'ROLLING_WINDOW' } },
    });
    expect(result).toEqual({ type: 'CUMULATIVE', confidence: 'HIGH' });
  });

  it('returns CUMULATIVE HIGH when 2+ keyword patterns match', () => {
    const result = classifyMarketStructure({
      question: 'Will there be 5 consecutive days without any qualifying event?',
      description: '',
    });
    expect(result).toEqual({ type: 'CUMULATIVE', confidence: 'HIGH' });
  });

  it('returns CUMULATIVE LOW when exactly 1 keyword pattern matches', () => {
    const result = classifyMarketStructure({
      question: 'Will it maintain above $50?',
      description: '',
    });
    expect(result).toEqual({ type: 'CUMULATIVE', confidence: 'LOW' });
  });

  it('prioritizes resolutionAnalysis over keyword patterns', () => {
    // Has cumulative keywords but INSTANTANEOUS temporal => TOUCH_CUMULATIVE wins
    const result = classifyMarketStructure({
      question: 'consecutive days without any event',
      description: '',
      resolutionAnalysis: { temporal: { windowType: 'INSTANTANEOUS' } },
    });
    expect(result.type).toBe('TOUCH_CUMULATIVE');
  });
});

// ─── calculateTheta (STANDARD) ───────────────────────────────────────

describe('calculateTheta — STANDARD', () => {
  it('produces negative yesTheta and positive noTheta', () => {
    const result = calculateTheta(0.50, 30, 'STANDARD');
    expect(result.dailyYesTheta).toBeLessThan(0);
    expect(result.dailyNoTheta).toBeGreaterThan(0);
  });

  it('weeklyTheta equals dailyTheta * 7', () => {
    const result = calculateTheta(0.50, 30, 'STANDARD');
    expect(result.weeklyYesTheta).toBeCloseTo(result.dailyYesTheta * 7, 10);
    expect(result.weeklyNoTheta).toBeCloseTo(result.dailyNoTheta * 7, 10);
  });

  it('returns null for out-of-bounds price', () => {
    expect(calculateTheta(0.01, 30, 'STANDARD')).toBeNull();
    expect(calculateTheta(0.96, 30, 'STANDARD')).toBeNull();
  });

  it('returns null for insufficient days remaining', () => {
    expect(calculateTheta(0.50, 0.3, 'STANDARD')).toBeNull();
  });

  it('returns marketStructure in result', () => {
    const result = calculateTheta(0.50, 30, 'STANDARD');
    expect(result.marketStructure).toBe('STANDARD');
  });

  it('theta magnitude increases as expiry nears', () => {
    const far = calculateTheta(0.50, 60, 'STANDARD');
    const near = calculateTheta(0.50, 10, 'STANDARD');
    expect(Math.abs(near.dailyYesTheta)).toBeGreaterThan(Math.abs(far.dailyYesTheta));
  });
});

// ─── calculateTheta — DAILY_CLOSE correction ─────────────────────────

describe('calculateTheta — DAILY_CLOSE correction', () => {
  it('reduces theta magnitude when DAILY_CLOSE is specified', () => {
    const standard = calculateTheta(0.50, 30, 'STANDARD');
    const dailyClose = calculateTheta(0.50, 30, 'STANDARD', 'DAILY_CLOSE');
    // DAILY_CLOSE correction reduces hazard rate => less theta
    expect(Math.abs(dailyClose.dailyYesTheta)).toBeLessThan(Math.abs(standard.dailyYesTheta));
  });

  it('applies correction factor to implied hazard rate', () => {
    const standard = calculateTheta(0.50, 30, 'STANDARD');
    const dailyClose = calculateTheta(0.50, 30, 'STANDARD', 'DAILY_CLOSE');
    expect(dailyClose.impliedHazardRate).toBeCloseTo(
      standard.impliedHazardRate * DAILY_CLOSE_CORRECTION_FACTOR,
      10,
    );
  });
});

// ─── calculateTheta — CUMULATIVE ─────────────────────────────────────

describe('calculateTheta — CUMULATIVE', () => {
  it('produces negative yesTheta (fewer days = lower YES prob)', () => {
    const result = calculateTheta(0.50, 30, 'CUMULATIVE');
    expect(result.dailyYesTheta).toBeLessThan(0);
    expect(result.dailyNoTheta).toBeGreaterThan(0);
  });

  it('impliedHazardRate matches q = 1 - (1-p)^(1/d)', () => {
    const p = 0.40;
    const d = 45;
    const result = calculateTheta(p, d, 'CUMULATIVE');
    const expectedQ = 1 - Math.pow(1 - p, 1 / d);
    expect(result.impliedHazardRate).toBeCloseTo(expectedQ, 10);
  });

  it('yesTheta equals pTomorrow - pToday using corrected formula', () => {
    const p = 0.40;
    const d = 45;
    const q = 1 - Math.pow(1 - p, 1 / d);
    const pToday = 1 - Math.pow(1 - q, d);
    const pTomorrow = 1 - Math.pow(1 - q, d - 1);
    const expectedTheta = pTomorrow - pToday;

    const result = calculateTheta(p, d, 'CUMULATIVE');
    expect(result.dailyYesTheta).toBeCloseTo(expectedTheta, 10);
  });
});

// ─── calculateTheta — TOUCH_CUMULATIVE ───────────────────────────────

describe('calculateTheta — TOUCH_CUMULATIVE', () => {
  it('produces negative yesTheta (each day without a touch removes a chance)', () => {
    // The market price conditions on "no touch yet" — a touched market
    // resolves — so P(touch by deadline) declines as remaining time shrinks.
    const result = calculateTheta(0.50, 30, 'TOUCH_CUMULATIVE');
    expect(result.dailyYesTheta).toBeLessThan(0);
    expect(result.dailyNoTheta).toBeGreaterThan(0);
  });

  it('yesTheta is (pTomorrow - pToday) using hazard model', () => {
    const p = 0.50;
    const d = 30;
    const h = 1 - Math.pow(1 - p, 1 / d);
    const pToday = 1 - Math.pow(1 - h, d);
    const pTomorrow = 1 - Math.pow(1 - h, d - 1);
    const expected = pTomorrow - pToday; // negative

    const result = calculateTheta(p, d, 'TOUCH_CUMULATIVE');
    expect(result.dailyYesTheta).toBeCloseTo(expected, 10);
  });
});

// ─── calculateTheta — theta acceleration ─────────────────────────────

describe('calculateTheta — theta acceleration', () => {
  it('computes positive acceleration when theta grows near expiry', () => {
    // 15 days out, so futureDays = 15 - 7 = 8 (valid)
    const result = calculateTheta(0.50, 15, 'STANDARD');
    expect(result.thetaAcceleration).toBeGreaterThan(0);
  });

  it('acceleration is zero when futureDays < 1', () => {
    // 7 days out => futureDays = 7-7 = 0 => skip
    const result = calculateTheta(0.50, 7, 'STANDARD');
    expect(result.thetaAcceleration).toBe(0);
  });

  it('acceleration formula: (|futureTheta| - |currentTheta|) / |currentTheta|', () => {
    const p = 0.50;
    const d = 30;
    const result = calculateTheta(p, d, 'STANDARD');
    const h = result.impliedHazardRate;

    const futureDays = d - 7;
    const pFuture = 1 - Math.pow(1 - h, futureDays);
    const pFutureMinus1 = 1 - Math.pow(1 - h, futureDays - 1);
    const futureTheta = pFutureMinus1 - pFuture;

    const expectedAccel =
      (Math.abs(futureTheta) - Math.abs(result.dailyYesTheta)) / Math.abs(result.dailyYesTheta);
    expect(result.thetaAcceleration).toBeCloseTo(expectedAccel, 10);
  });
});

// ─── projectDecayCurve ────────────────────────────────────────────────

describe('projectDecayCurve', () => {
  it('returns projection points at default PROJECTION_DAYS', () => {
    const points = projectDecayCurve(0.50, 60, 'STANDARD');
    expect(points.length).toBe(4); // [7, 14, 21, 28] all < 60
    expect(points[0].day).toBe(7);
    expect(points[3].day).toBe(28);
  });

  it('filters out projection days >= daysRemaining', () => {
    const points = projectDecayCurve(0.50, 20, 'STANDARD');
    // Only 7 and 14 are < 20
    expect(points.length).toBe(2);
    expect(points.map((p) => p.day)).toEqual([7, 14]);
  });

  it('projectedYes decays for STANDARD markets', () => {
    const points = projectDecayCurve(0.50, 60, 'STANDARD');
    // Each successive projection should show lower YES price
    for (let i = 1; i < points.length; i++) {
      expect(points[i].projectedYes).toBeLessThan(points[i - 1].projectedYes);
    }
  });

  it('projectedNo = 1 - projectedYes', () => {
    const points = projectDecayCurve(0.50, 60, 'STANDARD');
    for (const pt of points) {
      expect(pt.projectedNo).toBeCloseTo(1 - pt.projectedYes, 10);
    }
  });

  it('CUMULATIVE uses q-based formula for projections', () => {
    const p = 0.40;
    const d = 60;
    const q = 1 - Math.pow(1 - p, 1 / d);
    const points = projectDecayCurve(p, d, 'CUMULATIVE');

    for (const pt of points) {
      const dFuture = d - pt.day;
      const expectedYes = 1 - Math.pow(1 - q, dFuture);
      expect(pt.projectedYes).toBeCloseTo(expectedYes, 10);
    }
  });

  it('band width grows with sqrt(day/7)', () => {
    const points = projectDecayCurve(0.50, 60, 'STANDARD');
    for (const pt of points) {
      const expectedBand = 0.05 * Math.sqrt(pt.day / 7);
      expect(pt.upper).toBeCloseTo(Math.min(pt.projectedYes + expectedBand, 0.99), 10);
      expect(pt.lower).toBeCloseTo(Math.max(pt.projectedYes - expectedBand, 0.01), 10);
    }
  });

  it('returns empty array for null inputs', () => {
    expect(projectDecayCurve(null, 60, 'STANDARD')).toEqual([]);
    expect(projectDecayCurve(0.50, null, 'STANDARD')).toEqual([]);
    expect(projectDecayCurve(0.50, 0, 'STANDARD')).toEqual([]);
  });

  it('accepts custom projection days', () => {
    const points = projectDecayCurve(0.50, 60, 'STANDARD', [3, 10, 30]);
    expect(points.map((p) => p.day)).toEqual([3, 10, 30]);
  });
});

// ─── detectThetaZones ─────────────────────────────────────────────────

describe('detectThetaZones', () => {
  it('detects THETA_CRUSH_ZONE (mid-price, < 7 days)', () => {
    const zones = detectThetaZones(0.50, 5, {});
    expect(zones).toContain('THETA_CRUSH_ZONE');
  });

  it('does not flag THETA_CRUSH_ZONE when price is extreme', () => {
    const zones = detectThetaZones(0.10, 5, {});
    expect(zones).not.toContain('THETA_CRUSH_ZONE');
  });

  it('detects DEAD_MONEY (mid-price, > 120 days)', () => {
    const zones = detectThetaZones(0.50, 150, {});
    expect(zones).toContain('DEAD_MONEY');
  });

  it('does not flag DEAD_MONEY when days < 120', () => {
    const zones = detectThetaZones(0.50, 90, {});
    expect(zones).not.toContain('DEAD_MONEY');
  });

  it('detects THETA_ACCELERATION when acceleration > 0.5', () => {
    const zones = detectThetaZones(0.50, 15, { thetaAcceleration: 0.8 });
    expect(zones).toContain('THETA_ACCELERATION');
  });

  it('does not flag THETA_ACCELERATION when acceleration <= 0.5', () => {
    const zones = detectThetaZones(0.50, 15, { thetaAcceleration: 0.3 });
    expect(zones).not.toContain('THETA_ACCELERATION');
  });

  it('detects THETA_EXHAUSTED for extreme low price with many days', () => {
    const zones = detectThetaZones(0.04, 30, {});
    expect(zones).toContain('THETA_EXHAUSTED');
  });

  it('detects THETA_EXHAUSTED for extreme high price with many days', () => {
    // yesPrice > 0.95 is out of PRICE_VALID_MAX so use boundary: > THETA_EXHAUSTED_ZONE.priceHigh = 0.95
    // Actually the zone check is yesPrice > 0.95, but detectThetaZones has no PRICE_VALID check
    const zones = detectThetaZones(0.96, 30, {});
    expect(zones).toContain('THETA_EXHAUSTED');
  });

  it('can flag multiple zones simultaneously', () => {
    // THETA_CRUSH_ZONE: 0.25-0.75 && < 7 days
    // THETA_ACCELERATION: accel > 0.5
    const zones = detectThetaZones(0.50, 5, { thetaAcceleration: 0.8 });
    expect(zones).toContain('THETA_CRUSH_ZONE');
    expect(zones).toContain('THETA_ACCELERATION');
  });

  it('returns empty array for null inputs', () => {
    expect(detectThetaZones(null, 30, {})).toEqual([]);
    expect(detectThetaZones(0.50, null, {})).toEqual([]);
  });
});

// ─── analyzeTheta (integration) ───────────────────────────────────────

describe('analyzeTheta — integration', () => {
  it('returns full analysis for a STANDARD market', () => {
    const result = analyzeTheta({
      yesPrice: 0.50,
      noPrice: 0.50,
      daysLeft: 30,
      question: 'Will BTC exceed $100k by June?',
      description: 'Resolves Yes if BTC > 100k.',
    });

    expect(result).not.toBeNull();
    expect(result.structureType).toBe('STANDARD');
    expect(result.bestSide).toBe('NO');
    expect(result.bestTheta).toBeGreaterThan(0);
    expect(result.dailyYesTheta).toBeLessThan(0);
    expect(result.dailyNoTheta).toBeGreaterThan(0);
    expect(Array.isArray(result.zones)).toBe(true);
  });

  it('returns TOUCH_CUMULATIVE with bestSide NO for instantaneous markets', () => {
    // Time decay favors NO on touch markets too: each day without a touch
    // removes a remaining chance to trigger.
    const result = analyzeTheta({
      yesPrice: 0.30,
      noPrice: 0.70,
      daysLeft: 60,
      question: 'Will BTC touch $100k?',
      description: '',
      resolutionAnalysis: { temporal: { windowType: 'INSTANTANEOUS' } },
    });

    expect(result.structureType).toBe('TOUCH_CUMULATIVE');
    expect(result.bestSide).toBe('NO');
    expect(result.bestTheta).toBeGreaterThan(0);
    expect(result.dailyYesTheta).toBeLessThan(0);
  });

  it('returns CUMULATIVE with bestSide NO for continuous markets', () => {
    const result = analyzeTheta({
      yesPrice: 0.40,
      noPrice: 0.60,
      daysLeft: 45,
      question: 'Will there be a quiet period?',
      description: '',
      resolutionAnalysis: { isContinuous: true },
    });

    expect(result.structureType).toBe('CUMULATIVE');
    expect(result.bestSide).toBe('NO');
    expect(result.bestTheta).toBeGreaterThan(0);
  });

  it('applies DAILY_CLOSE correction from resolutionAnalysis', () => {
    const withoutCorrection = analyzeTheta({
      yesPrice: 0.50,
      noPrice: 0.50,
      daysLeft: 30,
      question: 'Will X happen?',
      description: '',
    });
    const withCorrection = analyzeTheta({
      yesPrice: 0.50,
      noPrice: 0.50,
      daysLeft: 30,
      question: 'Will X happen?',
      description: '',
      resolutionAnalysis: { temporal: { measurement: { frequency: 'DAILY_CLOSE' } } },
    });

    expect(Math.abs(withCorrection.dailyYesTheta)).toBeLessThan(
      Math.abs(withoutCorrection.dailyYesTheta),
    );
  });

  it('returns null when daysLeft is negative', () => {
    expect(analyzeTheta({ yesPrice: 0.50, noPrice: 0.50, daysLeft: -1 })).toBeNull();
  });

  it('returns null when daysLeft is null', () => {
    expect(analyzeTheta({ yesPrice: 0.50, noPrice: 0.50, daysLeft: null })).toBeNull();
  });

  it('includes zones in the result', () => {
    const result = analyzeTheta({
      yesPrice: 0.50,
      noPrice: 0.50,
      daysLeft: 5,
      question: 'Short-lived market',
      description: '',
    });
    expect(result.zones).toContain('THETA_CRUSH_ZONE');
  });
});
