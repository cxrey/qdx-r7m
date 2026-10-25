import { createContext, useContext } from 'react';

/**
 * PortfolioContext — provides portfolio callbacks to deeply nested components
 * without prop drilling through ResultsTable → rowData → MarketRow.
 *
 * Two contexts, because they change at different rates:
 * - Row context { hasPortfolio, isMarketHeld, getHeldPosition, addManualPosition }:
 *   read by every visible MarketRow. Changes only when holdings change, not
 *   when held prices move, so price ticks don't re-render every row.
 * - Details context: the full usePortfolio() object (summary, screenTrade, …).
 *   Changes with held prices; read only by the expanded detail panel.
 */
const PortfolioContext = createContext({
  hasPortfolio: false,
  isMarketHeld: () => false,
  getHeldPosition: () => null,
  addManualPosition: () => {},
});

const PortfolioDetailsContext = createContext(null);

export function PortfolioProvider({ value, details, children }) {
  return (
    <PortfolioContext.Provider value={value}>
      <PortfolioDetailsContext.Provider value={details}>
        {children}
      </PortfolioDetailsContext.Provider>
    </PortfolioContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- idiomatic context hook co-located with its provider
export function usePortfolioContext() {
  return useContext(PortfolioContext);
}

// eslint-disable-next-line react-refresh/only-export-components -- idiomatic context hook co-located with its provider
export function usePortfolioDetails() {
  return useContext(PortfolioDetailsContext);
}
