import { describe, it, expect } from 'vitest';
import { toYesHistory } from '../detailPanelData';

describe('toYesHistory (what ThetaCard measures against YES theta)', () => {
  const noHistory = { history: [{ t: 1, p: 0.3 }, { t: 2, p: 0.35 }] };

  it('With No selected, converts the NO history to YES prices (1 − p)', () => {
    const yes = toYesHistory(noHistory, 'no');
    expect(yes.history.map((pt) => pt.t)).toEqual([1, 2]);
    expect(yes.history[0].p).toBeCloseTo(0.7);
    expect(yes.history[1].p).toBeCloseTo(0.65);
  });

  it('passes YES history (and missing data) through unchanged', () => {
    expect(toYesHistory(noHistory, 'yes')).toBe(noHistory);
    expect(toYesHistory(null, 'no')).toBeNull();
  });
});
