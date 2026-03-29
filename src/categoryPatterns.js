/**
 * Shared category pattern definitions.
 * Single source of truth — used by BaseRateEngine (category inference)
 * and TradeFlowEngine (wallet relevance assessment).
 */

export const CATEGORY_PATTERNS = {
  Politics: [/president/i, /election/i, /trump/i, /biden/i, /congress/i, /senate/i, /governor/i, /democrat/i, /republican/i, /vote/i, /poll/i],
  Crypto: [/bitcoin/i, /btc/i, /ethereum/i, /eth\b/i, /crypto/i, /solana/i, /token/i, /defi/i, /nft/i, /blockchain/i],
  Finance: [/stock/i, /s&p/i, /nasdaq/i, /dow jones/i, /fed\b/i, /interest rate/i, /inflation/i, /gdp/i, /recession/i, /treasury/i],
  Sports: [/nba/i, /nfl/i, /mlb/i, /nhl/i, /soccer/i, /football/i, /basketball/i, /baseball/i, /tennis/i, /golf/i, /ufc/i, /boxing/i, /f1\b/i, /championship/i, /playoff/i, /super bowl/i],
  Geopolitics: [/war\b/i, /ceasefire/i, /iran/i, /russia/i, /ukraine/i, /china/i, /taiwan/i, /nato/i, /sanction/i, /military/i, /tariff/i],
  Tech: [/\bai\b/i, /artificial intelligence/i, /openai/i, /google/i, /apple/i, /microsoft/i, /meta\b/i, /spacex/i, /tesla/i, /chatgpt/i],
  'Pop Culture': [/movie/i, /film/i, /oscar/i, /grammy/i, /emmy/i, /album/i, /music/i, /celebrity/i, /tiktok/i, /youtube/i],
  Science: [/climate/i, /temperature/i, /earthquake/i, /hurricane/i, /pandemic/i, /virus/i, /vaccine/i, /covid/i, /nasa/i, /space/i],
  Legal: [/court/i, /lawsuit/i, /convicted/i, /trial\b/i, /judge/i, /indictment/i, /arrest/i, /guilty/i, /settlement/i, /ruling/i],
};

/**
 * Infer category from question text.
 * Returns the first matching category, or 'Other'.
 */
export function inferCategory(question) {
  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    if (patterns.some((p) => p.test(question))) return category;
  }
  return 'Other';
}

/**
 * Get patterns for a specific category.
 * Returns an empty array if the category has no patterns.
 */
export function getCategoryPatterns(category) {
  return CATEGORY_PATTERNS[category] || [];
}
