// @vitest-environment jsdom
/**
 * TradeFlowPanel: a failed trades request is an error to retry, never a
 * "0 trades in 24h" flow (which was also cached for 5 min); a window cut
 * short by a failed later page is shown but not cached.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createElement as h } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

vi.mock('../TradeFlowEngine', () => ({
  fetchMarketTrades: vi.fn(),
  fetchMarketHolders: vi.fn(),
  fetchWalletActivity: vi.fn(),
  getLeaderboardIndex: vi.fn(() => new Map()),
  analyzeTradeFlow: vi.fn(() => ({ dataAvailable: false })),
  assessWalletRelevance: vi.fn(),
  getCachedTradeFlow: vi.fn(() => null),
  setCachedTradeFlow: vi.fn(),
  formatUsdcSize: vi.fn(String),
  formatTimeAgo: vi.fn(String),
  truncateWallet: vi.fn(String),
}));
vi.mock('../dataApi', () => ({ isDataApiRateLimited: vi.fn(() => false) }));

const { fetchMarketTrades, fetchMarketHolders, analyzeTradeFlow, setCachedTradeFlow } = await import('../TradeFlowEngine');
const { default: TradeFlowPanel } = await import('../components/TradeFlowPanel');

const market = { id: 'm1', conditionId: '0xabc', category: 'Politics' };
const holders = [{ token: 'y', holders: [] }];

beforeEach(() => {
  vi.clearAllMocks();
  fetchMarketHolders.mockResolvedValue(holders);
});
afterEach(cleanup);

describe('TradeFlowPanel', () => {
  it('a failed trades request shows a retryable error and caches nothing', async () => {
    fetchMarketTrades.mockResolvedValue(null);
    render(h(TradeFlowPanel, { market }));
    await waitFor(() => expect(screen.getByText('Failed to load trade flow data')).toBeTruthy());
    expect(screen.getByText('Retry')).toBeTruthy();
    expect(analyzeTradeFlow).not.toHaveBeenCalled();
    expect(setCachedTradeFlow).not.toHaveBeenCalled();
  });

  it('a cut-short trade window is analysed but not cached', async () => {
    fetchMarketTrades.mockResolvedValue(Object.assign([{ id: 't1' }], { incomplete: true }));
    render(h(TradeFlowPanel, { market }));
    await waitFor(() => expect(analyzeTradeFlow).toHaveBeenCalledTimes(1));
    expect(setCachedTradeFlow).not.toHaveBeenCalled();
  });

  it('a complete window is cached', async () => {
    fetchMarketTrades.mockResolvedValue([{ id: 't1' }]);
    render(h(TradeFlowPanel, { market }));
    await waitFor(() => expect(setCachedTradeFlow).toHaveBeenCalledTimes(1));
  });
});
