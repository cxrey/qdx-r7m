import AnalysisCard from './AnalysisCard';

const CYAN = '#00d4aa';
const PINK = '#ff4d6a';

function NumberLine({ marketPrice, adjustedProb }) {
  const mktPct = (marketPrice * 100);
  const adjPct = (adjustedProb * 100);
  const left = Math.min(mktPct, adjPct);
  const right = Math.max(mktPct, adjPct);

  return (
    <div className="relative h-8 rounded-full overflow-hidden" style={{ background: '#1a1f2e' }}>
      {/* Zone coloring */}
      <div className="absolute inset-y-0 left-0" style={{ width: '15%', background: 'rgba(239,68,68,0.12)' }} />
      <div className="absolute inset-y-0 left-[15%]" style={{ width: '15%', background: 'rgba(107,114,128,0.06)' }} />
      <div className="absolute inset-y-0 left-[30%]" style={{ width: '40%', background: 'rgba(107,114,128,0.04)' }} />
      <div className="absolute inset-y-0 left-[70%]" style={{ width: '15%', background: 'rgba(107,114,128,0.06)' }} />
      <div className="absolute inset-y-0 left-[85%]" style={{ width: '15%', background: 'rgba(34,197,94,0.12)' }} />

      {/* Gap highlight */}
      <div
        className="absolute inset-y-0 rounded-sm"
        style={{
          left: `${left}%`,
          width: `${Math.max(right - left, 0.5)}%`,
          background: 'rgba(251,191,36,0.15)',
          borderLeft: '1px dashed rgba(251,191,36,0.4)',
          borderRight: '1px dashed rgba(251,191,36,0.4)',
        }}
      />

      {/* Market price dot */}
      <div
        className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 z-10"
        style={{
          left: `${mktPct}%`,
          transform: 'translate(-50%, -50%)',
          background: '#6b7280',
          borderColor: '#9ca3af',
        }}
        title={`Market: ${mktPct.toFixed(1)}%`}
      />

      {/* Adjusted probability dot */}
      <div
        className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 z-10"
        style={{
          left: `${adjPct}%`,
          transform: 'translate(-50%, -50%)',
          background: CYAN,
          borderColor: '#00ffcc',
        }}
        title={`Adjusted: ${adjPct.toFixed(1)}%`}
      />

      {/* Scale ticks */}
      {[0, 25, 50, 75, 100].map((tick) => (
        <div
          key={tick}
          className="absolute bottom-0 text-gray-600"
          style={{ left: `${tick}%`, transform: 'translateX(-50%)', fontSize: '8px' }}
        >
          {tick}
        </div>
      ))}
    </div>
  );
}

function recLabel(rec) {
  switch (rec) {
    case 'BUY_YES': return 'Buy Yes';
    case 'BUY_NO': return 'Buy No';
    case 'SPREAD_EATS_EDGE': return 'Spread Eats Edge';
    case 'NO_EDGE': return 'No Edge';
    default: return rec;
  }
}

function recColor(rec) {
  switch (rec) {
    case 'BUY_YES': return CYAN;
    case 'BUY_NO': return PINK;
    case 'SPREAD_EATS_EDGE': return '#f59e0b';
    default: return '#6b7280';
  }
}

export default function FLBCard({ flb, yesPrice, noPrice }) {
  if (!flb || flb.adjustedYesProb == null) {
    return (
      <AnalysisCard title="FLB Analysis" emptyWhen emptyMessage="Insufficient data for FLB analysis." />
    );
  }

  const bestSideIsYes = flb.bestSide === 'YES';
  const displayPrice = bestSideIsYes ? yesPrice : noPrice;
  const displayAdj = bestSideIsYes ? flb.adjustedYesProb : flb.adjustedNoProb;
  const rawEdge = flb.bestEdge;
  const spreadCost = rawEdge - flb.bestEdgeAfterSpread;
  const netEdge = flb.bestEdgeAfterSpread;

  // Contextual message
  let message = '';
  if (flb.isBiasOpportunity) {
    message = 'Structural FLB edge detected. The market appears to be mispricing this outcome due to favorite-longshot bias.';
  } else if (flb.isModerateEdge) {
    message = 'Moderate FLB signal. There may be a small edge from bias-based mispricing, but conviction should be lower.';
  } else if (flb.spreadKillsEdge) {
    message = 'The FLB model detects a raw edge, but the bid-ask spread consumes it. Wait for tighter spreads.';
  } else if (yesPrice > 0.3 && yesPrice < 0.7) {
    message = 'Market is in the neutral zone (30-70%). FLB corrections are minimal in this range.';
  } else {
    message = 'No significant FLB edge detected for this market.';
  }

  return (
    <AnalysisCard title="FLB Analysis">
      {/* Number line visualization */}
      <div className="mb-4">
        <div className="flex items-center gap-3 mb-1 text-xs text-gray-500">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: '#6b7280' }} />
            Market
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: CYAN }} />
            Adjusted
          </span>
        </div>
        {displayPrice != null && displayAdj != null && (
          <NumberLine marketPrice={displayPrice} adjustedProb={displayAdj} />
        )}
        <div className="text-xs text-gray-600 mt-1 text-center">
          Showing {bestSideIsYes ? 'Yes' : 'No'} side
        </div>
      </div>

      {/* Breakdown */}
      <div className="space-y-1.5 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-500">Market Price</span>
          <span className="text-gray-200">{displayPrice != null ? `${(displayPrice * 100).toFixed(1)}%` : '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Adjusted Prob</span>
          <span style={{ color: CYAN }}>{displayAdj != null ? `${(displayAdj * 100).toFixed(1)}%` : '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Raw Edge</span>
          <span className="text-gray-200">{rawEdge != null ? `${(rawEdge * 100).toFixed(2)}pp` : '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Spread Cost</span>
          <span className="text-yellow-400">{spreadCost != null ? `-${(spreadCost * 100).toFixed(2)}pp` : '—'}</span>
        </div>
        <div className="flex justify-between font-semibold">
          <span className="text-gray-400">Net Edge</span>
          <span style={{ color: netEdge > 0.03 ? CYAN : netEdge > 0.015 ? '#f59e0b' : '#6b7280' }}>
            {netEdge != null ? `${(netEdge * 100).toFixed(2)}pp` : '—'}
          </span>
        </div>
        <div className="flex justify-between pt-1 border-t border-gray-800">
          <span className="text-gray-500">Recommendation</span>
          <span className="font-semibold" style={{ color: recColor(flb.recommendation) }}>
            {recLabel(flb.recommendation)}
          </span>
        </div>
      </div>

      {/* Contextual message */}
      <div className="mt-3 p-2 rounded text-xs text-gray-400 leading-relaxed" style={{ background: '#0d1117' }}>
        {message}
      </div>
    </AnalysisCard>
  );
}
