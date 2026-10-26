import { describe, it, expect } from 'vitest';
import { annualizedYield, marketYield, daysToResolution, formatYield } from '../yieldUtils';
import { resolveFeeParams } from '../feeCalculator';
import { filterAndSort } from '../utils/filterAndSort';
import { makeProcessedMarket } from './helpers/marketFixtures';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-26T00:00:00Z');

describe('annualizedYield', () => {
  it('95¢ resolving in 30 days, no fee: (1/0.95)^(365/30) − 1 ≈ 86.65%', () => {
    const y = annualizedYield(0.95, 30);
    expect(y.annualized).toBeCloseTo(Math.pow(1 / 0.95, 365 / 30) - 1, 12);
    expect(y.annualized).toBeCloseTo(0.8665, 4);
    expect(y.simpleReturn).toBeCloseTo(1 / 0.95 - 1, 12);
  });

  it('the taker fee lowers the yield', () => {
    const crypto = resolveFeeParams({ gammaCategory: 'crypto', feesEnabled: true });
    const free = annualizedYield(0.9, 30);
    const withFee = annualizedYield(0.9, 30, crypto);
    expect(withFee.cost).toBeCloseTo(0.9 + 0.07 * 0.09, 12);
    expect(withFee.annualized).toBeLessThan(free.annualized);
  });

  it('buys at the ask (mid + half the spread), not the mid', () => {
    // 96.2¢ mid, 1¢ spread → 96.7¢; 248 days
    const atMid = annualizedYield(0.962, 248);
    const atAsk = annualizedYield(0.962, 248, null, 0.01);
    expect(atAsk.buyPrice).toBeCloseTo(0.967, 12);
    expect(atAsk.annualized).toBeCloseTo(Math.pow(1 / 0.967, 365 / 248) - 1, 12);
    expect(atAsk.annualized).toBeLessThan(atMid.annualized);
  });

  it('marketYield uses the market spread', () => {
    const end = new Date(NOW + 30 * DAY).toISOString();
    const y = marketYield({ yesPrice: 0.9, noPrice: 0.1, spread: 0.02, endDateIso: end }, NOW);
    expect(y.buyPrice).toBeCloseTo(0.91, 12);
  });

  it('annualizes over at least one day', () => {
    expect(annualizedYield(0.99, 0.1).days).toBe(1);
    expect(annualizedYield(0.99, 0.1).annualized).toBeCloseTo(annualizedYield(0.99, 1).annualized, 12);
  });

  it('is null without a usable price or a future end date', () => {
    expect(annualizedYield(null, 30)).toBeNull();
    expect(annualizedYield(1, 30)).toBeNull();
    expect(annualizedYield(0.9, null)).toBeNull();
    expect(annualizedYield(0.9, -2)).toBeNull(); // past its end date, unresolved
  });
});

describe('marketYield', () => {
  it('uses the favourite and fractional days from the end date', () => {
    const m = { yesPrice: 0.08, noPrice: 0.92, endDateIso: new Date(NOW + 10.5 * DAY).toISOString(), daysLeft: 11 };
    const y = marketYield(m, NOW);
    expect(y.side).toBe('NO');
    expect(y.days).toBeCloseTo(10.5, 10);
    expect(daysToResolution({ daysLeft: 11 }, NOW)).toBe(11); // fallback without an ISO date
  });

  it('is only for favourites (≥ 80¢): a coin flip resolving tomorrow has none', () => {
    const tomorrow = new Date(NOW + DAY).toISOString();
    expect(marketYield({ yesPrice: 0.5, noPrice: 0.5, endDateIso: tomorrow }, NOW)).toBeNull();
    expect(marketYield({ yesPrice: 0.79, noPrice: 0.21, endDateIso: tomorrow }, NOW)).toBeNull();
    expect(marketYield({ yesPrice: 0.8, noPrice: 0.2, endDateIso: tomorrow }, NOW)).not.toBeNull();
  });
});

describe('formatYield', () => {
  it('formats small, large and huge yields', () => {
    expect(formatYield(0.042)).toBe('4.2%');
    expect(formatYield(0.866)).toBe('87%');
    expect(formatYield(40)).toBe('>999%');
    expect(formatYield(null)).toBe('—');
  });
});

describe('sorting by annualized yield', () => {
  it('ranks by yield, markets without one last', () => {
    const end = (d) => new Date(Date.now() + d * DAY).toISOString();
    const markets = [
      makeProcessedMarket({ id: 'slow', yesPrice: 0.9, noPrice: 0.1, endDateIso: end(90) }),
      makeProcessedMarket({ id: 'fast', yesPrice: 0.95, noPrice: 0.05, endDateIso: end(10) }),
      makeProcessedMarket({ id: 'none', yesPrice: 0.95, noPrice: 0.05, endDateIso: null, daysLeft: null }),
    ];
    const sort = (sortAsc) => filterAndSort({
      markets,
      filters: {
        volumeRange: [0, Infinity], yesPriceRange: [0, 100], noPriceRange: [0, 100], daysLeftRange: [0, 10_000],
        categories: [], sortBy: 'annualizedYield', sortAsc,
      },
      searchLower: '',
      lookupState: { isLookupActive: false, fetchedMarkets: [], foundInLoadedId: null },
      portfolio: { hasPortfolio: false, isMarketHeld: () => false },
    }).map((m) => m.id);
    expect(sort(false)).toEqual(['fast', 'slow', 'none']);
    expect(sort(true)).toEqual(['slow', 'fast', 'none']);
  });
});
