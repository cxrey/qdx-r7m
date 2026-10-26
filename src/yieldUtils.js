/**
 * Annualized yield to resolution — for comparing favourites that resolve on
 * different dates (a 95¢ share paying out in 10 days vs a 90¢ one in 90).
 *
 * Buying a side at all-in cost c (price + taker fee) and holding it to
 * resolution returns 1/c − 1 IF that side wins. Annualized over the d days
 * left: (1/c)^(365/d) − 1. This is a yield, not an expected return — the side
 * loses with probability ≈ 1 − c, and that risk is not priced in here.
 */

import { computeFeePerShare } from './feeCalculator';
import { MS_PER_DAY } from './engineConfig';

const MIN_DAYS = 1; // annualizing a few hours' hold gives meaningless numbers
// The table's yield is for favourites only. "Yield if it wins" means little
// for a coin flip: a 50¢ market resolving tomorrow "yields" +100% in a day
// (>999%/yr) half the time, and such markets would top every sort.
export const YIELD_MIN_PRICE = 0.8;

/**
 * @param {number} price — the side's price (0–1)
 * @param {number} days — days until resolution (fractional)
 * @param {object|null} [feeParams]
 * @returns {{ annualized: number, simpleReturn: number, cost: number, days: number } | null}
 */
export function annualizedYield(price, days, feeParams = null) {
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;
  if (!Number.isFinite(days) || days <= 0) return null; // past its end date: payout time unknown
  const cost = price + computeFeePerShare(price, feeParams);
  if (cost >= 1) return null;
  const d = Math.max(days, MIN_DAYS);
  const simpleReturn = 1 / cost - 1;
  return { annualized: Math.pow(1 / cost, 365 / d) - 1, simpleReturn, cost, days: d };
}

/** Days until a market's end date (fractional), from endDateIso, else daysLeft. */
export function daysToResolution(market, now = Date.now()) {
  const end = market?.endDateIso ? Date.parse(market.endDateIso) : NaN;
  if (Number.isFinite(end)) return (end - now) / MS_PER_DAY;
  return market?.daysLeft ?? null;
}

/**
 * Yield of the market's favourite (higher-priced side) at its current price,
 * when it is priced at YIELD_MIN_PRICE or more. Computed on demand, so live
 * price ticks are reflected.
 */
export function marketYield(market, now = Date.now()) {
  const { yesPrice, noPrice } = market ?? {};
  if (yesPrice == null && noPrice == null) return null;
  const side = (yesPrice ?? -1) >= (noPrice ?? -1) ? 'YES' : 'NO';
  const price = side === 'YES' ? yesPrice : noPrice;
  if (!(price >= YIELD_MIN_PRICE)) return null;
  const y = annualizedYield(price, daysToResolution(market, now), market.feeParams ?? null);
  return y ? { ...y, side, price } : null;
}

/** "86%", "4.2%", ">999%" */
export function formatYield(annualized) {
  if (annualized == null) return '—';
  if (annualized > 9.99) return '>999%';
  const pct = annualized * 100;
  return `${pct < 10 ? pct.toFixed(1) : pct.toFixed(0)}%`;
}
