import { useMemo, useCallback } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis,
  Tooltip, CartesianGrid,
} from 'recharts';

function formatDate(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateTime(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function CustomTooltip({ active, payload, color }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="rounded px-3 py-2 text-xs border border-[#1f2937]" style={{ background: '#111827' }}>
      <div className="text-gray-400 mb-1">{formatDateTime(point.t)}</div>
      <div className="font-bold" style={{ color }}>{point.price.toFixed(1)}¢</div>
    </div>
  );
}

export default function PriceChart({ data, color }) {
  const chartData = useMemo(() => {
    if (!data || data.length === 0) return [];
    return data.map((d) => ({ t: d.t, price: d.p * 100 }));
  }, [data]);

  const tooltipRenderer = useCallback((props) => <CustomTooltip {...props} color={color} />, [color]);

  if (chartData.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-gray-600">
        No price data available
      </div>
    );
  }

  const prices = chartData.map((d) => d.price);
  const minP = Math.max(0, Math.floor(Math.min(...prices) - 2));
  const maxP = Math.min(100, Math.ceil(Math.max(...prices) + 2));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
        <defs>
          <linearGradient id={`grad-${color.replace('#','')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.25} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
        <XAxis
          dataKey="t" tickFormatter={formatDate}
          tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false}
          minTickGap={40}
        />
        <YAxis
          domain={[minP, maxP]}
          tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false}
          tickFormatter={(v) => `${v}¢`} width={42}
        />
        <Tooltip content={tooltipRenderer} />
        <Area
          type="monotone" dataKey="price"
          stroke={color} strokeWidth={2}
          fill={`url(#grad-${color.replace('#','')})`}
          dot={false} activeDot={{ r: 4, fill: color, stroke: '#0a0e17', strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
