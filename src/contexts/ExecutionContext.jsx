import { createContext, useContext, useState, useMemo } from 'react';

/**
 * ExecutionContext — provides maker/taker toggle to the component tree.
 * Default: 'taker' (conservative).
 */
const ExecutionContext = createContext({
  executionStyle: 'taker',
  setExecutionStyle: () => {},
  isMaker: false,
});

export function ExecutionProvider({ children }) {
  const [executionStyle, setExecutionStyle] = useState('taker');
  const value = useMemo(() => ({
    executionStyle,
    setExecutionStyle,
    isMaker: executionStyle === 'maker',
  }), [executionStyle]);
  return <ExecutionContext.Provider value={value}>{children}</ExecutionContext.Provider>;
}

export function useExecutionStyle() {
  return useContext(ExecutionContext);
}
