import { createContext, useContext, useState, useMemo } from 'react';

/**
 * ExecutionContext — provides maker/taker toggle to the component tree.
 * Default: 'taker' (conservative). Persisted to localStorage.
 */
const ExecutionContext = createContext({
  executionStyle: 'taker',
  setExecutionStyle: () => {},
  isMaker: false,
});

const STORAGE_KEY = 'pm_execution_style';

function readStoredStyle() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'maker' || v === 'taker') return v;
  } catch { /* ignore */ }
  return 'taker';
}

export function ExecutionProvider({ children }) {
  const [executionStyle, setExecutionStyleRaw] = useState(readStoredStyle);
  const setExecutionStyle = (style) => {
    setExecutionStyleRaw(style);
    try { localStorage.setItem(STORAGE_KEY, style); } catch { /* ignore */ }
  };
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
