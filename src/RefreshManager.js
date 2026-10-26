/**
 * RefreshManager — orchestrates all three refresh tiers:
 *   Tier 1: WebSocket price streaming (real-time)
 *   Tier 2: New market discovery (every 5min via Worker)
 *   Tier 3: Full catalog refresh (every 30min via Worker)
 *
 * Also handles: tab visibility, rate limit budget, polling fallback,
 * smart diffing, and resolution detection.
 */

import { WebSocketPriceStream } from './WebSocketPriceStream';
import { PriceUpdateBatcher } from './PriceUpdateBatcher';
import { fetchCatalog, flattenEventsToMarkets } from './api';
import { CATALOG_MIN_VOLUME } from './engineConfig';
import { processMarket, enrichWithBaseRate } from './processMarket';
import { processAllInWorker } from './workerManager';
import { handleRateLimit, getBackoffMultiplier, onBackoffChange, isClobRateLimited } from './ApiHealthManager';
import { withTimeout, TIMEOUT_GAMMA_PAGE } from './fetchUtils';
import { GAMMA_API } from './apiConfig';

const TIER2_INTERVAL = 60 * 1000;            // 60 sec (3 requests per cycle)
const TIER2_COOLDOWN = 30 * 1000;            // min gap between Tier 2 runs (must be < TIER2_INTERVAL)
const TIER3_INTERVAL = 10 * 60 * 1000;      // 10 min (parallel fetch burst)
const POLLING_FALLBACK_INTERVAL = 30_000;    // 30s polling if WS fails
const NEW_MARKET_PAGES = 3;                  // check first 3 pages for new markets
const PAGE_SIZE = 100;

export class RefreshManager {
  /**
   * @param {object} opts
   * @param {function} opts.onPriceUpdate     — (Map<marketId, {yesPrice, noPrice}>) => void
   * @param {function} opts.onNewMarkets      — (processedMarkets[]) => void
   * @param {function} opts.onFullRefresh     — (processedMarkets[]) => void
   * @param {function} opts.onResolution      — (marketId) => void
   * @param {function} opts.onStatusChange    — ({ws, tier, message}) => void
   * @param {function} opts.onToast           — ({type, message}) => void
   * @param {function} opts.getAssetIndex     — () => Map<assetId, marketId>  (for mapping WS updates)
   * @param {function} opts.getCurrentMarkets — () => processedMarket[]
   * @param {object}   opts.baseRatesRef      — ref to base rates
   */
  constructor(opts) {
    this._opts = opts;
    this._enabled = false;
    this._destroyed = false;

    // Build asset→market index for WS price mapping
    this._assetToMarket = new Map(); // assetId → { marketId, side: 'yes'|'no' }
    // Assets of markets settled via market_resolved — later quotes are ignored
    this._resolvedAssets = new Set();

    // marketId → consecutive incomplete Tier 3 crawls that missed it
    this._unconfirmedMisses = new Map();

    // Aborts in-flight Tier 2 / polling requests on stop()
    this._bgController = null;

    // Backoff multiplier listener (managed by ApiHealthManager)
    this._unsubBackoff = null;

    // Tier 3 abort controller
    this._tier3Controller = null;
    this._tier3Running = false;

    // Tier 2 state
    this._tier2Running = false;
    this._tier2LastCompleted = 0;  // timestamp of last completed Tier 2 run

    // Polling fallback
    this._pollingTimer = null;
    this._usePolling = false;

    // Worker
    this._worker = null;

    // WebSocket
    this._ws = null;
    this._batcher = null;

    // WS status
    this._wsStatus = 'disconnected';

    // Tab visibility
    this._handleVisibility = this._onVisibilityChange.bind(this);
  }

  // ── Public API ────────────────────────────────────────────────

  start() {
    if (this._enabled || this._destroyed) return;
    this._enabled = true;
    this._bgController = new AbortController();

    // Set up batcher
    this._batcher = new PriceUpdateBatcher((batch) => this._flushPriceUpdates(batch));
    this._batcher.start();

    // Start WebSocket
    this._startWebSocket();

    // Start Worker for Tier 2/3 timers
    this._startWorker();

    // Subscribe to backoff multiplier changes from ApiHealthManager
    this._unsubBackoff = onBackoffChange((multiplier) => {
      if (this._worker) {
        this._worker.postMessage({
          type: 'updateIntervals',
          tier2Interval: TIER2_INTERVAL * multiplier,
          tier3Interval: TIER3_INTERVAL * multiplier,
        });
      } else if (this._tier2FallbackTimer || this._tier3FallbackTimer) {
        // Recreate fallback timers with updated interval
        if (this._tier2FallbackTimer) {
          clearInterval(this._tier2FallbackTimer);
          this._tier2FallbackTimer = setInterval(() => this._runTier2(), TIER2_INTERVAL * multiplier);
        }
        if (this._tier3FallbackTimer) {
          clearInterval(this._tier3FallbackTimer);
          this._tier3FallbackTimer = setInterval(() => this._runTier3(), TIER3_INTERVAL * multiplier);
        }
      }
    });

    // Listen for tab visibility
    document.addEventListener('visibilitychange', this._handleVisibility);

    console.log('[RefreshManager] Started');
  }

  stop() {
    if (!this._enabled) return;
    this._enabled = false;
    this._bgController?.abort();
    this._bgController = null;

    // Stop WebSocket
    if (this._ws) {
      this._ws.disconnect();
      this._ws = null;
    }

    // Stop batcher
    if (this._batcher) {
      this._batcher.stop();
      this._batcher = null;
    }

    // Stop worker
    if (this._worker) {
      this._worker.postMessage({ type: 'stop' });
      this._worker.terminate();
      this._worker = null;
    }

    // Stop polling fallback
    this._stopPolling();

    // Abort any in-flight Tier 3. Clear the running flag here too: the aborted
    // run's `finally` leaves it alone once the controller is no longer its own,
    // so a stop() mid-crawl would otherwise block every Tier 3 after start().
    if (this._tier3Controller) {
      this._tier3Controller.abort();
      this._tier3Controller = null;
      this._tier3Running = false;
    }

    // Remove visibility listener
    document.removeEventListener('visibilitychange', this._handleVisibility);

    // Clear worker-fallback timers (set when Worker creation fails)
    if (this._tier2FallbackTimer) {
      clearInterval(this._tier2FallbackTimer);
      this._tier2FallbackTimer = null;
    }
    if (this._tier3FallbackTimer) {
      clearInterval(this._tier3FallbackTimer);
      this._tier3FallbackTimer = null;
    }

    // Unsubscribe from backoff changes
    if (this._unsubBackoff) {
      this._unsubBackoff();
      this._unsubBackoff = null;
    }

    this._wsStatus = 'disconnected';
    this._opts.onStatusChange?.({ ws: 'disconnected', tier: null, message: 'Auto-refresh stopped' });

    console.log('[RefreshManager] Stopped');
  }

  destroy() {
    this.stop();
    this._destroyed = true;
  }

  /** Rebuild the asset→market index from current markets. */
  rebuildAssetIndex(markets) {
    this._assetToMarket.clear();
    this._indexMarketAssets(markets);

    // Forget resolved-asset markers for assets no longer in the catalog
    for (const id of this._resolvedAssets) {
      if (!this._assetToMarket.has(id)) this._resolvedAssets.delete(id);
    }

    // Also while polling: the stream queues (un)subscriptions while its socket
    // is closed and sends them when it reconnects. Skipping them here left
    // markets indexed during polling unsubscribed — no live prices — until
    // the next Tier 3 rebuild.
    if (this._ws) {
      // Unsubscribe assets that dropped out of the catalog FIRST: they would
      // otherwise keep streaming and keep occupying MAX_WS_ASSETS slots, so
      // newly listed markets would eventually be refused a subscription.
      const dropped = [...this._ws.subscribedAssets].filter((id) => !this._assetToMarket.has(id));
      if (dropped.length > 0) this._ws.unsubscribe(dropped);

      this._ws.subscribe([...this._assetToMarket.keys()]);
    }
  }

  /**
   * Add each market's YES/NO token → market mapping to the asset index.
   * @returns {string[]} the asset ids that were indexed
   */
  _indexMarketAssets(markets) {
    const assetIds = [];
    for (const m of markets) {
      if (m.clobTokenIds?.length >= 2) {
        this._assetToMarket.set(m.clobTokenIds[0], { marketId: m.id, side: 'yes' });
        this._assetToMarket.set(m.clobTokenIds[1], { marketId: m.id, side: 'no' });
        assetIds.push(m.clobTokenIds[0], m.clobTokenIds[1]);
      }
    }
    return assetIds;
  }

  /** Background Gamma fetch with a timeout, cancelled by stop(). */
  _bgFetch(url) {
    return fetch(url, { signal: withTimeout(this._bgController?.signal, TIMEOUT_GAMMA_PAGE) });
  }

  /** Called after manual refresh to reset Tier 3 timer */
  resetTier3Timer() {
    if (this._worker) {
      this._worker.postMessage({ type: 'resetTier3' });
    }
    // Abort any in-flight Tier 3
    if (this._tier3Controller) {
      this._tier3Controller.abort();
      this._tier3Controller = null;
      this._tier3Running = false;
    }
  }

  get wsStatus() {
    return this._usePolling ? 'polling' : this._wsStatus;
  }

  get isEnabled() {
    return this._enabled;
  }

  // ── WebSocket (Tier 1) ────────────────────────────────────────

  _startWebSocket() {
    this._ws = new WebSocketPriceStream({
      onPriceChange: (assetId, update) => {
        if (this._resolvedAssets.has(assetId)) return;
        if (this._batcher) {
          this._batcher.enqueue(assetId, update);
        }
      },
      onResolution: (winningAssetId, data) => {
        const mapping = this._assetToMarket.get(winningAssetId);
        if (!mapping) return;
        // Settle prices: winning token → 1, losing token → 0. Enqueued through
        // the batcher (not sent directly) so it REPLACES any quote already
        // queued for these assets instead of being overwritten by it on the
        // next flush; later quotes for these assets are dropped above.
        const settle = new Map([[winningAssetId, { price: 1 }]]);
        for (const id of data.assetIds) {
          if (id !== winningAssetId) settle.set(id, { price: 0 });
        }
        for (const [id, update] of settle) {
          this._resolvedAssets.add(id);
          if (this._batcher) this._batcher.enqueue(id, update);
        }
        if (!this._batcher) this._flushPriceUpdates(settle);
        this._opts.onResolution?.(mapping.marketId);
        const outcome = data.winningOutcome || (mapping.side === 'yes' ? 'Yes' : 'No');
        this._opts.onToast?.({ type: 'info', message: `Market resolved: ${outcome}` });
      },
      onNewMarket: () => {
        // WS new_market event — trigger an immediate Tier 2 check
        this._runTier2();
      },
      onStatusChange: (status) => {
        this._wsStatus = status;
        this._opts.onStatusChange?.({ ws: status, tier: 1, message: `WebSocket: ${status}` });

        if (status === 'error') {
          // WS failed after max retries — fall back to polling
          console.warn('[RefreshManager] WebSocket failed — switching to polling fallback');
          this._usePolling = true;
          this._startPolling();
          this._opts.onStatusChange?.({ ws: 'polling', tier: 1, message: 'Polling fallback active' });
          this._opts.onToast?.({ type: 'warn', message: 'Live prices unavailable — using polling' });
        }
        if (status === 'connected' && this._usePolling) {
          // WS recovered — stop polling
          this._usePolling = false;
          this._stopPolling();
          this._opts.onStatusChange?.({ ws: 'connected', tier: 1, message: 'WebSocket reconnected' });
          this._opts.onToast?.({ type: 'success', message: 'Live prices restored' });
        }
      },
    });

    this._ws.connect();

    // Subscribe to all known assets
    const allAssets = [...this._assetToMarket.keys()];
    if (allAssets.length > 0) {
      this._ws.subscribe(allAssets);
    }
  }

  // ── Polling Fallback ──────────────────────────────────────────

  _startPolling() {
    this._stopPolling();
    this._pollingTimer = setInterval(() => this._pollPrices(), POLLING_FALLBACK_INTERVAL);
  }

  _stopPolling() {
    if (this._pollingTimer) {
      clearInterval(this._pollingTimer);
      this._pollingTimer = null;
    }
  }

  async _pollPrices() {
    if (!this._enabled) return;
    // Don't hammer Gamma API while the circuit breaker is tripped — the 30s
    // polling interval ignores backoff and would extend the rate limit window.
    if (isClobRateLimited()) return;
    try {
      // Fetch first 3 pages of markets sorted by volume (most active).
      // Intentionally uses /markets (not /events) — only needs prices, not tags.
      const updates = new Map();
      for (let page = 0; page < 3; page++) {
        const url = `${GAMMA_API}/markets?limit=100&offset=${page * 100}&active=true&closed=false&order=volume&ascending=false`;
        const res = await this._bgFetch(url);
        if (res.status === 429 || res.status === 403) {
          this._handleRateLimit(res.status);
          this._opts.onToast?.({ type: 'warn', message: `Gamma API ${res.status === 403 ? 'forbidden' : 'rate limited'} during polling` });
          break;
        }
        if (!res.ok) break;
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) break;

        for (const m of data) {
          let outcomePrices = [];
          try { if (m.outcomePrices) outcomePrices = JSON.parse(m.outcomePrices); } catch { console.debug('[RefreshManager] Skipping malformed outcomePrices for', m.id); }
          if (outcomePrices.length >= 2) {
            updates.set(m.id, {
              yesPrice: parseFloat(outcomePrices[0]),
              noPrice: parseFloat(outcomePrices[1]),
            });
          }
        }
      }

      if (updates.size > 0) {
        this._opts.onPriceUpdate?.(updates);
      }
    } catch (err) {
      if (err.name !== 'AbortError') console.warn('[RefreshManager] Polling error:', err.message);
    }
  }

  // ── Worker (Tier 2 & 3) ──────────────────────────────────────

  _startWorker() {
    try {
      this._worker = new Worker(
        new URL('./refreshWorker.js', import.meta.url),
        { type: 'module' }
      );

      this._worker.onmessage = (e) => {
        switch (e.data.type) {
          case 'tier2Tick':
            this._runTier2();
            break;
          case 'tier3Tick':
            this._runTier3();
            break;
        }
      };

      this._worker.onerror = (err) => {
        console.error('[RefreshManager] Worker error:', err);
      };

      this._worker.postMessage({
        type: 'start',
        tier2Interval: TIER2_INTERVAL * getBackoffMultiplier(),
        tier3Interval: TIER3_INTERVAL * getBackoffMultiplier(),
      });
    } catch (err) {
      console.error('[RefreshManager] Worker creation failed, using setInterval fallback:', err);
      // Fallback: use main-thread timers
      this._tier2FallbackTimer = setInterval(() => this._runTier2(), TIER2_INTERVAL * getBackoffMultiplier());
      this._tier3FallbackTimer = setInterval(() => this._runTier3(), TIER3_INTERVAL * getBackoffMultiplier());
    }
  }

  // ── Tier 2: New Market Discovery ──────────────────────────────

  async _runTier2() {
    if (!this._enabled || this._tier2Running) return;

    // Cooldown: skip if Tier 2 completed less than TIER2_COOLDOWN ago
    if (Date.now() - this._tier2LastCompleted < TIER2_COOLDOWN) return;

    this._tier2Running = true;

    try {
      const existingMarkets = this._opts.getCurrentMarkets?.() || [];
      const existingIds = new Set(existingMarkets.map((m) => m.id));
      // Dedupe within this run too: pages are fetched sequentially ordered
      // by createdAt, so a market created mid-run shifts offsets and can
      // appear on two pages — without this, it would be added twice
      // (duplicate rows / duplicate React keys).
      const seenThisRun = new Set();

      const newMarkets = [];
      for (let page = 0; page < NEW_MARKET_PAGES; page++) {
        // Fetch from /events to get event-level tags for fee category resolution.
        // Same event-level floor as the catalog crawl (CATALOG_MIN_VOLUME).
        // NOTE: /events filters by `volume_min`; it silently IGNORES
        // `volume_num_min` (that's the /markets name), which is why discovery
        // previously pulled in events with single-digit volume.
        const url = `${GAMMA_API}/events?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}&active=true&closed=false&order=createdAt&ascending=false&volume_min=${CATALOG_MIN_VOLUME}`;
        const res = await this._bgFetch(url);

        if (res.status === 429 || res.status === 403) {
          this._handleRateLimit(res.status);
          break;
        }
        if (!res.ok) break;

        const events = await res.json();
        if (!Array.isArray(events) || events.length === 0) break;

        const flattened = flattenEventsToMarkets(events);
        for (const m of flattened) {
          if (!existingIds.has(m.id) && !seenThisRun.has(m.id)) {
            seenThisRun.add(m.id);
            let processed = processMarket(m);
            if (processed.question) {
              const rates = this._opts.baseRatesRef?.current;
              if (rates) {
                processed = enrichWithBaseRate(processed, rates);
              }
              newMarkets.push(processed);
            }
          }
        }
      }

      if (newMarkets.length > 0) {
        console.log(`[RefreshManager] Tier 2: Found ${newMarkets.length} new markets`);
        this._opts.onNewMarkets?.(newMarkets);
        this._opts.onToast?.({ type: 'info', message: `${newMarkets.length} new market${newMarkets.length > 1 ? 's' : ''} discovered` });

        // Subscribe to new market assets (queued by the stream while polling)
        const newAssets = this._indexMarketAssets(newMarkets);
        if (newAssets.length > 0 && this._ws) {
          this._ws.subscribe(newAssets);
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('[RefreshManager] Tier 2 error:', err.message);
      }
    } finally {
      this._tier2Running = false;
      this._tier2LastCompleted = Date.now();
    }
  }

  // ── Tier 3: Full Catalog Refresh ──────────────────────────────

  async _runTier3() {
    if (!this._enabled || this._tier3Running) return;
    this._tier3Running = true;
    // This run's own controller. resetTier3Timer()/stop() abort it and null
    // this._tier3Controller (and may start a new run) while we're awaiting;
    // fetchCatalog resolves with partial results on abort rather than
    // throwing, so every check reads the local `signal`, and `finally` only
    // clears state that still belongs to this run.
    const controller = new AbortController();
    this._tier3Controller = controller;
    const { signal } = controller;

    try {
      this._opts.onStatusChange?.({ ws: this.wsStatus, tier: 3, message: 'Full refresh in progress...' });

      const { markets: raw, complete } = await fetchCatalog(
        null, // no progress callback for background refresh
        signal
      );

      if (signal.aborted) return;

      // Deduplicate
      const seen = new Set();
      const deduped = raw.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });

      if (signal.aborted) return;
      const allProcessed = await processAllInWorker(deduped);
      if (signal.aborted) return;
      let processed = allProcessed.filter((m) => m.question);

      // Smart diff against current markets
      const currentMarkets = this._opts.getCurrentMarkets?.() || [];
      processed = keepUnconfirmedMarkets(processed, currentMarkets, complete, this._unconfirmedMisses);
      const diff = smartDiff(currentMarkets, processed);

      if (diff.hasChanges) {
        console.log(
          `[RefreshManager] Tier 3: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.priceChanged.length} price changes`
        );

        // Apply base rates
        const rates = this._opts.baseRatesRef?.current;
        if (rates) {
          for (let i = 0; i < processed.length; i++) {
            processed[i] = enrichWithBaseRate(processed[i], rates);
          }
        }

        // Removed (possibly resolved) markets drop out with the new array —
        // no per-id onResolution call needed.
        this._opts.onFullRefresh?.(processed);

        // Rebuild asset index
        this.rebuildAssetIndex(processed);

        if (diff.added.length > 0 || diff.removed.length > 0) {
          this._opts.onToast?.({
            type: 'info',
            message: `Catalog refreshed: +${diff.added.length} / -${diff.removed.length} markets`,
          });
        }
      } else {
        console.log('[RefreshManager] Tier 3: No changes detected');
      }

      this._opts.onStatusChange?.({ ws: this.wsStatus, tier: null, message: null });
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('[RefreshManager] Tier 3 error:', err.message);
      }
    } finally {
      // A newer run may have started after this one was aborted — leave its state alone
      if (this._tier3Controller === controller) {
        this._tier3Running = false;
        this._tier3Controller = null;
      }
    }
  }

  // ── Price Flush ───────────────────────────────────────────────

  _flushPriceUpdates(batch) {
    // batch: Map<assetId, {price, bestBid, bestAsk, timestamp}>
    // Convert to Map<marketId, {yesPrice, noPrice}>
    // YES and NO are complementary tokens: derive one from the other so the
    // pair can't drift apart. When both sides update in one batch, the
    // YES-token quote wins.
    const marketUpdates = new Map();

    for (const [assetId, update] of batch) {
      const mapping = this._assetToMarket.get(assetId);
      if (!mapping || !isFinite(update.price)) continue;

      const { marketId, side } = mapping;
      const existing = marketUpdates.get(marketId);
      if (side === 'yes') {
        marketUpdates.set(marketId, { yesPrice: update.price, noPrice: 1 - update.price, _fromYes: true });
      } else if (!existing?._fromYes) {
        marketUpdates.set(marketId, { yesPrice: 1 - update.price, noPrice: update.price });
      }
    }
    for (const entry of marketUpdates.values()) delete entry._fromYes;

    if (marketUpdates.size > 0) {
      this._opts.onPriceUpdate?.(marketUpdates);
    }
  }

  // ── Rate Limit Management ─────────────────────────────────────

  _handleRateLimit(statusCode = 429) {
    // Delegate to unified ApiHealthManager — triggers circuit breaker,
    // concurrency reduction, and backoff escalation in one call.
    // Worker interval updates happen via the onBackoffChange subscription.
    handleRateLimit(statusCode);
  }

  // ── Tab Visibility ────────────────────────────────────────────

  _onVisibilityChange() {
    if (document.hidden) {
      if (this._ws) this._ws.pause();
    } else {
      if (this._ws) this._ws.resume();
      // If polling was active, do an immediate poll on return
      if (this._usePolling) {
        this._pollPrices();
      }
    }
  }
}

// ── Smart Diff ──────────────────────────────────────────────────

// A market missing from this many consecutive INCOMPLETE crawls is dropped
// anyway — otherwise a band that keeps failing would keep resolved markets
// forever.
export const MAX_UNCONFIRMED_REFRESHES = 3;

/**
 * After an INCOMPLETE catalog crawl (a band stopped early on a failed page,
 * rate limit, or page cap), markets missing from the crawl are unconfirmed,
 * not removed: keep the current copies so a transient failure can't wipe
 * thousands of rows until the next refresh. A complete crawl is authoritative.
 *
 * `misses` (marketId → consecutive unconfirmed refreshes) persists across
 * calls and is updated in place: a market seen again resets to 0, and one
 * unconfirmed for MAX_UNCONFIRMED_REFRESHES refreshes in a row is dropped.
 */
export function keepUnconfirmedMarkets(crawled, currentMarkets, complete, misses = new Map()) {
  if (complete) {
    misses.clear();
    return crawled;
  }
  const crawledIds = new Set(crawled.map((m) => m.id));
  for (const id of crawledIds) misses.delete(id);

  const kept = [];
  let dropped = 0;
  for (const m of currentMarkets) {
    if (crawledIds.has(m.id)) continue;
    const count = (misses.get(m.id) || 0) + 1;
    if (count >= MAX_UNCONFIRMED_REFRESHES) {
      misses.delete(m.id);
      dropped++;
    } else {
      misses.set(m.id, count);
      kept.push(m);
    }
  }
  if (kept.length > 0 || dropped > 0) {
    console.warn(`[RefreshManager] Tier 3 crawl incomplete — keeping ${kept.length} markets it didn't reach` +
      (dropped > 0 ? `, dropping ${dropped} unconfirmed for ${MAX_UNCONFIRMED_REFRESHES} refreshes in a row` : ''));
  }
  return kept.length > 0 ? crawled.concat(kept) : crawled;
}

/**
 * Compare old and new market arrays to detect changes.
 * Builds id-keyed maps and compares yesPrice/noPrice per market.
 */
function smartDiff(oldMarkets, newMarkets) {
  const oldMap = new Map(oldMarkets.map((m) => [m.id, m]));
  const newMap = new Map(newMarkets.map((m) => [m.id, m]));

  const added = [];
  const removed = [];
  const priceChanged = [];

  // Find added and price-changed
  for (const [id, newM] of newMap) {
    const oldM = oldMap.get(id);
    if (!oldM) {
      added.push(id);
    } else {
      if (oldM.yesPrice !== newM.yesPrice || oldM.noPrice !== newM.noPrice) {
        priceChanged.push(id);
      }
    }
  }

  // Find removed
  for (const id of oldMap.keys()) {
    if (!newMap.has(id)) {
      removed.push(id);
    }
  }

  return {
    added,
    removed,
    priceChanged,
    hasChanges: added.length > 0 || removed.length > 0 || priceChanged.length > 0,
  };
}
