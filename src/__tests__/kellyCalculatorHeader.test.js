// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createElement as h } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import KellyCalculator from '../components/KellyCalculator';

beforeEach(() => localStorage.clear()); // default Kelly settings: $1,000 bankroll, 80% max exposure
afterEach(cleanup);

// A market with a clear YES edge at the default estimate (price + 5pp)
const market = { id: 'k1', question: 'Will it happen?', yesPrice: 0.3, noPrice: 0.7, flb: { bestSide: 'YES' } };

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
});
