/**
 * Polymarket Data API v2 client (docs.polymarket.com/migrate/data-api-v1-to-v2).
 *
 * v1 was retired on 2026-10-24. v2 differs in four ways, all absorbed here:
 *   1. Routes live under /v2 (/v1/leaderboard → /v2/leaderboard, etc.).
 *   2. Responses are wrapped: { data, pagination: { next_cursor, has_more } }.
 *   3. Pagination is cursor-only — `offset` is rejected with HTTP 400.
 *   4. Fields are snake_case, and a few were renamed (asset → token_id, the
 *      leaderboard's proxyWallet → user_id, positions' size → current_size).
 *
 * Rows are normalized back to the v1 field names the analysis code (and
 * the localStorage caches written under v1) already use, so the migration
 * is confined to this module. Request params also renamed: the v1 `market`
 * filter is now `condition` (`market` returns HTTP 400).
 */

import { DATA_API } from './apiConfig';
import { withTimeout, TIMEOUT_DATA_API } from './fetchUtils';
import { throwIfRateLimited } from './clobErrorHandler';

/** proxy_wallet → proxyWallet, outcome_index → outcomeIndex */
const toCamel = (key) => key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/**
 * v2 → v1 renames beyond snake_case → camelCase, per row type. Keys are the
 * camelCased v2 names; values are the v1 names consumers read.
 */
const RENAMES = {
  trade: { tokenId: 'asset' },
  activity: { tokenId: 'asset' },
  holder: { tokenId: 'asset' },
  holderGroup: { tokenId: 'token' },
  position: {
    tokenId: 'asset', currentSize: 'size', currentPrice: 'curPrice',
    oppositeTokenId: 'oppositeAsset', unrealizedPnl: 'cashPnl',
  },
  leaderboard: { userId: 'proxyWallet', volume: 'vol', verified: 'verifiedBadge' },
};

/** Convert one v2 row to the v1 shape for the given row type. */
export function toV1Row(row, type) {
  if (!row || typeof row !== 'object') return row;
  const renames = RENAMES[type] || {};
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    const camel = toCamel(key);
    out[renames[camel] ?? camel] = value;
  }
  // v2 holder groups nest their holders; normalize those too
  if (type === 'holderGroup' && Array.isArray(out.holders)) {
    out.holders = out.holders.map((h) => toV1Row(h, 'holder'));
  }
  return out;
}

/**
 * GET a v2 route, following pagination.next_cursor up to `maxPages` pages.
 *
 * @param {string} route  — e.g. '/v2/trades'
 * @param {object} params — query params; undefined/null values are dropped
 * @param {object} [opts]
 * @param {number} [opts.maxPages=1] — pages to follow (1 = first page only)
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ ok: true, rows: object[], hasMore: boolean } | { ok: false, status: number, error: string|null }>}
 * @throws on 429/403 (with .status) so callers' rate-limit handling keeps working
 */
export async function dataApiGet(route, params = {}, { maxPages = 1, signal } = {}) {
  const rows = [];
  let cursor = null;
  let hasMore = false;

  for (let page = 0; page < maxPages; page++) {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v != null) query.set(k, String(v));
    }
    if (cursor) query.set('cursor', cursor);

    const res = await fetch(`${DATA_API}${route}?${query}`, { signal: withTimeout(signal ?? null, TIMEOUT_DATA_API) });
    throwIfRateLimited(res);
    if (!res.ok) {
      let error = null;
      try { error = (await res.json())?.error ?? null; } catch { /* non-JSON body */ }
      return { ok: false, status: res.status, error };
    }

    const body = await res.json();
    const data = body?.data;
    if (Array.isArray(data)) rows.push(...data);
    else if (data != null) rows.push(data);

    cursor = body?.pagination?.next_cursor ?? null;
    hasMore = Boolean(body?.pagination?.has_more && cursor);
    if (!hasMore) break;
  }

  return { ok: true, rows, hasMore };
}
