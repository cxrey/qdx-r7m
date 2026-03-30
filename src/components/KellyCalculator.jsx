/**
 * KellyCalculator.jsx — Binary Kelly Criterion position sizer.
 * Shows in expanded market detail panel.
 *
 * UI ordering (strict):
 *   1. Probability slider (your estimate)
 *   2. Sensitivity table
 *   3. Break-even question
 *   4. Scenario selection
 *   5. Final $ sizing output
 */
import { useState, useMemo, useCallback } from 'react';
import {
  calculateKelly,
  calculateSensitivityTable,
  calculateScenarios,
  calculateReEvalTrigger,
  applyPortfolioConstraints,
  getKellySettings,
  saveKellySettings,
  saveJournalEntry,
} from '../KellyEngine';

const CYAN = '#00d4aa';
const PINK = '#ff4d6a';

// ── Robustness Badge ──
function RobustnessBadge({ level }) {
  const cfg = {
    ROBUST: { bg: 'bg-emerald-900/60', text: 'text-emerald-300', label: 'Robust' },
    SOLID: { bg: 'bg-emerald-900/40', text: 'text-emerald-400', label: 'Solid' },
    MODERATE: { bg: 'bg-yellow-900/40', text: 'text-yellow-300', label: 'Moderate' },
    FRAGILE: { bg: 'bg-red-900/40', text: 'text-red-300', label: 'Fragile' },
  }[level] || { bg: 'bg-gray-800', text: 'text-gray-400', label: level };

  return (
    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${cfg.bg} ${cfg.text}`}>
      {cfg.label}
    </span>
  );
}

// ── No Edge State ──
function NoEdgeCard({ kelly }) {
  return (
    <div className="rounded-lg border border-gray-700/50 p-4" style={{ background: 'rgba(107, 114, 128, 0.08)' }}>
      <div className="text-sm font-semibold text-gray-300 mb-1">No Detectable Edge</div>
      <div className="text-xs text-gray-400">
        {kelly.reason}
      </div>
      <div className="text-xs text-gray-500 mt-2">
        Gap to break-even: {kelly.gapPp?.toFixed(1) || '0'}pp.
        The market price already reflects (or exceeds) your probability estimate.
        Consider whether you have information the market doesn't.
      </div>
    </div>
  );
}

// ── Sensitivity Table ──
function SensitivityTableView({ rows, side, sideProb }) {
  return (
    <div className="rounded-lg border border-[#1f2937]" style={{ background: '#111827' }}>
      <div className="px-3 py-2 border-b border-gray-800">
        <span className="text-xs font-semibold text-gray-400 uppercase">Sensitivity Analysis</span>
        <span className="text-[10px] text-gray-500 ml-2">How sizing changes with your probability estimate</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-800 text-gray-500">
              <th className="px-3 py-1.5 text-left font-medium">Your Prob</th>
              <th className="px-3 py-1.5 text-left font-medium">Edge</th>
              <th className="px-3 py-1.5 text-left font-medium">Robustness</th>
              <th className="px-3 py-1.5 text-right font-medium">Kelly %</th>
              <th className="px-3 py-1.5 text-right font-medium">Bet Size</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const isCenter = row.isCenter;
              const bgStyle = isCenter ? { background: 'rgba(0, 212, 170, 0.06)' } : {};
              const hasEdge = row.kelly.valid && !row.kelly.noEdge;

              return (
                <tr
                  key={i}
                  className={`border-b border-gray-800/50 ${isCenter ? 'font-semibold' : ''}`}
                  style={bgStyle}
                >
                  <td className="px-3 py-1.5">
                    <span className={isCenter ? 'text-gray-100' : 'text-gray-400'}>
                      {side === 'NO' ? (100 - parseFloat(row.probPct)).toFixed(1) : row.probPct}%
                      {isCenter && <span className="ml-1 text-[9px] text-gray-500">(you)</span>}
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    {hasEdge ? (
                      <span style={{ color: row.kelly.edge > 3 ? CYAN : row.kelly.edge > 1 ? '#eab308' : '#9ca3af' }}>
                        {row.kelly.edge.toFixed(1)}pp
                      </span>
                    ) : (
                      <span className="text-gray-600">--</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {hasEdge ? (
                      <RobustnessBadge level={row.kelly.robustness.level} />
                    ) : (
                      <span className="text-gray-600 text-[10px]">no edge</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right text-gray-400">
                    {hasEdge ? `${(row.kelly.fractionalKelly * 100).toFixed(1)}%` : '--'}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {row.cappedDollars > 0 ? (
                      <span className={`${row.belowMinimum ? 'text-gray-600 line-through' : 'text-gray-200'}`}>
                        ${row.cappedDollars.toFixed(0)}
                        {row.capped && <span className="text-[9px] text-amber-500 ml-0.5">cap</span>}
                      </span>
                    ) : (
                      <span className="text-gray-600">$0</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Break-Even Display ──
function BreakEvenSection({ kelly, side, sideProb }) {
  const bePct = (kelly.breakEvenProb * 100).toFixed(1);
  const estPct = (sideProb * 100).toFixed(1);

  return (
    <div className="rounded-lg border border-[#1f2937] p-3" style={{ background: '#111827' }}>
      <div className="text-xs font-semibold text-gray-400 uppercase mb-2">Break-Even Check</div>
      <div className="flex items-center gap-4 text-sm">
        <div>
          <div className="text-[10px] text-gray-500 mb-0.5">Market implies</div>
          <div className="text-gray-300 font-semibold">{bePct}%</div>
        </div>
        <div className="text-gray-600">vs</div>
        <div>
          <div className="text-[10px] text-gray-500 mb-0.5">Your estimate</div>
          <div className="font-semibold" style={{ color: CYAN }}>{estPct}%</div>
        </div>
        <div className="flex-1 text-right">
          <div className="text-[10px] text-gray-500 mb-0.5">Gap</div>
          <div className={`font-bold ${kelly.gapPp > 5 ? 'text-emerald-400' : kelly.gapPp > 2 ? 'text-yellow-400' : 'text-gray-400'}`}>
            +{kelly.gapPp.toFixed(1)}pp
          </div>
        </div>
      </div>
      <div className="text-[10px] text-gray-500 mt-2">
        You need {side === 'YES' ? 'YES' : 'NO'} to happen at least {bePct}% of the time to break even at this price.
        Your estimate of {estPct}% gives a {kelly.gapPp.toFixed(1)}pp edge.
      </div>
    </div>
  );
}

// ── Scenario Cards ──
function ScenarioSection({ scenarios }) {
  if (!scenarios) return null;

  return (
    <div className="rounded-lg border border-[#1f2937] p-3" style={{ background: '#111827' }}>
      <div className="text-xs font-semibold text-gray-400 uppercase mb-2">Scenarios</div>

      {/* Win / Loss */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="rounded border border-emerald-900/50 p-2" style={{ background: 'rgba(0,212,170,0.04)' }}>
          <div className="text-[10px] text-gray-500">If {scenarios.side} wins ({(scenarios.win.prob * 100).toFixed(0)}% est.)</div>
          <div className="text-sm font-bold text-emerald-400">+${scenarios.win.profit.toFixed(2)}</div>
          <div className="text-[10px] text-gray-500">+{scenarios.win.returnPct.toFixed(0)}% return</div>
        </div>
        <div className="rounded border border-red-900/50 p-2" style={{ background: 'rgba(255,77,106,0.04)' }}>
          <div className="text-[10px] text-gray-500">If {scenarios.side} loses ({(scenarios.loss.prob * 100).toFixed(0)}% est.)</div>
          <div className="text-sm font-bold text-red-400">-${scenarios.loss.amount.toFixed(2)}</div>
          <div className="text-[10px] text-gray-500">Total loss of bet</div>
        </div>
      </div>

      {/* Expected value */}
      <div className="flex items-center gap-2 mb-3 text-xs">
        <span className="text-gray-500">Expected value:</span>
        <span className={scenarios.ev >= 0 ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold'}>
          {scenarios.ev >= 0 ? '+' : ''}${scenarios.ev.toFixed(2)} ({scenarios.evPct >= 0 ? '+' : ''}{scenarios.evPct.toFixed(1)}%)
        </span>
      </div>

      {/* Partial scenarios */}
      <div className="text-[10px] text-gray-500 mb-1">If price moves before resolution:</div>
      <div className="grid grid-cols-4 gap-1">
        {scenarios.partialScenarios.map((ps, i) => (
          <div key={i} className="rounded bg-gray-800/50 p-1.5 text-center">
            <div className="text-[10px] text-gray-500">{ps.label}</div>
            <div className={`text-[11px] font-semibold ${ps.paperPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {ps.paperPnl >= 0 ? '+' : ''}${ps.paperPnl.toFixed(1)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Re-evaluation Triggers ──
function ReEvalSection({ triggers }) {
  if (!triggers || triggers.triggers.length === 0) return null;

  return (
    <div className="rounded-lg border border-[#1f2937] p-3" style={{ background: '#111827' }}>
      <div className="text-xs font-semibold text-gray-400 uppercase mb-2">Re-evaluate When</div>
      <div className="space-y-1">
        {triggers.triggers.map((t, i) => (
          <div key={i} className="flex items-start gap-2 text-xs">
            <span className="text-gray-600 shrink-0 mt-0.5">
              {t.type === 'PRICE_MOVE' ? 'P' : t.type === 'TIME' ? 'T' : t.type === 'THETA' ? 'D' : t.type === 'VOLUME' ? 'V' : 'i'}
            </span>
            <span className="text-gray-400">{t.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Constraint Warnings ──
function ConstraintWarnings({ constraints }) {
  if (!constraints || constraints.constraints.length === 0) return null;

  return (
    <div className="space-y-1">
      {constraints.constraints.map((c, i) => (
        <div key={i} className="text-[10px] text-amber-400 flex items-start gap-1">
          <span className="shrink-0">!</span>
          <span>{c.label}</span>
        </div>
      ))}
    </div>
  );
}

// ── Final Sizing Output ──
function FinalSizing({ kelly, constrained, settings, scenarios, onJournal }) {
  if (!kelly || kelly.noEdge) return null;

  const betSize = constrained?.adjustedDollars || 0;
  const shares = scenarios?.shares || 0;
  const pctBankroll = settings.bankroll > 0 ? (betSize / settings.bankroll) * 100 : 0;

  return (
    <div className="rounded-lg border p-4" style={{ background: 'rgba(0, 212, 170, 0.04)', borderColor: 'rgba(0, 212, 170, 0.2)' }}>
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold text-gray-400 uppercase">Suggested Position Size</div>
        <RobustnessBadge level={kelly.robustness.level} />
      </div>

      {constrained?.effective ? (
        <>
          <div className="flex items-baseline gap-3 mb-2">
            <span className="text-2xl font-bold" style={{ color: CYAN }}>${betSize.toFixed(0)}</span>
            <span className="text-sm text-gray-400">
              {pctBankroll.toFixed(1)}% of bankroll
            </span>
          </div>
          <div className="text-xs text-gray-400 mb-2">
            ~{shares.toFixed(1)} shares at {(kelly.marketPrice * 100).toFixed(1)}c
          </div>
          <div className="text-[10px] text-gray-500 mb-3">
            {kelly.robustness.label}. Full Kelly would be {(kelly.fullKelly * 100).toFixed(1)}%
            (${(kelly.fullKelly * settings.bankroll).toFixed(0)}).
          </div>
          <ConstraintWarnings constraints={constrained} />

          {/* Journal button */}
          {onJournal && (
            <button
              onClick={onJournal}
              className="mt-3 w-full py-1.5 rounded text-xs font-medium border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors"
            >
              Record in Decision Journal
            </button>
          )}
        </>
      ) : (
        <div className="text-xs text-gray-500">
          {constrained?.belowMinimum
            ? `Calculated bet ($${betSize.toFixed(2)}) is below minimum practical size ($${settings.minPracticalBet}).`
            : 'No bet recommended at current sizing.'
          }
        </div>
      )}
    </div>
  );
}

// ── Settings Popover ──
function SettingsPopover({ settings, onSave, onClose }) {
  const [local, setLocal] = useState({ ...settings });

  const handleSave = () => {
    onSave(local);
    onClose();
  };

  return (
    <div
      className="absolute top-8 right-0 z-50 rounded-lg border border-gray-700 p-3 shadow-xl"
      style={{ background: '#1a1f2e', width: 240 }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="text-xs text-gray-400 font-semibold mb-2">Kelly Settings</div>
      <div className="space-y-2">
        <SettingsField label="Bankroll ($)" value={local.bankroll} onChange={(v) => setLocal((s) => ({ ...s, bankroll: v }))} min={0} step={100} />
        <SettingsField label="Max Position (%)" value={local.maxPositionPct} onChange={(v) => setLocal((s) => ({ ...s, maxPositionPct: v }))} min={1} max={100} step={1} />
        <SettingsField label="Max Total Exposure (%)" value={local.maxTotalExposure} onChange={(v) => setLocal((s) => ({ ...s, maxTotalExposure: v }))} min={1} max={100} step={5} />
        <SettingsField label="Min Bet ($)" value={local.minPracticalBet} onChange={(v) => setLocal((s) => ({ ...s, minPracticalBet: v }))} min={0} step={1} />
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={local.correlationPenalty}
            onChange={(e) => setLocal((s) => ({ ...s, correlationPenalty: e.target.checked }))}
            className="rounded"
          />
          <span className="text-[10px] text-gray-400">Correlation penalty</span>
        </div>
      </div>
      <div className="flex gap-2 mt-3">
        <button onClick={handleSave} className="flex-1 px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-xs font-medium text-white">Save</button>
        <button onClick={onClose} className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-xs text-gray-300">Cancel</button>
      </div>
    </div>
  );
}

function SettingsField({ label, value, onChange, min, max, step }) {
  return (
    <div>
      <label className="text-[10px] text-gray-500">{label}</label>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 focus:outline-none focus:border-emerald-500"
      />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ── MAIN COMPONENT ──
// ══════════════════════════════════════════════════════════════

export default function KellyCalculator({ market, portfolio }) {
  const [collapsed, setCollapsed] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState(getKellySettings);
  const [journalSaved, setJournalSaved] = useState(false);

  // Side toggle: YES or NO
  const defaultSide = (() => {
    if (market.flb?.bestSide === 'YES' || market.flb?.bestSide === 'NO') return market.flb.bestSide;
    if (market.yesPrice != null && market.yesPrice < 0.5) return 'YES';
    return 'NO';
  })();
  const [side, setSide] = useState(defaultSide);

  // Market price for selected side
  const marketPrice = side === 'YES'
    ? (market.yesPrice ?? 0.5)
    : (market.noPrice ?? 0.5);

  // The slider represents the probability of the SELECTED side happening.
  // Internally, calculateKelly expects estProb = probability of YES (the event).
  // Break-even: need side prob > marketPrice. Default starts 5pp above.
  const defaultEstimate = Math.max(0.05, Math.min(0.95, marketPrice + 0.05));
  const [sideProb, setSideProb] = useState(defaultEstimate);

  // Convert slider value to YES probability for the engine
  const estProb = side === 'YES' ? sideProb : (1 - sideProb);

  // Core calculations
  const kelly = useMemo(
    () => calculateKelly(estProb, marketPrice, side),
    [estProb, marketPrice, side]
  );

  const sensitivity = useMemo(
    () => calculateSensitivityTable(marketPrice, estProb, side, settings),
    [marketPrice, estProb, side, settings]
  );

  const betDollars = kelly.valid && !kelly.noEdge
    ? kelly.fractionalKelly * settings.bankroll
    : 0;

  const constrained = useMemo(
    () => applyPortfolioConstraints(betDollars, market, portfolio, settings),
    [betDollars, market, portfolio, settings]
  );

  const scenarios = useMemo(
    () => constrained.adjustedDollars > 0
      ? calculateScenarios(constrained.adjustedDollars, marketPrice, side, estProb, settings)
      : null,
    [constrained.adjustedDollars, marketPrice, side, estProb, settings]
  );

  const reEvalTriggers = useMemo(
    () => calculateReEvalTrigger(marketPrice, estProb, market.daysLeft, market.theta),
    [marketPrice, estProb, market.daysLeft, market.theta]
  );

  // Handle settings save
  const handleSaveSettings = useCallback((newSettings) => {
    setSettings(newSettings);
    saveKellySettings(newSettings);
  }, []);

  // Handle journal recording
  const handleJournal = useCallback(() => {
    const entry = saveJournalEntry({
      marketId: market.id,
      marketQuestion: market.question,
      side,
      estProb,
      marketPrice,
      betSize: constrained.adjustedDollars,
      kellyFraction: kelly.fractionalKelly,
      robustness: kelly.robustness?.level,
      gapPp: kelly.gapPp,
      bankroll: settings.bankroll,
    });
    if (entry) {
      setJournalSaved(true);
      setTimeout(() => setJournalSaved(false), 2000);
    }
  }, [market, side, estProb, marketPrice, constrained, kelly, settings]);

  // Handle side change — reset estimate
  const handleSideChange = useCallback((newSide) => {
    setSide(newSide);
    const newPrice = newSide === 'YES' ? (market.yesPrice ?? 0.5) : (market.noPrice ?? 0.5);
    setSideProb(Math.max(0.05, Math.min(0.95, newPrice + 0.05)));
  }, [market]);

  if (collapsed) {
    return (
      <div className="rounded-lg border border-[#1f2937]" style={{ background: '#111827' }}>
        <button
          onClick={() => setCollapsed(false)}
          className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-gray-800/30 transition-colors"
        >
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-gray-400 uppercase">Position Sizer (Kelly)</span>
            {kelly.valid && !kelly.noEdge && (
              <span className="text-[10px] text-gray-500">
                ~${(kelly.fractionalKelly * settings.bankroll).toFixed(0)} suggested
              </span>
            )}
          </div>
          <span className="text-gray-600 text-xs">expand</span>
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[#1f2937]" style={{ background: '#111827' }}>
      {/* Header — click anywhere to collapse */}
      <div
        className="px-4 py-3 border-b border-gray-800 flex items-center justify-between cursor-pointer hover:bg-gray-800/30 transition-colors"
        onClick={() => setCollapsed(true)}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-400 uppercase">Position Sizer (Kelly)</span>
          {journalSaved && (
            <span className="text-[10px] text-emerald-400">Saved to journal</span>
          )}
        </div>
        <div className="flex items-center gap-2 relative">
          <button
            onClick={(e) => { e.stopPropagation(); setShowSettings(!showSettings); }}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            Settings
          </button>
          <span className="text-xs text-gray-500">collapse</span>
          {showSettings && (
            <SettingsPopover
              settings={settings}
              onSave={handleSaveSettings}
              onClose={() => setShowSettings(false)}
            />
          )}
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* Side toggle */}
        <div className="flex gap-2">
          <button
            onClick={() => handleSideChange('YES')}
            className={`flex-1 px-3 py-1.5 rounded text-xs font-semibold transition-colors border ${
              side === 'YES' ? 'text-white' : 'text-gray-500 border-transparent hover:text-gray-300'
            }`}
            style={side === 'YES' ? { borderColor: CYAN, background: 'rgba(0,212,170,0.1)', color: CYAN } : {}}
          >
            Buy Yes @ {market.yesPrice != null ? `${(market.yesPrice * 100).toFixed(1)}c` : '--'}
          </button>
          <button
            onClick={() => handleSideChange('NO')}
            className={`flex-1 px-3 py-1.5 rounded text-xs font-semibold transition-colors border ${
              side === 'NO' ? 'text-white' : 'text-gray-500 border-transparent hover:text-gray-300'
            }`}
            style={side === 'NO' ? { borderColor: PINK, background: 'rgba(255,77,106,0.1)', color: PINK } : {}}
          >
            Buy No @ {market.noPrice != null ? `${(market.noPrice * 100).toFixed(1)}c` : '--'}
          </button>
        </div>

        {/* 1. PROBABILITY SLIDER */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-gray-400">
              Your probability estimate for <span className="text-gray-200 font-medium">{side === 'YES' ? 'YES' : 'NO'}</span>
            </label>
            <span className="text-sm font-bold" style={{ color: CYAN }}>
              {(sideProb * 100).toFixed(1)}%
            </span>
          </div>
          <input
            type="range"
            min={1}
            max={99}
            step={0.5}
            value={sideProb * 100}
            onChange={(e) => setSideProb(parseFloat(e.target.value) / 100)}
            className="w-full h-1.5 rounded-lg appearance-none cursor-pointer"
            style={{
              background: `linear-gradient(to right, ${CYAN} ${sideProb * 100}%, #374151 ${sideProb * 100}%)`,
            }}
          />
          <div className="flex justify-between text-[10px] text-gray-600 mt-0.5">
            <span>1%</span>
            <span>Market: {(marketPrice * 100).toFixed(1)}%</span>
            <span>99%</span>
          </div>
        </div>

        {/* NO EDGE state */}
        {kelly.valid && kelly.noEdge && (
          <NoEdgeCard kelly={kelly} />
        )}

        {/* Only show remaining sections if there IS an edge */}
        {kelly.valid && !kelly.noEdge && (
          <>
            {/* 2. SENSITIVITY TABLE */}
            <SensitivityTableView rows={sensitivity} side={side} sideProb={sideProb} />

            {/* 3. BREAK-EVEN QUESTION */}
            <BreakEvenSection kelly={kelly} side={side} sideProb={sideProb} />

            {/* 4. SCENARIOS */}
            <ScenarioSection scenarios={scenarios} />

            {/* RE-EVALUATION TRIGGERS */}
            <ReEvalSection triggers={reEvalTriggers} />

            {/* 5. FINAL SIZING OUTPUT */}
            <FinalSizing
              kelly={kelly}
              constrained={constrained}
              settings={settings}
              scenarios={scenarios}
              onJournal={handleJournal}
            />
          </>
        )}

        {/* Disclaimer */}
        <div className="text-[10px] text-gray-600 leading-relaxed">
          This is a mathematical sizing tool, not financial advice.
          Kelly sizing assumes your probability estimate is correct — real edges are uncertain.
          The fractional Kelly approach reduces risk but also reduces expected growth.
          Bankroll: ${settings.bankroll.toLocaleString()}.
        </div>
      </div>
    </div>
  );
}

// Export a compact inline component for table rows
export function KellySizeLink({ market }) {
  if (!market.yesPrice && !market.noPrice) return null;

  const price = market.yesPrice ?? market.noPrice ?? 0.5;
  const settings = getKellySettings();

  // Quick check: is there any possible edge?
  const hasAnyAnalysis = market.flb || market.baseRate || market.volumeEfficiency;
  if (!hasAnyAnalysis) return null;

  return (
    <span className="text-[10px] text-gray-500 hover:text-gray-300 cursor-pointer" title="Open position sizer">
      Size
    </span>
  );
}
