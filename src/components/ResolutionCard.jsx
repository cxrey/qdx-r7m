import { useState } from 'react';
import AnalysisCard from './AnalysisCard';

const COLORS = {
  exclusionary: '#ff4d6a',
  qualifying: '#f59e0b',
  continuous: '#00d4aa',
  touch: '#60a5fa',
  data_driven: '#a78bfa',
  consensus: '#9ca3af',
};

const TYPE_LABELS = {
  exclusionary: 'EXCLUSION',
  qualifying: 'CONDITION',
  continuous: 'CONTINUOUS',
  touch: 'TOUCH',
};

const CHAR_ICONS = {
  MULTI_CONDITION: '',
  EXCLUSIONARY: '',
  CONTINUOUS: '',
  TOUCH: '',
  DATA_DRIVEN: '',
  CONSENSUS_BASED: '',
};

const CHAR_LABELS = {
  MULTI_CONDITION: 'Multi-Condition',
  EXCLUSIONARY: 'Exclusionary',
  CONTINUOUS: 'Continuous',
  TOUCH: 'Touch',
  DATA_DRIVEN: 'Data-Driven',
  CONSENSUS_BASED: 'Consensus-Based',
};

function StrictnessGauge({ score, label }) {
  // Horizontal bar gauge
  let barColor;
  if (score >= 70) barColor = '#ff4d6a';
  else if (score >= 50) barColor = '#f59e0b';
  else if (score >= 30) barColor = '#eab308';
  else barColor = '#00d4aa';

  return (
    <div className="mb-3">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-2xl font-bold" style={{ color: barColor }}>{score}</span>
        <span className="text-xs font-semibold" style={{ color: barColor }}>{label}</span>
      </div>
      <div className="h-2.5 rounded-full overflow-hidden" style={{ background: '#1a1f2e' }}>
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${score}%`,
            background: `linear-gradient(90deg, #00d4aa 0%, #eab308 40%, #f59e0b 60%, #ff4d6a 100%)`,
          }}
        />
      </div>
      <div className="flex justify-between text-[9px] text-gray-600 mt-0.5">
        <span>Lenient</span>
        <span>Strict</span>
      </div>
    </div>
  );
}

function AnnotatedSentence({ segment }) {
  if (segment.type === 'neutral') {
    return <p className="text-sm text-gray-400 leading-relaxed mb-1">{segment.text}</p>;
  }

  const color = COLORS[segment.type] || '#9ca3af';
  const typeLabel = TYPE_LABELS[segment.type];

  return (
    <div
      className="mb-1.5 pl-3 py-1.5 pr-2 rounded-r text-sm leading-relaxed relative"
      style={{
        background: `${color}15`,
        borderLeft: `3px solid ${color}`,
      }}
    >
      {typeLabel && (
        <span
          className="absolute top-1 right-2 text-[9px] font-bold uppercase tracking-wider"
          style={{ color }}
        >
          {typeLabel}
        </span>
      )}
      <span className="text-gray-300">{segment.text}</span>
    </div>
  );
}

function BreakdownRow({ item }) {
  const barWidth = Math.min(((item.multiplier - 0.5) / 1.5) * 100, 100);
  const isDiscount = item.multiplier < 1;

  return (
    <div className="flex items-center gap-2 text-xs py-1">
      <span className="w-5 text-center">{item.icon}</span>
      <span className="flex-1 text-gray-400 truncate">{item.factor}</span>
      <span
        className="font-mono font-semibold w-12 text-right"
        style={{ color: isDiscount ? '#00d4aa' : '#f59e0b' }}
      >
        ×{item.multiplier.toFixed(2)}
      </span>
      <div className="w-16 h-1.5 rounded-full overflow-hidden" style={{ background: '#1a1f2e' }}>
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.abs(barWidth)}%`,
            background: isDiscount ? '#00d4aa' : '#f59e0b',
          }}
        />
      </div>
    </div>
  );
}

function MispricingAlert({ flag, yesPrice }) {
  if (flag === 'NEUTRAL') return null;
  const priceCents = yesPrice != null ? (yesPrice * 100).toFixed(1) : '?';

  if (flag === 'YES_LIKELY_OVERPRICED') {
    return (
      <div className="mt-3 p-2.5 rounded text-xs leading-relaxed border" style={{ background: 'rgba(255,77,106,0.08)', borderColor: 'rgba(255,77,106,0.3)', color: '#fca5a5' }}>
        Resolution rules are very strict but Yes is priced at {priceCents}&cent;. Casual traders may not have read the exclusionary clauses and condition requirements. Structural edge: consider No.
      </div>
    );
  }
  if (flag === 'YES_LIKELY_UNDERPRICED') {
    return (
      <div className="mt-3 p-2.5 rounded text-xs leading-relaxed border" style={{ background: 'rgba(0,212,170,0.08)', borderColor: 'rgba(0,212,170,0.3)', color: '#86efac' }}>
        This is a TOUCH market with lenient resolution — Yes only needs one qualifying moment. May be underpriced at {priceCents}¢.
      </div>
    );
  }
  return null;
}

function CharacteristicBadge({ char: c }) {
  const icon = CHAR_ICONS[c.type] || '•';
  const label = CHAR_LABELS[c.type] || c.type;
  return (
    <div className="text-xs text-gray-400 flex items-start gap-1.5 py-0.5">
      <span>{icon}</span>
      <span>
        <span className="font-semibold text-gray-300">{label}</span>
        {c.conditionCount ? ` ×${c.conditionCount}` : ''}
        {' '}
        <span className="text-gray-600">({c.confidence})</span>
        {' — '}
        <span className="text-gray-500">{c.detail}</span>
      </span>
    </div>
  );
}

// ─── Temporal Section Components ───

const WINDOW_BADGE_CONFIG = {
  FIXED_DEADLINE: { label: 'Fixed Deadline', color: '#60a5fa' },
  ROLLING_WINDOW: { label: 'Rolling Window', color: '#f59e0b' },
  CHECKPOINT: { label: 'Checkpoint', color: '#9ca3af' },
  INSTANTANEOUS: { label: 'Instantaneous', color: '#00d4aa' },
  DURATION_AT_LEVEL: { label: 'Duration at Level', color: '#a78bfa' },
};

function WindowTypeBadge({ temporal }) {
  const config = WINDOW_BADGE_CONFIG[temporal.windowType] || WINDOW_BADGE_CONFIG.FIXED_DEADLINE;
  let detail = '';
  if (temporal.windowType === 'ROLLING_WINDOW' && temporal.windowLength) {
    detail = `: ${temporal.windowLength.value} consecutive ${temporal.windowLength.unit}s`;
  } else if (temporal.windowType === 'FIXED_DEADLINE' && temporal.deadlineDate) {
    detail = `: ${temporal.deadlineDate instanceof Date ? temporal.deadlineDate.toLocaleDateString() : temporal.deadlineDate}`;
  } else if (temporal.windowType === 'DURATION_AT_LEVEL' && temporal.windowLength) {
    detail = `: ${temporal.windowLength.value} ${temporal.windowLength.unit}s at level`;
  }

  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border"
      style={{ borderColor: `${config.color}50`, color: config.color, background: `${config.color}12` }}
    >
      {config.label}{detail}
    </span>
  );
}

function TemporalMetricsRow({ temporal }) {
  const m = temporal.metrics;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-400">
      {m.impliedDailyRate != null && (
        <span>
          Daily Rate: <span className="text-gray-300 font-semibold">{(m.impliedDailyRate * 100).toFixed(2)}%/d</span>
        </span>
      )}
      {m.timeNormalizedPrice != null && (
        <span title="Price normalized by sqrt(time) — comparable across different durations">
          TNP: <span className="text-gray-300 font-semibold">{m.timeNormalizedPrice.toFixed(4)}</span>
        </span>
      )}
      <span>
        Measurement: <span className="text-gray-300">{temporal.measurement.frequency.replace(/_/g, ' ').toLowerCase()}</span>
      </span>
      {temporal.timezone.timezone ? (
        <span>TZ: <span className="text-gray-300">{temporal.timezone.timezone}</span></span>
      ) : (
        <span className="text-yellow-500/80">No timezone</span>
      )}
    </div>
  );
}

function TemporalEdgeAlert({ edge }) {
  return (
    <div
      className="p-2 rounded text-xs leading-relaxed border mt-1.5"
      style={{
        background: `${edge.color}08`,
        borderColor: `${edge.color}30`,
        color: `${edge.color}cc`,
      }}
    >
      {edge.icon} {edge.text}
    </div>
  );
}

function BoundaryTimeline({ lifecycle, windowType, windowLength }) {
  if (!lifecycle) return null;
  const { elapsedPct, remainingPct, createdDate, endDateStr } = lifecycle;

  // Window bracket for rolling windows
  let windowBracket = null;
  if (windowType === 'ROLLING_WINDOW' && windowLength) {
    const wDays = windowLength.value * (windowLength.unit === 'week' ? 7 : windowLength.unit === 'month' ? 30 : 1);
    // Approximate bracket position as % of remaining
    const bracketWidthPct = Math.min(remainingPct * 0.6, 25);
    windowBracket = { widthPct: bracketWidthPct, label: `${windowLength.value}${windowLength.unit[0]}` };
  }

  return (
    <div className="mt-2">
      <div className="relative h-10 w-full">
        {/* Track */}
        <div className="absolute top-4 left-0 right-0 h-1.5 rounded-full" style={{ background: '#1a1f2e' }}>
          {/* Elapsed */}
          <div
            className="absolute top-0 left-0 h-full rounded-l-full"
            style={{ width: `${elapsedPct}%`, background: '#374151' }}
          />
          {/* Now marker */}
          <div
            className="absolute top-[-4px] w-2.5 h-2.5 rounded-full border-2"
            style={{ left: `${elapsedPct}%`, transform: 'translateX(-50%)', background: '#00d4aa', borderColor: '#111827' }}
          />
        </div>
        {/* Rolling window bracket */}
        {windowBracket && (
          <div
            className="absolute top-7 h-2 rounded-sm border border-amber-500/40"
            style={{
              left: `${Math.max(elapsedPct - 2, 0)}%`,
              width: `${windowBracket.widthPct}%`,
              background: 'rgba(245,158,11,0.1)',
            }}
          >
            <span className="absolute -top-0.5 left-1/2 -translate-x-1/2 text-[8px] text-amber-400/70">
              {windowBracket.label}
            </span>
          </div>
        )}
        {/* Labels */}
        <div className="absolute top-0 left-0 text-[8px] text-gray-600">{createdDate}</div>
        <div className="absolute top-0 text-[8px] text-gray-500 font-semibold" style={{ left: `${elapsedPct}%`, transform: 'translateX(-50%)' }}>NOW</div>
        <div className="absolute top-0 right-0 text-[8px] text-gray-600">{endDateStr}</div>
      </div>
    </div>
  );
}

function TemporalSection({ temporal }) {
  if (!temporal) return null;

  return (
    <div className="pt-3 mt-3 border-t border-gray-800/60">
      <div className="text-[10px] font-semibold text-gray-500 uppercase mb-2">Temporal Structure</div>

      {/* Window type badge */}
      <div className="mb-2">
        <WindowTypeBadge temporal={temporal} />
      </div>

      {/* Metrics row */}
      <TemporalMetricsRow temporal={temporal} />

      {/* Temporal edge alerts */}
      {temporal.temporalEdges?.length > 0 && (
        <div className="mt-1.5">
          {temporal.temporalEdges.map((edge, i) => (
            <TemporalEdgeAlert key={i} edge={edge} />
          ))}
        </div>
      )}

      {/* Boundary timeline */}
      <BoundaryTimeline
        lifecycle={temporal.lifecycleProgress}
        windowType={temporal.windowType}
        windowLength={temporal.windowLength}
      />
    </div>
  );
}

export default function ResolutionCard({ resolution, yesPrice }) {
  const [collapsed, setCollapsed] = useState(false);

  if (!resolution) {
    return (
      <AnalysisCard title="Resolution Analysis" emptyWhen emptyMessage="No resolution rules available." />
    );
  }

  const { characteristics, annotatedRules, strictness } = resolution;
  const hasHighConfidence = characteristics.some((c) => c.confidence === 'HIGH');

  return (
    <AnalysisCard className="!p-0">
      {/* Collapsible header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-800/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-400 uppercase">Resolution Analysis</span>
          {strictness && (
            <span
              className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
              style={{
                background: strictness.score >= 65 ? 'rgba(255,77,106,0.15)' : strictness.score < 45 ? 'rgba(0,212,170,0.15)' : 'rgba(107,114,128,0.15)',
                color: strictness.score >= 65 ? '#ff4d6a' : strictness.score < 45 ? '#00d4aa' : '#9ca3af',
              }}
            >
              {strictness.label} ({strictness.score})
            </span>
          )}
        </div>
        <span className="text-gray-600 text-xs">{collapsed ? '▸' : '▾'}</span>
      </button>

      {!collapsed && (
        <div className="px-4 pb-4">
          <div className="flex flex-col md:flex-row gap-4">
            {/* Left: Annotated Rules (60%) */}
            <div className="flex-[3] min-w-0">
              <div className="text-[10px] font-semibold text-gray-500 uppercase mb-2">Resolution Rules</div>
              <div className="max-h-[300px] overflow-y-auto pr-1 space-y-0.5">
                {hasHighConfidence ? (
                  annotatedRules.map((seg, i) => (
                    <AnnotatedSentence key={i} segment={seg} />
                  ))
                ) : annotatedRules.length > 0 ? (
                  <>
                    {annotatedRules.map((seg, i) => (
                      <p key={i} className="text-sm text-gray-400 leading-relaxed mb-1">{seg.text}</p>
                    ))}
                    <div className="text-xs text-gray-600 mt-2 italic">
                      Auto-analysis inconclusive — review rules manually
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-gray-600">No resolution text to analyze.</div>
                )}
              </div>
            </div>

            {/* Right: Strictness Breakdown (40%) */}
            <div className="flex-[2] min-w-0">
              {strictness && (
                <>
                  <div className="text-[10px] font-semibold text-gray-500 uppercase mb-2">Strictness Score</div>
                  <StrictnessGauge score={strictness.score} label={strictness.label} />

                  {strictness.penaltyBreakdown.length > 0 && (
                    <div className="mb-3">
                      <div className="text-[10px] font-semibold text-gray-500 uppercase mb-1">Breakdown</div>
                      {strictness.penaltyBreakdown.map((item, i) => (
                        <BreakdownRow key={i} item={item} />
                      ))}
                    </div>
                  )}

                  <MispricingAlert flag={strictness.mispricingFlag} yesPrice={yesPrice} />
                </>
              )}

              {/* Characteristic badges */}
              {characteristics.length > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-800">
                  <div className="text-[10px] font-semibold text-gray-500 uppercase mb-1">Detected Patterns</div>
                  {characteristics.map((c, i) => (
                    <CharacteristicBadge key={i} char={c} />
                  ))}
                </div>
              )}

              {/* Temporal Structure */}
              <TemporalSection temporal={resolution.temporal} />
            </div>
          </div>
        </div>
      )}
    </AnalysisCard>
  );
}

/**
 * Compact cell for the main table Rules column.
 */
export function RulesCell({ resolution }) {
  if (!resolution || !resolution.strictness) {
    return <span className="text-gray-600 text-xs">--</span>;
  }

  const { strictness, characteristics } = resolution;
  const highChars = characteristics.filter((c) => c.confidence === 'HIGH');

  let textColor, shortLabel;
  if (strictness.score >= 65) {
    textColor = '#ff4d6a';
    shortLabel = 'Strict';
  } else if (strictness.score < 45) {
    textColor = '#00d4aa';
    shortLabel = 'Lenient';
  } else {
    textColor = '#9ca3af';
    shortLabel = 'Moderate';
  }

  // Build tooltip with full detail
  const parts = [strictness.label + ' resolution (score: ' + strictness.score + ')'];
  for (const c of highChars) {
    const label = CHAR_LABELS[c.type] || c.type;
    parts.push(label + ': ' + c.detail);
  }
  if (strictness.score >= 65) parts.push('Favors No');
  else if (strictness.score < 45) parts.push('Favors Yes');
  const tooltip = parts.join(' | ');

  return (
    <span
      className="text-xs font-semibold"
      style={{ color: textColor }}
      title={tooltip}
    >
      {shortLabel} {strictness.score}
    </span>
  );
}
