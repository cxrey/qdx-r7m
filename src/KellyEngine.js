import { computeEffectiveFeeRate, computeFeePerShare } from './feeCalculator';
import { allInCost } from './executionCost';

/**
 * KellyEngine.js — Pure JS utility for Kelly Criterion position sizing.
 * Provides bet sizing calculations with sensitivity analysis, scenario modeling,
 * re-evaluation triggers, and portfolio-level constraints.
 *
 * DESIGN PHILOSOPHY: This is a MATHEMATICAL TOOL, not financial advice.
 * All outputs include uncertainty ranges. Fractional Kelly scaling is
 * robustness-aware — less confident edges get smaller fractions.
 */

// ─── Settings & Storage ─────────────────────────────────────────────

const SETTINGS_KEY = 'pm_kelly_settings';
const JOURNAL_KEY = 'pm_kelly_journal';
const CALIBRATION_KEY = 'pm_kelly_calibration';
// Correlation assumed for a bet in a market already in the portfolio (the
// cap pair correlations use in PortfolioEngine)
const ALREADY_HELD_CORRELATION = 0.95;

const DEFAULT_SETTINGS = {
  bankroll: 1000,
  maxPositionPct: 20,       // % of bankroll for any single bet
  maxTotalExposure: 80,     // % of bankroll across all positions
  minPracticalBet: 5,       // $ minimum to bother placing
  defaultFraction: 0.25,    // default Kelly fraction (quarter-Kelly)
  correlationPenalty: true,  // reduce sizing for correlated positions
};

export function getKellySettings() {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS };
}

export function saveKellySettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* ignore */ }
}

// ─── Core Kelly Calculation ─────────────────────────────────────────

/**
 * Calculate Kelly fraction for a binary market.
 *
 * Everything is priced at the ALL-IN cost per share c̄ — what you actually pay
 * for a share that returns $1 if your side wins (fill price + taker fee):
 *   EV per share   = p − c̄
 *   EV per dollar  = p / c̄ − 1
 *   full Kelly f*  = (p − c̄) / (1 − c̄)
 * Without `opts.cost`, c̄ = quoted price + its taker fee (no slippage).
 *
 * @param {number} estProb - Your estimated probability of YES (0–1)
 * @param {number} marketPrice - Quoted price of the selected side (0–1)
 * @param {string} side - 'YES' or 'NO'
 * @param {Object} [feeParams] - market.feeParams; null = no fees
 * @param {Object} [opts]
 * @param {number} [opts.cost] - all-in cost per share (e.g. from allInCost)
 * @param {number} [opts.maxFraction] - your Kelly fraction λ (settings.defaultFraction);
 *   the robustness tier caps it further for weaker edges
 * @returns {Object} Kelly analysis result
 */
export function calculateKelly(estProb, marketPrice, side = 'YES', feeParams = null, opts = {}) {
  // Validate inputs
  if (estProb < 0 || estProb > 1 || marketPrice <= 0 || marketPrice >= 1) {
    return { valid: false, reason: 'Invalid inputs' };
  }

  // p = probability the selected side wins
  const p = side === 'YES' ? estProb : 1 - estProb;
  const q = 1 - p;

  // Raw edge at the quoted price, before any costs (per dollar)
  const edge = p / marketPrice - 1;
  // Fee as a fraction of trade value at the quoted price (for display)
  const takerFeeRate = computeEffectiveFeeRate(marketPrice, feeParams);

  // All-in cost per share
  const cost = Number.isFinite(opts.cost) && opts.cost > 0
    ? opts.cost
    : marketPrice + computeFeePerShare(marketPrice, feeParams);
  if (cost >= 1) {
    return {
      valid: true, noEdge: true, side, estProb, marketPrice, cost, breakEvenProb: cost,
      gapPp: (p - cost) * 100, edge: edge * 100, feeAdjustedEdge: -100, takerFeeRate, fullKelly: 0,
      evPerShare: p - cost,
      reason: 'Costs exceed the $1 payout',
    };
  }
  const b = (1 - cost) / cost; // net odds: profit per dollar risked, after costs
  const netEdge = p / cost - 1; // EV per dollar, after costs

  // Break-even: your side must win more often than c̄
  const breakEvenProb = cost;
  const gapPp = (p - cost) * 100;

  // NO_EDGE_DETECTABLE check
  if (gapPp < 0.5) {
    return {
      valid: true,
      noEdge: true,
      side,
      estProb,
      marketPrice,
      cost,
      breakEvenProb,
      gapPp,
      edge: edge * 100,
      feeAdjustedEdge: netEdge * 100,
      takerFeeRate,
      fullKelly: 0,
      evPerShare: p - cost,
      reason: gapPp <= 0
        ? (p > marketPrice
          ? 'Fill price and fees use up your edge'
          : 'Market price already reflects or exceeds your estimate')
        : 'Edge too small to be meaningful (< 0.5pp)',
    };
  }

  // Full Kelly at the all-in cost: f* = (p − c̄) / (1 − c̄)
  const fullKelly = (p - cost) / (1 - cost);

  // Fraction λ: your setting, capped by the robustness tier
  const robustness = assessRobustness(gapPp, estProb);
  const fractionMultiplier = Number.isFinite(opts.maxFraction) && opts.maxFraction > 0
    ? Math.min(opts.maxFraction, robustness.kellyFraction)
    : robustness.kellyFraction;
  const fractionalKelly = fullKelly * fractionMultiplier;

  // Expected growth rate (log utility)
  const growthRate = fractionalKelly > 0
    ? p * Math.log(1 + fractionalKelly * b) + q * Math.log(1 - fractionalKelly)
    : 0;

  return {
    valid: true,
    noEdge: false,
    side,
    estProb,
    marketPrice,
    cost,
    breakEvenProb,
    gapPp,
    edge: edge * 100,
    feeAdjustedEdge: netEdge * 100,
    takerFeeRate,
    fullKelly,
    feeAdjustedFullKelly: fullKelly, // kept for callers; costs are now in fullKelly
    fractionalKelly,
    fractionMultiplier,
    robustness,
    odds: b,
    growthRate,
    expectedValue: netEdge,
    evPerShare: p - cost,
  };
}

/**
 * Kelly at the price you'd actually fill at. The fill depends on the order
 * size and the size on the fill, so iterate: top-of-book cost → Kelly size →
 * cost of that size → … (converges in a few steps: cost rises with size).
 *
 * @param {object} opts — calculateKelly's inputs plus allInCost's:
 *   { estProb, side, marketPrice, feeParams, bankroll, maxFraction, book, bookSide, spread }
 * @returns {{ kelly: object, quote: object }}
 */
export function calculateKellyAtExecution({
  estProb, side, marketPrice, feeParams = null, bankroll, maxFraction,
  book = null, bookSide = 'YES', spread = null, iterations = 4,
}) {
  const quoteFor = (dollars) => allInCost({ side, dollars, price: marketPrice, spread, book, bookSide, feeParams });
  let quote = quoteFor(1);
  let kelly = calculateKelly(estProb, marketPrice, side, feeParams, { cost: quote.cost, maxFraction });
  for (let i = 0; i < iterations; i++) {
    const dollars = kelly.valid && !kelly.noEdge ? kelly.fractionalKelly * bankroll : 0;
    if (!(dollars > 1)) break;
    const next = quoteFor(dollars);
    if (Math.abs(next.cost - quote.cost) < 1e-7) break;
    quote = next;
    kelly = calculateKelly(estProb, marketPrice, side, feeParams, { cost: quote.cost, maxFraction });
  }
  return { kelly, quote };
}

/**
 * Assess robustness of the edge and determine Kelly fraction.
 */
function assessRobustness(gapPp, estProb) {
  // How far is our estimate from 50/50 (max uncertainty)?
  const distFromCenter = Math.abs(estProb - 0.5);

  let level, kellyFraction, label;

  if (gapPp >= 10 && distFromCenter > 0.2) {
    level = 'ROBUST';
    kellyFraction = 0.5;  // half-Kelly
    label = 'Robust edge - half Kelly';
  } else if (gapPp >= 5) {
    level = 'SOLID';
    kellyFraction = 0.25; // quarter-Kelly
    label = 'Solid edge - quarter Kelly';
  } else if (gapPp >= 2) {
    level = 'MODERATE';
    kellyFraction = 0.25; // quarter-Kelly
    label = 'Moderate edge - quarter Kelly';
  } else {
    level = 'FRAGILE';
    kellyFraction = 0.125; // eighth-Kelly
    label = 'Fragile edge - eighth Kelly';
  }

  return { level, kellyFraction, label };
}

// ─── Multi-Outcome Kelly ────────────────────────────────────────────

/**
 * Calculate Kelly fractions for a multi-outcome market (3+ outcomes).
 *
 * APPROXIMATION: computes an independent binary Kelly per outcome, then
 * scales proportionally if the total exceeds the allocation cap. This is
 * NOT true multi-outcome Kelly (which requires joint optimization) and
 * tends to overstate risk for mutually exclusive outcomes, where
 * simultaneous YES bets partially hedge each other — so it errs
 * conservative on sizing.
 *
 * @param {Array<{name: string, estProb: number, marketPrice: number}>} outcomes
 * Each outcome may carry its own `feeParams` (outcomes of one event can sit
 * in different fee categories); `defaultFeeParams` covers outcomes without.
 *
 * @param {Array<{name: string, estProb: number, marketPrice: number, feeParams?: Object}>} outcomes
 * @param {Object} defaultFeeParams - fallback feeParams for outcomes without their own
 * @returns {Object} Multi-outcome Kelly result
 */
export function calculateMultiOutcomeKelly(outcomes, defaultFeeParams = null) {
  if (!outcomes || outcomes.length < 2) {
    return { valid: false, reason: 'Need at least 2 outcomes' };
  }

  // Normalize estimated probabilities to sum to 1
  const totalProb = outcomes.reduce((s, o) => s + o.estProb, 0);
  if (totalProb <= 0) {
    return { valid: false, reason: 'Probabilities must be positive' };
  }

  const normalized = outcomes.map((o) => ({
    ...o,
    estProb: o.estProb / totalProb,
    odds: (1 - o.marketPrice) / o.marketPrice,
    edge: o.estProb / totalProb - o.marketPrice,
  }));

  // For each outcome, calculate independent Kelly as if it were binary
  const results = normalized.map((o) => {
    const kelly = calculateKelly(o.estProb, o.marketPrice, 'YES', o.feeParams ?? defaultFeeParams);
    return {
      name: o.name,
      estProb: o.estProb,
      marketPrice: o.marketPrice,
      edge: o.edge,
      edgePp: o.edge * 100,
      kelly,
      recommendedFraction: kelly.valid && !kelly.noEdge ? kelly.fractionalKelly : 0,
    };
  });

  // Check total allocation doesn't exceed 100%
  const totalAllocation = results.reduce((s, r) => s + r.recommendedFraction, 0);

  // Scale down proportionally if over-allocated
  let scaledResults = results;
  if (totalAllocation > 0.8) {
    const scale = 0.8 / totalAllocation;
    scaledResults = results.map((r) => ({
      ...r,
      recommendedFraction: r.recommendedFraction * scale,
      scaled: true,
    }));
  }

  return {
    valid: true,
    outcomes: scaledResults,
    totalAllocation: scaledResults.reduce((s, r) => s + r.recommendedFraction, 0),
    probsNormalized: Math.abs(totalProb - 1) > 1e-9,
    originalProbSum: totalProb,
  };
}

// ─── Sensitivity Table ──────────────────────────────────────────────

/**
 * Generate a sensitivity table showing how Kelly changes across
 * different probability estimates.
 *
 * @param {number} marketPrice - Current market price
 * @param {number} centerProb - Your center estimate
 * @param {string} side - 'YES' or 'NO'
 * @param {Object} settings - Kelly settings
 * @param {Object} feeParams - market.feeParams, passed to calculateKelly
 * @param {Object} [kellyOpts] - { cost, maxFraction }, passed to calculateKelly
 *   (the cost is the center size's; rows at other sizes would fill slightly differently)
 * @returns {Array} Rows of sensitivity data
 */
export function calculateSensitivityTable(marketPrice, centerProb, side = 'YES', settings = null, feeParams = null, kellyOpts = {}) {
  const s = settings || getKellySettings();
  const rows = [];

  // Generate range: centerProb +/- 15pp in 2.5pp steps
  const steps = [];
  for (let delta = -15; delta <= 15; delta += 2.5) {
    const prob = centerProb + delta / 100;
    if (prob > 0.02 && prob < 0.98) {
      steps.push(prob);
    }
  }

  for (const prob of steps) {
    const kelly = calculateKelly(prob, marketPrice, side, feeParams, kellyOpts);
    const dollars = kelly.valid && !kelly.noEdge
      ? Math.max(0, kelly.fractionalKelly * s.bankroll)
      : 0;

    // Apply position cap
    const maxDollars = s.bankroll * (s.maxPositionPct / 100);
    const cappedDollars = Math.min(dollars, maxDollars);

    rows.push({
      prob,
      probPct: (prob * 100).toFixed(1),
      isCenter: Math.abs(prob - centerProb) < 0.001,
      kelly,
      rawDollars: dollars,
      cappedDollars,
      capped: cappedDollars < dollars,
      belowMinimum: cappedDollars > 0 && cappedDollars < s.minPracticalBet,
      shares: kelly.cost > 0 ? cappedDollars / kelly.cost : 0,
    });
  }

  return rows;
}

// ─── Scenario Analysis ──────────────────────────────────────────────

/**
 * Calculate outcomes under different scenarios.
 *
 * @param {number} betSize - Dollar amount of the bet
 * @param {number} marketPrice - Price paid per share of the SELECTED side —
 *   pass the all-in cost (fill price + fee) so profit and EV are net of costs
 * @param {string} side - 'YES' or 'NO'
 * @param {number} estProb - Estimated probability of YES (the event)
 * @param {Object} settings - Kelly settings
 * @returns {Object} Scenario analysis
 */
export function calculateScenarios(betSize, marketPrice, side, estProb, settings = null) {
  const s = settings || getKellySettings();

  // Shares purchased at the selected side's own price.
  // (Previously NO inverted the price a second time — callers already pass
  // noPrice for NO — so NO bets were priced at ~yesPrice and shares/EV
  // were wrong.)
  const entryPrice = marketPrice;
  const shares = betSize / entryPrice;

  // Win scenario: each share pays $1
  const winPayout = shares * 1;
  const winProfit = winPayout - betSize;
  const winReturn = betSize > 0 ? (winProfit / betSize) * 100 : 0;

  // Lose scenario: shares worth $0
  const lossAmount = betSize;

  // Expected value
  const winProb = side === 'YES' ? estProb : (1 - estProb);
  const ev = winProb * winProfit - (1 - winProb) * lossAmount;
  const evPct = betSize > 0 ? (ev / betSize) * 100 : 0;
  const evPerShare = winProb - entryPrice; // p − c̄

  // Impact on bankroll
  const bankrollAfterWin = s.bankroll - betSize + winPayout;
  const bankrollAfterLoss = s.bankroll - betSize;
  const expectedBankroll = winProb * bankrollAfterWin + (1 - winProb) * bankrollAfterLoss;

  // Partial scenarios (market moves but doesn't resolve)
  const partialScenarios = [
    { label: 'Price +10c', priceMove: 0.10 },
    { label: 'Price +5c', priceMove: 0.05 },
    { label: 'Price -5c', priceMove: -0.05 },
    { label: 'Price -10c', priceMove: -0.10 },
  ].map((s) => {
    const newPrice = Math.max(0.01, Math.min(0.99, entryPrice + s.priceMove));
    const paperValue = shares * newPrice;
    const paperPnl = paperValue - betSize;
    return {
      ...s,
      newPrice,
      paperValue,
      paperPnl,
      paperPnlPct: betSize > 0 ? (paperPnl / betSize) * 100 : 0,
    };
  });

  return {
    betSize,
    shares,
    entryPrice,
    side,
    win: { payout: winPayout, profit: winProfit, returnPct: winReturn, prob: winProb },
    loss: { amount: lossAmount, prob: 1 - winProb },
    ev,
    evPct,
    evPerShare,
    bankrollAfterWin,
    bankrollAfterLoss,
    expectedBankroll,
    partialScenarios,
  };
}

// ─── Re-evaluation Triggers ─────────────────────────────────────────

/**
 * Calculate when you should re-evaluate a position.
 *
 * @param {number} entryPrice - Price at entry
 * @param {number} estProb - Estimated probability at entry
 * @param {number} daysLeft - Days until market resolution
 * @param {Object} theta - Theta data from ThetaEngine (optional)
 * @returns {Object} Re-evaluation triggers
 */
export function calculateReEvalTrigger(entryPrice, estProb, daysLeft, theta = null) {
  const triggers = [];

  // Price movement triggers
  const priceTriggerUp = Math.min(0.99, entryPrice + 0.10);
  const priceTriggerDown = Math.max(0.01, entryPrice - 0.10);
  triggers.push({
    type: 'PRICE_MOVE',
    label: `Price moves above ${(priceTriggerUp * 100).toFixed(0)}c or below ${(priceTriggerDown * 100).toFixed(0)}c`,
    upperBound: priceTriggerUp,
    lowerBound: priceTriggerDown,
  });

  // Time-based triggers
  if (daysLeft != null && daysLeft > 0) {
    // Re-evaluate at certain time milestones
    const milestones = [
      { pct: 0.5, label: 'Halfway to resolution' },
      { pct: 0.75, label: '75% of time elapsed' },
      { pct: 0.9, label: '90% of time elapsed' },
    ];
    for (const m of milestones) {
      const daysAtMilestone = daysLeft * (1 - m.pct);
      if (daysAtMilestone > 1) {
        triggers.push({
          type: 'TIME',
          label: `${m.label} (~${Math.round(daysAtMilestone)} days from now)`,
          daysFromNow: Math.round(daysAtMilestone),
        });
      }
    }
  }

  // Theta-aware: if high theta, re-evaluate sooner
  if (theta?.bestTheta != null) {
    const dailyDecay = Math.abs(theta.bestTheta) * 100; // cents/day
    if (dailyDecay > 0.5) {
      const daysTo5c = 5 / dailyDecay;
      triggers.push({
        type: 'THETA',
        label: `High time decay (~${dailyDecay.toFixed(1)}c/day) - re-evaluate in ${Math.round(daysTo5c)} days`,
        daysFromNow: Math.round(daysTo5c),
        dailyDecay,
      });
    }
  }

  // Volume trigger: re-evaluate if market gets significantly more liquid
  triggers.push({
    type: 'VOLUME',
    label: 'Volume doubles or unusual activity detected',
  });

  // New information trigger
  triggers.push({
    type: 'INFO',
    label: 'Material new information about the underlying event',
  });

  return {
    triggers,
    nextReEval: triggers
      .filter((t) => t.daysFromNow != null)
      .sort((a, b) => a.daysFromNow - b.daysFromNow)[0] || null,
  };
}

// ─── Portfolio Constraints ──────────────────────────────────────────

/**
 * Apply portfolio-level constraints to a proposed bet.
 *
 * @param {number} rawDollars - Unconstrained bet size
 * @param {Object} market - Market data
 * @param {Object} portfolio - Portfolio hook data (optional)
 * @param {Object} settings - Kelly settings
 * @param {'YES'|'NO'|null} side - Side being bet. Needed to tell adding to a
 *   position you hold in this market from offsetting it; when unknown, the
 *   conservative "adds to it" penalty applies.
 * @returns {Object} Constrained sizing result
 */
export function applyPortfolioConstraints(rawDollars, market, portfolio = null, settings = null, side = null) {
  const s = settings || getKellySettings();
  const constraints = [];
  let adjustedDollars = rawDollars;

  // 1. Max position size
  const maxPosition = s.bankroll * (s.maxPositionPct / 100);
  if (adjustedDollars > maxPosition) {
    constraints.push({
      type: 'MAX_POSITION',
      label: `Capped at ${s.maxPositionPct}% of bankroll ($${maxPosition.toFixed(0)})`,
      original: adjustedDollars,
    });
    adjustedDollars = maxPosition;
  }

  // 2. Max total exposure
  if (portfolio?.hasPortfolio && portfolio.summary) {
    const currentExposure = portfolio.summary.totalValue || 0;
    const maxExposure = s.bankroll * (s.maxTotalExposure / 100);
    const remaining = Math.max(0, maxExposure - currentExposure);
    if (adjustedDollars > remaining) {
      constraints.push({
        type: 'MAX_EXPOSURE',
        label: `Total exposure limit: $${remaining.toFixed(0)} remaining of $${maxExposure.toFixed(0)} max`,
        original: adjustedDollars,
      });
      adjustedDollars = remaining;
    }
  }

  // 3. Correlation penalty
  if (s.correlationPenalty && portfolio?.hasPortfolio && portfolio.screenTrade) {
    const screening = portfolio.screenTrade(market);
    const held = screening?.alreadyHeld; // { yes, no } shares in this market
    const betSide = side === 'YES' || side === 'NO' ? side : null;
    const heldOnBetSide = held && betSide ? held[betSide.toLowerCase()] : 0;
    const otherSide = betSide === 'YES' ? 'NO' : 'YES';
    const heldOnOtherSide = held && betSide ? held[otherSide.toLowerCase()] : 0;

    if (held && (!betSide || heldOnBetSide > 0)) {
      // Adding to a position in this very market is the most concentrated
      // bet there is: penalize it like the strongest correlation (the 0.95
      // cap). Side unknown → assume it adds (conservative).
      const penalty = 1 - (ALREADY_HELD_CORRELATION - 0.5);
      constraints.push({
        type: 'CORRELATION',
        label: betSide
          ? `Adds to your existing ${betSide} position in this market (${heldOnBetSide.toFixed(0)} shares), reduced by ${((1 - penalty) * 100).toFixed(0)}%`
          : `Adds to a market you already hold, reduced by ${((1 - penalty) * 100).toFixed(0)}%`,
        original: adjustedDollars,
      });
      adjustedDollars *= penalty;
    } else {
      if (heldOnOtherSide > 0) {
        // Betting the other side offsets the position rather than adding
        // risk — say so, without a penalty for it
        constraints.push({
          type: 'OFFSET',
          label: `Offsets your existing ${otherSide} position in this market (${heldOnOtherSide.toFixed(0)} shares) — no concentration penalty`,
        });
      }
      // With the side known, use the screening's per-side view: positions on
      // other outcomes of a mutually exclusive event carry their exact,
      // price-implied payoff correlation — strongly negative ones are hedges
      // (noted, not penalized), strongly positive ones are penalized, and
      // near-zero ones (e.g. two longshots) are neither. Other correlations
      // are unsigned, so they're penalized either way.
      const risk = betSide ? screening?.sideRisk?.[betSide] : null;
      for (const h of risk?.hedges ?? []) {
        constraints.push({
          type: 'OFFSET',
          label: `Hedges your ${h.side} position in "${h.question.slice(0, 40)}" (outcomes of one event; r=${h.correlation.toFixed(2)}) — no correlation penalty`,
        });
      }
      const correlation = risk ? risk.correlation : screening?.maxCorrelation;
      if (correlation > 0.5) {
        const penalty = 1 - (correlation - 0.5); // 0.5 corr = no penalty, 1.0 = 50% reduction
        const penalizedDollars = adjustedDollars * penalty;
        const pct = ((1 - penalty) * 100).toFixed(0);
        constraints.push({
          type: 'CORRELATION',
          label: risk?.directionKnown
            ? `Moves with your ${risk.side} position in "${risk.question.slice(0, 40)}" (outcomes of one event; r=${correlation.toFixed(2)}), reduced by ${pct}%`
            : `Correlated with another position (r=${correlation.toFixed(2)}; direction not modelled), reduced by ${pct}%`,
          original: adjustedDollars,
        });
        adjustedDollars = penalizedDollars;
      }
    }
  }

  // 4. Minimum practical bet check
  const belowMinimum = adjustedDollars > 0 && adjustedDollars < s.minPracticalBet;
  if (belowMinimum) {
    constraints.push({
      type: 'BELOW_MINIMUM',
      label: `Below minimum practical bet of $${s.minPracticalBet}`,
    });
  }

  // 5. Min bet as % of bankroll check
  const pctOfBankroll = s.bankroll > 0 ? (adjustedDollars / s.bankroll) * 100 : 0;
  if (pctOfBankroll < 1 && adjustedDollars > 0) {
    constraints.push({
      type: 'TINY_FRACTION',
      label: 'Less than 1% of bankroll - edge may not be worth the attention cost',
    });
  }

  return {
    rawDollars,
    adjustedDollars: Math.max(0, adjustedDollars),
    constraints,
    belowMinimum,
    pctOfBankroll,
    effective: !belowMinimum && adjustedDollars > 0,
  };
}

// ─── Decision Journal ───────────────────────────────────────────────

export function getJournalEntries() {
  try {
    const stored = localStorage.getItem(JOURNAL_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch { return []; }
}

export function saveJournalEntry(entry) {
  try {
    const entries = getJournalEntries();
    const newEntry = {
      id: `j_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      ...entry,
      reEvaluations: [],
      resolved: false,
      outcome: null,
    };
    entries.unshift(newEntry);
    // Keep max 200 entries
    if (entries.length > 200) entries.length = 200;
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(entries));
    return newEntry;
  } catch { return null; }
}

export function addReEvaluation(entryId, reEval) {
  try {
    const entries = getJournalEntries();
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) return false;
    entry.reEvaluations.push({
      timestamp: new Date().toISOString(),
      ...reEval,
    });
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(entries));
    return true;
  } catch { return false; }
}

export function resolveJournalEntry(entryId, outcome, { auto = false } = {}) {
  try {
    const entries = getJournalEntries();
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) return false;
    entry.resolved = true;
    entry.outcome = outcome; // 'WIN', 'LOSS', or 'SCRATCH'
    entry.resolvedAt = new Date().toISOString();
    if (auto) entry.autoResolved = true; // from the market's settlement, not by hand
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(entries));
    return true;
  } catch { return false; }
}

/** Merge fields into an entry (auto-resolution check stamps, markouts). */
export function updateJournalEntry(entryId, patch) {
  try {
    const entries = getJournalEntries();
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) return false;
    Object.assign(entry, patch);
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(entries));
    return true;
  } catch { return false; }
}

export function deleteJournalEntry(entryId) {
  try {
    const entries = getJournalEntries().filter((e) => e.id !== entryId);
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(entries));
    return true;
  } catch { return false; }
}

// ─── Calibration Tracking ───────────────────────────────────────────

export function getCalibrationData() {
  try {
    const stored = localStorage.getItem(CALIBRATION_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch { return []; }
}

export function addCalibrationPoint(point) {
  try {
    const data = getCalibrationData();
    data.push({
      timestamp: new Date().toISOString(),
      ...point,
    });
    // Keep last 500 points
    if (data.length > 500) data.splice(0, data.length - 500);
    localStorage.setItem(CALIBRATION_KEY, JSON.stringify(data));
    return true;
  } catch { return false; }
}

// Fewer resolved entries than this and the scores are mostly noise
export const MIN_CALIBRATION_SAMPLE = 30;
const LOG_LOSS_CLIP = 0.01;

/**
 * Whether the event (YES) happened, from a resolved entry: 1, 0, or null
 * (unresolved / scratched). `estProb` is P(YES) whichever side was bet, so it
 * must be scored against YES — not against "the chosen side won", which
 * mis-scored every NO bet (a winning NO at P(YES)=0.2 scored 0.64, not 0.04).
 */
export function yesOutcome(entry) {
  if (!entry?.resolved || (entry.outcome !== 'WIN' && entry.outcome !== 'LOSS')) return null;
  return (entry.side === 'YES') === (entry.outcome === 'WIN') ? 1 : 0;
}

/** The market's P(YES) when the entry was recorded (marketPrice is the chosen side's price). */
export function marketYesProb(entry) {
  if (!Number.isFinite(entry?.marketPrice)) return null;
  return entry.side === 'NO' ? 1 - entry.marketPrice : entry.marketPrice;
}

const brier = (p, y) => (p - y) ** 2;
function logLoss(p, y) {
  const q = Math.min(1 - LOG_LOSS_CLIP, Math.max(LOG_LOSS_CLIP, p));
  return -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
}

/**
 * Compute calibration metrics: bucket predictions of P(YES) and see how often
 * YES actually happened; score them (Brier, log loss) and benchmark them
 * against the market price at the time of the bet.
 *
 * @param {object[]} [entries] — journal entries (default: the stored journal)
 */
export function computeCalibrationMetrics(entries = getJournalEntries()) {
  const scored = entries
    .map((e) => ({ e, y: yesOutcome(e) }))
    .filter(({ e, y }) => y != null && Number.isFinite(e.estProb));
  if (scored.length === 0) return { buckets: [], totalResolved: 0 };

  // Bucket by predicted P(YES) (in 10% bands)
  const buckets = [];
  for (let lower = 0; lower < 100; lower += 10) {
    const upper = lower + 10;
    const inBucket = scored.filter(({ e }) => {
      const pct = e.estProb * 100;
      return pct >= lower && (pct < upper || (upper === 100 && pct <= 100));
    });
    if (inBucket.length === 0) continue;

    const yesCount = inBucket.filter(({ y }) => y === 1).length;
    const actualRate = yesCount / inBucket.length;
    const midpoint = (lower + upper) / 2 / 100;

    buckets.push({
      range: `${lower}-${upper}%`,
      midpoint,
      count: inBucket.length,
      wins: yesCount, // YES outcomes in the bucket
      actualRate,
      calibrationError: actualRate - midpoint,
      overconfident: actualRate < midpoint,
    });
  }

  // Overall metrics
  const totalResolved = scored.length;
  const totalWins = scored.filter(({ e }) => e.outcome === 'WIN').length;
  const overallWinRate = totalWins / totalResolved;

  const mean = (fn) => scored.reduce((sum, s) => sum + fn(s), 0) / totalResolved;
  const brierScore = mean(({ e, y }) => brier(e.estProb, y));
  const logLossScore = mean(({ e, y }) => logLoss(e.estProb, y));

  // Benchmark: the market's own P(YES) at entry, on the entries that have it
  const benchmarked = scored.filter(({ e }) => marketYesProb(e) != null);
  let marketBrier = null;
  let marketLogLoss = null;
  let skillScore = null;
  if (benchmarked.length > 0) {
    const n = benchmarked.length;
    const youBrier = benchmarked.reduce((s, { e, y }) => s + brier(e.estProb, y), 0) / n;
    marketBrier = benchmarked.reduce((s, { e, y }) => s + brier(marketYesProb(e), y), 0) / n;
    marketLogLoss = benchmarked.reduce((s, { e, y }) => s + logLoss(marketYesProb(e), y), 0) / n;
    // Brier skill score: > 0 = better than the price you bet against
    skillScore = marketBrier > 0 ? 1 - youBrier / marketBrier : null;
  }

  return {
    buckets,
    totalResolved,
    totalWins,
    overallWinRate,
    brierScore,
    logLoss: logLossScore,
    marketBrier,
    marketLogLoss,
    skillScore,
    benchmarkCount: benchmarked.length,
    smallSample: totalResolved < MIN_CALIBRATION_SAMPLE,
  };
}

// ─── Markouts (line value) ──────────────────────────────────────────
//
// How far the price of the side you bet moved in your favour 1 and 7 days
// after you recorded the decision, in cents: price(t + h) − entry price.
// Unlike P&L this needs no resolution, so it gives skill feedback in days.
// (A true "closing line" is ill-defined here: prices run to 0/1 at
// settlement, and old price history gets pruned — so values are stored once
// found.) A horizon at/after the market's end, or one where the price has
// already settled, is not applicable (stored as null).

export const MARKOUT_HORIZONS = [
  { key: 'markout1d', days: 1 },
  { key: 'markout7d', days: 7 },
];
const MARKOUT_WINDOW_S = 6 * 3600; // look back this far from t + h for the last price
const MARKOUT_GIVE_UP_DAYS = 30; // no history this long after t + h → treat as unavailable
const MARKOUT_MAX_FETCHES = 20; // per run
const DAY_MS = 86_400_000;

function sideTokenId(entry) {
  return entry.side === 'NO' ? entry.noTokenId : entry.yesTokenId;
}

/** The markouts an entry is due for: horizon passed, not yet stored. */
function dueMarkouts(entry, now) {
  const created = Date.parse(entry.createdAt);
  if (!Number.isFinite(created) || !sideTokenId(entry) || !Number.isFinite(entry.marketPrice)) return [];
  return MARKOUT_HORIZONS.filter((h) => entry[h.key] === undefined && created + h.days * DAY_MS <= now);
}

/**
 * Fill in due markouts from price history.
 *
 * @param {function} fetchHistory — async (tokenId, startTs, endTs) => { history: [{ t, p }] } | null
 * @returns {Promise<number>} markouts stored (including not-applicable ones)
 */
export async function updateMarkouts(fetchHistory, { now = Date.now(), delayMs = AUTO_RESOLVE_DELAY_MS, signal } = {}) {
  let stored = 0;
  let fetches = 0;
  for (const entry of getJournalEntries()) {
    for (const h of dueMarkouts(entry, now)) {
      if (signal?.aborted || fetches >= MARKOUT_MAX_FETCHES) return stored;
      const at = Date.parse(entry.createdAt) + h.days * DAY_MS;
      const end = entry.endDate ? Date.parse(entry.endDate) : NaN;
      if (Number.isFinite(end) && at >= end) {
        if (updateJournalEntry(entry.id, { [h.key]: null })) stored++;
        continue;
      }
      if (fetches > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      fetches++;
      const endTs = Math.floor(at / 1000);
      let res = null;
      try { res = await fetchHistory(sideTokenId(entry), endTs - MARKOUT_WINDOW_S, endTs); } catch { res = null; }
      const points = (res?.history ?? []).filter((pt) => pt.t <= endTs);
      const last = points.length > 0 ? points[points.length - 1].p : null;
      let value;
      if (last != null) {
        // Already settled (0/1) → the move is the resolution, not line movement
        value = last >= SETTLED_HIGH || last <= SETTLED_LOW ? null : (last - entry.marketPrice) * 100;
      } else if (now - at > MARKOUT_GIVE_UP_DAYS * DAY_MS) {
        value = null; // history pruned or never recorded
      } else {
        continue; // nothing yet — retry next time
      }
      if (updateJournalEntry(entry.id, { [h.key]: value })) stored++;
    }
  }
  return stored;
}

/** Average markout per horizon, in cents: { markout1d: { avg, n }, markout7d: { avg, n } }. */
export function summarizeMarkouts(entries = getJournalEntries()) {
  const out = {};
  for (const h of MARKOUT_HORIZONS) {
    const vals = entries.map((e) => e[h.key]).filter((v) => Number.isFinite(v));
    out[h.key] = { avg: vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null, n: vals.length };
  }
  return out;
}

// ─── Auto-resolution ────────────────────────────────────────────────

const SETTLED_HIGH = 0.99;
const SETTLED_LOW = 0.01;
const AUTO_RESOLVE_DELAY_MS = 250;
const AUTO_RESOLVE_MAX = 20; // lookups per run
const AUTO_RESOLVE_RECHECK_MS = 60 * 60 * 1000; // an unsettled market is looked up at most hourly

/**
 * The journal outcome a settled market implies for an entry, from a raw
 * Gamma market (as /markets/{id} returns it): 'WIN' / 'LOSS' for the entry's
 * side, 'SCRATCH' for a 50/50 (void) settlement, null while unsettled.
 */
export function outcomeFromSettledMarket(entry, rawMarket) {
  if (!rawMarket || rawMarket.closed !== true) return null;
  let prices = rawMarket.outcomePrices;
  if (typeof prices === 'string') {
    try { prices = JSON.parse(prices); } catch { return null; }
  }
  const yes = parseFloat(prices?.[0]);
  const no = parseFloat(prices?.[1]);
  if (!Number.isFinite(yes) || !Number.isFinite(no)) return null;
  let yesWon;
  if (yes >= SETTLED_HIGH && no <= SETTLED_LOW) yesWon = true;
  else if (no >= SETTLED_HIGH && yes <= SETTLED_LOW) yesWon = false;
  else if (Math.abs(yes - 0.5) < 0.01 && Math.abs(no - 0.5) < 0.01) return 'SCRATCH';
  else return null; // closed but not settled yet
  return (entry.side === 'YES') === yesWon ? 'WIN' : 'LOSS';
}

/** Unresolved entries that may have settled: past their end date, or with none recorded. */
function dueForResolution(entry, now) {
  if (entry.resolved || !entry.marketId) return false;
  if (entry.resolutionCheckedAt && now - entry.resolutionCheckedAt < AUTO_RESOLVE_RECHECK_MS) return false;
  if (!entry.endDate) return true;
  const end = Date.parse(entry.endDate);
  return !Number.isFinite(end) || end <= now;
}

/**
 * Look up due, unresolved entries and resolve those whose market has settled.
 * Sequential and throttled (it runs when the journal is opened).
 *
 * @param {function} fetchMarket — async (marketId) => raw Gamma market | null
 * @returns {Promise<number>} entries resolved
 */
export async function autoResolveJournal(fetchMarket, { now = Date.now(), delayMs = AUTO_RESOLVE_DELAY_MS, signal } = {}) {
  const due = getJournalEntries().filter((e) => dueForResolution(e, now)).slice(0, AUTO_RESOLVE_MAX);
  let resolved = 0;
  for (let i = 0; i < due.length; i++) {
    if (signal?.aborted) break;
    if (i > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    let raw = null;
    try { raw = await fetchMarket(due[i].marketId); } catch { raw = null; }
    const outcome = outcomeFromSettledMarket(due[i], raw);
    if (outcome && resolveJournalEntry(due[i].id, outcome, { auto: true })) resolved++;
    else if (raw) updateJournalEntry(due[i].id, { resolutionCheckedAt: now }); // a failed lookup is retried next time
  }
  return resolved;
}
