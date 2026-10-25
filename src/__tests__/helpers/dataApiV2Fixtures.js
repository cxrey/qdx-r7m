/**
 * Data API v2 response fixtures. Field names and value types are copied from
 * live v2 responses (2026-10-25); values are synthetic so no real trader's
 * wallet or profile ends up in the repo.
 */

export const WALLET = '0x' + '1'.repeat(40);
export const WALLET_2 = '0x' + '2'.repeat(40);
export const CONDITION = '0x' + 'c'.repeat(64);
export const YES_TOKEN = '1'.repeat(70);
export const NO_TOKEN = '2'.repeat(70);

export const envelope = (data, { nextCursor = null, limit = 100 } = {}) => ({
  data,
  pagination: { limit, offset: 0, has_more: nextCursor != null, next_cursor: nextCursor },
});

export const v2Trade = (overrides = {}) => ({
  proxy_wallet: WALLET, side: 'BUY', token_id: YES_TOKEN, condition_id: CONDITION,
  size: 120.5, price: 0.62, timestamp: 1792937915, title: 'Test market?', slug: 'test-market',
  icon: 'https://example.invalid/i.png', event_slug: 'test-event', outcome: 'Yes', outcome_index: 0,
  name: 'trader-one', pseudonym: 'Brave-Owl', bio: '', profile_image: '', profile_image_optimized: '',
  transaction_hash: '0x' + 'a'.repeat(64),
  ...overrides,
});

export const v2HolderGroup = (tokenId, holders) => ({
  token_id: tokenId,
  holders: holders.map((h) => ({
    proxy_wallet: WALLET, bio: '', token_id: tokenId, pseudonym: 'Brave-Owl', amount: 5000,
    display_username_public: true, outcome_index: tokenId === YES_TOKEN ? 0 : 1,
    name: 'holder', profile_image: '', profile_image_optimized: '', verified: false,
    ...h,
  })),
});

export const v2LeaderboardEntry = (overrides = {}) => ({
  rank: 1, user_id: WALLET, pnl: 125000.5, volume: 900000.25, user_name: 'top-trader',
  profile_image: '', x_username: '', verified: true,
  ...overrides,
});

export const v2Activity = (overrides = {}) => ({
  proxy_wallet: WALLET, timestamp: 1731489409, condition_id: CONDITION, type: 'TRADE',
  size: 199.95, usdc_size: 193.15, transaction_hash: '0x' + 'b'.repeat(64), price: 0.966,
  token_id: YES_TOKEN, side: 'BUY', outcome_index: 0, title: 'Test market?', slug: 'test-market',
  icon: '', event_slug: 'test-event', outcome: 'Yes', name: '', pseudonym: 'Brave-Owl', bio: '',
  profile_image: '', profile_image_optimized: '',
  ...overrides,
});

export const v2Position = (overrides = {}) => ({
  proxy_wallet: WALLET, token_id: YES_TOKEN, condition_id: CONDITION, current_size: 1500,
  avg_price: 0.4, entry_cost_usdc: 600, entry_fees_usdc: 1.2, total_cost_usdc: 601.2,
  current_price: 0.55, current_value: 825, total_size: 1500, realized_pnl: 0,
  unrealized_pnl: 223.8, total_pnl: 223.8, percent_pnl: 37.2, percent_realized_pnl: 0,
  status: 'OPEN', redeemable: false, mergeable: false, negative_risk: false, archived: false,
  title: 'Test market?', slug: 'test-market', icon: '', event_id: '123', event_slug: 'test-event',
  outcome: 'Yes', outcome_index: 0, opposite_outcome: 'No', opposite_token_id: NO_TOKEN,
  end_date: '2026-12-31', last_event_at: 1792900000, first_entry_at: 1790000000,
  name: '', profile_image: '', verified: false,
  ...overrides,
});

/** Build a fetch Response for a JSON body. */
export const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });
