// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createElement as h } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import KellyCalculator from '../components/KellyCalculator';

beforeEach(() => localStorage.clear()); // default Kelly settings: $1,000 bankroll, 80% max exposure
afterEach(cleanup);

// The default estimate is the model's (FLB-adjusted) probability: give this
// market a model view 5pp above the price, so it opens with a clear YES edge
const market = { id: 'k1', question: 'Will it happen?', yesPrice: 0.3, noPrice: 0.7, flb: { bestSide: 'YES', adjustedYesProb: 0.35, adjustedNoProb: 0.65 } };

describe('KellyCalculator collapsed header', () => {
  it('shows the bet size after limits, the same number the expanded view recommends', () => {
    // $790 of the $800 max exposure is used → only $10 may be added
    const portfolio = { hasPortfolio: true, summary: { totalValue: 790 }, screenTrade: () => ({ maxCorrelation: 0 }) };
    render(h(KellyCalculator, { market, portfolio }));
    expect(screen.getByText('~$10 suggested')).toBeTruthy();
  });

  it('without a portfolio, shows the unconstrained Kelly size', () => {
    render(h(KellyCalculator, { market, portfolio: null }));
    const label = screen.getByText(/suggested$/).textContent;
    expect(Number(label.match(/\$(\d+)/)[1])).toBeGreaterThan(10);
  });

  it('with no model view, opens at no edge (the estimate starts at the price, not price + 5pp)', () => {
    const plain = { id: 'k2', question: 'Will it?', yesPrice: 0.3, noPrice: 0.7, flb: { bestSide: 'YES' } };
    render(h(KellyCalculator, { market: plain, portfolio: null }));
    expect(screen.queryByText(/suggested$/)).toBeNull();
  });
});
