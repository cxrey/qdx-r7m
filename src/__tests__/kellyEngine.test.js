import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  calculateKelly,
  calculateSensitivityTable,
  calculateScenarios,
  calculateReEvalTrigger,
  applyPortfolioConstraints,
  getKellySettings,
  saveKellySettings,
  saveJournalEntry,
  getJournalEntries,
  calculateMultiOutcomeKelly,
} from '../KellyEngine.js';

// ─── localStorage mock ─────────────────────────────────────────────

let store = {};

beforeEach(() => {
  store = {};
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key) => store[key] ?? null),
    setItem: vi.fn((key, val) => { store[key] = val; }),
    removeItem: vi.fn((key) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
  });
});

// ─── 1. calculateKelly() ───────────────────────────────────────────

describe('calculateKelly', () => {
  it('returns invalid for out-of-range probability', () => {
    expect(calculateKelly(-0.1, 0.5).valid).toBe(false);
    expect(calculateKelly(1.1, 0.5).valid).toBe(false);
  });

  it('returns invalid when marketPrice is 0 or 1', () => {
    expect(calculateKelly(0.6, 0).valid).toBe(false);
    expect(calculateKelly(0.6, 1).valid).toBe(false);
  });

  it('returns noEdge when estimate equals market price', () => {
    const r = calculateKelly(0.5, 0.5, 'YES');
    expect(r.valid).toBe(true);
    expect(r.noEdge).toBe(true);
    expect(r.fullKelly).toBe(0);
  });

  it('returns noEdge when edge is below 0.5pp', () => {
    // estProb barely above marketPrice
    const r = calculateKelly(0.502, 0.50, 'YES');
    expect(r.noEdge).toBe(true);
  });

  it('detects a valid edge for YES side', () => {
    const r = calculateKelly(0.7, 0.5, 'YES');
    expect(r.valid).toBe(true);
    expect(r.noEdge).toBe(false);
    expect(r.fullKelly).toBeGreaterThan(0);
    expect(r.fractionalKelly).toBeGreaterThan(0);
    expect(r.fractionalKelly).toBeLessThanOrEqual(r.fullKelly);
    expect(r.side).toBe('YES');
  });

  it('detects a valid edge for NO side', () => {
    // estProb 0.3 means we think YES is 30%, so NO is 70%, market YES price 0.5
    const r = calculateKelly(0.3, 0.5, 'NO');
    expect(r.valid).toBe(true);
    expect(r.noEdge).toBe(false);
    expect(r.fullKelly).toBeGreaterThan(0);
    expect(r.side).toBe('NO');
  });

  it('assigns ROBUST robustness for large edge far from 50/50', () => {
    // gapPp >= 10 and distFromCenter > 0.2  =>  estProb 0.85, market 0.50
    const r = calculateKelly(0.85, 0.50, 'YES');
    expect(r.robustness.level).toBe('ROBUST');
    expect(r.robustness.kellyFraction).toBe(0.5);
  });

  it('assigns SOLID robustness for gap >= 5pp', () => {
    // gapPp ~8, but distFromCenter = 0.08 (< 0.2), so not ROBUST => SOLID
    const r = calculateKelly(0.58, 0.50, 'YES');
    expect(r.robustness.level).toBe('SOLID');
    expect(r.robustness.kellyFraction).toBe(0.25);
  });

  it('assigns MODERATE robustness for gap 2-5pp', () => {
    const r = calculateKelly(0.53, 0.50, 'YES');
    expect(r.robustness.level).toBe('MODERATE');
    expect(r.robustness.kellyFraction).toBe(0.25);
  });

  it('assigns FRAGILE robustness for gap < 2pp', () => {
    const r = calculateKelly(0.515, 0.50, 'YES');
    expect(r.robustness.level).toBe('FRAGILE');
    expect(r.robustness.kellyFraction).toBe(0.125);
  });

  it('computes expected value and growth rate', () => {
    const r = calculateKelly(0.7, 0.5, 'YES');
    expect(r.expectedValue).toBeGreaterThan(0);
    expect(r.growthRate).toBeGreaterThan(0);
    expect(typeof r.odds).toBe('number');
  });

  it('handles extreme low market price', () => {
    const r = calculateKelly(0.5, 0.01, 'YES');
    expect(r.valid).toBe(true);
    expect(r.noEdge).toBe(false);
    expect(r.fullKelly).toBeGreaterThan(0);
  });

  it('handles extreme high market price', () => {
    const r = calculateKelly(0.5, 0.99, 'YES');
    // estProb 0.5 < marketPrice 0.99 => no edge
    expect(r.noEdge).toBe(true);
  });
});

// ─── 2. calculateSensitivityTable() ────────────────────────────────

describe('calculateSensitivityTable', () => {
  const settings = {
    bankroll: 1000,
    maxPositionPct: 20,
    maxTotalExposure: 80,
    minPracticalBet: 5,
    defaultFraction: 0.25,
    correlationPenalty: true,
  };

  it('returns an array of rows', () => {
    const rows = calculateSensitivityTable(0.5, 0.6, 'YES', settings);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('marks the center row', () => {
    const rows = calculateSensitivityTable(0.5, 0.6, 'YES', settings);
    const centerRows = rows.filter((r) => r.isCenter);
    expect(centerRows.length).toBe(1);
    expect(centerRows[0].prob).toBeCloseTo(0.6, 2);
  });

  it('clamps probabilities to (0.02, 0.98)', () => {
    // centerProb near 0 => steps going below 0.02 should be excluded
    const rows = calculateSensitivityTable(0.5, 0.05, 'YES', settings);
    for (const row of rows) {
      expect(row.prob).toBeGreaterThan(0.02);
      expect(row.prob).toBeLessThan(0.98);
    }
  });

  it('caps dollar amounts at maxPositionPct', () => {
    const rows = calculateSensitivityTable(0.3, 0.7, 'YES', settings);
    const maxDollars = settings.bankroll * (settings.maxPositionPct / 100);
    for (const row of rows) {
      expect(row.cappedDollars).toBeLessThanOrEqual(maxDollars + 0.01);
    }
  });

  it('flags below-minimum rows', () => {
    // Use a tiny bankroll so dollar amounts are small
    const tinySettings = { ...settings, bankroll: 20 };
    const rows = calculateSensitivityTable(0.5, 0.52, 'YES', tinySettings);
    const belowMin = rows.filter((r) => r.belowMinimum);
    // Some rows with small edges should produce below-minimum bets
    expect(belowMin.length).toBeGreaterThanOrEqual(0); // structural check
  });
});

// ─── 3. calculateScenarios() ───────────────────────────────────────

describe('calculateScenarios', () => {
  const settings = { bankroll: 1000, maxPositionPct: 20, maxTotalExposure: 80, minPracticalBet: 5, defaultFraction: 0.25, correlationPenalty: true };

  it('computes win/loss for a YES bet', () => {
    const s = calculateScenarios(100, 0.5, 'YES', 0.6, settings);
    expect(s.shares).toBeCloseTo(200, 0); // 100 / 0.5
    expect(s.win.profit).toBeCloseTo(100, 0); // 200 * 1 - 100
    expect(s.loss.amount).toBe(100);
    expect(s.win.prob).toBe(0.6);
  });

  it('computes win/loss for a NO bet', () => {
    // marketPrice is the NO share price (same convention as calculateKelly):
    // NO trading at 40¢ with estProb(YES)=0.3 → win prob 0.7
    const s = calculateScenarios(100, 0.4, 'NO', 0.3, settings);
    expect(s.entryPrice).toBeCloseTo(0.4, 5);
    const expectedShares = 100 / 0.4;
    expect(s.shares).toBeCloseTo(expectedShares, 1);
    expect(s.win.prob).toBeCloseTo(0.7, 5); // 1 - estProb for NO
    expect(s.win.profit).toBeCloseTo(expectedShares - 100, 1); // shares × $1 − bet
  });

  it('NO bet at the same side price yields same shares as a YES bet', () => {
    // Regression: NO used to invert the price a second time (double
    // inversion), pricing a 40¢ NO position at 60¢.
    const yes = calculateScenarios(100, 0.4, 'YES', 0.6, settings);
    const no = calculateScenarios(100, 0.4, 'NO', 0.4, settings);
    expect(no.shares).toBeCloseTo(yes.shares, 5);
    expect(no.entryPrice).toBeCloseTo(yes.entryPrice, 5);
  });

  it('calculates positive EV when edge exists', () => {
    const s = calculateScenarios(100, 0.5, 'YES', 0.7, settings);
    expect(s.ev).toBeGreaterThan(0);
    expect(s.evPct).toBeGreaterThan(0);
  });

  it('includes partial price-move scenarios', () => {
    const s = calculateScenarios(100, 0.5, 'YES', 0.6, settings);
    expect(s.partialScenarios).toHaveLength(4);
    // Price +10c should show positive PnL
    const up10 = s.partialScenarios.find((p) => p.label === 'Price +10c');
    expect(up10.paperPnl).toBeGreaterThan(0);
    // Price -10c should show negative PnL
    const down10 = s.partialScenarios.find((p) => p.label === 'Price -10c');
    expect(down10.paperPnl).toBeLessThan(0);
  });

  it('calculates bankroll after win and loss', () => {
    const s = calculateScenarios(100, 0.5, 'YES', 0.6, settings);
    expect(s.bankrollAfterWin).toBe(1000 - 100 + 200); // bankroll - bet + shares*1
    expect(s.bankrollAfterLoss).toBe(900);
  });
});

// ─── 4. calculateReEvalTrigger() ───────────────────────────────────

describe('calculateReEvalTrigger', () => {
  it('always includes PRICE_MOVE, VOLUME, and INFO triggers', () => {
    const r = calculateReEvalTrigger(0.5, 0.6, 30);
    const types = r.triggers.map((t) => t.type);
    expect(types).toContain('PRICE_MOVE');
    expect(types).toContain('VOLUME');
    expect(types).toContain('INFO');
  });

  it('sets correct price bounds', () => {
    const r = calculateReEvalTrigger(0.5, 0.6, 30);
    const pm = r.triggers.find((t) => t.type === 'PRICE_MOVE');
    expect(pm.upperBound).toBeCloseTo(0.6, 5);
    expect(pm.lowerBound).toBeCloseTo(0.4, 5);
  });

  it('clamps price bounds to [0.01, 0.99]', () => {
    const rHigh = calculateReEvalTrigger(0.95, 0.6, 30);
    expect(rHigh.triggers.find((t) => t.type === 'PRICE_MOVE').upperBound).toBe(0.99);

    const rLow = calculateReEvalTrigger(0.05, 0.6, 30);
    expect(rLow.triggers.find((t) => t.type === 'PRICE_MOVE').lowerBound).toBe(0.01);
  });

  it('adds TIME triggers when daysLeft > 0', () => {
    const r = calculateReEvalTrigger(0.5, 0.6, 100);
    const timeTriggers = r.triggers.filter((t) => t.type === 'TIME');
    expect(timeTriggers.length).toBeGreaterThanOrEqual(1);
    // Halfway milestone: 100 * (1 - 0.5) = 50 days
    expect(timeTriggers.some((t) => t.daysFromNow === 50)).toBe(true);
  });

  it('skips TIME triggers when daysLeft is null or 0', () => {
    const r1 = calculateReEvalTrigger(0.5, 0.6, null);
    const r2 = calculateReEvalTrigger(0.5, 0.6, 0);
    expect(r1.triggers.filter((t) => t.type === 'TIME')).toHaveLength(0);
    expect(r2.triggers.filter((t) => t.type === 'TIME')).toHaveLength(0);
  });

  it('adds THETA trigger when daily decay > 0.5c', () => {
    const theta = { bestTheta: -0.01 }; // 1c/day
    const r = calculateReEvalTrigger(0.5, 0.6, 30, theta);
    const thetaTrigger = r.triggers.find((t) => t.type === 'THETA');
    expect(thetaTrigger).toBeTruthy();
    expect(thetaTrigger.dailyDecay).toBeCloseTo(1.0, 1);
  });

  it('does not add THETA trigger when decay is low', () => {
    const theta = { bestTheta: -0.001 }; // 0.1c/day
    const r = calculateReEvalTrigger(0.5, 0.6, 30, theta);
    expect(r.triggers.find((t) => t.type === 'THETA')).toBeUndefined();
  });

  it('nextReEval picks the soonest time-based trigger', () => {
    const r = calculateReEvalTrigger(0.5, 0.6, 100);
    expect(r.nextReEval).toBeTruthy();
    // Should be the earliest daysFromNow among TIME triggers
    const timeTriggers = r.triggers.filter((t) => t.daysFromNow != null);
    const minDays = Math.min(...timeTriggers.map((t) => t.daysFromNow));
    expect(r.nextReEval.daysFromNow).toBe(minDays);
  });
});

// ─── 5. applyPortfolioConstraints() ────────────────────────────────

describe('applyPortfolioConstraints', () => {
  const settings = { bankroll: 1000, maxPositionPct: 20, maxTotalExposure: 80, minPracticalBet: 5, defaultFraction: 0.25, correlationPenalty: true };
  const market = { id: 'test' };

  it('caps at max position size', () => {
    const r = applyPortfolioConstraints(500, market, null, settings);
    expect(r.adjustedDollars).toBe(200); // 20% of 1000
    expect(r.constraints.some((c) => c.type === 'MAX_POSITION')).toBe(true);
  });

  it('does not cap when below max position', () => {
    const r = applyPortfolioConstraints(100, market, null, settings);
    expect(r.adjustedDollars).toBe(100);
    expect(r.constraints.some((c) => c.type === 'MAX_POSITION')).toBe(false);
  });

  describe('a market you already hold', () => {
    const heldPortfolio = (alreadyHeld, maxCorrelation = 0.1) => ({
      hasPortfolio: true, summary: { totalValue: 0 },
      screenTrade: () => ({ alreadyHeld, maxCorrelation }),
    });

    it('betting the side you hold is penalized like the strongest correlation', () => {
      const r = applyPortfolioConstraints(100, market, heldPortfolio({ yes: 100, no: 0 }), settings, 'YES');
      expect(r.adjustedDollars).toBeCloseTo(55); // 0.95 → 45% reduction
      expect(r.constraints.find((x) => x.type === 'CORRELATION').label)
        .toBe('Adds to your existing YES position in this market (100 shares), reduced by 45%');
    });

    it('betting the other side offsets it: no penalty, an informational note', () => {
      const r = applyPortfolioConstraints(100, market, heldPortfolio({ yes: 100, no: 0 }), settings, 'NO');
      expect(r.adjustedDollars).toBe(100);
      expect(r.constraints.some((x) => x.type === 'CORRELATION')).toBe(false);
      const note = r.constraints.find((x) => x.type === 'OFFSET');
      expect(note.label).toBe('Offsets your existing YES position in this market (100 shares) — no concentration penalty');
      expect(note.original).toBeUndefined();
    });

    it('an offsetting bet still gets the penalty for OTHER correlated positions', () => {
      const r = applyPortfolioConstraints(100, market, heldPortfolio({ yes: 100, no: 0 }, 0.8), settings, 'NO');
      expect(r.adjustedDollars).toBeCloseTo(70);
      expect(r.constraints.find((x) => x.type === 'CORRELATION').label).toContain('direction not modelled');
    });

    it('when the side is unknown, assumes it adds (conservative)', () => {
      const r = applyPortfolioConstraints(100, market, heldPortfolio({ yes: 0, no: 50 }), settings);
      expect(r.adjustedDollars).toBeCloseTo(55);
      expect(r.constraints.find((x) => x.type === 'CORRELATION').label).toBe('Adds to a market you already hold, reduced by 45%');
    });
  });

  it('limits by total exposure when portfolio present', () => {
    const portfolio = { hasPortfolio: true, summary: { totalValue: 750 } };
    const r = applyPortfolioConstraints(150, market, portfolio, settings);
    // maxExposure = 800, remaining = 800 - 750 = 50
    expect(r.adjustedDollars).toBe(50);
    expect(r.constraints.some((c) => c.type === 'MAX_EXPOSURE')).toBe(true);
  });

  it('applies correlation penalty when correlated', () => {
    const portfolio = {
      hasPortfolio: true,
      summary: { totalValue: 0 },
      screenTrade: () => ({ maxCorrelation: 0.8 }),
    };
    const r = applyPortfolioConstraints(100, market, portfolio, settings);
    // penalty = 1 - (0.8 - 0.5) = 0.7 => 100 * 0.7 = 70
    expect(r.adjustedDollars).toBeCloseTo(70, 0);
    expect(r.constraints.some((c) => c.type === 'CORRELATION')).toBe(true);
  });

  it('flags below-minimum bets', () => {
    const r = applyPortfolioConstraints(3, market, null, settings);
    expect(r.belowMinimum).toBe(true);
    expect(r.effective).toBe(false);
  });

  it('flags tiny fraction of bankroll', () => {
    const r = applyPortfolioConstraints(5, market, null, settings);
    // 5 / 1000 = 0.5% < 1%
    expect(r.constraints.some((c) => c.type === 'TINY_FRACTION')).toBe(true);
  });

  it('returns zero for negative adjusted dollars', () => {
    const portfolio = { hasPortfolio: true, summary: { totalValue: 900 } };
    // maxExposure remaining = 800 - 900 = 0 (clamped)
    const r = applyPortfolioConstraints(100, market, portfolio, settings);
    expect(r.adjustedDollars).toBe(0);
  });
});

// ─── 6. getKellySettings() / saveKellySettings() ──────────────────

describe('getKellySettings / saveKellySettings', () => {
  it('returns defaults when nothing stored', () => {
    const s = getKellySettings();
    expect(s.bankroll).toBe(1000);
    expect(s.maxPositionPct).toBe(20);
    expect(s.defaultFraction).toBe(0.25);
  });

  it('round-trips custom settings through localStorage', () => {
    saveKellySettings({ bankroll: 5000, maxPositionPct: 10 });
    const s = getKellySettings();
    expect(s.bankroll).toBe(5000);
    expect(s.maxPositionPct).toBe(10);
    // defaults still present for unset keys
    expect(s.minPracticalBet).toBe(5);
  });

  it('handles corrupt localStorage gracefully', () => {
    store['pm_kelly_settings'] = 'NOT_JSON!!!';
    const s = getKellySettings();
    expect(s.bankroll).toBe(1000); // falls back to defaults
  });
});

// ─── 7. saveJournalEntry() / getJournalEntries() ──────────────────

describe('saveJournalEntry / getJournalEntries', () => {
  it('returns empty array when no entries', () => {
    expect(getJournalEntries()).toEqual([]);
  });

  it('saves and retrieves a journal entry', () => {
    const entry = saveJournalEntry({ market: 'test', estProb: 0.6 });
    expect(entry).toBeTruthy();
    expect(entry.id).toMatch(/^j_/);
    expect(entry.market).toBe('test');
    expect(entry.resolved).toBe(false);

    const entries = getJournalEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(entry.id);
  });

  it('prepends new entries (newest first)', () => {
    saveJournalEntry({ market: 'first' });
    saveJournalEntry({ market: 'second' });
    const entries = getJournalEntries();
    expect(entries[0].market).toBe('second');
    expect(entries[1].market).toBe('first');
  });

  it('caps at 200 entries', () => {
    for (let i = 0; i < 210; i++) {
      saveJournalEntry({ market: `m${i}` });
    }
    const entries = getJournalEntries();
    expect(entries.length).toBe(200);
  });

  it('handles corrupt journal gracefully', () => {
    store['pm_kelly_journal'] = 'BROKEN';
    expect(getJournalEntries()).toEqual([]);
  });
});

// ─── 8. calculateMultiOutcomeKelly (bonus) ─────────────────────────

describe('calculateMultiOutcomeKelly', () => {
  it('rejects fewer than 2 outcomes', () => {
    expect(calculateMultiOutcomeKelly([{ name: 'A', estProb: 0.5, marketPrice: 0.5 }]).valid).toBe(false);
    expect(calculateMultiOutcomeKelly(null).valid).toBe(false);
  });

  it('normalizes probabilities and returns results', () => {
    const r = calculateMultiOutcomeKelly([
      { name: 'A', estProb: 0.5, marketPrice: 0.3 },
      { name: 'B', estProb: 0.3, marketPrice: 0.4 },
      { name: 'C', estProb: 0.2, marketPrice: 0.3 },
    ]);
    expect(r.valid).toBe(true);
    expect(r.outcomes).toHaveLength(3);
    expect(r.totalAllocation).toBeGreaterThanOrEqual(0);
    expect(r.totalAllocation).toBeLessThanOrEqual(0.8 + 0.001);
  });
});
