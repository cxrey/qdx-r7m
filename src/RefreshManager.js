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
import { fetchAllMarkets, flattenEventsToMarkets } from './api';
import { processMarket, enrichWithBaseRate } from './processMarket';
import { processAllInWorker } from './workerManager';
import { handleRateLimit, getBackoffMultiplier, onBackoffChange, isClobRateLimited } from './ApiHealthManager';

const TIER2_INTERVAL = 60 * 1000;            // 60 sec (3 requests per cycle)
const TIER2_COOLDOWN = 30 * 1000;            // min gap between Tier 2 runs (must be < TIER2_INTERVAL)
const TIER3_INTERVAL = 10 * 60 * 1000;      // 10 min (parallel fetch burst)
const POLLING_FALLBACK_INTERVAL = 30_000;    // 30s polling if WS fails
const NEW_MARKET_PAGES = 3;                  // check first 3 pages for new markets
const PAGE_SIZE = 100;
const GAMMA_API = '/gamma-api';

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

    // Abort any in-flight Tier 3
    if (this._tier3Controller) {
      this._tier3Controller.abort();
      this._tier3Controller = null;
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
    for (const m of markets) {
      if (m.clobTokenIds && m.clobTokenIds.length >= 2) {
        this._assetToMarket.set(m.clobTokenIds[0], { marketId: m.id, side: 'yes' });
        this._assetToMarket.set(m.clobTokenIds[1], { marketId: m.id, side: 'no' });
      }
    }

    // Subscribe WS to all asset IDs
    if (this._ws && !this._usePolling) {
      const allAssets = [...this._assetToMarket.keys()];
      this._ws.subscribe(allAssets);
    }
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
        if (this._batcher) {
          this._batcher.enqueue(assetId, update);
        }
      },
      onResolution: (winningAssetId, data) => {
        const mapping = this._assetToMarket.get(winningAssetId);
        if (!mapping) return;
        // Settle prices: winning token → 1, losing token → 0
        const yesPrice = mapping.side === 'yes' ? 1 : 0;
        this._opts.onPriceUpdate?.(new Map([[mapping.marketId, { yesPrice, noPrice: 1 - yesPrice }]]));
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
        const res = await fetch(url);
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
      console.warn('[RefreshManager] Polling error:', err.message);
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
        // Fetch from /events to get event-level tags for fee category resolution
        const url = `${GAMMA_API}/events?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}&active=true&closed=false&order=createdAt&ascending=false&volume_num_min=100`;
        const res = await fetch(url);

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

        // Subscribe to new market assets
        const newAssets = [];
        for (const m of newMarkets) {
          if (m.clobTokenIds?.length >= 2) {
            this._assetToMarket.set(m.clobTokenIds[0], { marketId: m.id, side: 'yes' });
            this._assetToMarket.set(m.clobTokenIds[1], { marketId: m.id, side: 'no' });
            newAssets.push(m.clobTokenIds[0], m.clobTokenIds[1]);
          }
        }
        if (newAssets.length > 0 && this._ws && !this._usePolling) {
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
    this._tier3Controller = new AbortController();

    try {
      this._opts.onStatusChange?.({ ws: this.wsStatus, tier: 3, message: 'Full refresh in progress...' });

      const raw = await fetchAllMarkets(
        null, // no progress callback for background refresh
        this._tier3Controller.signal
      );

      if (this._tier3Controller.signal.aborted) return;

      // Deduplicate
      const seen = new Set();
      const deduped = raw.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });

      if (this._tier3Controller.signal.aborted) return;
      const allProcessed = await processAllInWorker(deduped);
      if (this._tier3Controller.signal.aborted) return;
      const processed = allProcessed.filter((m) => m.question);

      // Smart diff against current markets
      const currentMarkets = this._opts.getCurrentMarkets?.() || [];
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

        this._opts.onFullRefresh?.(processed);

        // Notify about removed (possibly resolved) markets
        for (const id of diff.removed) {
          this._opts.onResolution?.(id);
        }

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
      this._tier3Running = false;
      this._tier3Controller = null;
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
