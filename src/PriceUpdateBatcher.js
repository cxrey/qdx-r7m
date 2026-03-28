/**
 * PriceUpdateBatcher — collects WebSocket price events and flushes
 * them in fixed 150ms batches to avoid per-tick React re-renders.
 */

const FLUSH_INTERVAL = 150; // ms

export class PriceUpdateBatcher {
  constructor(onFlush) {
    this._onFlush = onFlush;       // (Map<assetId, {price, bestBid, bestAsk, timestamp}>) => void
    this._pending = new Map();     // assetId → latest update
    this._timer = null;
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._timer = setInterval(() => this._flush(), FLUSH_INTERVAL);
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    // Flush any remaining
    if (this._pending.size > 0) this._flush();
  }

  /** Enqueue a price update — only the latest per asset is kept. */
  enqueue(assetId, update) {
    this._pending.set(assetId, update);
  }

  _flush() {
    if (this._pending.size === 0) return;
    const batch = new Map(this._pending);
    this._pending.clear();
    try {
      this._onFlush(batch);
    } catch (err) {
      console.error('[PriceUpdateBatcher] Flush error:', err);
    }
  }

  get pendingCount() {
    return this._pending.size;
  }
}
