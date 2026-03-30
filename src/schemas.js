import { z } from 'zod';

// ── Helpers ────────────────────────────────────────────────────────
const coerceNum = z.coerce.number();
const strOrNum = z.union([z.string(), z.number()]);

// ── OrderBook Level ────────────────────────────────────────────────
const OrderBookLevelSchema = z.object({
  price: strOrNum,
  size: strOrNum,
}).passthrough();

// ── Schemas ────────────────────────────────────────────────────────

export const GammaMarketSchema = z.object({
  id: strOrNum,
  question: z.string(),
  slug: z.string(),
  description: z.string().optional(),
  active: z.boolean(),
  closed: z.boolean(),
  volume: coerceNum,
  volume24hr: coerceNum.optional(),
  endDate: z.string().optional(),
  createdAt: z.string().optional(),
  outcomePrices: z.string(),
  clobTokenIds: z.string(),
  conditionId: z.string().optional(),
  condition_id: z.string().optional(),
}).passthrough();

export const OrderBookSchema = z.object({
  bids: z.array(OrderBookLevelSchema).optional().default([]),
  asks: z.array(OrderBookLevelSchema).optional().default([]),
}).passthrough();

export const PricePointSchema = z.union([
  z.object({ t: z.number(), p: z.number() }).passthrough(),
  z.object({ timestamp: z.number(), price: z.number() }).passthrough(),
]);

export const TradeSchema = z.object({
  price: z.number(),
  side: z.string().optional(),
  size: z.number().optional(),
  shares: z.number().optional(),
  usdcSize: z.number().optional(),
  timestamp: strOrNum.optional(),
  created_at: strOrNum.optional(),
  time: strOrNum.optional(),
  proxyWallet: z.string().optional(),
  proxy_wallet: z.string().optional(),
  maker: z.string().optional(),
  taker: z.string().optional(),
}).passthrough();

export const LeaderboardEntrySchema = z.object({
  proxyWallet: z.string().optional(),
  proxy_wallet: z.string().optional(),
  rank: strOrNum.optional(),
  pnl: z.number().optional(),
  profit: z.number().optional(),
  vol: z.number().optional(),
  volume: z.number().optional(),
}).passthrough();

export const WSPriceUpdateSchema = z.object({
  asset_id: z.string(),
  price: coerceNum,
}).passthrough();

export const CacheEnvelopeSchema = z.object({
  ts: z.number(),
  data: z.unknown(),
});

// ── Safe-parse wrappers (log + passthrough on failure) ─────────────

export function parseGammaMarkets(data) {
  const result = z.array(GammaMarketSchema).safeParse(data);
  if (!result.success) {
    console.warn('[Schema] GammaMarket validation failed:', result.error?.issues?.slice(0, 3) ?? []);
    return data;
  }
  return result.data;
}

export function parseOrderBook(data) {
  const result = OrderBookSchema.safeParse(data);
  if (!result.success) {
    console.warn('[Schema] OrderBook validation failed:', result.error?.issues?.slice(0, 3) ?? []);
    return data;
  }
  return result.data;
}

export function parseLeaderboard(data) {
  const result = z.array(LeaderboardEntrySchema).safeParse(data);
  if (!result.success) {
    console.warn('[Schema] Leaderboard validation failed:', result.error?.issues?.slice(0, 3) ?? []);
    return data;
  }
  return result.data;
}

export function parsePriceHistory(data) {
  const result = z.array(PricePointSchema).safeParse(data);
  if (!result.success) {
    console.warn('[Schema] PriceHistory validation failed:', result.error?.issues?.slice(0, 3) ?? []);
    return data;
  }
  return result.data;
}

export function parseTrades(data) {
  const result = z.array(TradeSchema).safeParse(data);
  if (!result.success) {
    console.warn('[Schema] Trade validation failed:', result.error?.issues?.slice(0, 3) ?? []);
    return data;
  }
  return result.data;
}
