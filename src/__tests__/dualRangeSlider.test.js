import { describe, it, expect, afterEach, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); });
import { createScaleMapper, smartRound, parseSliderValue } from '../components/DualRangeSlider';

// ── createScaleMapper ────────────────────────────────────────────

describe('createScaleMapper — linear', () => {
  const { toSlider, fromSlider } = createScaleMapper(0, 100, false);

  it('maps min to 0', () => {
    expect(toSlider(0)).toBe(0);
  });

  it('maps max to 1000', () => {
    expect(toSlider(100)).toBe(1000);
  });

  it('maps midpoint to 500', () => {
    expect(toSlider(50)).toBe(500);
  });

  it('round-trips through toSlider → fromSlider', () => {
    for (const v of [0, 25, 50, 75, 100]) {
      expect(fromSlider(toSlider(v))).toBeCloseTo(v, 5);
    }
  });

  it('fromSlider(0) returns min', () => {
    expect(fromSlider(0)).toBe(0);
  });

  it('fromSlider(1000) returns max', () => {
    expect(fromSlider(1000)).toBe(100);
  });
});

describe('createScaleMapper — linear with offset range', () => {
  const { toSlider, fromSlider } = createScaleMapper(200, 800, false);

  it('maps 200 → 0 and 800 → 1000', () => {
    expect(toSlider(200)).toBe(0);
    expect(toSlider(800)).toBe(1000);
  });

  it('maps 500 → 500', () => {
    expect(toSlider(500)).toBe(500);
  });

  it('round-trips', () => {
    expect(fromSlider(toSlider(350))).toBeCloseTo(350, 5);
  });
});

describe('createScaleMapper — cubic (log scale)', () => {
  const { toSlider, fromSlider } = createScaleMapper(0, 50_000_000, true);

  it('maps min to 0 and max to 1000', () => {
    expect(toSlider(0)).toBe(0);
    expect(toSlider(50_000_000)).toBe(1000);
  });

  it('gives more resolution at the low end', () => {
    // 1% of range ($500K) should map to ~21% of slider (cube root of 0.01 ≈ 0.215)
    const sliderPos = toSlider(500_000);
    expect(sliderPos).toBeGreaterThan(200);
    expect(sliderPos).toBeLessThan(230);
  });

  it('round-trips through toSlider → fromSlider within 0.3% of range', () => {
    for (const v of [0, 100_000, 1_000_000, 10_000_000, 50_000_000]) {
      const rt = fromSlider(toSlider(v));
      // Cubic slider with 1000 integer steps: max quantization error ~0.15%
      expect(Math.abs(rt - v)).toBeLessThan(50_000_000 * 0.003);
    }
  });

  it('fromSlider(500) maps to ~12.5% of range (cubic)', () => {
    // (500/1000)^3 = 0.125 → $6.25M
    const val = fromSlider(500);
    expect(val).toBeCloseTo(6_250_000, -4);
  });
});

// ── smartRound ───────────────────────────────────────────────────

describe('smartRound — small ranges (≤1000)', () => {
  it('rounds to nearest integer for range ≤ 200', () => {
    expect(smartRound(3.7, 0, 100)).toBe(4);
    expect(smartRound(50.2, 0, 200)).toBe(50);
  });

  it('rounds to nearest integer for range ≤ 1000', () => {
    expect(smartRound(123.6, 0, 1000)).toBe(124);
    expect(smartRound(999.4, 0, 1000)).toBe(999);
  });
});

describe('smartRound — large ranges (volume dollars)', () => {
  const min = 0;
  const max = 50_000_000;

  it('rounds to nearest 100 for values < 10K', () => {
    expect(smartRound(5_432, min, max)).toBe(5_400);
    expect(smartRound(9_950, min, max)).toBe(10_000);
  });

  it('rounds to nearest 1K for values 10K–100K', () => {
    expect(smartRound(23_456, min, max)).toBe(23_000);
    expect(smartRound(99_500, min, max)).toBe(100_000);
  });

  it('rounds to nearest 5K for values 100K–1M', () => {
    expect(smartRound(123_456, min, max)).toBe(125_000);
    expect(smartRound(997_500, min, max)).toBe(1_000_000);
  });

  it('rounds to nearest 25K for values 1M–10M', () => {
    expect(smartRound(1_234_567, min, max)).toBe(1_225_000);
    expect(smartRound(9_987_500, min, max)).toBe(10_000_000);
  });

  it('rounds to nearest 100K for values ≥ 10M', () => {
    expect(smartRound(12_345_678, min, max)).toBe(12_300_000);
    expect(smartRound(49_950_000, min, max)).toBe(50_000_000);
  });
});

describe('smartRound — edge cases', () => {
  it('handles zero', () => {
    expect(smartRound(0, 0, 50_000_000)).toBe(0);
  });

  it('handles exact boundaries', () => {
    expect(smartRound(100, 0, 100)).toBe(100);
    expect(smartRound(0, 0, 100)).toBe(0);
  });

  it('handles negative values in rounding', () => {
    // smartRound uses Math.abs for threshold checks
    expect(smartRound(-5_432, -50_000_000, 50_000_000)).toBe(-5_400);
  });
});

// ── Defensive / error paths ─────────────────────────────────────

describe('createScaleMapper — defensive inputs', () => {
  it('does not throw on NaN input to toSlider', () => {
    const { toSlider } = createScaleMapper(0, 100, false);
    expect(() => toSlider(NaN)).not.toThrow();
  });

  it('does not throw on Infinity input to toSlider', () => {
    const { toSlider } = createScaleMapper(0, 100, false);
    expect(() => toSlider(Infinity)).not.toThrow();
  });

  it('does not throw on NaN input to fromSlider', () => {
    const { fromSlider } = createScaleMapper(0, 100, false);
    expect(() => fromSlider(NaN)).not.toThrow();
  });

  it('handles min === max without division by zero', () => {
    const { toSlider, fromSlider } = createScaleMapper(50, 50, false);
    expect(() => toSlider(50)).not.toThrow();
    expect(() => fromSlider(500)).not.toThrow();
  });
});

describe('smartRound — defensive inputs', () => {
  it('does not throw on NaN', () => {
    expect(() => smartRound(NaN, 0, 100)).not.toThrow();
  });

  it('does not throw on Infinity', () => {
    expect(() => smartRound(Infinity, 0, 100)).not.toThrow();
  });

  it('does not throw when min > max', () => {
    expect(() => smartRound(50, 100, 0)).not.toThrow();
  });
});

describe('parseSliderValue (slider text boxes)', () => {
  it('reads K/M/B suffixes as displayed in the Volume boxes', () => {
    expect(parseSliderValue('$15K')).toBe(15_000);
    expect(parseSliderValue('$20k')).toBe(20_000);
    expect(parseSliderValue('$1.5M')).toBe(1_500_000);
    expect(parseSliderValue('2b')).toBe(2_000_000_000);
  });

  it('reads plain numbers and ignores symbols', () => {
    expect(parseSliderValue('365')).toBe(365);
    expect(parseSliderValue('50¢')).toBe(50);
    expect(parseSliderValue('$25,000')).toBe(25_000);
    expect(parseSliderValue(' 12.5 ')).toBe(12.5);
  });

  it('returns NaN for non-numeric input', () => {
    expect(parseSliderValue('')).toBeNaN();
    expect(parseSliderValue('-')).toBeNaN();
    expect(parseSliderValue('abc')).toBeNaN();
    expect(parseSliderValue('K')).toBeNaN();
  });
});
