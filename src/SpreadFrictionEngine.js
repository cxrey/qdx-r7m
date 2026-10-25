/**
 * Spread & Friction Analyzer
 *
 * Calculates real execution costs for Polymarket trades including
 * bid-ask spread, slippage from walking the order book, and depth metrics.
 */

import { computeFeePP, computeRoundTripCostPP } from './feeCalculator';

// --- Order Book Normalization ---

/**
 * Parse, filter, and sort raw order book data once.
 * Returns pre-processed bids (desc by price) and asks (asc by price).
 * Accepts raw or already-normalized data (idempotent).
 * @param {{ bids: Array, asks: Array }} orderBook
 * @returns {{ bids: Array<{price: number, size: number}>, asks: Array<{price: number, size: number}> } | null}
 */
export function normalizeOrderBook(orderBook) {
  if (!orderBook) return null;

  // Internal sentinel — set only by this function. Callers should never construct
  // objects with _normalized: true; doing so with string-priced entries will break.
  if (orderBook._normalized) return orderBook;

  const bids = (orderBook.bids || [])
    .map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
    .filter((b) => !isNaN(b.price) && !isNaN(b.size) && b.size > 0)
    .sort((a, b) => b.price - a.price);
  const asks = (orderBook.asks || [])
    .map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
    .filter((a) => !isNaN(a.price) && !isNaN(a.size) && a.size > 0)
    .sort((a, b) => a.price - b.price);

  return { bids, asks, _normalized: true };
}

// --- Core Spread ---

/**
 * Calculate basic spread metrics from order book data.
 * Accepts raw or normalized order book.
 * @param {{ bids: Array, asks: Array }} orderBook
 * @returns {{ bestBid: number, bestAsk: number, midpoint: number, absoluteSpread: number } | null}
 */
export function calculateSpread(orderBook) {
  const norm = normalizeOrderBook(orderBook);
  if (!norm || norm.bids.length === 0 || norm.asks.length === 0) return null;

  const bestBid = norm.bids[0].price;  // sorted desc
  const bestAsk = norm.asks[0].price;  // sorted asc
  const midpoint = (bestBid + bestAsk) / 2;
  const absoluteSpread = bestAsk - bestBid;

  return { bestBid, bestAsk, midpoint, absoluteSpread };
}

// --- Fill Simulation ---

/**
 * Simulate walking the order book to fill a given dollar amount.
 * @param {{ bids: Array, asks: Array }} orderBook
 * @param {"BUY_YES" | "BUY_NO"} side
 * @param {number} entrySize - Dollar amount to fill
 * @returns {object | null}
 */
export function simulateFill(orderBook, side, entrySize) {
  if (!orderBook || entrySize <= 0) return null;

  const norm = normalizeOrderBook(orderBook);
  if (!norm || norm.bids.length === 0 || norm.asks.length === 0) return null;

  const bestBid = norm.bids[0].price;
  const bestAsk = norm.asks[0].price;
  const midpoint = (bestBid + bestAsk) / 2;

  if (side === 'BUY_YES') {
    // Lift asks — already sorted ascending by price
    const asks = norm.asks;

    let totalCost = 0;
    let totalShares = 0;
    let remainingDollars = entrySize;
    let levelsConsumed = 0;

    for (const level of asks) {
      levelsConsumed++;
      const levelCost = level.size * level.price;

      if (remainingDollars >= levelCost) {
        totalCost += levelCost;
        totalShares += level.size;
        remainingDollars -= levelCost;
      } else {
        const sharesFillable = remainingDollars / level.price;
        totalCost += remainingDollars;
        totalShares += sharesFillable;
        remainingDollars = 0;
        break;
      }
    }

    const averageFillPrice = totalShares > 0 ? totalCost / totalShares : bestAsk;
    const slippage = averageFillPrice - bestAsk;
    const midpointPrice = midpoint;
    const spreadCost = averageFillPrice - midpointPrice;
    const frictionPct = averageFillPrice > 0 ? spreadCost / averageFillPrice : 0;

    return {
      side,
      entrySize,
      averageFillPrice,
      midpointPrice,
      spreadCost,
      slippage,
      totalFriction: spreadCost,
      frictionPct,
      totalShares,
      levelsConsumed,
      bookExhausted: remainingDollars > 0,
      unfilled: remainingDollars,
    };
  }

  if (side === 'BUY_NO') {
    // Hit bids on yes book — already sorted descending by price
    const bids = norm.bids;

    let totalCost = 0;
    let totalShares = 0;
    let remainingDollars = entrySize;
    let levelsConsumed = 0;

    for (const level of bids) {
      const noPrice = 1 - level.price;
      if (noPrice <= 0) continue;
      levelsConsumed++;
      const levelCost = level.size * noPrice;

      if (remainingDollars >= levelCost) {
        totalShares += level.size;
        totalCost += levelCost;
        remainingDollars -= levelCost;
      } else {
        const sharesFillable = remainingDollars / noPrice;
        totalShares += sharesFillable;
        totalCost += remainingDollars;
        remainingDollars = 0;
        break;
      }
    }

    const bestNoPrice = 1 - bestBid;
    const averageFillPrice = totalShares > 0 ? totalCost / totalShares : bestNoPrice;
    const slippage = averageFillPrice - bestNoPrice;
    const midpointNoPrice = 1 - midpoint;
    const spreadCost = averageFillPrice - midpointNoPrice;
    const frictionPct = averageFillPrice > 0 ? spreadCost / averageFillPrice : 0;

    return {
      side,
      entrySize,
      averageFillPrice,
      midpointPrice: midpointNoPrice,
      spreadCost,
      slippage,
      totalFriction: spreadCost,
      frictionPct,
      totalShares,
      levelsConsumed,
      bookExhausted: remainingDollars > 0,
      unfilled: remainingDollars,
    };
  }

  return null;
}

// --- Depth Metrics ---

/**
 * Summarize order book depth within 5¢ of best bid/ask.
 * @param {{ bids: Array, asks: Array }} orderBook
 * @returns {object | null}
 */
export function calculateDepthMetrics(orderBook) {
  const norm = normalizeOrderBook(orderBook);
  if (!norm || norm.bids.length === 0 || norm.asks.length === 0) return null;

  const bestBid = norm.bids[0].price;
  const bestAsk = norm.asks[0].price;

  const bids = norm.bids;
  const asks = norm.asks;

  // Dollar depth within 5¢ of best bid/ask
  const bidDepthAt5c = bids
    .filter((b) => bestBid - b.price <= 0.05)
    .reduce((sum, b) => sum + b.size * b.price, 0);

  const askDepthAt5c = asks
    .filter((a) => a.price - bestAsk <= 0.05)
    .reduce((sum, a) => sum + a.size * a.price, 0);

  const totalNearDepth = bidDepthAt5c + askDepthAt5c;
  const depthImbalance = totalNearDepth > 0 ? bidDepthAt5c / totalNearDepth : 0.5;

  return {
    bidDepthAt5c,
    askDepthAt5c,
    totalNearDepth,
    depthImbalance,
    bidLevels: bids.length,
    askLevels: asks.length,
  };
}

// --- Friction Score ---

/**
 * 0-100 score summarizing friction severity.
 * @param {{ absoluteSpread: number }} spreadData
 * @param {{ totalNearDepth: number }} depthMetrics
 * @param {number} yesPrice
 * @returns {{ score: number, label: string, worstSpreadPct: number }}
 */
export function calculateFrictionScore(spreadData, depthMetrics, yesPrice) {
  if (!spreadData || yesPrice == null) return { score: 0, label: 'Unknown', worstSpreadPct: 0 };

  const noPrice = 1 - yesPrice;
  const spreadPctYes = yesPrice > 0 ? spreadData.absoluteSpread / yesPrice : 0;
  const spreadPctNo = noPrice > 0 ? spreadData.absoluteSpread / noPrice : 0;
  const worstSpreadPct = Math.max(spreadPctYes, spreadPctNo);

  // Spread penalty
  let spreadPenalty = 0;
  if (worstSpreadPct < 0.02) {
    spreadPenalty = 0;
  } else if (worstSpreadPct <= 0.05) {
    spreadPenalty = ((worstSpreadPct - 0.02) / 0.03) * 25;
  } else if (worstSpreadPct <= 0.10) {
    spreadPenalty = 25 + ((worstSpreadPct - 0.05) / 0.05) * 25;
  } else {
    spreadPenalty = 50 + Math.min(((worstSpreadPct - 0.10) / 0.10) * 30, 30);
  }

  // Depth penalty
  let depthPenalty = 0;
  const totalNearDepth = depthMetrics?.totalNearDepth ?? 0;
  if (totalNearDepth >= 50000) depthPenalty = 0;
  else if (totalNearDepth >= 10000) depthPenalty = 3;
  else if (totalNearDepth >= 2000) depthPenalty = 8;
  else if (totalNearDepth >= 500) depthPenalty = 15;
  else depthPenalty = 25;

  const score = Math.max(0, Math.round(100 - spreadPenalty - depthPenalty));

  let label;
  if (score >= 80) label = 'Clean';
  else if (score >= 60) label = 'Moderate';
  else if (score >= 35) label = 'Heavy';
  else label = 'Prohibitive';

  return { score, label, worstSpreadPct };
}

// --- Edge Survival ---

/**
 * Checks if edges from other engines survive the spread.
 * @param {object} market - Processed market object
 * @param {{ absoluteSpread: number }} spreadData - From calculateSpread
 * @returns {object}
 */
export function calculateEdgeSurvival(market, spreadData) {
  if (!spreadData) return { edges: [], survivingEdges: 0, killedEdges: 0 };

  const halfSpread = spreadData.absoluteSpread / 2; // one-way cost
  const { gammaCategory, feesEnabled, feeSchedule } = market;
  // One-way taker fee (decimal, per share) at a given share price
  const takerFee = (price) => computeFeePP(price, gammaCategory, feesEnabled, feeSchedule) / 100;
  const edges = [];

  // FLB edge — one-way entry (half spread + taker fee), held to resolution.
  // flb.takerFeePP is already computed at the best side's price.
  if (market.flb?.bestEdge != null) {
    const raw = market.flb.bestEdge;
    const fee = (market.flb.takerFeePP ?? 0) / 100;
    const net = raw - halfSpread - fee;
    edges.push({
      source: 'FLB',
      rawEdge: raw,
      netEdge: net,
      survives: net > 0,
      side: market.flb.bestSide || 'N/A',
    });
  }

  // Base rate gap — one-way entry on the suggested side
  if (market.baseRate?.absGapCents != null && market.baseRate.absGapCents > 0) {
    const raw = market.baseRate.absGapCents / 100; // convert cents to fraction
    const side = market.baseRate.gapType === 'NARRATIVE_PREMIUM' ? 'NO' : 'YES';
    const sidePrice = side === 'YES' ? market.yesPrice : market.noPrice;
    const net = raw - halfSpread - takerFee(sidePrice);
    edges.push({
      source: 'Base Rate',
      rawEdge: raw,
      netEdge: net,
      survives: net > 0,
      side,
    });
  }

  // Theta — cumulative decay over the remaining life vs a full round trip
  // (enter + exit: full spread + two taker fees). Same cost basis as
  // processMarket's thetaBreakEvenDays, but priced off the live book.
  if (market.theta?.bestTheta != null && Math.abs(market.theta.bestTheta) > 0 && market.daysLeft > 0) {
    const raw = Math.abs(market.theta.bestTheta) * market.daysLeft;
    const roundTrip = computeRoundTripCostPP(
      market.yesPrice, spreadData.absoluteSpread, gammaCategory, feesEnabled, feeSchedule,
    ).totalCostPP / 100;
    const net = raw - roundTrip;
    edges.push({
      source: 'Theta (to expiry)',
      rawEdge: raw,
      netEdge: net,
      survives: net > 0,
      side: market.theta.bestSide || 'N/A',
    });
  }

  const survivingEdges = edges.filter((e) => e.survives).length;
  const killedEdges = edges.filter((e) => !e.survives).length;

  return { edges, survivingEdges, killedEdges };
}

// --- Estimated spread from overround (no order book needed) ---

/**
 * Estimate spread from yes/no price overround. Used as a proxy in the table column
 * when real order book data isn't available.
 * @param {number} yesPrice
 * @param {number} noPrice
 * @returns {{ estimatedSpread: number, isEstimate: boolean }}
 */
export function estimateSpreadFromPrices(yesPrice, noPrice) {
  if (yesPrice == null || noPrice == null) return { estimatedSpread: null, isEstimate: true };
  const overround = Math.abs((yesPrice + noPrice) - 1.0);
  return { estimatedSpread: overround, isEstimate: true };
}
