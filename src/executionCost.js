/**
 * All-in cost of buying a side: the average price you'd actually fill at,
 * plus the taker fee — the c̄ in EV = p − c̄ and Kelly f* = (p − c̄)/(1 − c̄).
 *
 * The quoted price (outcomePrices / live mid) is not executable: buying pays
 * at least the ask, more for size that walks the book, plus the fee.
 */

import { simulateFill } from './SpreadFrictionEngine';
import { computeFeePerShare } from './feeCalculator';

/**
 * @param {object} opts
 * @param {'YES'|'NO'} opts.side — the side being bought
 * @param {number} opts.dollars — order size in dollars (the fill depends on it)
 * @param {number} opts.price — quoted price of that side (fallback)
 * @param {number|null} [opts.spread] — quoted bid-ask spread (fallback: half of it is paid)
 * @param {object|null} [opts.book] — an order book ({ bids, asks }) of one token
 * @param {'YES'|'NO'} [opts.bookSide] — which token `book` belongs to
 * @param {object|null} [opts.feeParams]
 * @returns {{ cost: number, fillPrice: number, fee: number, source: 'book'|'estimate'|'quote', bookExhausted: boolean }}
 */
export function allInCost({ side, dollars, price, spread = null, book = null, bookSide = 'YES', feeParams = null }) {
  let fillPrice = null;
  let source = 'quote';
  let bookExhausted = false;

  if (book) {
    // Binary books mirror each other: buying the book's own token lifts its
    // asks; buying the other token walks its bids at 1 − price.
    const fill = simulateFill(book, side === bookSide ? 'BUY_YES' : 'BUY_NO', Math.max(dollars, 1));
    if (fill && fill.totalShares > 0 && fill.averageFillPrice > 0 && fill.averageFillPrice < 1) {
      fillPrice = fill.averageFillPrice;
      bookExhausted = fill.bookExhausted;
      source = 'book';
    }
  }

  if (fillPrice == null) {
    if (spread != null && spread > 0) {
      fillPrice = Math.min(0.999, price + spread / 2); // estimated ask
      source = 'estimate';
    } else {
      fillPrice = price;
    }
  }

  const fee = computeFeePerShare(fillPrice, feeParams);
  return { cost: fillPrice + fee, fillPrice, fee, source, bookExhausted };
}
