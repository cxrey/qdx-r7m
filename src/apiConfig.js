/**
 * Same-origin base paths for the Polymarket APIs. Each is proxied to the real
 * host by vite.config.js (dev and preview) — see apiProxy there.
 */
export const GAMMA_API = '/gamma-api'; // gamma-api.polymarket.com — markets, events, tags
export const CLOB_API = '/clob-api';   // clob.polymarket.com — order books, prices
export const DATA_API = '/data-api';   // data-api.polymarket.com — trades, positions, holders
