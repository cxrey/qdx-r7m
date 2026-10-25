/**
 * Merge a {yesPrice, noPrice} update into the pending-price map that App's
 * throttle drains into rawMarkets. Null/undefined sides keep the value
 * already pending for that market.
 */
export function mergePendingPrice(pending, marketId, { yesPrice, noPrice }) {
  const existing = pending.get(marketId);
  if (existing) {
    if (yesPrice != null) existing.yesPrice = yesPrice;
    if (noPrice != null) existing.noPrice = noPrice;
  } else {
    pending.set(marketId, { yesPrice, noPrice });
  }
}
