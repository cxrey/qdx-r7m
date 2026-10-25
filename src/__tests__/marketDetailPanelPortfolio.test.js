// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement as h } from 'react';
import { render, screen, cleanup } from '@testing-library/react';

// The panel fetches price history and the order book on mount; keep it offline
vi.mock('../api', () => ({
  fetchPriceHistory: vi.fn(async () => null),
  fetchOrderBook: vi.fn(async () => null),
}));

import MarketDetailPanel from '../components/MarketDetailPanel';
import { PortfolioProvider } from '../contexts/PortfolioContext';
import { processMarket } from '../processMarket';
import { makeMarket } from './helpers/marketFixtures';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const rowContext = { hasPortfolio: true, isMarketHeld: () => false, getHeldPosition: () => null, addManualPosition: () => {} };
const screening = {
  fit: 'INCREASES_CONCENTRATION', maxCorrelation: 0.8, maxCorrelationMarket: null,
  clusterName: 'Politics', currentDivScore: 70, newDivScore: 55, text: 'Adding it increases concentration risk.',
};

function renderPanel(details) {
  const market = processMarket(makeMarket());
  return render(h(PortfolioProvider, { value: rowContext, details }, h(MarketDetailPanel, { market })));
}

describe('MarketDetailPanel reads the full portfolio from context', () => {
  it('shows Portfolio Impact when you have a portfolio', () => {
    // Before: MarketRow passed the panel a copy with hasPortfolio stripped
    // out, so this section could never appear.
    const screenTrade = vi.fn(() => screening);
    renderPanel({ hasPortfolio: true, screenTrade, summary: { totalValue: 500 } });
    expect(screen.getByText('Portfolio Impact')).toBeTruthy();
    expect(screen.getByText('Adding it increases concentration risk.')).toBeTruthy();
    expect(screenTrade).toHaveBeenCalled();
  });

  it('hides Portfolio Impact without a portfolio', () => {
    renderPanel({ hasPortfolio: false, screenTrade: vi.fn(), summary: { totalValue: 0 } });
    expect(screen.queryByText('Portfolio Impact')).toBeNull();
  });

  it('renders without a details provider value (e.g. outside the scanner)', () => {
    renderPanel(null);
    expect(screen.queryByText('Portfolio Impact')).toBeNull();
  });
});
