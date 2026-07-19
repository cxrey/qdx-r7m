import { useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, CartesianGrid } from 'recharts';
import {
  projectDecayCurveDense,
  calculateInformationResidual,
} from '../ThetaEngine';
import AnalysisCard from './AnalysisCard';

const CYAN = '#00d4aa';
const AMBER = '#f59e0b';
const MUTED = '#6b7280';

function ZoneBadge({ zone }) {
  const config = {
    THETA_CRUSH_ZONE: { text: 'Theta Crush Zone', cls: 'bg-amber-900/50 text-amber-300 border-amber-700/50' },
    DEAD_MONEY: { text: 'Dead Money', cls: 'bg-gray-800 text-gray-500 border-gray-700' },
    THETA_ACCELERATION: { text: 'Theta Acceleration', cls: 'bg-cyan-900/40 text-cyan-300 border-cyan-700/50' },
    THETA_EXHAUSTED: { text: 'Theta Exhausted', cls: 'bg-gray-800 text-gray-600 border-gray-700' },
  };
  const c = config[zone] || { text: zone, cls: 'bg-gray-800 text-gray-500 border-gray-700' };
  return <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold border ${c.cls}`}>{c.text}</span>;
}

function StructureBadge({ type, confidence }) {
  const isStd = type === 'STANDARD';
  const isTouch = type === 'TOUCH_CUMULATIVE';
  let label = '↓ Yes Decays';
  let color = CYAN;
  let bg = 'rgba(0,212,170,0.08)';
  let border = '#00d4aa50';
  if (isTouch) {
    label = 'Touch — Chances Shrink';
    color = '#60a5fa';
    bg = 'rgba(96,165,250,0.08)';
    border = '#60a5fa50';
  } else if (!isStd) {
    label = '↑ Yes Builds';
    color = '#22c55e';
    bg = 'rgba(34,197,94,0.08)';
    border = '#22c55e50';
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border"
      style={{ borderColor: border, color, background: bg }}
    >
      {label}
      {confidence === 'LOW' && (
        <span title="Market structure auto-detected — verify manually" className="cursor-help opacity-70">?</span>
      )}
    </span>
  );
}

function formatTheta(v) {
  if (v == null) return '—';
  const cents = v * 100;
  const sign = cents >= 0 ? '+' : '';
  return `${sign}${cents.toFixed(2)}¢`;
}

function thetaColor(absTheta) {
  const c = Math.abs(absTheta) * 100;
  if (c > 0.5) return CYAN;
  if (c > 0.2) return AMBER;
  if (c > 0.05) return '#9ca3af';
  return '#4b5563';
}

function accelLabel(acc) {
  if (acc == null) return { text: '—', color: MUTED };
  if (acc > 0.05) return { text: `+${(acc * 100).toFixed(0)}% Accelerating`, color: AMBER };
  if (acc > -0.05) return { text: 'Steady', color: MUTED };
  return { text: `${(acc * 100).toFixed(0)}% Decelerating`, color: '#9ca3af' };
}

function ResidualBar({ residual }) {
  if (!residual) return null;

  const { thetaComponent, informationComponent } = residual;
  const thetaCents = thetaComponent * 100;
  const infoCents = informationComponent * 100;
  const maxAbs = Math.max(Math.abs(thetaCents), Math.abs(infoCents), 0.1);
  const scale = 40 / maxAbs; // max bar = 40% width

  return (
    <div className="mt-2">
      <div className="flex items-center gap-2 h-5">
        <span className="text-[10px] text-gray-500 w-12 shrink-0">Theta</span>
        <div className="flex-1 relative h-3 rounded-sm overflow-hidden" style={{ background: '#1a1f2e' }}>
          <div
            className="absolute top-0 h-full rounded-sm"
            style={{
              left: thetaCents >= 0 ? '50%' : `${50 - Math.abs(thetaCents) * scale}%`,
              width: `${Math.abs(thetaCents) * scale}%`,
              background: CYAN,
              opacity: 0.7,
            }}
          />
        </div>
        <span className="text-[10px] w-14 text-right" style={{ color: CYAN }}>{formatTheta(thetaComponent)}</span>
      </div>
      <div className="flex items-center gap-2 h-5">
        <span className="text-[10px] text-gray-500 w-12 shrink-0">Info</span>
        <div className="flex-1 relative h-3 rounded-sm overflow-hidden" style={{ background: '#1a1f2e' }}>
          <div
            className="absolute top-0 h-full rounded-sm"
            style={{
              left: infoCents >= 0 ? '50%' : `${50 - Math.abs(infoCents) * scale}%`,
              width: `${Math.abs(infoCents) * scale}%`,
              background: AMBER,
              opacity: 0.7,
            }}
          />
        </div>
        <span className="text-[10px] w-14 text-right" style={{ color: AMBER }}>{formatTheta(informationComponent)}</span>
      </div>
    </div>
  );
}

function ProjectionChart({ yesPrice, daysRemaining, marketStructure }) {
  const data = useMemo(() => {
    const maxDays = Math.min(60, Math.floor(daysRemaining));
    const curve = projectDecayCurveDense(yesPrice, daysRemaining, marketStructure, maxDays);
    return curve.map((pt) => ({
      day: pt.day,
      price: +(pt.projectedYes * 100).toFixed(2),
      upper: +(pt.upper * 100).toFixed(2),
      lower: +(pt.lower * 100).toFixed(2),
    }));
  }, [yesPrice, daysRemaining, marketStructure]);

  if (data.length < 2) return null;

  const lineColor = marketStructure === 'CUMULATIVE' ? '#22c55e' : CYAN;
  const currentCents = (yesPrice * 100).toFixed(1);

  return (
    <div style={{ height: 200 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
          <XAxis
            dataKey="day"
            tick={{ fill: '#6b7280', fontSize: 10 }}
            axisLine={{ stroke: '#374151' }}
            tickLine={false}
            label={{ value: 'Days from now', position: 'insideBottom', offset: -2, fill: '#6b7280', fontSize: 10 }}
          />
          <YAxis
            domain={['auto', 'auto']}
            tick={{ fill: '#6b7280', fontSize: 10 }}
            axisLine={{ stroke: '#374151' }}
            tickLine={false}
            tickFormatter={(v) => `${v}¢`}
            width={40}
          />
          <Tooltip
            contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 6, fontSize: 11 }}
            labelStyle={{ color: '#9ca3af' }}
            labelFormatter={(d) => `Day ${d}`}
            formatter={(val, name) => {
              if (name === 'price') return [`${val}¢`, 'Projected Yes'];
              if (name === 'upper') return [`${val}¢`, 'Upper'];
              if (name === 'lower') return [`${val}¢`, 'Lower'];
              return [val, name];
            }}
          />
          <Area type="monotone" dataKey="upper" stroke="none" fill={lineColor} fillOpacity={0.08} />
          <Area type="monotone" dataKey="lower" stroke="none" fill="#0a0e17" fillOpacity={1} />
          <Area
            type="monotone"
            dataKey="price"
            stroke={lineColor}
            strokeWidth={2}
            fill={lineColor}
            fillOpacity={0.12}
            dot={(props) => {
              const { cx, cy, payload } = props;
              if ([7, 14, 21, 28].includes(payload.day)) {
                return <circle key={payload.day} cx={cx} cy={cy} r={3} fill={lineColor} stroke="#fff" strokeWidth={1} />;
              }
              return null;
            }}
          />
          <ReferenceLine
            y={parseFloat(currentCents)}
            stroke="#6b7280"
            strokeDasharray="4 4"
            strokeWidth={1}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function ThetaCard({ theta, market, priceHistory }) {
  // Hooks must run unconditionally — guard on theta inside each memo,
  // then early-return below.

  // Information residual from price history
  const residual = useMemo(() => {
    if (!theta) return null;
    if (!priceHistory || !priceHistory.history || priceHistory.history.length < 2) return null;
    const hist = priceHistory.history;
    const now = hist[hist.length - 1];
    // Find price ~7 days ago
    const nowTs = now.t;
    const weekAgoTs = nowTs - 7 * 86400;
    let closest = hist[0];
    for (const pt of hist) {
      if (Math.abs(pt.t - weekAgoTs) < Math.abs(closest.t - weekAgoTs)) {
        closest = pt;
      }
    }
    const daysDiff = (nowTs - closest.t) / 86400;
    if (daysDiff < 1) return null;

    return calculateInformationResidual(now.p, closest.p, theta.dailyYesTheta, daysDiff);
  }, [priceHistory, theta]);

  // Projection summary
  const projSummary = useMemo(() => {
    if (!theta) return null;
    if (!market.daysLeft || market.daysLeft < 7) return null;
    const projDays = Math.min(14, Math.floor(market.daysLeft) - 1);
    if (projDays < 1) return null;

    const curve = projectDecayCurveDense(market.yesPrice, market.daysLeft, theta.structureType, projDays);
    if (curve.length < 2) return null;
    const last = curve[curve.length - 1];
    return {
      days: projDays,
      from: (market.yesPrice * 100).toFixed(1),
      to: (last.projectedYes * 100).toFixed(1),
    };
  }, [market.yesPrice, market.daysLeft, theta]);

  if (!theta) {
    const msg = market.daysLeft == null
      ? 'No resolution date — theta N/A'
      : market.daysLeft < 0
        ? 'Past resolution date'
        : 'Insufficient data for theta analysis';
    return (
      <AnalysisCard title="Time Decay Analysis" emptyWhen emptyMessage={msg} />
    );
  }

  const accel = accelLabel(theta.thetaAcceleration);

  return (
    <AnalysisCard
      title="Time Decay"
      badge={<StructureBadge type={theta.structureType} confidence={theta.structureConfidence} />}
      headerExtra={theta.zones.length > 0 ? (
        <div className="flex gap-1 flex-wrap">
          {theta.zones.map((z) => <ZoneBadge key={z} zone={z} />)}
        </div>
      ) : undefined}
    >
      {/* Theta metrics grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm mb-4">
        <div className="flex justify-between">
          <span className="text-[#9ca3af]">Daily Θ</span>
          <span style={{ color: thetaColor(theta.bestTheta) }} className="font-semibold">
            {formatTheta(theta.bestTheta)}/d
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#9ca3af]">Weekly Θ</span>
          <span className="text-gray-300">{formatTheta(theta.bestTheta * 7)}/w</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#9ca3af]">Hazard Rate</span>
          <span className="text-gray-300">{(theta.impliedHazardRate * 100).toFixed(2)}%/d</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#9ca3af]">Θ Accel</span>
          <span style={{ color: accel.color }}>{accel.text}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#9ca3af]">Days Left</span>
          <span className="text-gray-300">{market.daysLeft}d</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[#9ca3af]">Theta Side</span>
          <span
            className="font-semibold"
            style={{ color: theta.bestSide === 'YES' ? CYAN : '#ff4d6a' }}
          >
            Favors {theta.bestSide === 'YES' ? 'Yes' : 'No'}
          </span>
        </div>
        <div className="flex justify-between col-span-2">
          <span className="text-[#9ca3af]">Break-Even</span>
          {market.feeFree ? (
            <span className="text-emerald-400 font-semibold">Immediate (fee-free)</span>
          ) : market.thetaBreakEvenDays != null ? (
            <span style={{ color:
              market.thetaBreakEvenDays > market.daysLeft ? '#ef4444' :
              market.thetaBreakEvenDays > market.daysLeft * 0.5 ? AMBER : CYAN
            }} className="font-semibold">
              {market.thetaBreakEvenDays}d (hold {market.thetaBreakEvenDays}+ days)
            </span>
          ) : (
            <span className="text-gray-500">N/A</span>
          )}
        </div>
      </div>

      {/* Information Residual */}
      {residual ? (
        <div className="mb-4 p-2.5 rounded" style={{ background: '#0d1117' }}>
          <div className="text-[10px] font-semibold text-gray-500 uppercase mb-1">Last ~7 Days</div>
          <div className="text-xs text-gray-300">
            Price moved <span className="font-semibold">{formatTheta(residual.actualMove)}</span> ={' '}
            <span style={{ color: CYAN }}>{formatTheta(residual.thetaComponent)} theta</span> +{' '}
            <span style={{ color: AMBER }}>{formatTheta(residual.informationComponent)} info</span>
          </div>
          <ResidualBar residual={residual} />
          <div className="text-[10px] text-gray-500 mt-1.5">
            {residual.thetaDominant
              ? 'Time decay is driving this market — low information flow'
              : residual.momentum === 'AGAINST_THETA'
                ? 'Information is overriding theta — something is happening'
                : 'Mixed signals — theta and information roughly balanced'}
          </div>
        </div>
      ) : (
        <div className="mb-4 p-2 rounded text-[10px] text-gray-600" style={{ background: '#0d1117' }}>
          Insufficient price history for residual analysis
        </div>
      )}

      {/* Projection Chart */}
      {market.daysLeft > 1 && market.yesPrice != null && (
        <>
          <div className="text-[10px] font-semibold text-gray-500 uppercase mb-1">Projected Decay Curve</div>
          <ProjectionChart
            yesPrice={market.yesPrice}
            daysRemaining={market.daysLeft}
            marketStructure={theta.structureType}
          />
          {projSummary && (
            <div className="text-xs text-gray-500 mt-1 text-center">
              {theta.structureType === 'CUMULATIVE'
                ? `If condition holds: Yes projected to rise from ${projSummary.from}¢ → ${projSummary.to}¢ over next ${projSummary.days} days`
                : theta.structureType === 'TOUCH_CUMULATIVE'
                  ? `Touch market: Yes projected to decay from ${projSummary.from}¢ → ${projSummary.to}¢ as time window shrinks (fewer chances left)`
                  : `If nothing changes: Yes projected to drop from ${projSummary.from}¢ → ${projSummary.to}¢ over next ${projSummary.days} days (theta alone)`}
            </div>
          )}
        </>
      )}
    </AnalysisCard>
  );
}
