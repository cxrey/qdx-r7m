import { useMemo } from 'react';

const CYAN = '#00d4aa';
const PINK = '#ff4d6a';
const LEVELS = 10;

function fmtSize(v) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
}

export default function OrderBookTable({ bids, asks }) {
  const { bidLevels, askLevels, spread } = useMemo(() => {
    const parsedBids = (bids || [])
      .map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
      .filter((b) => !isNaN(b.price) && !isNaN(b.size))
      .sort((a, b) => b.price - a.price)
      .slice(0, LEVELS);

    const parsedAsks = (asks || [])
      .map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
      .filter((a) => !isNaN(a.price) && !isNaN(a.size))
      .sort((a, b) => a.price - b.price)
      .slice(0, LEVELS);

    // Cumulative totals
    let cum = 0;
    const bidLevels = parsedBids.map((b) => { cum += b.size; return { ...b, total: cum }; });
    cum = 0;
    const askLevels = parsedAsks.map((a) => { cum += a.size; return { ...a, total: cum }; });

    const bestBid = parsedBids[0]?.price ?? 0;
    const bestAsk = parsedAsks[0]?.price ?? 0;
    const spread = bestAsk > 0 && bestBid > 0 ? ((bestAsk - bestBid) * 100).toFixed(1) : null;

    return { bidLevels, askLevels: askLevels.reverse(), spread };
  }, [bids, asks]);

  const maxBidSize = Math.max(...bidLevels.map((b) => b.total), 1);
  const maxAskSize = Math.max(...askLevels.map((a) => a.total), 1);

  return (
    <div className="px-4 pb-4">
      <div className="grid grid-cols-2 gap-px" style={{ background: '#1f2937' }}>
        {/* Asks (left) — reversed so lowest ask is at bottom */}
        <div style={{ background: '#111827' }}>
          <div className="grid grid-cols-3 text-[10px] font-semibold text-gray-500 uppercase px-2 py-1.5 border-b border-[#1f2937]">
            <div>Price</div><div className="text-right">Size</div><div className="text-right">Total</div>
          </div>
          {askLevels.length === 0 ? (
            <div className="text-xs text-gray-600 text-center py-4">No asks</div>
          ) : (
            askLevels.map((a, i) => (
              <div key={i} className="relative grid grid-cols-3 text-xs px-2 py-1 items-center">
                <div className="absolute inset-0" style={{
                  background: PINK,
                  opacity: 0.08,
                  width: `${(a.total / maxAskSize) * 100}%`,
                  right: 0,
                  left: 'auto',
                }} />
                <div className="relative" style={{ color: PINK }}>{(a.price * 100).toFixed(1)}¢</div>
                <div className="relative text-right text-gray-300">{fmtSize(a.size)}</div>
                <div className="relative text-right text-gray-500">{fmtSize(a.total)}</div>
              </div>
            ))
          )}
        </div>

        {/* Bids (right) */}
        <div style={{ background: '#111827' }}>
          <div className="grid grid-cols-3 text-[10px] font-semibold text-gray-500 uppercase px-2 py-1.5 border-b border-[#1f2937]">
            <div>Price</div><div className="text-right">Size</div><div className="text-right">Total</div>
          </div>
          {bidLevels.length === 0 ? (
            <div className="text-xs text-gray-600 text-center py-4">No bids</div>
          ) : (
            bidLevels.map((b, i) => (
              <div key={i} className="relative grid grid-cols-3 text-xs px-2 py-1 items-center">
                <div className="absolute inset-0" style={{
                  background: CYAN,
                  opacity: 0.08,
                  width: `${(b.total / maxBidSize) * 100}%`,
                }} />
                <div className="relative" style={{ color: CYAN }}>{(b.price * 100).toFixed(1)}¢</div>
                <div className="relative text-right text-gray-300">{fmtSize(b.size)}</div>
                <div className="relative text-right text-gray-500">{fmtSize(b.total)}</div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Spread bar */}
      {spread && (
        <div className="text-center py-1.5 text-xs font-semibold rounded-b"
          style={{ background: 'rgba(0,212,170,0.12)', color: CYAN }}>
          Spread: {spread}¢
        </div>
      )}
    </div>
  );
}
