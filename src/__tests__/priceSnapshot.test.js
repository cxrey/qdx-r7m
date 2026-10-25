import { describe, it, expect } from 'vitest';
import { buildIndexMap, diffPriceSnapshot, shouldRefilter } from '../utils/priceSnapshot';

const markets = [
  { id: 'a', yesPrice: 0.50, noPrice: 0.50 },
  { id: 'b', yesPrice: 0.20, noPrice: 0.80 },
  { id: 'c', yesPrice: null, noPrice: null },
];

describe('buildIndexMap', () => {
  it('maps market id to array index', () => {
    expect([...buildIndexMap(markets)]).toEqual([['a', 0], ['b', 1], ['c', 2]]);
  });
});

describe('diffPriceSnapshot', () => {
  it('flags an up move with the tick sequence number', () => {
    const { priceChanged, flashes } = diffPriceSnapshot(markets, new Map([['a', { yesPrice: 0.52, noPrice: 0.48 }]]), 7);
    expect(priceChanged).toBe(true);
    expect(flashes).toEqual({ a: 'up:7' });
  });

  it('flags a down move', () => {
    const { flashes } = diffPriceSnapshot(markets, new Map([['b', { yesPrice: 0.15, noPrice: 0.85 }]]), 3);
    expect(flashes).toEqual({ b: 'down:3' });
  });

  it('reports no change (and no flash) when the update matches the displayed price', () => {
    const { priceChanged, flashes } = diffPriceSnapshot(markets, new Map([['a', { yesPrice: 0.50, noPrice: 0.50 }]]), 1);
    expect(priceChanged).toBe(false);
    expect(flashes).toEqual({});
  });

  it('counts a NO-only change as a price change without a YES flash', () => {
    const { priceChanged, flashes } = diffPriceSnapshot(markets, new Map([['a', { noPrice: 0.49 }]]), 1);
    expect(priceChanged).toBe(true);
    expect(flashes).toEqual({});
  });

  it('does not flash a market getting its first price', () => {
    const { priceChanged, flashes } = diffPriceSnapshot(markets, new Map([['c', { yesPrice: 0.3, noPrice: 0.7 }]]), 1);
    expect(priceChanged).toBe(true);
    expect(flashes).toEqual({});
  });

  it('ignores updates for markets that are not loaded', () => {
    const { priceChanged, flashes } = diffPriceSnapshot(markets, new Map([['zzz', { yesPrice: 0.9 }]]), 1);
    expect(priceChanged).toBe(false);
    expect(flashes).toEqual({});
  });

  it('gives consecutive same-direction moves distinct flash values', () => {
    const first = diffPriceSnapshot(markets, new Map([['a', { yesPrice: 0.51 }]]), 1).flashes.a;
    const second = diffPriceSnapshot(markets, new Map([['a', { yesPrice: 0.51 }]]), 2).flashes.a;
    expect(first).not.toBe(second);
  });
});

describe('shouldRefilter', () => {
  const arr = [];
  it('re-filters when prices changed', () => {
    expect(shouldRefilter(true, arr, arr)).toBe(true);
  });
  it('re-filters when the markets array changed since the last filter', () => {
    expect(shouldRefilter(false, [], arr)).toBe(true);
  });
  it('skips idle ticks (no price change, same array)', () => {
    expect(shouldRefilter(false, arr, arr)).toBe(false);
  });
});
