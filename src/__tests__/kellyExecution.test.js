/**
 * EV and Kelly at the all-in cost c̄ (fill price from the order book + taker
 * fee): EV/share = p − c̄, f* = (p − c̄)/(1 − c̄), λ = min(your setting, tier).
 */
import { describe, it, expect } from 'vitest';
import { calculateKelly, calculateKellyAtExecution, calculateScenarios } from '../KellyEngine';
import { allInCost } from '../executionCost';
import { resolveFeeParams } from '../feeCalculator';

const crypto = resolveFeeParams({ gammaCategory: 'crypto', feesEnabled: true }); // 0.07 × p(1−p)
// A YES-token book: asks 100 @ 0.50, 100 @ 0.52; bids 100 @ 0.48, 100 @ 0.46
const yesBook = {
  asks: [{ price: '0.50', size: '100' }, { price: '0.52', size: '100' }],
  bids: [{ price: '0.48', size: '100' }, { price: '0.46', size: '100' }],
};

describe('calculateKelly at an all-in cost', () => {
  it('full Kelly is (p − c̄)/(1 − c̄) and EV per share is p − c̄', () => {
    const k = calculateKelly(0.6, 0.5, 'YES', null, { cost: 0.52 });
    expect(k.fullKelly).toBeCloseTo((0.6 - 0.52) / (1 - 0.52), 10);
    expect(k.evPerShare).toBeCloseTo(0.08, 10);
    expect(k.expectedValue).toBeCloseTo(0.6 / 0.52 - 1, 10);
    expect(k.breakEvenProb).toBe(0.52);
  });

  it('without a cost, prices at the quote plus its fee', () => {
    const k = calculateKelly(0.6, 0.5, 'YES', crypto);
    expect(k.cost).toBeCloseTo(0.5 + 0.07 * 0.25, 10);
  });

  it('an edge that fill and fee use up is no edge, and says so', () => {
    const k = calculateKelly(0.51, 0.5, 'YES', null, { cost: 0.5175 });
    expect(k.noEdge).toBe(true);
    expect(k.reason).toBe('Fill price and fees use up your edge');
  });

  it('λ is your setting, capped by the robustness tier', () => {
    // ROBUST tier allows 0.5
    expect(calculateKelly(0.85, 0.5, 'YES', null, { maxFraction: 0.25 }).fractionMultiplier).toBe(0.25);
    expect(calculateKelly(0.85, 0.5, 'YES', null, { maxFraction: 1 }).fractionMultiplier).toBe(0.5);
    // FRAGILE tier (gap < 2pp) caps a 0.25 setting at 0.125
    expect(calculateKelly(0.515, 0.5, 'YES', null, { maxFraction: 0.25 }).fractionMultiplier).toBe(0.125);
  });
});

describe('allInCost', () => {
  it('walks the asks for the book\'s own token', () => {
    // $75: 100 shares for $50 at 0.50, then $25 at 0.52
    const q = allInCost({ side: 'YES', dollars: 75, price: 0.49, book: yesBook, bookSide: 'YES' });
    expect(q.source).toBe('book');
    expect(q.fillPrice).toBeCloseTo(75 / (100 + 25 / 0.52), 10);
    expect(q.cost).toBe(q.fillPrice); // no fees
  });

  it('buys the other token by walking the bids at 1 − price', () => {
    // NO at 0.52 (100 shares, $52), then $23 at 0.54
    const q = allInCost({ side: 'NO', dollars: 75, price: 0.51, book: yesBook, bookSide: 'YES' });
    expect(q.fillPrice).toBeCloseTo(75 / (100 + 23 / 0.54), 10);
    // The same book seen as the NO token's: buying YES walks its bids
    const flipped = allInCost({ side: 'YES', dollars: 75, price: 0.49, book: yesBook, bookSide: 'NO' });
    expect(flipped.fillPrice).toBeCloseTo(q.fillPrice, 10);
  });

  it('adds the taker fee at the fill price', () => {
    const q = allInCost({ side: 'YES', dollars: 10, price: 0.49, book: yesBook, bookSide: 'YES', feeParams: crypto });
    expect(q.fillPrice).toBeCloseTo(0.5, 10);
    expect(q.fee).toBeCloseTo(0.07 * 0.25, 10);
    expect(q.cost).toBeCloseTo(0.5175, 10);
  });

  it('without a book, estimates the ask as mid + half the spread', () => {
    expect(allInCost({ side: 'YES', dollars: 10, price: 0.5, spread: 0.02 })).toMatchObject({ fillPrice: 0.51, source: 'estimate' });
    expect(allInCost({ side: 'YES', dollars: 10, price: 0.5 })).toMatchObject({ fillPrice: 0.5, source: 'quote' });
  });
});

describe('calculateKellyAtExecution', () => {
  it('sizes at the cost of the size it suggests', () => {
    const { kelly, quote } = calculateKellyAtExecution({
      estProb: 0.8, side: 'YES', marketPrice: 0.49, bankroll: 1000, maxFraction: 0.5,
      book: yesBook, bookSide: 'YES',
    });
    const dollars = kelly.fractionalKelly * 1000;
    // Big enough to walk past the first level, so it pays more than the best ask
    expect(dollars).toBeGreaterThan(50);
    expect(quote.cost).toBeGreaterThan(0.5);
    // Consistent: the quote is the cost of (about) that size
    const check = allInCost({ side: 'YES', dollars, price: 0.49, book: yesBook, bookSide: 'YES' });
    expect(check.cost).toBeCloseTo(quote.cost, 3);
    expect(kelly.cost).toBe(quote.cost);
  });
});

describe('calculateScenarios at the all-in cost', () => {
  it('EV is net of fill and fee', () => {
    const s = calculateScenarios(100, 0.5175, 'YES', 0.6, { bankroll: 1000 });
    expect(s.evPerShare).toBeCloseTo(0.6 - 0.5175, 10);
    expect(s.ev).toBeCloseTo(100 * (0.6 / 0.5175 - 1), 8);
  });
});
