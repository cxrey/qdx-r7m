import { useMemo } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis,
  CartesianGrid, Tooltip,
} from 'recharts';

const CYAN = '#00d4aa';
const PINK = '#ff4d6a';

export default function DepthChart({ bids, asks }) {
  const chartData = useMemo(() => {
    if ((!bids || bids.length === 0) && (!asks || asks.length === 0)) return [];

    // Parse and sort bids descending by price
    const parsedBids = (bids || [])
      .map((b) => ({ price: parseFloat(b.price) * 100, size: parseFloat(b.size) }))
      .filter((b) => !isNaN(b.price) && !isNaN(b.size))
      .sort((a, b) => b.price - a.price);

    // Parse and sort asks ascending by price
    const parsedAsks = (asks || [])
      .map((a) => ({ price: parseFloat(a.price) * 100, size: parseFloat(a.size) }))
      .filter((a) => !isNaN(a.price) && !isNaN(a.size))
      .sort((a, b) => a.price - b.price);

    // Cumulative bids (from highest to lowest)
    let cumBid = 0;
    const bidPoints = parsedBids.map((b) => {
      cumBid += b.size;
      return { price: b.price, bidDepth: cumBid };
    }).reverse(); // reverse so price goes low -> high

    // Cumulative asks (from lowest to highest)
    let cumAsk = 0;
    const askPoints = parsedAsks.map((a) => {
      cumAsk += a.size;
      return { price: a.price, askDepth: cumAsk };
    });

    // Merge into one dataset by price
    const merged = [];
    for (const bp of bidPoints) {
      merged.push({ price: bp.price, bidDepth: bp.bidDepth, askDepth: null });
    }
    for (const ap of askPoints) {
      merged.push({ price: ap.price, bidDepth: null, askDepth: ap.askDepth });
    }
    merged.sort((a, b) => a.price - b.price);

    return merged;
  }, [bids, asks]);

  if (chartData.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-gray-600">
        No depth data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
        <defs>
          <linearGradient id="bidGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CYAN} stopOpacity={0.3} />
            <stop offset="100%" stopColor={CYAN} stopOpacity={0.05} />
          </linearGradient>
          <linearGradient id="askGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={PINK} stopOpacity={0.3} />
            <stop offset="100%" stopColor={PINK} stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
        <XAxis
          dataKey="price" type="number"
          tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false}
          tickFormatter={(v) => `${v.toFixed(0)}¢`}
          domain={['dataMin', 'dataMax']}
        />
        <YAxis
          tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false}
          tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(1)}K` : v.toFixed(0)}
          width={50}
        />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0]?.payload;
            return (
              <div className="rounded px-3 py-2 text-xs border border-[#1f2937]" style={{ background: '#111827' }}>
                <div className="text-gray-300">{d.price?.toFixed(1)}¢</div>
                {d.bidDepth != null && <div style={{ color: CYAN }}>Bid depth: {d.bidDepth.toFixed(0)}</div>}
                {d.askDepth != null && <div style={{ color: PINK }}>Ask depth: {d.askDepth.toFixed(0)}</div>}
              </div>
            );
          }}
        />
        <Area type="stepAfter" dataKey="bidDepth" stroke={CYAN} fill="url(#bidGrad)"
          strokeWidth={1.5} dot={false} connectNulls={false} />
        <Area type="stepAfter" dataKey="askDepth" stroke={PINK} fill="url(#askGrad)"
          strokeWidth={1.5} dot={false} connectNulls={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
