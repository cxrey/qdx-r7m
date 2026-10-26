/**
 * Decision-journal scoring: Brier / log loss against what happened to YES,
 * the market-price benchmark, and auto-resolution from settled markets.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  computeCalibrationMetrics,
  yesOutcome,
  marketYesProb,
  outcomeFromSettledMarket,
  autoResolveJournal,
  saveJournalEntry,
  getJournalEntries,
} from '../KellyEngine.js';

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

const entry = (over) => ({ resolved: true, side: 'YES', outcome: 'WIN', estProb: 0.6, marketPrice: 0.5, ...over });

describe('scoring basis', () => {
  it('a winning NO bet means YES did not happen', () => {
    expect(yesOutcome(entry({ side: 'NO', outcome: 'WIN' }))).toBe(0);
    expect(yesOutcome(entry({ side: 'NO', outcome: 'LOSS' }))).toBe(1);
    expect(yesOutcome(entry({ side: 'YES', outcome: 'WIN' }))).toBe(1);
    expect(yesOutcome(entry({ outcome: 'SCRATCH' }))).toBeNull();
    expect(yesOutcome(entry({ resolved: false }))).toBeNull();
  });

  it('a winning NO bet at P(YES)=0.2 scores 0.04, not 0.64', () => {
    const m = computeCalibrationMetrics([entry({ side: 'NO', outcome: 'WIN', estProb: 0.2, marketPrice: 0.7 })]);
    expect(m.brierScore).toBeCloseTo(0.04, 10);
  });

  it('the market benchmark converts a NO price to P(YES)', () => {
    expect(marketYesProb(entry({ side: 'NO', marketPrice: 0.7 }))).toBeCloseTo(0.3, 10);
    expect(marketYesProb(entry({ side: 'YES', marketPrice: 0.7 }))).toBe(0.7);
  });

  it('calibration buckets count YES outcomes, whichever side was bet', () => {
    const m = computeCalibrationMetrics([
      entry({ side: 'NO', outcome: 'WIN', estProb: 0.25 }), // YES didn't happen
      entry({ side: 'YES', outcome: 'WIN', estProb: 0.22 }), // YES happened
    ]);
    expect(m.buckets).toHaveLength(1);
    expect(m.buckets[0]).toMatchObject({ range: '20-30%', count: 2, wins: 1, actualRate: 0.5 });
  });
});

describe('scores', () => {
  it('log loss of a single YES at p=0.8 is −ln 0.8', () => {
    const m = computeCalibrationMetrics([entry({ estProb: 0.8 })]);
    expect(m.logLoss).toBeCloseTo(-Math.log(0.8), 10);
  });

  it('log loss is clipped so a 0% call that happened is finite', () => {
    const m = computeCalibrationMetrics([entry({ estProb: 0 })]);
    expect(m.logLoss).toBeCloseTo(-Math.log(0.01), 10);
  });

  it('skill is 0 when your estimates equal the market price', () => {
    const m = computeCalibrationMetrics([
      entry({ estProb: 0.6, marketPrice: 0.6 }),
      entry({ side: 'NO', outcome: 'LOSS', estProb: 0.3, marketPrice: 0.7 }),
    ]);
    expect(m.skillScore).toBeCloseTo(0, 10);
  });

  it('skill is positive when you were closer than the market', () => {
    const m = computeCalibrationMetrics([entry({ estProb: 0.8, marketPrice: 0.5 })]);
    expect(m.marketBrier).toBeCloseTo(0.25, 10);
    expect(m.skillScore).toBeCloseTo(1 - 0.04 / 0.25, 10);
  });

  it('flags a small sample', () => {
    expect(computeCalibrationMetrics([entry()]).smallSample).toBe(true);
  });
});

describe('outcomeFromSettledMarket', () => {
  const raw = (prices, closed = true) => ({ closed, outcomePrices: JSON.stringify(prices) });
  it('maps a settled market to WIN/LOSS for the entry side', () => {
    expect(outcomeFromSettledMarket({ side: 'YES' }, raw(['1', '0']))).toBe('WIN');
    expect(outcomeFromSettledMarket({ side: 'NO' }, raw(['1', '0']))).toBe('LOSS');
    expect(outcomeFromSettledMarket({ side: 'NO' }, raw(['0', '1']))).toBe('WIN');
  });
  it('a 50/50 settlement is a scratch', () => {
    expect(outcomeFromSettledMarket({ side: 'YES' }, raw(['0.5', '0.5']))).toBe('SCRATCH');
  });
  it('an open or unsettled market resolves nothing', () => {
    expect(outcomeFromSettledMarket({ side: 'YES' }, raw(['1', '0'], false))).toBeNull();
    expect(outcomeFromSettledMarket({ side: 'YES' }, raw(['0.97', '0.03']))).toBeNull();
    expect(outcomeFromSettledMarket({ side: 'YES' }, null)).toBeNull();
  });
});

describe('autoResolveJournal', () => {
  const NOW = Date.parse('2026-10-26T12:00:00Z');
  const past = '2026-10-20T00:00:00Z';
  const future = '2026-12-01T00:00:00Z';

  it('resolves settled markets, leaves open ones, and skips entries not yet due', async () => {
    saveJournalEntry({ marketId: 'settled', side: 'NO', estProb: 0.3, marketPrice: 0.7, endDate: past });
    saveJournalEntry({ marketId: 'open', side: 'YES', estProb: 0.6, marketPrice: 0.5, endDate: past });
    saveJournalEntry({ marketId: 'future', side: 'YES', estProb: 0.6, marketPrice: 0.5, endDate: future });
    const fetchMarket = vi.fn(async (id) => (id === 'settled'
      ? { closed: true, outcomePrices: '["0","1"]' }
      : { closed: false, outcomePrices: '["0.6","0.4"]' }));

    const n = await autoResolveJournal(fetchMarket, { now: NOW, delayMs: 0 });
    expect(n).toBe(1);
    expect(fetchMarket.mock.calls.map(([id]) => id).sort()).toEqual(['open', 'settled']);
    const byId = Object.fromEntries(getJournalEntries().map((e) => [e.marketId, e]));
    expect(byId.settled).toMatchObject({ resolved: true, outcome: 'WIN', autoResolved: true });
    expect(byId.open.resolved).toBe(false);
    expect(byId.future.resolved).toBe(false);
  });

  it('an unsettled market is looked up at most hourly; a failed lookup is retried', async () => {
    saveJournalEntry({ marketId: 'open', side: 'YES', estProb: 0.6, marketPrice: 0.5, endDate: past });
    saveJournalEntry({ marketId: 'down', side: 'YES', estProb: 0.6, marketPrice: 0.5, endDate: past });
    const fetchMarket = vi.fn(async (id) => (id === 'open' ? { closed: false, outcomePrices: '["0.6","0.4"]' } : null));
    await autoResolveJournal(fetchMarket, { now: NOW, delayMs: 0 });
    await autoResolveJournal(fetchMarket, { now: NOW + 10 * 60_000, delayMs: 0 });
    expect(fetchMarket.mock.calls.map(([id]) => id).sort()).toEqual(['down', 'down', 'open']);
  });
});
