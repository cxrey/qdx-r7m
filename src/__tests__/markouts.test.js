/**
 * Markouts: the bet side's price 1 and 7 days after a journal entry, minus
 * the entry price — stored once found, not applicable after resolution.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { saveJournalEntry, getJournalEntries, updateMarkouts, summarizeMarkouts } from '../KellyEngine.js';

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

const DAY = 86_400_000;
const CREATED = Date.parse('2026-10-01T00:00:00Z');
const at = (days) => Math.floor((CREATED + days * DAY) / 1000);
const record = (over) => saveJournalEntry({
  marketId: 'm', side: 'YES', estProb: 0.6, marketPrice: 0.40,
  yesTokenId: 'yes-tok', noTokenId: 'no-tok', endDate: '2026-12-31T00:00:00Z',
  ...over,
  createdAt: new Date(CREATED).toISOString(),
});
// History ending exactly at the horizon, with the given last price
const historyAt = (price) => vi.fn(async (_tok, _start, end) => ({ history: [{ t: end - 3600, p: 0.1 }, { t: end, p: price }] }));
const byKey = () => getJournalEntries()[0];

describe('updateMarkouts', () => {
  it('stores the side price move at +1d and +7d, in cents', async () => {
    record();
    const fetchHistory = historyAt(0.45);
    const n = await updateMarkouts(fetchHistory, { now: CREATED + 8 * DAY, delayMs: 0 });
    expect(n).toBe(2);
    expect(byKey().markout1d).toBeCloseTo(5, 10);
    expect(byKey().markout7d).toBeCloseTo(5, 10);
    expect(fetchHistory.mock.calls.map(([tok, , end]) => [tok, end])).toEqual([['yes-tok', at(1)], ['yes-tok', at(7)]]);
  });

  it('reads the NO token for a NO bet, so a NO price rise is positive', async () => {
    record({ side: 'NO', marketPrice: 0.60 });
    const fetchHistory = historyAt(0.55);
    await updateMarkouts(fetchHistory, { now: CREATED + 2 * DAY, delayMs: 0 });
    expect(fetchHistory.mock.calls[0][0]).toBe('no-tok');
    expect(byKey().markout1d).toBeCloseTo(-5, 10);
    expect(byKey().markout7d).toBeUndefined(); // not due yet
  });

  it('does not refetch a stored markout', async () => {
    record();
    const fetchHistory = historyAt(0.45);
    await updateMarkouts(fetchHistory, { now: CREATED + 2 * DAY, delayMs: 0 });
    await updateMarkouts(fetchHistory, { now: CREATED + 3 * DAY, delayMs: 0 });
    expect(fetchHistory).toHaveBeenCalledTimes(1);
  });

  it('a horizon at or after the market end, or a settled price, is not applicable', async () => {
    record({ endDate: new Date(CREATED + 3 * DAY).toISOString() });
    const fetchHistory = historyAt(0.995);
    await updateMarkouts(fetchHistory, { now: CREATED + 8 * DAY, delayMs: 0 });
    expect(byKey().markout1d).toBeNull(); // settled price
    expect(byKey().markout7d).toBeNull(); // after the end date — not even fetched
    expect(fetchHistory).toHaveBeenCalledTimes(1);
  });

  it('no history yet is retried; long-missing history is given up on', async () => {
    record();
    const empty = vi.fn(async () => ({ history: [] }));
    await updateMarkouts(empty, { now: CREATED + 2 * DAY, delayMs: 0 });
    expect(byKey().markout1d).toBeUndefined();
    await updateMarkouts(empty, { now: CREATED + 40 * DAY, delayMs: 0 });
    expect(byKey().markout1d).toBeNull();
  });
});

describe('summarizeMarkouts', () => {
  it('averages the stored values and ignores not-applicable ones', () => {
    const s = summarizeMarkouts([{ markout1d: 4 }, { markout1d: -2 }, { markout1d: null }, {}]);
    expect(s.markout1d).toEqual({ avg: 1, n: 2 });
    expect(s.markout7d).toEqual({ avg: null, n: 0 });
  });
});
