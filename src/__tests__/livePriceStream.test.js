/**
 * Live price path: WebSocketPriceStream event parsing and RefreshManager's
 * conversion of per-token quotes into market yes/no prices.
 * Payloads are the documented examples from
 * docs.polymarket.com/market-data/websocket/market-channel.
 */
import { describe, it, expect, vi } from 'vitest';

// Capture the callbacks RefreshManager hands to the stream, without opening a socket
const wsInstances = [];
vi.mock('../WebSocketPriceStream', async (importOriginal) => {
  const actual = await importOriginal();
  class MockStream {
    constructor(opts) { this.opts = opts; wsInstances.push(this); }
    connect() {}
    subscribe() {}
  }
  return { ...actual, RealWebSocketPriceStream: actual.WebSocketPriceStream, WebSocketPriceStream: MockStream };
});

const { RealWebSocketPriceStream: WebSocketPriceStream } = await import('../WebSocketPriceStream');
const { RefreshManager } = await import('../RefreshManager');

const YES = '107505882767731489358349912513945399560393482969656700824895970500493757150417';
const NO = '7305630249804085635496399869905769372294302716159034447326228509068694952392';

function makeStream() {
  const onPriceChange = vi.fn();
  const onResolution = vi.fn();
  const onNewMarket = vi.fn();
  const stream = new WebSocketPriceStream({ onPriceChange, onResolution, onNewMarket });
  return { stream, onPriceChange, onResolution, onNewMarket };
}

describe('WebSocketPriceStream — price_change', () => {
  const docExample = {
    event_type: 'price_change',
    market: '0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75',
    price_changes: [{
      asset_id: YES, price: '0.08', size: '33343.4', side: 'BUY',
      hash: '56621a121a47ed9333273e21c83b660cff37ae50', best_bid: '0.08', best_ask: '0.09',
    }],
    timestamp: '1782753357257',
  };

  it('emits the best bid/ask mid, not the changed book level', () => {
    const { stream, onPriceChange } = makeStream();
    stream._handleMessage(JSON.stringify(docExample));
    expect(onPriceChange).toHaveBeenCalledTimes(1);
    const [assetId, update] = onPriceChange.mock.calls[0];
    expect(assetId).toBe(YES);
    expect(update.price).toBeCloseTo(0.085, 10);
    expect(update.bestBid).toBe(0.08);
    expect(update.bestAsk).toBe(0.09);
  });

  it('ignores the level price even when it is far from the touch', () => {
    const { stream, onPriceChange } = makeStream();
    const deepLevel = {
      ...docExample,
      price_changes: [{ ...docExample.price_changes[0], price: '0.02', best_bid: '0.64', best_ask: '0.66' }],
    };
    stream._handleMessage(JSON.stringify(deepLevel));
    expect(onPriceChange.mock.calls[0][1].price).toBeCloseTo(0.65, 10);
  });

  it('skips entries without a valid best bid and ask', () => {
    const { stream, onPriceChange } = makeStream();
    const entries = [
      { asset_id: YES, price: '0.5', best_bid: null, best_ask: '0.6' },
      { asset_id: YES, price: '0.5', best_bid: '0.4' },
      { asset_id: YES, price: '0.5', best_bid: '0', best_ask: '0.6' },   // empty bid side
      { asset_id: YES, price: '0.5', best_bid: '0.4', best_ask: '1' },   // empty ask side
      { asset_id: YES, price: '0.5', best_bid: '0.7', best_ask: '0.6' }, // crossed
    ];
    stream._handleMessage(JSON.stringify({ event_type: 'price_change', price_changes: entries, timestamp: '1' }));
    expect(onPriceChange).not.toHaveBeenCalled();
  });
});

describe('WebSocketPriceStream — best_bid_ask', () => {
  it('emits the mid from the documented payload', () => {
    const { stream, onPriceChange } = makeStream();
    stream._handleMessage(JSON.stringify({
      event_type: 'best_bid_ask',
      market: '0x747d',
      asset_id: YES,
      best_bid: '0.08', best_ask: '0.09', spread: '0.01',
      timestamp: '1782753357257',
    }));
    expect(onPriceChange.mock.calls[0][0]).toBe(YES);
    expect(onPriceChange.mock.calls[0][1].price).toBeCloseTo(0.085, 10);
  });
});

describe('WebSocketPriceStream — market_resolved', () => {
  it('emits the winning asset and outcome from the documented payload', () => {
    const { stream, onResolution } = makeStream();
    stream._handleMessage(JSON.stringify({
      event_type: 'market_resolved',
      id: '123456',
      market: '0x747d',
      assets_ids: [YES, NO],
      winning_asset_id: YES,
      winning_outcome: 'Yes',
      timestamp: '1782753357257',
    }));
    expect(onResolution).toHaveBeenCalledWith(YES, {
      winningOutcome: 'Yes',
      assetIds: [YES, NO],
      timestamp: '1782753357257',
    });
  });

  it('ignores a malformed resolution without winning_asset_id', () => {
    const { stream, onResolution } = makeStream();
    stream._handleMessage(JSON.stringify({ event_type: 'market_resolved', asset_id: YES, price: '1' }));
    expect(onResolution).not.toHaveBeenCalled();
  });
});

describe('RefreshManager — live price mapping', () => {
  function makeManager() {
    const onPriceUpdate = vi.fn();
    const onResolution = vi.fn();
    const onToast = vi.fn();
    const mgr = new RefreshManager({ onPriceUpdate, onResolution, onToast });
    mgr.rebuildAssetIndex([{ id: 'm1', clobTokenIds: [YES, NO] }]);
    return { mgr, onPriceUpdate, onResolution, onToast };
  }

  it('derives NO as 1 − YES from a YES-token quote', () => {
    const { mgr, onPriceUpdate } = makeManager();
    mgr._flushPriceUpdates(new Map([[YES, { price: 0.65 }]]));
    const update = onPriceUpdate.mock.calls[0][0].get('m1');
    expect(update.yesPrice).toBeCloseTo(0.65, 10);
    expect(update.noPrice).toBeCloseTo(0.35, 10);
  });

  it('derives YES as 1 − NO from a NO-token quote', () => {
    const { mgr, onPriceUpdate } = makeManager();
    mgr._flushPriceUpdates(new Map([[NO, { price: 0.30 }]]));
    const update = onPriceUpdate.mock.calls[0][0].get('m1');
    expect(update.yesPrice).toBeCloseTo(0.70, 10);
    expect(update.noPrice).toBeCloseTo(0.30, 10);
  });

  it('prefers the YES-token quote when both sides update in one batch', () => {
    const { mgr, onPriceUpdate } = makeManager();
    // NO first, then YES — and the reverse order
    mgr._flushPriceUpdates(new Map([[NO, { price: 0.40 }], [YES, { price: 0.62 }]]));
    mgr._flushPriceUpdates(new Map([[YES, { price: 0.62 }], [NO, { price: 0.40 }]]));
    for (const [updates] of onPriceUpdate.mock.calls) {
      expect(updates.get('m1')).toEqual({ yesPrice: 0.62, noPrice: expect.closeTo(0.38, 10) });
    }
  });

  it('settles prices and notifies on resolution', () => {
    const { mgr, onPriceUpdate, onResolution, onToast } = makeManager();
    mgr._startWebSocket();
    const stream = wsInstances.at(-1);
    stream.opts.onResolution(NO, { winningOutcome: 'No', assetIds: [YES, NO] });

    expect(onPriceUpdate.mock.calls[0][0].get('m1')).toEqual({ yesPrice: 0, noPrice: 1 });
    expect(onResolution).toHaveBeenCalledWith('m1');
    expect(onToast).toHaveBeenCalledWith({ type: 'info', message: 'Market resolved: No' });
  });
});
