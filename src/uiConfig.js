/**
 * Shared UI constants for the virtual-scrolled markets table.
 *
 * Single source of truth for row heights and batch-fetch delays.
 * Imported by ResultsTable.jsx and MarketRow.jsx.
 */

// ── Brand colors ───────────────────────────────────────────────
export const CYAN = '#00d4aa';
export const PINK = '#ff4d6a';
export const PURPLE = '#a78bfa';
export const AMBER = '#f59e0b';
export const RED = '#ef4444';

// ── Row heights (px) ────────────────────────────────────────────
export const ROW_HEIGHT = 44;        // collapsed row (dynamic measurement via useDynamicRowHeight handles expanded)
export const HEADER_HEIGHT = 36;     // column header bar
export const FOOTER_HEIGHT = 32;     // results count bar
export const BANNER_HEIGHT = 32;     // rate limit warning banner

// ── Background fetch delays (ms) ────────────────────────────────
// Sequential fetches use these delays between requests to avoid
// hammering the API. The initial delay is the wait before the first
// batch starts (lets the scroll settle).
export const SPREAD_FETCH_DELAY = 200;   // between order book requests
export const SPREAD_BATCH_START = 500;   // initial delay before spread batch
export const FLOW_FETCH_DELAY = 300;     // between trade flow requests
export const FLOW_BATCH_START = 1000;    // initial delay before flow batch

// ── Spread cache tuning ─────────────────────────────────────────
export const SPREAD_CACHE_CAP = 500;       // max entries in spread LRU cache

// ── Hover prefetch tuning ───────────────────────────────────────
export const HOVER_DEBOUNCE_DELAY = 400;   // ms before hover triggers fetch
export const PREFETCH_CACHE_TTL = 30000;   // 30s cache lifetime per entry
export const PREFETCH_LRU_CAP = 20;        // max entries in prefetch cache

// ── Throttle tuning ──────────────────────────────────────────────
export const PRICE_THROTTLE_MS = 1000;          // interval between price-tick filterAndSort checks
export const MAX_FILTER_SORT_SKIPS = 10;        // max consecutive skips (10 × 1s = 10s max staleness)
export const THROTTLE_LOG_EVERY = 60;           // cycles between skip-ratio logs (60 × 1s = 60s)
