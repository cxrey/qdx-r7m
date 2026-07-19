import { createContext, useContext } from 'react';

/**
 * PortfolioContext — provides portfolio callbacks to deeply nested components
 * without prop drilling through ResultsTable → rowData → MarketRow.
 *
 * Value shape: { hasPortfolio, isMarketHeld, getHeldPosition, addManualPosition, portfolio }
 */
const PortfolioContext = createContext({
  hasPortfolio: false,
  isMarketHeld: () => false,
  getHeldPosition: () => null,
  addManualPosition: () => {},
  portfolio: null,
});

export function PortfolioProvider({ value, children }) {
  return <PortfolioContext.Provider value={value}>{children}</PortfolioContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- idiomatic context hook co-located with its provider
export function usePortfolioContext() {
  return useContext(PortfolioContext);
}
