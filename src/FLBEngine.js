import { computeFeePP, computeMakerRebatePP, isFeeFree } from './feeCalculator';

// Calibration curve - additive adjustments based on prediction market literature
const CORRECTION_CURVE = [
  [0.01, -0.008], [0.03, -0.018], [0.05, -0.025], [0.08, -0.028],
  [0.10, -0.027], [0.15, -0.022], [0.20, -0.016], [0.25, -0.010],
  [0.30, -0.005], [0.35, -0.002], [0.40, 0.000], [0.50, 0.000],
  [0.60, 0.000], [0.65, +0.002], [0.70, +0.005], [0.75, +0.010],
  [0.80, +0.016], [0.85, +0.022], [0.90, +0.027], [0.92, +0.028],
  [0.95, +0.025], [0.97, +0.018], [0.99, +0.008],
];

export function getCorrectionPoints() {
  return CORRECTION_CURVE;
}

export function getAdjustedProbability(price, amplifier = 1.0) {
  if (price == null || isNaN(price)) return null;

  // Clamp input
  const p = Math.max(0.001, Math.min(0.999, price));

  let correction;

  // Find surrounding points for interpolation
  if (p <= CORRECTION_CURVE[0][0]) {
    correction = CORRECTION_CURVE[0][1];
  } else if (p >= CORRECTION_CURVE[CORRECTION_CURVE.length - 1][0]) {
    correction = CORRECTION_CURVE[CORRECTION_CURVE.length - 1][1];
  } else {
    correction = 0;
    for (let i = 0; i < CORRECTION_CURVE.length - 1; i++) {
      const [x0, y0] = CORRECTION_CURVE[i];
      const [x1, y1] = CORRECTION_CURVE[i + 1];
      if (p >= x0 && p <= x1) {
        const t = (p - x0) / (x1 - x0);
        correction = y0 + t * (y1 - y0);
        break;
      }
    }
  }

  return Math.max(0.001, Math.min(0.999, p + correction * amplifier));
}

export function analyzeFLB(market) {
  // feeParams: from resolveFeeParams (processMarket); absent → treated as fee-free
  const { yesPrice, noPrice, spread, resolutionAnalysis, feeParams } = market;

  if (yesPrice == null || noPrice == null) {
    return {
      adjustedYesProb: null,
      adjustedNoProb: null,
      yesEdge: 0,
      yesEdgeAfterSpread: 0,
      noEdge: 0,
      noEdgeAfterSpread: 0,
      recommendation: 'NO_EDGE',
      bestEdge: 0,
      bestSide: null,
      isBiasOpportunity: false,
      isModerateEdge: false,
      spreadKillsEdge: false,
      netEdge: 0,
      netEdgeTaker: 0,
      netEdgeMaker: 0,
      takerFeePP: 0,
      makerRebatePP: 0,
      feeFree: true,
    };
  }

  // Amplify FLB correction for multi-condition markets
  let amplifier = 1.0;
  const multiChar = resolutionAnalysis?.characteristics?.find((c) => c.type === 'MULTI_CONDITION');
  if (multiChar && multiChar.conditionCount >= 2) {
    amplifier = 1.0 + (multiChar.conditionCount - 1) * 0.3;
  }

  const adjustedYesProb = getAdjustedProbability(yesPrice, amplifier);
  const adjustedNoProb = getAdjustedProbability(noPrice, amplifier);

  // Edge = adjusted probability - market price
  // Positive edge means market is underpricing this outcome
  const yesEdge = adjustedYesProb - yesPrice;
  const noEdge = adjustedNoProb - noPrice;

  const halfSpread = (spread != null ? spread : 0) / 2;

  const yesEdgeAfterSpread = yesEdge - halfSpread;
  const noEdgeAfterSpread = noEdge - halfSpread;

  // Determine best side
  let bestSide = null;
  let bestEdge = 0;
  let bestEdgeAfterSpread = 0;

  if (yesEdgeAfterSpread > noEdgeAfterSpread) {
    bestSide = 'YES';
    bestEdge = yesEdge;
    bestEdgeAfterSpread = yesEdgeAfterSpread;
  } else if (noEdgeAfterSpread > yesEdgeAfterSpread) {
    bestSide = 'NO';
    bestEdge = noEdge;
    bestEdgeAfterSpread = noEdgeAfterSpread;
  }

  const isBiasOpportunity = bestEdgeAfterSpread > 0.03;
  const isModerateEdge = bestEdgeAfterSpread > 0.015;
  const spreadKillsEdge = bestEdge > 0.015 && bestEdgeAfterSpread <= 0;

  let recommendation = 'NO_EDGE';
  if (isBiasOpportunity) {
    recommendation = bestSide === 'YES' ? 'BUY_YES' : 'BUY_NO';
  } else if (isModerateEdge) {
    recommendation = bestSide === 'YES' ? 'BUY_YES' : 'BUY_NO';
  } else if (spreadKillsEdge) {
    recommendation = 'SPREAD_EATS_EDGE';
  }

  // Fee-adjusted net edges (convert pp to decimal for consistency with edge units)
  const bestPrice = bestSide === 'YES' ? yesPrice : bestSide === 'NO' ? noPrice : null;
  const takerFeePP = computeFeePP(bestPrice, feeParams);
  const makerRebatePP = computeMakerRebatePP(bestPrice, feeParams);
  const takerFeeDecimal = takerFeePP / 100;
  const makerRebateDecimal = makerRebatePP / 100;
  const netEdgeTaker = bestEdgeAfterSpread - takerFeeDecimal;
  const netEdgeMaker = bestEdgeAfterSpread + makerRebateDecimal;

  return {
    adjustedYesProb,
    adjustedNoProb,
    yesEdge,
    yesEdgeAfterSpread,
    noEdge,
    noEdgeAfterSpread,
    recommendation,
    bestEdge: Math.max(yesEdge, noEdge),
    bestEdgeAfterSpread,
    bestSide,
    isBiasOpportunity,
    isModerateEdge,
    spreadKillsEdge,
    netEdge: netEdgeTaker,
    netEdgeTaker,
    netEdgeMaker,
    takerFeePP,
    makerRebatePP,
    feeFree: isFeeFree(feeParams),
  };
}
