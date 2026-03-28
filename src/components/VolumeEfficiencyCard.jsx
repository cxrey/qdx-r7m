import { useMemo } from 'react';
import { calculateMispricingZone } from '../VolumeEfficiencyEngine';

const PRIORITY_CONFIG = {
  SWEET_SPOT: { shortLabel: 'Sweet', label: 'Sweet Spot', bg: 'rgba(0,212,170,0.25)', text: '#00d4aa', border: 'rgba(0,212,170,0.4)' },
  OPPORTUNITY: { shortLabel: 'Opp.', label: 'Opportunity', bg: 'rgba(34,211,238,0.20)', text: '#22d3ee', border: 'rgba(34,211,238,0.35)' },
  MARGINAL: { shortLabel: 'Marg.', label: 'Marginal', bg: 'rgba(245,158,11,0.20)', text: '#f59e0b', border: 'rgba(245,158,11,0.35)' },
  EFFICIENT: { shortLabel: 'Fair', label: 'Fair', bg: 'rgba(55,65,81,0.40)', text: '#9ca3af', border: 'rgba(55,65,81,0.5)' },
  LOW_LIQUIDITY: { shortLabel: 'Low', label: 'Low Liquidity', bg: 'rgba(127,29,29,0.30)', text: '#ef4444', border: 'rgba(239,68,68,0.3)' },
};

const VELOCITY_DOTS = {
  Hot: { color: '#00d4aa', pulse: true },
  Active: { color: '#00d4aa', pulse: false },
  Normal: null,
  Stale: { color: '#f59e0b', pulse: false },
  Dead: { color: '#ef4444', pulse: false },
};

function formatVol(v) {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

// ─── Zone Visualization SVG ───
function ZoneBar({ ve, yesPrice, noPrice }) {
  if (!ve) return null;

  const zMin = ve.zoneMin * 100;
  const zMax = ve.zoneMax * 100;
  const yesPos = (yesPrice || 0) * 100;
  const noPos = (noPrice || 0) * 100;
  const inZone = ve.inZone;

  return (
    <svg viewBox="0 0 200 30" className="w-full" style={{ height: 30 }}>
      {/* Background track */}
      <rect x="0" y="8" width="200" height="14" rx="3" fill="#1f2937" />

      {/* Mispricing zone */}
      <defs>
        <linearGradient id="zoneGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#00d4aa" stopOpacity="0.05" />
          <stop offset="50%" stopColor="#00d4aa" stopOpacity="0.30" />
          <stop offset="100%" stopColor="#00d4aa" stopOpacity="0.05" />
        </linearGradient>
      </defs>
      <rect
        x={zMin * 2} y="8"
        width={(zMax - zMin) * 2} height="14"
        fill="url(#zoneGrad)"
      />
      {/* Zone edges */}
      <line x1={zMin * 2} y1="8" x2={zMin * 2} y2="22" stroke="#00d4aa" strokeWidth="0.5" strokeOpacity="0.4" />
      <line x1={zMax * 2} y1="8" x2={zMax * 2} y2="22" stroke="#00d4aa" strokeWidth="0.5" strokeOpacity="0.4" />

      {/* Yes price marker */}
      <line x1={yesPos * 2} y1="5" x2={yesPos * 2} y2="25" stroke="#00d4aa" strokeWidth="2" />
      <circle cx={yesPos * 2} cy="15" r="3" fill="#00d4aa" opacity={inZone ? 1 : 0.4} />

      {/* No price marker */}
      <line x1={noPos * 2} y1="5" x2={noPos * 2} y2="25" stroke="#ff4d6a" strokeWidth="1.5" strokeDasharray="2 2" />

      {/* Scale labels */}
      <text x="0" y="30" fill="#6b7280" fontSize="7" textAnchor="start">0¢</text>
      <text x="50" y="30" fill="#6b7280" fontSize="7" textAnchor="middle">25¢</text>
      <text x="100" y="30" fill="#6b7280" fontSize="7" textAnchor="middle">50¢</text>
      <text x="150" y="30" fill="#6b7280" fontSize="7" textAnchor="middle">75¢</text>
      <text x="200" y="30" fill="#6b7280" fontSize="7" textAnchor="end">100¢</text>
    </svg>
  );
}

// ─── Priority Explanation ───
function PriorityExplanation({ ve }) {
  if (!ve) return null;

  const texts = {
    SWEET_SPOT: 'Sweet Spot — price is deep in the mispricing zone for a market with meaningful volume. This is the ideal setup for an analytical edge.',
    OPPORTUNITY: 'Opportunity — price is within the mispricing zone. Worth deeper analysis.',
    MARGINAL: 'Marginal — price is near the edge of the mispricing zone. Small edge if any.',
    EFFICIENT: `This price is likely efficiently set for a market with ${formatVol(ve.effectiveVolume)} volume. Edge must come from information, not market structure.`,
    LOW_LIQUIDITY: 'Low liquidity — volume too low to trust any structural analysis. Price could be anything — beware of manipulation and wide spreads.',
  };

  const config = PRIORITY_CONFIG[ve.priority] || PRIORITY_CONFIG.EFFICIENT;

  return (
    <div
      className="text-xs leading-relaxed p-2 rounded border mt-3"
      style={{ background: `${config.bg}`, borderColor: config.border, color: `${config.text}cc` }}
    >
      {texts[ve.priority]}
    </div>
  );
}

// ─── Main Card Component ───
export default function VolumeEfficiencyCard({ market, bookData }) {
  const ve = market.volumeEfficiency;

  // Re-run with book depth if available
  const refined = useMemo(() => {
    if (!ve || !bookData) return ve;

    const bids = bookData.bids || [];
    const asks = bookData.asks || [];
    const totalBidDepth = bids.reduce((sum, b) => sum + parseFloat(b.size || 0), 0);
    const totalAskDepth = asks.reduce((sum, a) => sum + parseFloat(a.size || 0), 0);

    if (totalBidDepth === 0 && totalAskDepth === 0) return ve;

    return calculateMispricingZone(
      market.yesPrice,
      ve.effectiveVolume,
      ve.velocityLabel,
      ve.recencyMultiplier,
      { totalBidDepth, totalAskDepth }
    ) || ve;
  }, [ve, bookData, market.yesPrice]);

  if (!refined) {
    return (
      <div className="rounded-lg border border-[#1f2937] p-4" style={{ background: '#111827' }}>
        <div className="text-xs font-semibold text-gray-400 uppercase">Volume-Price Efficiency</div>
        <div className="text-sm text-gray-600 mt-2">Insufficient data for efficiency analysis.</div>
      </div>
    );
  }

  const config = PRIORITY_CONFIG[refined.priority] || PRIORITY_CONFIG.EFFICIENT;
  const velDot = VELOCITY_DOTS[refined.velocityLabel];

  return (
    <div className="rounded-lg border border-[#1f2937] p-4" style={{ background: '#111827' }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-400 uppercase">Volume-Price Efficiency</span>
          <span
            className="text-[10px] font-semibold px-2 py-0.5 rounded-full border"
            style={{ background: config.bg, color: config.text, borderColor: config.border }}
          >
            {config.label}
          </span>
        </div>
        {velDot && (
          <span className="flex items-center gap-1 text-[10px] text-gray-500">
            {refined.velocityLabel}
            <span
              className={`inline-block w-2 h-2 rounded-full ${velDot.pulse ? 'animate-pulse' : ''}`}
              style={{ background: velDot.color }}
            />
          </span>
        )}
      </div>

      {/* Zone visualization */}
      <ZoneBar ve={refined} yesPrice={market.yesPrice} noPrice={market.noPrice} />

      {/* Metrics grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm mt-3">
        <div className="flex justify-between">
          <span className="text-[#9ca3af]">Eff. Volume</span>
          <span className="text-gray-300">
            {formatVol(refined.effectiveVolume)}
            {refined.recencyMultiplier !== 1.0 && (
              <span className="text-gray-600 text-[10px] ml-1">
                ({formatVol(refined.rawVolume || market.volume)} × {refined.recencyMultiplier.toFixed(1)})
              </span>
            )}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#9ca3af]">Velocity</span>
          <span className="text-gray-300 flex items-center gap-1">
            {refined.velocityLabel}
            {velDot && (
              <span
                className={`inline-block w-1.5 h-1.5 rounded-full ${velDot.pulse ? 'animate-pulse' : ''}`}
                style={{ background: velDot.color }}
              />
            )}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#9ca3af]">Mispricing Zone</span>
          <span className="text-gray-300">
            {(refined.zoneMin * 100).toFixed(0)}¢ — {(refined.zoneMax * 100).toFixed(0)}¢
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#9ca3af]">Zone Depth</span>
          <span style={{ color: refined.inZone ? '#00d4aa' : '#9ca3af' }}>
            {refined.inZone
              ? `${(refined.zoneDepth * 100).toFixed(0)}% inside`
              : 'Outside zone'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#9ca3af]">Est. Edge</span>
          <span
            className="font-semibold"
            style={{ color: refined.estimatedEdge > 0.05 ? '#00d4aa' : refined.estimatedEdge > 0.02 ? '#22d3ee' : '#9ca3af' }}
          >
            ~{(refined.estimatedEdge * 100).toFixed(1)}%
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#9ca3af]">Max Edge</span>
          <span className="text-gray-400">~{(refined.maxExpectedEdge * 100).toFixed(1)}%</span>
        </div>
        {refined.depthAdjusted && (
          <div className="col-span-2 flex justify-between">
            <span className="text-[#9ca3af]">Book Depth Adj.</span>
            <span className="text-gray-400">
              ×{refined.depthMultiplier?.toFixed(2)}
              {refined.depthMultiplier < 1 ? ' (thin book — zone widened)' : refined.depthMultiplier > 1 ? ' (thick book — zone narrowed)' : ''}
            </span>
          </div>
        )}
      </div>

      {/* Priority explanation */}
      <PriorityExplanation ve={refined} />
    </div>
  );
}

// ─── Table Cell ───
export function VolPriceCell({ ve }) {
  if (!ve) return <span className="text-gray-600 text-xs">--</span>;

  const config = PRIORITY_CONFIG[ve.priority] || PRIORITY_CONFIG.EFFICIENT;
  const edgePct = (ve.estimatedEdge * 100).toFixed(0);

  const tooltip = `${config.label} | Est. edge: ~${edgePct}% | Volume: ${formatVol(ve.effectiveVolume)} (${ve.velocityLabel})`;

  return (
    <div title={tooltip}>
      <span
        className="text-xs font-semibold"
        style={{ color: config.text }}
      >
        {config.shortLabel}
      </span>
      {ve.estimatedEdge > 0 && (
        <span className="text-[10px] text-gray-500 ml-1">~{edgePct}%</span>
      )}
    </div>
  );
}
