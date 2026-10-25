/**
 * WebSocketPriceStream — connects to Polymarket's market WebSocket
 * for real-time price streaming (Tier 1).
 *
 * Protocol (docs.polymarket.com/api-reference/wss/market, verified 2026-07-19):
 *   URL: wss://ws-subscriptions-clob.polymarket.com/ws/market
 *   Handshake: { assets_ids: [], type: "market", initial_dump, custom_feature_enabled }
 *   Subscribe: { operation: "subscribe", assets_ids: [...], custom_feature_enabled }
 *   Unsubscribe: { operation: "unsubscribe", assets_ids: [...] }
 *   Heartbeat: send text "PING" every 10s, expect text "PONG"
 *   Events: price_change, last_trade_price, book, tick_size_change — always;
 *           best_bid_ask, new_market, market_resolved — ONLY when
 *           custom_feature_enabled: true is sent (we rely on new_market for
 *           Tier-2 discovery and market_resolved for resolution callbacks).
 *   initial_dump: false — skips the per-asset orderbook snapshot on
 *   subscribe; we ignore book events and subscribe ~10K assets, so the
 *   default (true) would burst thousands of unused snapshots.
 */

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const PING_INTERVAL = 10_000;      // 10s heartbeat
const PONG_TIMEOUT = 10_000;       // 10s to receive PONG
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY = 1000;
const MAX_ASSETS_PER_SUB = 50;     // assets per subscribe message
const SUB_STAGGER_DELAY = 100;     // ms between subscribe chunks
const MAX_WS_ASSETS = 10_000;      // cap: top 5000 markets × 2 sides

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export class WebSocketPriceStream {
  /**
   * @param {object} opts
   * @param {function} opts.onPriceChange  — (assetId, {price, bestBid, bestAsk, timestamp}) => void
   * @param {function} opts.onResolution   — (winningAssetId, {winningOutcome, assetIds, timestamp}) => void
   * @param {function} opts.onNewMarket    — (data) => void
   * @param {function} opts.onStatusChange — ('connecting'|'connected'|'disconnected'|'error') => void
   */
  constructor({ onPriceChange, onResolution, onNewMarket, onStatusChange }) {
    this._onPriceChange = onPriceChange;
    this._onResolution = onResolution;
    this._onNewMarket = onNewMarket;
    this._onStatusChange = onStatusChange || (() => {});

    this._ws = null;
    this._subscribedAssets = new Set();
    this._pendingSubscribes = new Set();
    this._pendingUnsubscribes = new Set();

    this._pingTimer = null;
    this._pongTimer = null;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._status = 'disconnected';
    this._destroyed = false;
    this._paused = false;
    this._pauseDisconnectTimer = null;
    this._subscribing = false;  // true while staggered subscription is in progress
  }

  // ── Public API ────────────────────────────────────────────────

  connect() {
    if (this._destroyed) return;
    this._setStatus('connecting');
    this._cleanup();

    try {
      this._ws = new WebSocket(WS_URL);
    } catch (err) {
      console.error('[WS] Failed to create WebSocket:', err);
      this._scheduleReconnect();
      return;
    }

    this._ws.onopen = () => {
      console.log('[WS] Connected');
      this._reconnectAttempts = 0;

      // Send handshake — custom_feature_enabled unlocks new_market /
      // market_resolved events; initial_dump: false skips unused book snapshots
      this._send({ assets_ids: [], type: 'market', initial_dump: false, custom_feature_enabled: true });

      // Start heartbeat immediately (server expects it)
      this._startPing();

      // Stagger-subscribe to pending/existing assets
      const allAssets = new Set([...this._subscribedAssets, ...this._pendingSubscribes]);
      this._pendingSubscribes.clear();
      if (allAssets.size > 0) {
        this._staggerSubscribe([...allAssets]);
      }

      // Process pending unsubscribes
      if (this._pendingUnsubscribes.size > 0) {
        this._sendUnsubscribe([...this._pendingUnsubscribes]);
        this._pendingUnsubscribes.clear();
      }

      this._setStatus('connected');
    };

    this._ws.onmessage = (event) => {
      this._handleMessage(event.data);
    };

    this._ws.onerror = (event) => {
      console.error('[WS] Error:', event);
    };

    this._ws.onclose = (event) => {
      console.log(`[WS] Closed: code=${event.code} reason=${event.reason}`);
      this._stopPing();
      this._subscribing = false;
      this._setStatus('disconnected');
      if (!this._destroyed) {
        this._scheduleReconnect();
      }
    };
  }

  disconnect() {
    this._destroyed = true;
    this._cleanup();
    this._setStatus('disconnected');
  }

  /**
   * Subscribe to price updates for the given asset IDs (clobTokenIds).
   * Can be called before connection is open — will queue.
   * Caps at MAX_WS_ASSETS to avoid overloading the connection.
   */
  subscribe(assetIds) {
    if (!assetIds || assetIds.length === 0) return;

    // Cap total subscribed assets
    const remaining = MAX_WS_ASSETS - this._subscribedAssets.size;
    const newIds = assetIds.filter((id) => !this._subscribedAssets.has(id)).slice(0, Math.max(0, remaining));
    if (newIds.length === 0) return;

    newIds.forEach((id) => {
      this._subscribedAssets.add(id);
      this._pendingUnsubscribes.delete(id);
    });

    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._staggerSubscribe(newIds);
    } else {
      newIds.forEach((id) => this._pendingSubscribes.add(id));
    }
  }

  /**
   * Unsubscribe from specific asset IDs.
   */
  unsubscribe(assetIds) {
    if (!assetIds || assetIds.length === 0) return;
    assetIds.forEach((id) => {
      this._subscribedAssets.delete(id);
      this._pendingSubscribes.delete(id);
    });

    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._sendUnsubscribe(assetIds);
    } else {
      assetIds.forEach((id) => this._pendingUnsubscribes.add(id));
    }
  }

  /** Pause processing (tab hidden). Still receives but drops. */
  pause() {
    this._paused = true;
    // Disconnect after 5 minutes if still paused
    this._pauseDisconnectTimer = setTimeout(() => {
      if (this._paused && this._ws) {
        console.log('[WS] Disconnecting after 5min hidden');
        this._ws.close();
      }
    }, 5 * 60 * 1000);
  }

  /** Resume processing (tab visible). Reconnect if needed. */
  resume() {
    this._paused = false;
    if (this._pauseDisconnectTimer) {
      clearTimeout(this._pauseDisconnectTimer);
      this._pauseDisconnectTimer = null;
    }
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      this._reconnectAttempts = 0;
      this.connect();
    }
  }

  get status() {
    return this._status;
  }

  get subscribedCount() {
    return this._subscribedAssets.size;
  }

  // ── Private ───────────────────────────────────────────────────

  _send(data) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(data));
    }
  }

  /**
   * Subscribe in staggered chunks to avoid flooding the server.
   * Sends MAX_ASSETS_PER_SUB assets every SUB_STAGGER_DELAY ms.
   */
  async _staggerSubscribe(assetIds) {
    if (this._subscribing) {
      // Already subscribing — add to pending for next round
      assetIds.forEach((id) => this._pendingSubscribes.add(id));
      return;
    }
    this._subscribing = true;

    const total = assetIds.length;
    let sent = 0;

    for (let i = 0; i < total; i += MAX_ASSETS_PER_SUB) {
      if (this._destroyed || !this._ws || this._ws.readyState !== WebSocket.OPEN) break;

      const chunk = assetIds.slice(i, i + MAX_ASSETS_PER_SUB);
      this._send({ operation: 'subscribe', assets_ids: chunk, custom_feature_enabled: true });
      sent += chunk.length;

      if (i + MAX_ASSETS_PER_SUB < total) {
        await delay(SUB_STAGGER_DELAY);
      }
    }

    console.log(`[WS] Subscribed to ${sent} assets (of ${total} requested, ${this._subscribedAssets.size} total)`);
    this._subscribing = false;

    // Process any that accumulated while we were subscribing
    if (this._pendingSubscribes.size > 0) {
      const next = [...this._pendingSubscribes];
      this._pendingSubscribes.clear();
      this._staggerSubscribe(next);
    }
  }

  _sendUnsubscribe(assetIds) {
    for (let i = 0; i < assetIds.length; i += MAX_ASSETS_PER_SUB) {
      const chunk = assetIds.slice(i, i + MAX_ASSETS_PER_SUB);
      this._send({ operation: 'unsubscribe', assets_ids: chunk });
    }
  }

  _handleMessage(raw) {
    if (this._paused) return;

    // Handle PONG
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed === 'PONG' || trimmed === 'pong') {
        this._onPong();
        return;
      }
    }

    let events;
    try {
      const parsed = JSON.parse(raw);
      events = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return; // non-JSON, ignore
    }

    for (const evt of events) {
      if (!evt || !evt.event_type) continue;

      switch (evt.event_type) {
        case 'price_change':
          this._handlePriceChange(evt);
          break;
        case 'last_trade_price':
          this._handleLastTradePrice(evt);
          break;
        case 'best_bid_ask':
          this._emitQuote(evt.asset_id, evt.best_bid, evt.best_ask, evt.timestamp);
          break;
        case 'market_resolved':
          this._handleResolution(evt);
          break;
        case 'new_market':
          if (this._onNewMarket) this._onNewMarket(evt);
          break;
        // book, tick_size_change — ignored for now
      }
    }
  }

  _handlePriceChange(evt) {
    if (!evt.price_changes || !Array.isArray(evt.price_changes)) return;
    // NOTE: pc.price is the order-book LEVEL whose size changed (e.g. a
    // resting bid deep in the book), not the market price. The market price
    // is the mid of best_bid/best_ask, which each entry also carries.
    for (const pc of evt.price_changes) {
      this._emitQuote(pc.asset_id, pc.best_bid, pc.best_ask, evt.timestamp);
    }
  }

  /** Emit a mid-price update from a best bid/ask pair; skip if either is missing/invalid. */
  _emitQuote(assetId, rawBid, rawAsk, timestamp) {
    if (!assetId) return;
    const bestBid = parseFloat(rawBid);
    const bestAsk = parseFloat(rawAsk);
    if (!isFinite(bestBid) || !isFinite(bestAsk) || bestBid <= 0 || bestAsk >= 1 || bestAsk < bestBid) return;
    this._onPriceChange(assetId, {
      price: (bestBid + bestAsk) / 2,
      bestBid,
      bestAsk,
      timestamp,
    });
  }

  _handleLastTradePrice(evt) {
    if (!evt.asset_id) return;
    this._onPriceChange(evt.asset_id, {
      price: parseFloat(evt.price),
      bestBid: null,
      bestAsk: null,
      timestamp: evt.timestamp,
    });
  }

  _handleResolution(evt) {
    // Payload: { winning_asset_id, winning_outcome, assets_ids: [...], market }
    if (!evt.winning_asset_id) return;
    this._onResolution(evt.winning_asset_id, {
      winningOutcome: evt.winning_outcome ?? null,
      assetIds: Array.isArray(evt.assets_ids) ? evt.assets_ids : [],
      timestamp: evt.timestamp,
    });
  }

  // ── Heartbeat ─────────────────────────────────────────────────

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        try {
          this._ws.send('PING');
        } catch { /* ignore */ }

        // Set pong timeout — clear any existing first
        if (this._pongTimer) clearTimeout(this._pongTimer);
        this._pongTimer = setTimeout(() => {
          console.warn('[WS] Pong timeout — reconnecting');
          if (this._ws) this._ws.close();
        }, PONG_TIMEOUT);
      }
    }, PING_INTERVAL);
  }

  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    if (this._pongTimer) { clearTimeout(this._pongTimer); this._pongTimer = null; }
  }

  _onPong() {
    if (this._pongTimer) { clearTimeout(this._pongTimer); this._pongTimer = null; }
  }

  // ── Reconnection ──────────────────────────────────────────────

  _scheduleReconnect() {
    if (this._destroyed || this._reconnectTimer) return;
    if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`[WS] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached — falling back to polling`);
      this._setStatus('error');
      return;
    }

    const d = RECONNECT_BASE_DELAY * Math.pow(2, this._reconnectAttempts);
    const jitter = d * 0.3 * Math.random();
    const totalDelay = Math.min(d + jitter, 30_000);

    console.log(`[WS] Reconnecting in ${Math.round(totalDelay)}ms (attempt ${this._reconnectAttempts + 1})`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnectAttempts++;
      this.connect();
    }, totalDelay);
  }

  _cleanup() {
    this._stopPing();
    this._subscribing = false;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._pauseDisconnectTimer) { clearTimeout(this._pauseDisconnectTimer); this._pauseDisconnectTimer = null; }
    if (this._ws) {
      this._ws.onopen = null;
      this._ws.onmessage = null;
      this._ws.onerror = null;
      this._ws.onclose = null;
      if (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING) {
        this._ws.close();
      }
      this._ws = null;
    }
  }

  _setStatus(status) {
    if (this._status === status) return;
    this._status = status;
    this._onStatusChange(status);
  }
}
