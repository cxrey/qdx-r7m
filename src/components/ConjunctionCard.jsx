import { useState, useMemo, useCallback } from 'react';
import { calculateCompoundProbability } from '../ConjunctionEngine';

const TYPE_COLORS = {
  ALL_OF: '#ff4d6a',
  K_OF_N: '#f59e0b',
  ANY_OF: '#00d4aa',
  SEQUENTIAL: '#a78bfa',
  THRESHOLD: '#f59e0b',
};

const TYPE_LABELS = {
  ALL_OF: 'ALL',
  K_OF_N: 'K/N',
  ANY_OF: 'ANY',
  SEQUENTIAL: 'SEQ',
  THRESHOLD: 'THR',
};

const TYPE_DESCRIPTIONS = {
  ALL_OF: 'ALL CONDITIONS REQUIRED',
  K_OF_N: 'CONDITIONS REQUIRED',
  ANY_OF: 'ANY 1 CONDITION SUFFICIENT',
  SEQUENTIAL: 'CONDITIONS IN SEQUENCE',
  THRESHOLD: 'THRESHOLD CONDITIONS',
};

const INSIGHT_TEXT = {
  ALL_OF: "The conjunction fallacy: humans intuitively estimate conjunctions as roughly the AVERAGE of individual probabilities. Math says it's closer to the PRODUCT. A 20% × 20% × 20% conjunction is 0.8%, not 20%.",
  K_OF_N: 'K-of-N markets are less extreme than ALL-OF, but still overpriced when K > N/2. When K is low relative to N (like 1 of 6), the market may actually be underpriced because ANY-OF conjunctions are high probability.',
  ANY_OF: "ANY-OF is the inverse conjunction — probability is HIGHER than any individual condition. If each of 4 conditions has 15% probability, at least one happening is 48%, not 15%. These markets often UNDERPRICE Yes.",
  SEQUENTIAL: 'Sequential conditions compound like ALL-OF, but with an additional time-constraint penalty. Each step must happen within a window after the previous, making the compound probability even lower.',
  THRESHOLD: 'Threshold conditions work like K-of-N but with a quantitative trigger per trial. The compound probability depends on both the per-trial success rate and the required frequency.',
};

/**
 * Compact cell for the table column.
 */
export function ConjunctionCell({ conjunction }) {
  if (!conjunction?.isConjunction) return <span className="text-gray-600 text-xs">--</span>;

  const { type, conditionCount, requiredCount, gapPp } = conjunction;
  const color = TYPE_COLORS[type] || '#9ca3af';
  const label = type === 'K_OF_N' ? `${requiredCount}/${conditionCount}` : `${conditionCount} ${TYPE_LABELS[type]}`;

  const tooltip = `${TYPE_DESCRIPTIONS[type] || type}: ${conditionCount} conditions, ${requiredCount} required` +
    (gapPp != null ? `. Gap: ${gapPp > 0 ? '+' : ''}${gapPp.toFixed(1)}pp` : '');

  return (
    <span
      className="text-xs font-semibold"
      style={{ color }}
      title={tooltip}
    >
      {label}
    </span>
  );
}

/**
 * Full interactive conjunction calculator card for expanded detail panel.
 */
export default function ConjunctionCard({ market, conjunction, allMarkets }) {
  const {
    type, conditionCount, requiredCount, conditions, confidence,
    defaultProbs, sensitivityTable, impliedIndividualProb,
  } = conjunction;

  const yesPrice = market.yesPrice ?? 0;
  const color = TYPE_COLORS[type] || '#9ca3af';

  // Interactive state: individual probabilities
  const [probs, setProbs] = useState(() => [...defaultProbs]);
  const [correlation, setCorrelation] = useState(0.3);

  const updateProb = useCallback((index, value) => {
    setProbs((prev) => {
      const next = [...prev];
      next[index] = Math.max(0.01, Math.min(0.99, value));
      return next;
    });
  }, []);

  // Live calculation
  const compoundProb = useMemo(
    () => calculateCompoundProbability(type, probs, correlation, requiredCount),
    [type, probs, correlation, requiredCount]
  );

  const gap = yesPrice - compoundProb;
  const gapPp = gap * 100;

  // Determine source labels for each condition
  const sourceLabels = useMemo(() => {
    return probs.map((p, i) => {
      if (Math.abs(p - defaultProbs[i]) > 0.005) return 'user';
      return 'implied';
    });
  }, [probs, defaultProbs]);

  const typeDesc = type === 'K_OF_N'
    ? `${requiredCount} OF ${conditionCount} ${TYPE_DESCRIPTIONS[type]}`
    : `${type === 'ANY_OF' ? '' : conditionCount + ' '}${TYPE_DESCRIPTIONS[type]}`;

  return (
    <div className="rounded-lg border border-[#1f2937] p-4" style={{ background: '#111827' }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="text-xs font-semibold text-gray-400 uppercase">
          Conjunction Probability Calculator
        </div>
        {confidence === 'LOW' && (
          <span className="text-[10px] text-gray-500">Low confidence detection</span>
        )}
      </div>

      {/* Type badge */}
      <div
        className="inline-block px-3 py-1.5 rounded-md text-xs font-bold mb-4"
        style={{ color, background: `${color}15`, border: `1px solid ${color}30` }}
      >
        {typeDesc}
      </div>

      {/* Condition sliders */}
      <div className="space-y-3 mb-4">
        {Array.from({ length: conditionCount }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-xs text-gray-400 mb-1 truncate">
                {conditions[i]
                  ? conditions[i].substring(0, 60) + (conditions[i].length > 60 ? '...' : '')
                  : `Condition ${i + 1}`}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={1}
                  max={99}
                  step={1}
                  value={Math.round(probs[i] * 100)}
                  onChange={(e) => updateProb(i, parseInt(e.target.value) / 100)}
                  className="flex-1"
                  style={{ accentColor: color }}
                />
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={Math.round(probs[i] * 100)}
                  onChange={(e) => updateProb(i, parseInt(e.target.value || '50') / 100)}
                  className="w-14 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 text-center"
                />
                <span className="text-[10px] text-gray-500 w-16 shrink-0 text-right">
                  {sourceLabels[i] === 'user'
                    ? <span className="text-white">Yours</span>
                    : <span className="text-gray-500">Implied</span>}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Correlation slider */}
      <div className="mb-4 pb-4 border-b border-[#1f2937]">
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-400 shrink-0">Correlation (ρ):</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(correlation * 100)}
            onChange={(e) => setCorrelation(parseInt(e.target.value) / 100)}
            className="flex-1"
          />
          <input
            type="number"
            min={0}
            max={100}
            step={5}
            value={Math.round(correlation * 100)}
            onChange={(e) => setCorrelation(parseInt(e.target.value || '30') / 100)}
            className="w-14 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 text-center"
          />
          <span className="text-[10px] text-gray-500">%</span>
        </div>
        <div className="text-[10px] text-gray-600 mt-1">
          0 = independent events. 100 = perfectly correlated. Most real-world conditions: 20-50%
        </div>
      </div>

      {/* Result — primary output */}
      <div className="mb-4">
        <div className="flex items-baseline gap-3 mb-2">
          <span className="text-xs text-gray-500 uppercase">Compound Probability:</span>
          <span
            className="text-2xl font-bold"
            style={{ color: Math.abs(gapPp) < 3 ? '#9ca3af' : gap > 0 ? '#00d4aa' : '#ff4d6a' }}
          >
            {(compoundProb * 100).toFixed(1)}%
          </span>
        </div>

        {/* Comparison bar */}
        <div className="relative h-8 bg-gray-800 rounded mb-2">
          {/* Gap zone */}
          {(() => {
            const left = Math.min(compoundProb, yesPrice) * 100;
            const width = Math.abs(gap) * 100;
            return (
              <div
                className="absolute top-0 h-full rounded opacity-20"
                style={{
                  left: `${left}%`,
                  width: `${Math.max(width, 0.5)}%`,
                  background: '#f59e0b',
                }}
              />
            );
          })()}
          {/* Compound marker */}
          <div
            className="absolute top-0 h-full w-0.5"
            style={{ left: `${compoundProb * 100}%`, background: '#00d4aa' }}
          >
            <div className="absolute -top-4 left-1/2 -translate-x-1/2 text-[9px] font-semibold whitespace-nowrap" style={{ color: '#00d4aa' }}>
              {(compoundProb * 100).toFixed(1)}%
            </div>
          </div>
          {/* Market marker */}
          <div
            className="absolute top-0 h-full w-0.5 bg-white"
            style={{ left: `${yesPrice * 100}%` }}
          >
            <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 text-[9px] font-semibold text-white whitespace-nowrap">
              Mkt {(yesPrice * 100).toFixed(1)}%
            </div>
          </div>
        </div>

        {/* Gap text */}
        <div className="text-xs text-gray-400 mt-5 space-y-1">
          <p>
            Your estimates produce a compound probability of{' '}
            <span className="text-white font-semibold">{(compoundProb * 100).toFixed(1)}%</span>.
          </p>
          <p>
            The market is priced at{' '}
            <span className="text-white font-semibold">{(yesPrice * 100).toFixed(1)}%</span>.
          </p>
          <p>
            Gap:{' '}
            <span
              className="font-semibold"
              style={{ color: Math.abs(gapPp) < 3 ? '#9ca3af' : gap > 0 ? '#00d4aa' : '#ff4d6a' }}
            >
              {gapPp > 0 ? '+' : ''}{gapPp.toFixed(1)}pp
            </span>
            {Math.abs(gapPp) >= 3 && (
              <span className="text-gray-500">
                {' '}— the market is {gap > 0 ? 'overpricing' : 'underpricing'} Yes by{' '}
                {Math.abs(gapPp).toFixed(1)} percentage points.
              </span>
            )}
          </p>
          {impliedIndividualProb != null && (
            <p className="mt-2 text-gray-500 italic">
              For the market price of {(yesPrice * 100).toFixed(0)}¢ to be fair, each condition needs
              ~{(impliedIndividualProb * 100).toFixed(0)}% individual probability.
              Do you think each condition is that likely?
            </p>
          )}
        </div>
      </div>

      {/* Sensitivity table */}
      {sensitivityTable.length > 0 && (
        <div className="mb-4 pt-3 border-t border-[#1f2937]">
          <div className="text-[10px] text-gray-500 uppercase mb-2">
            Sensitivity (equal probs, ρ={correlation.toFixed(1)})
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
            <div className="text-gray-500 font-semibold pb-1 border-b border-gray-800">Each condition</div>
            <div className="text-gray-500 font-semibold pb-1 border-b border-gray-800">Compound prob</div>
            {sensitivityTable.map((row) => {
              const isClosest = sensitivityTable.reduce((best, r) =>
                Math.abs(r.compoundResult - yesPrice) < Math.abs(best.compoundResult - yesPrice) ? r : best
              ) === row;
              return (
                <SensitivityRow
                  key={row.individualProb}
                  row={row}
                  isClosest={isClosest}
                  yesPrice={yesPrice}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Insight text */}
      {INSIGHT_TEXT[type] && (
        <div className="pt-3 border-t border-[#1f2937]">
          <p className="text-[11px] text-gray-600 leading-relaxed">
            {INSIGHT_TEXT[type]}
          </p>
        </div>
      )}

      {confidence === 'LOW' && (
        <div className="mt-3 text-[10px] text-gray-600 italic">
          Conditions could not be auto-extracted — enter your estimates manually using the sliders above.
        </div>
      )}
    </div>
  );
}

function SensitivityRow({ row, isClosest, yesPrice }) {
  return (
    <>
      <div
        className={`py-0.5 ${isClosest ? 'text-white font-semibold' : 'text-gray-400'}`}
        style={isClosest ? { background: 'rgba(255,255,255,0.05)', borderRadius: 2 } : undefined}
      >
        {(row.individualProb * 100).toFixed(0)}%
      </div>
      <div
        className={`py-0.5 ${isClosest ? 'text-white font-semibold' : 'text-gray-400'}`}
        style={isClosest ? { background: 'rgba(255,255,255,0.05)', borderRadius: 2 } : undefined}
      >
        {(row.compoundResult * 100).toFixed(1)}%
        {isClosest && <span className="text-gray-500 ml-1">← Mkt implies</span>}
      </div>
    </>
  );
}
