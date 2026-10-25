/**
 * MultiOutcomeKelly.jsx — Kelly Criterion for events with 3+ outcomes.
 * Allows users to set estimated probabilities for each outcome and
 * get allocation recommendations.
 */
import { useState, useMemo, useCallback } from 'react';
import {
  calculateMultiOutcomeKelly,
  getKellySettings,
} from '../KellyEngine';

const CYAN = '#00d4aa';
const COLORS = ['#00d4aa', '#3b82f6', '#f59e0b', '#ef4444', '#a855f7', '#ec4899', '#14b8a6', '#f97316'];

function RobustnessBadge({ level }) {
  const cfg = {
    ROBUST: { bg: 'bg-emerald-900/60', text: 'text-emerald-300', label: 'Robust' },
    SOLID: { bg: 'bg-emerald-900/40', text: 'text-emerald-400', label: 'Solid' },
    MODERATE: { bg: 'bg-yellow-900/40', text: 'text-yellow-300', label: 'Moderate' },
    FRAGILE: { bg: 'bg-red-900/40', text: 'text-red-300', label: 'Fragile' },
  }[level] || { bg: 'bg-gray-800', text: 'text-gray-400', label: level };

  return (
    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${cfg.bg} ${cfg.text}`}>
      {cfg.label}
    </span>
  );
}

export default function MultiOutcomeKelly({ outcomes: initialOutcomes }) {
  const [settings] = useState(getKellySettings);
  const [collapsed, setCollapsed] = useState(true);

  // Build editable outcomes from initial data
  const [estimates, setEstimates] = useState(() =>
    initialOutcomes.map((o) => ({
      name: o.name || o.question || `Outcome ${o.index || ''}`,
      marketPrice: o.marketPrice || o.yesPrice || 0.5,
      estProb: o.marketPrice || o.yesPrice || (1 / initialOutcomes.length),
      // Per-outcome fee context (processed markets carry feeParams)
      feeParams: o.feeParams ?? null,
    }))
  );

  const totalEstProb = estimates.reduce((s, e) => s + e.estProb, 0);

  const handleProbChange = useCallback((idx, newProb) => {
    setEstimates((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], estProb: newProb };
      return next;
    });
  }, []);

  // Normalize button
  const handleNormalize = useCallback(() => {
    const total = estimates.reduce((s, e) => s + e.estProb, 0);
    if (total <= 0) return;
    setEstimates((prev) => prev.map((e) => ({ ...e, estProb: e.estProb / total })));
  }, [estimates]);

  // Multi-outcome Kelly calculation
  const result = useMemo(
    () => calculateMultiOutcomeKelly(estimates),
    [estimates]
  );

  if (collapsed) {
    return (
      <div className="rounded-lg border border-[#1f2937]" style={{ background: '#111827' }}>
        <button
          onClick={() => setCollapsed(false)}
          className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-gray-800/30 transition-colors"
        >
          <span className="text-xs font-semibold text-gray-400 uppercase">
            Multi-Outcome Sizer ({initialOutcomes.length} outcomes)
          </span>
          <span className="text-gray-600 text-xs">expand</span>
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[#1f2937]" style={{ background: '#111827' }}>
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-400 uppercase">
          Multi-Outcome Position Sizer
        </span>
        <button
          onClick={() => setCollapsed(true)}
          className="text-xs text-gray-500 hover:text-gray-300"
        >
          collapse
        </button>
      </div>

      <div className="p-4 space-y-4">
        {/* Probability sliders for each outcome */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400">Set your probability estimates:</span>
            <div className="flex items-center gap-2">
              <span className={`text-[10px] ${Math.abs(totalEstProb - 1) < 0.01 ? 'text-emerald-400' : 'text-amber-400'}`}>
                Total: {(totalEstProb * 100).toFixed(1)}%
              </span>
              {Math.abs(totalEstProb - 1) > 0.01 && (
                <button
                  onClick={handleNormalize}
                  className="text-[10px] text-gray-500 hover:text-gray-300 underline"
                >
                  Normalize to 100%
                </button>
              )}
            </div>
          </div>

          {estimates.map((outcome, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-xs text-gray-300 truncate">{outcome.name}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] text-gray-500">
                      Mkt: {(outcome.marketPrice * 100).toFixed(1)}%
                    </span>
                    <span className="text-xs font-semibold" style={{ color: COLORS[i % COLORS.length] }}>
                      {(outcome.estProb * 100).toFixed(1)}%
                    </span>
                  </div>
                </div>
                <input
                  type="range"
                  min={1}
                  max={99}
                  step={0.5}
                  value={outcome.estProb * 100}
                  onChange={(e) => handleProbChange(i, parseFloat(e.target.value) / 100)}
                  className="w-full h-1 rounded-lg appearance-none cursor-pointer"
                  style={{
                    background: `linear-gradient(to right, ${COLORS[i % COLORS.length]} ${outcome.estProb * 100}%, #374151 ${outcome.estProb * 100}%)`,
                  }}
                />
              </div>
            </div>
          ))}
        </div>

        {/* Results */}
        {result.valid && (
          <div className="rounded-lg border border-[#1f2937] overflow-hidden">
            <div className="px-3 py-2 bg-gray-900/50 border-b border-gray-800">
              <span className="text-xs font-semibold text-gray-400 uppercase">Allocation</span>
              {result.probsNormalized && (
                <span className="text-[10px] text-amber-400 ml-2">
                  (probabilities normalized from {(result.originalProbSum * 100).toFixed(0)}%)
                </span>
              )}
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500">
                  <th className="px-3 py-1.5 text-left font-medium">Outcome</th>
                  <th className="px-3 py-1.5 text-right font-medium">Your Prob</th>
                  <th className="px-3 py-1.5 text-right font-medium">Market</th>
                  <th className="px-3 py-1.5 text-right font-medium">Edge</th>
                  <th className="px-3 py-1.5 text-right font-medium">Allocation</th>
                  <th className="px-3 py-1.5 text-right font-medium">$ Size</th>
                </tr>
              </thead>
              <tbody>
                {result.outcomes.map((o, i) => {
                  const dollars = o.recommendedFraction * settings.bankroll;
                  const hasEdge = o.kelly.valid && !o.kelly.noEdge;
                  return (
                    <tr key={i} className="border-b border-gray-800/50">
                      <td className="px-3 py-1.5">
                        <span className="flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
                          <span className="text-gray-300 truncate">{o.name}</span>
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-400">
                        {(o.estProb * 100).toFixed(1)}%
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-500">
                        {(o.marketPrice * 100).toFixed(1)}%
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        {hasEdge ? (
                          <span style={{ color: o.edgePp > 3 ? CYAN : o.edgePp > 1 ? '#eab308' : '#9ca3af' }}>
                            {o.edgePp > 0 ? '+' : ''}{o.edgePp.toFixed(1)}pp
                          </span>
                        ) : (
                          <span className="text-gray-600">--</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right text-gray-400">
                        {hasEdge ? `${(o.recommendedFraction * 100).toFixed(1)}%` : '--'}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        {hasEdge && dollars >= 1 ? (
                          <span className="text-gray-200 font-semibold">${dollars.toFixed(0)}</span>
                        ) : (
                          <span className="text-gray-600">$0</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-gray-700">
                  <td className="px-3 py-1.5 text-gray-400 font-medium" colSpan={4}>Total Allocation</td>
                  <td className="px-3 py-1.5 text-right text-gray-300 font-medium">
                    {(result.totalAllocation * 100).toFixed(1)}%
                  </td>
                  <td className="px-3 py-1.5 text-right text-gray-200 font-semibold">
                    ${(result.totalAllocation * settings.bankroll).toFixed(0)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {/* Disclaimer */}
        <div className="text-[10px] text-gray-600 leading-relaxed">
          Multi-outcome Kelly uses independent binary Kelly for each outcome, scaled down if total exceeds 80%.
          This is an approximation - true multi-outcome Kelly requires optimization that's rarely worth the added complexity.
          Bankroll: ${settings.bankroll.toLocaleString()}.
        </div>
      </div>
    </div>
  );
}
