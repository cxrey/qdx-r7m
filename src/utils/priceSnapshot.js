/**
 * Pure helpers for App's 1s price throttle tick. Kept out of the component
 * so the decisions (what changed, what flashes, whether to re-filter) are
 * unit-testable without rendering.
 */

/** marketId → array index. O(n); built once per tick. */
export function buildIndexMap(markets) {
  const map = new Map();
  for (let i = 0; i < markets.length; i++) map.set(markets[i].id, i);
  return map;
}

/**
 * Compare a pending-price snapshot against the displayed markets.
 *
 * @param {object[]} base      — markets array currently rendered
 * @param {Map<string,{yesPrice?:number,noPrice?:number}>} snapshot — pending updates
 * @param {number} seq         — flash sequence number for this tick
 * @param {Map} [baseIdx]      — buildIndexMap(base), if already built
 * @returns {{ priceChanged: boolean, flashes: Object<string,string> }}
 *   flashes: marketId → 'up:<seq>' | 'down:<seq>' for markets whose YES price
 *   moved. The sequence number makes consecutive same-direction moves
 *   distinct values, so each one re-triggers the row animation.
 */
export function diffPriceSnapshot(base, snapshot, seq, baseIdx = buildIndexMap(base)) {
  let priceChanged = false;
  const flashes = {};
  for (const [marketId, update] of snapshot) {
    const m = base[baseIdx.get(marketId)];
    if (!m) continue;
    const newYes = update.yesPrice ?? m.yesPrice;
    const newNo = update.noPrice ?? m.noPrice;
    if (newYes === m.yesPrice && newNo === m.noPrice) continue;
    priceChanged = true;
    if (m.yesPrice != null && newYes !== m.yesPrice) {
      flashes[marketId] = `${newYes > m.yesPrice ? 'up' : 'down'}:${seq}`;
    }
  }
  return { priceChanged, flashes };
}

/**
 * Re-filter only when there is something new: prices were just applied, or
 * the markets array differs from the one last filtered (every writer to
 * rawMarkets produces a new array, so identity is a complete signal).
 */
export function shouldRefilter(priceChanged, currentMarkets, lastFilteredMarkets) {
  return priceChanged || currentMarkets !== lastFilteredMarkets;
}
