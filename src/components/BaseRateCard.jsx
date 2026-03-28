import { getBaseRateEdgeConfidence } from '../BaseRateEngine';

const CYAN = '#00d4aa';
const PINK = '#ff4d6a';
const AMBER = '#f59e0b';

function ConfidenceBadge({ level }) {
  const map = {
    VERY_HIGH: { label: 'Very High', cls: 'bg-emerald-900/60 text-emerald-300' },
    HIGH: { label: 'High', cls: 'bg-emerald-900/60 text-emerald-300' },
    MEDIUM: { label: 'Medium', cls: 'bg-yellow-900/60 text-yellow-300' },
    LOW: { label: 'Low', cls: 'bg-gray-800 text-gray-400' },
    CONFLICTED: { label: 'Conflicted', cls: 'bg-red-900/60 text-red-300' },
    UNKNOWN: { label: '—', cls: 'bg-gray-800 text-gray-500' },
  };
  const { label, cls } = map[level] || map.UNKNOWN;
  return <span className={`px-2 py-0.5 rounded text-xs font-semibold ${cls}`}>{label}</span>;
}

function ComparisonBar({ label, value, maxValue, color, displayValue }) {
  const pct = maxValue > 0 ? Math.min(100, (value / maxValue) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-400 w-20 shrink-0 text-right">{label}</span>
      <div className="flex-1 h-5 bg-gray-800 rounded overflow-hidden relative">
        <div
          className="h-full rounded transition-all"
          style={{ width: `${pct}%`, background: color, opacity: 0.7 }}
        />
        <span className="absolute inset-0 flex items-center px-2 text-xs font-semibold text-white">
          {displayValue}
        </span>
      </div>
    </div>
  );
}

function SourceTable({ sources }) {
  if (!sources || sources.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="text-xs font-semibold text-gray-500 uppercase mb-1">Base Rate Sources</div>
      <div className="space-y-1">
        {sources.map((src, i) => (
          <div key={i} className="flex items-center justify-between text-xs">
            <span className="text-gray-400">{src.label}</span>
            <div className="flex items-center gap-3">
              <span className="text-gray-300">{(src.rate * 100).toFixed(1)}%</span>
              <span className="text-gray-600">n={src.n}</span>
              <span className="text-gray-600">w={src.weight}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function BaseRateCell({ baseRate }) {
  if (!baseRate || baseRate.gapType === 'FAIR') {
    return <span className="text-gray-600 text-xs">--</span>;
  }

  const sign = baseRate.gapCents >= 0 ? '+' : '';
  let color = '#9ca3af';
  if (baseRate.gapType === 'NARRATIVE_PREMIUM' && baseRate.absGapCents > 5) color = PINK;
  else if (baseRate.gapType === 'NARRATIVE_DISCOUNT' && baseRate.absGapCents > 5) color = CYAN;
  else if (baseRate.absGapCents > 3) color = AMBER;

  return (
    <span
      className="text-xs font-semibold"
      style={{ color }}
      title={`Market ${baseRate.gapCents > 0 ? 'overprices' : 'underprices'} YES by ${baseRate.absGapCents.toFixed(1)}¢ vs historical base rate (${(baseRate.baseRate * 100).toFixed(1)}%)`}
    >
      {sign}{baseRate.gapCents.toFixed(1)}¢
    </span>
  );
}

export default function BaseRateCard({ baseRate, flb }) {
  if (!baseRate) return null;

  const edgeConfidence = getBaseRateEdgeConfidence(baseRate, flb);
  const maxBar = Math.max(baseRate.marketPrice, baseRate.baseRate, 0.01);

  return (
    <div className="rounded-lg border border-[#1f2937] p-4" style={{ background: '#111827' }}>
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-semibold text-gray-400 uppercase">Base Rate Analysis</div>
        <ConfidenceBadge level={edgeConfidence} />
      </div>

      {/* Comparison Bars */}
      <div className="space-y-2 mb-4">
        <ComparisonBar
          label="Market"
          value={baseRate.marketPrice}
          maxValue={maxBar}
          color={CYAN}
          displayValue={`${(baseRate.marketPrice * 100).toFixed(1)}¢`}
        />
        <ComparisonBar
          label="Base Rate"
          value={baseRate.baseRate}
          maxValue={maxBar}
          color={AMBER}
          displayValue={`${(baseRate.baseRate * 100).toFixed(1)}%`}
        />
      </div>

      {/* Gap Summary */}
      <div className="rounded px-3 py-2 mb-3" style={{ background: '#0d1117' }}>
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-400">Narrative Gap</span>
          <span
            className="font-bold"
            style={{
              color:
                baseRate.gapType === 'NARRATIVE_PREMIUM' ? PINK :
                baseRate.gapType === 'NARRATIVE_DISCOUNT' ? CYAN :
                '#9ca3af',
            }}
          >
            {baseRate.gapCents >= 0 ? '+' : ''}{baseRate.gapCents.toFixed(1)}¢
          </span>
        </div>
        <div className="text-xs text-gray-500 mt-1">
          {baseRate.gapType === 'NARRATIVE_PREMIUM' && (
            <>Market prices YES <strong className="text-red-400">{baseRate.absGapCents.toFixed(1)}¢ above</strong> historical base rate. Possible narrative-driven overpricing.</>
          )}
          {baseRate.gapType === 'NARRATIVE_DISCOUNT' && (
            <>Market prices YES <strong className="text-emerald-400">{baseRate.absGapCents.toFixed(1)}¢ below</strong> historical base rate. Possible value opportunity.</>
          )}
          {baseRate.gapType === 'FAIR' && (
            <>Market price is within historical norms for {baseRate.category} markets in the {baseRate.priceBucket} range.</>
          )}
        </div>
      </div>

      {/* Suggestion */}
      {baseRate.suggestion && (
        <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded" style={{ background: baseRate.suggestion === 'BUY_YES' ? 'rgba(0,212,170,0.08)' : 'rgba(255,77,106,0.08)' }}>
          <span className="text-xs font-semibold" style={{ color: baseRate.suggestion === 'BUY_YES' ? CYAN : PINK }}>
            {baseRate.suggestion === 'BUY_YES' ? '↑ Buy Yes' : '↓ Buy No'}
          </span>
          <span className="text-xs text-gray-500">
            — base rate suggests {baseRate.suggestion === 'BUY_YES' ? 'YES is underpriced' : 'YES is overpriced'}
          </span>
        </div>
      )}

      {/* Stats Row */}
      <div className="grid grid-cols-3 gap-3 text-center mb-2">
        <div>
          <div className="text-xs text-gray-500">Category</div>
          <div className="text-sm text-gray-300">{baseRate.category}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Price Bucket</div>
          <div className="text-sm text-gray-300">{baseRate.priceBucket}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Sample Size</div>
          <div className="text-sm text-gray-300">{baseRate.totalSamples}</div>
        </div>
      </div>

      {/* Source Breakdown */}
      <SourceTable sources={baseRate.sources} />
    </div>
  );
}
