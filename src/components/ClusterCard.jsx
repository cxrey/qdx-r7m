/**
 * ClusterCard — Displays a correlation cluster with risk assessment.
 */

function formatValue(v) {
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function RiskBadge({ risk }) {
  const cls = risk === 'HIGH'
    ? 'bg-red-900/60 text-red-300 border-red-700/50'
    : risk === 'MEDIUM'
    ? 'bg-amber-900/60 text-amber-300 border-amber-700/50'
    : 'bg-emerald-900/60 text-emerald-300 border-emerald-700/50';

  return (
    <span className={`px-2 py-0.5 rounded text-xs font-bold border ${cls}`}>
      {risk}
    </span>
  );
}

export default function ClusterCard({ cluster }) {
  if (!cluster) return null;

  return (
    <div
      className="rounded-lg border p-4"
      style={{
        background: '#111827',
        borderColor: cluster.risk === 'HIGH' ? '#7f1d1d' : cluster.risk === 'MEDIUM' ? '#78350f' : '#1f2937',
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-gray-200">{cluster.name}</span>
        <RiskBadge risk={cluster.risk} />
      </div>

      <div className="text-xs text-gray-400 mb-3">
        {cluster.positions.length} position{cluster.positions.length !== 1 ? 's' : ''} | {formatValue(cluster.totalValue)} total value | {(cluster.portfolioWeight * 100).toFixed(0)}% of portfolio
      </div>

      {cluster.positions.length > 1 && (
        <div className="text-xs text-gray-500 mb-3">
          Effective independent bets: {cluster.effectivePositionCount.toFixed(1)}
          {cluster.averageCorrelation > 0.3 && (
            <span className="text-gray-400">
              {' '}(high correlation reduces {cluster.positions.length} positions to ~{cluster.effectivePositionCount.toFixed(1)} independent bets)
            </span>
          )}
        </div>
      )}

      {/* Position list */}
      <div className="space-y-1.5 mb-3">
        {cluster.positions.map((pos, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ background: pos.side === 'YES' ? '#00d4aa' : '#ff4d6a' }}
            />
            <span className="text-gray-300 truncate flex-1">
              {pos.market?.question || 'Unknown market'}
            </span>
            <span className={`shrink-0 font-medium ${pos.side === 'YES' ? 'text-[#00d4aa]' : 'text-[#ff4d6a]'}`}>
              {pos.side}
            </span>
            <span className="text-gray-400 shrink-0">
              {formatValue(pos.currentValue || 0)}
            </span>
          </div>
        ))}
      </div>

      {/* Risk message */}
      {cluster.risk === 'HIGH' && (
        <div className="rounded px-3 py-2 text-xs text-red-300" style={{ background: 'rgba(239, 68, 68, 0.1)' }}>
          <span className="font-semibold">Warning:</span> This cluster represents {(cluster.portfolioWeight * 100).toFixed(0)}% of your portfolio.
          A single event would move all these positions simultaneously.
          Consider reducing exposure or hedging.
        </div>
      )}

      {cluster.risk === 'MEDIUM' && (
        <div className="rounded px-3 py-2 text-xs text-amber-300" style={{ background: 'rgba(245, 158, 11, 0.1)' }}>
          Moderate concentration. These positions share correlated exposure.
        </div>
      )}
    </div>
  );
}
