/**
 * CorrelationMatrix — Heatmap of pairwise position correlations.
 * Compact diagnostic visual for portfolio correlation analysis.
 */

function getHeatColor(value) {
  if (value >= 0.9) return '#ef4444';
  if (value >= 0.7) return '#f97316';
  if (value >= 0.5) return '#eab308';
  if (value >= 0.3) return '#3b82f6';
  return '#1e293b';
}

function truncateTitle(title, maxLen = 18) {
  if (!title || title.length <= maxLen) return title || '';
  return title.slice(0, maxLen - 1) + '\u2026';
}

export default function CorrelationMatrix({ positions, correlationMatrix, clusters }) {
  if (!positions || positions.length === 0 || !correlationMatrix || correlationMatrix.length === 0) {
    return null;
  }

  const n = positions.length;

  // For > 15 positions, show cluster summary instead
  if (n > 15 && clusters && clusters.length > 1) {
    return (
      <div className="rounded-lg border border-[#1f2937] p-4" style={{ background: '#111827' }}>
        <div className="text-xs font-semibold text-gray-400 uppercase mb-3">
          Cluster Correlation (aggregated from {n} positions)
        </div>
        <div className="text-xs text-gray-500 mb-2">
          Portfolio too large for position-level view. Showing cluster summaries.
        </div>
        <div className="flex flex-wrap gap-2">
          {clusters.map((c, i) => (
            <div key={i} className="text-xs text-gray-400">
              <span className={`inline-block w-3 h-3 rounded mr-1 ${c.risk === 'HIGH' ? 'bg-red-500' : c.risk === 'MEDIUM' ? 'bg-amber-500' : 'bg-emerald-500'}`} />
              {c.name} ({c.positions.length})
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Build cluster boundary set for visual grouping
  const clusterBoundaries = new Set();
  if (clusters) {
    let runningIdx = 0;
    for (const c of clusters) {
      runningIdx += c.positions.length;
      if (runningIdx < n) clusterBoundaries.add(runningIdx);
    }
  }

  const cellSize = Math.min(24, Math.floor(280 / n));
  const labelWidth = 90;

  return (
    <div className="rounded-lg border border-[#1f2937] p-4" style={{ background: '#111827' }}>
      <div className="text-xs font-semibold text-gray-400 uppercase mb-3">Correlation Matrix</div>

      <div className="overflow-auto" style={{ maxWidth: '100%', maxHeight: 340 }}>
        <div style={{ display: 'inline-block' }}>
          {/* Column headers */}
          <div style={{ display: 'flex', marginLeft: labelWidth }}>
            {positions.map((p, i) => (
              <div
                key={i}
                style={{ width: cellSize, height: labelWidth, position: 'relative' }}
                title={p.market?.question || `Position ${i + 1}`}
              >
                <div
                  className="text-[9px] text-gray-500 whitespace-nowrap"
                  style={{
                    position: 'absolute',
                    bottom: 2,
                    left: cellSize / 2,
                    transform: 'rotate(-60deg)',
                    transformOrigin: 'bottom left',
                  }}
                >
                  {truncateTitle(p.market?.question, 14)}
                </div>
              </div>
            ))}
          </div>

          {/* Rows */}
          {positions.map((rowPos, i) => (
            <div key={i} style={{ display: 'flex', height: cellSize }}>
              <div
                className="text-[9px] text-gray-500 truncate flex items-center pr-1"
                style={{ width: labelWidth }}
                title={rowPos.market?.question || `Position ${i + 1}`}
              >
                {truncateTitle(rowPos.market?.question, 14)}
              </div>

              {positions.map((_, j) => {
                const val = correlationMatrix[i]?.[j] ?? 0;
                const isBoundaryRight = clusterBoundaries.has(j + 1);
                const isBoundaryBottom = clusterBoundaries.has(i + 1);
                return (
                  <div
                    key={j}
                    style={{
                      width: cellSize,
                      height: cellSize,
                      backgroundColor: i === j ? '#374151' : getHeatColor(val),
                      borderRight: isBoundaryRight ? '2px solid #00d4aa' : '1px solid #0f172a',
                      borderBottom: isBoundaryBottom ? '2px solid #00d4aa' : '1px solid #0f172a',
                    }}
                    title={`${truncateTitle(rowPos.market?.question, 30)} x ${truncateTitle(positions[j]?.market?.question, 30)}: ${val.toFixed(2)}`}
                    className="cursor-default"
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-2 mt-3 text-[10px] text-gray-500">
        <span>Low</span>
        <div className="flex h-3">
          {[0, 0.2, 0.4, 0.6, 0.8, 1.0].map((v, i) => (
            <div key={i} style={{ width: 20, height: 12, background: getHeatColor(v) }} />
          ))}
        </div>
        <span>High</span>
      </div>
    </div>
  );
}
