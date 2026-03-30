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

export function usePortfolioContext() {
  return useContext(PortfolioContext);
}
