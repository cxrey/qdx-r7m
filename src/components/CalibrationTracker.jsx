/**
 * CalibrationTracker.jsx — Decision journal + calibration chart.
 * Shows in Portfolio Dashboard tab.
 * Tracks past predictions, re-evaluations, and calibration over time.
 */
import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  getJournalEntries,
  resolveJournalEntry,
  deleteJournalEntry,
  addReEvaluation,
  computeCalibrationMetrics,
  autoResolveJournal,
  MIN_CALIBRATION_SAMPLE,
} from '../KellyEngine';
import { fetchMarketById } from '../api';
import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from 'recharts';

const CYAN = '#00d4aa';
const PINK = '#ff4d6a';

// ── Calibration Chart ──
function CalibrationChart({ metrics }) {
  if (!metrics || metrics.buckets.length < 2) {
    return (
      <div className="text-center py-6 text-gray-500 text-xs">
        Need at least 2 resolved prediction buckets to show calibration chart.
        Record and resolve more predictions to see your calibration.
      </div>
    );
  }

  const chartData = metrics.buckets.map((b) => ({
    predicted: b.midpoint * 100,
    actual: b.actualRate * 100,
    count: b.count,
    label: b.range,
  }));

  return (
    <div>
      <div className="text-xs text-gray-400 mb-2">
        Perfect calibration = dots on diagonal line
      </div>
      <div style={{ width: '100%', height: 200 }}>
        <ResponsiveContainer>
          <ScatterChart margin={{ top: 5, right: 10, bottom: 20, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis
              dataKey="predicted"
              type="number"
              domain={[0, 100]}
              tick={{ fill: '#6b7280', fontSize: 10 }}
              label={{ value: 'Your P(YES) %', position: 'bottom', offset: 5, fill: '#6b7280', fontSize: 10 }}
            />
            <YAxis
              dataKey="actual"
              type="number"
              domain={[0, 100]}
              tick={{ fill: '#6b7280', fontSize: 10 }}
              label={{ value: 'YES happened %', angle: -90, position: 'insideLeft', fill: '#6b7280', fontSize: 10 }}
            />
            <ReferenceLine
              segment={[{ x: 0, y: 0 }, { x: 100, y: 100 }]}
              stroke="#374151"
              strokeDasharray="5 5"
            />
            <Tooltip
              content={({ payload }) => {
                if (!payload || payload.length === 0) return null;
                const d = payload[0].payload;
                return (
                  <div className="rounded border border-gray-700 px-2 py-1 text-xs" style={{ background: '#1a1f2e' }}>
                    <div className="text-gray-300">Predicted: {d.predicted.toFixed(0)}%</div>
                    <div className="text-gray-300">Actual: {d.actual.toFixed(0)}%</div>
                    <div className="text-gray-500">{d.count} predictions</div>
                  </div>
                );
              }}
            />
            <Scatter data={chartData} fill={CYAN} r={6} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ── Metrics Summary ──
function MetricsSummary({ metrics }) {
  if (!metrics || metrics.totalResolved === 0) return null;
  const skill = metrics.skillScore;

  return (
    <div className="mb-3">
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        <MetricCard
          label="Resolved"
          value={metrics.totalResolved}
        />
        <MetricCard
          label="Win Rate"
          value={`${(metrics.overallWinRate * 100).toFixed(0)}%`}
          color={metrics.overallWinRate > 0.5 ? CYAN : PINK}
        />
        <MetricCard
          label="Brier Score"
          value={metrics.brierScore.toFixed(3)}
          subtitle={metrics.marketBrier != null ? `Market ${metrics.marketBrier.toFixed(3)}` : 'Lower is better'}
        />
        <MetricCard
          label="Log Loss"
          value={metrics.logLoss.toFixed(3)}
          subtitle={metrics.marketLogLoss != null ? `Market ${metrics.marketLogLoss.toFixed(3)}` : 'Lower is better'}
        />
        <MetricCard
          label="Skill vs Market"
          value={skill != null ? `${skill >= 0 ? '+' : ''}${(skill * 100).toFixed(1)}%` : '--'}
          subtitle={skill == null ? 'No benchmark' : skill > 0 ? 'Beat the price' : 'Behind the price'}
          color={skill == null ? undefined : skill > 0 ? CYAN : PINK}
        />
        <MetricCard
          label="Calibration"
          value={
            metrics.buckets.length > 0
              ? `${(metrics.buckets.reduce((s, b) => s + Math.abs(b.calibrationError), 0) / metrics.buckets.length * 100).toFixed(1)}pp`
              : '--'
          }
          subtitle="Avg error"
        />
      </div>
      <div className="text-[9px] text-gray-500 mt-1.5 leading-relaxed">
        Scores are for your P(YES) against what happened; &quot;Market&quot; scores the price you bet against.
        Skill = 1 − your Brier ÷ market Brier.
        {metrics.smallSample && ` Only ${metrics.totalResolved} resolved — below ${MIN_CALIBRATION_SAMPLE}, these are mostly noise.`}
      </div>
    </div>
  );
}

function MetricCard({ label, value, subtitle, color }) {
  return (
    <div className="rounded border border-[#1f2937] p-2" style={{ background: '#111827' }}>
      <div className="text-[9px] text-gray-500 uppercase">{label}</div>
      <div className="text-sm font-bold" style={{ color: color || '#e5e7eb' }}>{value}</div>
      {subtitle && <div className="text-[9px] text-gray-500">{subtitle}</div>}
    </div>
  );
}

// ── Journal Entry Row ──
function JournalRow({ entry, onResolve, onReEval, onDelete }) {
  const [showActions, setShowActions] = useState(false);
  const [showReEval, setShowReEval] = useState(false);
  const [reEvalNote, setReEvalNote] = useState('');
  const [reEvalNewProb, setReEvalNewProb] = useState((entry.estProb * 100).toFixed(0));

  const handleResolve = (outcome) => {
    onResolve(entry.id, outcome);
    setShowActions(false);
  };

  const handleReEval = () => {
    onReEval(entry.id, {
      newEstProb: parseFloat(reEvalNewProb) / 100,
      note: reEvalNote,
      previousEstProb: entry.estProb,
    });
    setShowReEval(false);
    setReEvalNote('');
  };

  const date = new Date(entry.createdAt);
  const dateStr = `${date.getMonth() + 1}/${date.getDate()}`;

  return (
    <div className="border-b border-gray-800/50">
      <div
        className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-gray-800/30 cursor-pointer"
        onClick={() => setShowActions(!showActions)}
      >
        {/* Status dot */}
        <span className={`w-2 h-2 rounded-full shrink-0 ${
          entry.resolved
            ? entry.outcome === 'WIN' ? 'bg-emerald-400' : entry.outcome === 'LOSS' ? 'bg-red-400' : 'bg-gray-400'
            : 'bg-yellow-400'
        }`} />

        {/* Market + details */}
        <div className="flex-1 min-w-0">
          <div className="text-gray-300 truncate">{entry.marketQuestion || 'Unknown market'}</div>
          <div className="flex items-center gap-3 text-[10px] text-gray-500 mt-0.5">
            <span>{dateStr}</span>
            <span className={entry.side === 'YES' ? 'text-emerald-400' : 'text-red-400'}>
              {entry.side}
            </span>
            <span>Est YES: {(entry.estProb * 100).toFixed(0)}%</span>
            <span>Mkt: {(entry.marketPrice * 100).toFixed(0)}%</span>
            <span>+{entry.gapPp?.toFixed(1) || '?'}pp</span>
            <span>${entry.betSize?.toFixed(0) || '?'}</span>
            {entry.reEvaluations?.length > 0 && (
              <span className="text-gray-600">
                {entry.reEvaluations.length} re-eval{entry.reEvaluations.length > 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>

        {/* Outcome badge */}
        {entry.resolved && (
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
            entry.outcome === 'WIN' ? 'bg-emerald-900/50 text-emerald-300'
              : entry.outcome === 'LOSS' ? 'bg-red-900/50 text-red-300'
              : 'bg-gray-700 text-gray-300'
          }`}>
            {entry.outcome}
          </span>
        )}
      </div>

      {/* Action panel */}
      {showActions && !entry.resolved && (
        <div className="px-3 pb-2 flex flex-wrap gap-1">
          <button
            onClick={() => handleResolve('WIN')}
            className="px-2 py-1 rounded text-[10px] font-medium bg-emerald-900/40 text-emerald-300 hover:bg-emerald-900/60"
          >
            Resolved: Win
          </button>
          <button
            onClick={() => handleResolve('LOSS')}
            className="px-2 py-1 rounded text-[10px] font-medium bg-red-900/40 text-red-300 hover:bg-red-900/60"
          >
            Resolved: Loss
          </button>
          <button
            onClick={() => handleResolve('SCRATCH')}
            className="px-2 py-1 rounded text-[10px] font-medium bg-gray-700 text-gray-300 hover:bg-gray-600"
          >
            Scratch (exited)
          </button>
          <button
            onClick={() => setShowReEval(!showReEval)}
            className="px-2 py-1 rounded text-[10px] font-medium bg-gray-800 text-gray-400 hover:text-gray-200"
          >
            Re-evaluate
          </button>
          <button
            onClick={() => onDelete(entry.id)}
            className="px-2 py-1 rounded text-[10px] font-medium text-red-500 hover:text-red-400"
          >
            Delete
          </button>
        </div>
      )}

      {/* Re-evaluation form */}
      {showReEval && (
        <div className="px-3 pb-2 space-y-1.5">
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-gray-500 shrink-0">New prob:</label>
            <input
              type="number"
              min={1}
              max={99}
              value={reEvalNewProb}
              onChange={(e) => setReEvalNewProb(e.target.value)}
              className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-[10px] text-gray-100"
            />
            <span className="text-[10px] text-gray-500">%</span>
          </div>
          <input
            type="text"
            placeholder="What changed? (optional)"
            value={reEvalNote}
            onChange={(e) => setReEvalNote(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[10px] text-gray-100 placeholder-gray-600"
          />
          <button
            onClick={handleReEval}
            className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-[10px] text-gray-300"
          >
            Save Re-evaluation
          </button>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ── MAIN COMPONENT ──
// ══════════════════════════════════════════════════════════════

export default function CalibrationTracker() {
  const [entries, setEntries] = useState(getJournalEntries);
  const [showResolved, setShowResolved] = useState(false);

  const metrics = useMemo(() => computeCalibrationMetrics(entries), [entries]);

  // Resolve entries whose markets have settled (throttled; at most hourly per entry)
  useEffect(() => {
    const controller = new AbortController();
    const fetchRaw = async (id) => (await fetchMarketById(id, controller.signal))?.markets?.[0] ?? null;
    autoResolveJournal(fetchRaw, { signal: controller.signal }).then((n) => {
      if (!controller.signal.aborted && n > 0) setEntries(getJournalEntries());
    });
    return () => controller.abort();
  }, []);

  const handleResolve = useCallback((id, outcome) => {
    resolveJournalEntry(id, outcome);
    setEntries(getJournalEntries());
  }, []);

  const handleReEval = useCallback((id, data) => {
    addReEvaluation(id, data);
    setEntries(getJournalEntries());
  }, []);

  const handleDelete = useCallback((id) => {
    deleteJournalEntry(id);
    setEntries(getJournalEntries());
  }, []);

  const openEntries = entries.filter((e) => !e.resolved);
  const resolvedEntries = entries.filter((e) => e.resolved);
  const displayEntries = showResolved ? entries : openEntries;

  if (entries.length === 0) {
    return (
      <div className="rounded-lg border border-[#1f2937] p-6" style={{ background: '#111827' }}>
        <div className="text-xs font-semibold text-gray-400 uppercase mb-2">Decision Journal</div>
        <div className="text-sm text-gray-500 mb-2">
          No decisions recorded yet.
        </div>
        <div className="text-xs text-gray-600">
          Use the Position Sizer (Kelly) in the market detail panel to record decisions.
          Over time, this builds a calibration profile showing how well-calibrated your probability estimates are.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[#1f2937]" style={{ background: '#111827' }}>
      <div className="px-4 py-3 border-b border-gray-800">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold text-gray-400 uppercase">Decision Journal & Calibration</span>
          <span className="text-[10px] text-gray-500">
            {openEntries.length} open / {resolvedEntries.length} resolved
          </span>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {/* Calibration metrics */}
        <MetricsSummary metrics={metrics} />

        {/* Calibration chart */}
        {metrics.totalResolved >= 5 && (
          <CalibrationChart metrics={metrics} />
        )}

        {/* Journal entries */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <button
              onClick={() => setShowResolved(false)}
              className={`px-2 py-0.5 rounded text-[10px] transition-colors ${!showResolved ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}
            >
              Open ({openEntries.length})
            </button>
            <button
              onClick={() => setShowResolved(true)}
              className={`px-2 py-0.5 rounded text-[10px] transition-colors ${showResolved ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}
            >
              All ({entries.length})
            </button>
          </div>

          <div className="rounded border border-gray-800 max-h-[300px] overflow-y-auto">
            {displayEntries.length === 0 ? (
              <div className="text-center text-gray-500 py-4 text-xs">
                {showResolved ? 'No entries yet.' : 'No open positions. All decisions have been resolved.'}
              </div>
            ) : (
              displayEntries.map((entry) => (
                <JournalRow
                  key={entry.id}
                  entry={entry}
                  onResolve={handleResolve}
                  onReEval={handleReEval}
                  onDelete={handleDelete}
                />
              ))
            )}
          </div>
        </div>

        {/* Tips */}
        {metrics.totalResolved >= 10 && metrics.brierScore > 0.25 && (
          <div className="text-[10px] text-amber-400/80 leading-relaxed rounded border border-amber-900/30 p-2" style={{ background: 'rgba(245,158,11,0.04)' }}>
            Your Brier score ({metrics.brierScore.toFixed(3)}) suggests predictions could be better calibrated.
            Consider: Are you consistently over- or under-confident?
            The calibration chart shows where your predictions diverge from reality.
          </div>
        )}
      </div>
    </div>
  );
}
