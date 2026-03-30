/**
 * PortfolioDashboard — Main portfolio view with wallet connection,
 * positions table, diversification score, correlation analysis, and alerts.
 */
import { useState, useCallback } from 'react';
import CorrelationMatrix from './CorrelationMatrix';
import ClusterCard from './ClusterCard';
import CalibrationTracker from './CalibrationTracker';
import { formatPrice } from '../formatters';

const CYAN = '#00d4aa';
const PINK = '#ff4d6a';

const VALID_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

function formatValue(v) {
  if (v == null || isNaN(v)) return '$0';
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

const SORT_OPTIONS = [
  { value: 'value', label: 'Value' },
  { value: 'pnl', label: 'P&L' },
  { value: 'pnlPct', label: 'P&L %' },
  { value: 'daysLeft', label: 'Days Left' },
  { value: 'category', label: 'Category' },
];

// ── Wallet Connection Panel ──
function WalletConnect({ walletAddress, connectWallet, disconnectWallet, error }) {
  const [inputAddress, setInputAddress] = useState('');
  const [inputError, setInputError] = useState('');

  const handleConnect = useCallback(() => {
    const addr = inputAddress.trim();
    if (!VALID_ADDRESS.test(addr)) {
      setInputError('Invalid Ethereum/Polygon address. Must be 0x followed by 40 hex characters.');
      return;
    }
    setInputError('');
    connectWallet(addr);
    setInputAddress('');
  }, [inputAddress, connectWallet]);

  if (walletAddress) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className="text-gray-400">Connected:</span>
        <span className="font-mono text-xs text-gray-300">{walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}</span>
        <button onClick={disconnectWallet} className="text-xs text-red-400 hover:text-red-300 underline">
          Disconnect
        </button>
        <button onClick={() => { disconnectWallet(); }} className="text-xs text-gray-500 hover:text-gray-300 underline">
          Change wallet
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[#1f2937] p-6" style={{ background: '#111827' }}>
      <div className="text-sm text-gray-300 mb-3">
        Enter your Polymarket wallet address to analyze your portfolio
      </div>
      <div className="flex gap-2 mb-2">
        <input
          type="text"
          placeholder="0x..."
          value={inputAddress}
          onChange={(e) => { setInputAddress(e.target.value); setInputError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') handleConnect(); }}
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-emerald-500 font-mono"
        />
        <button
          onClick={handleConnect}
          className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-sm font-medium text-white transition-colors"
        >
          Load Portfolio
        </button>
      </div>
      {inputError && <div className="text-xs text-red-400 mb-2">{inputError}</div>}
      {error && <div className="text-xs text-amber-400 mb-2">{error}</div>}
      <div className="text-xs text-gray-500 mb-3">
        Your wallet address is stored locally in your browser only. We read on-chain data — no private keys or signing required.
      </div>
      <div className="text-xs text-gray-600">
        Or add positions manually from the scanner using the + button on market rows.
      </div>
    </div>
  );
}

// ── Diversification Score Gauge ──
function DiversificationGauge({ concentration }) {
  const score = concentration.diversificationScore;
  let gaugeColor = '#ef4444';
  if (score >= 80) gaugeColor = '#00d4aa';
  else if (score >= 50) gaugeColor = '#eab308';
  else if (score >= 30) gaugeColor = '#f97316';

  const yesW = concentration.yesExposure + concentration.noExposure > 0
    ? (concentration.yesExposure / (concentration.yesExposure + concentration.noExposure)) * 100
    : 50;

  return (
    <div className="rounded-lg border border-[#1f2937] p-4" style={{ background: '#111827' }}>
      <div className="flex items-center gap-4 mb-3">
        <div className="text-center">
          <div className="text-3xl font-bold" style={{ color: gaugeColor }}>{score}</div>
          <div className="text-xs text-gray-500">/ 100</div>
        </div>
        <div>
          <div className="text-sm font-semibold text-gray-200">{concentration.diversificationLabel}</div>
          <div className="text-xs text-gray-400">
            {concentration.effectiveBets.toFixed(1)} effective independent bets
          </div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-2 rounded-full bg-gray-800 mb-3 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${score}%`, background: gaugeColor }} />
      </div>

      {/* Side balance bar */}
      <div className="mb-2">
        <div className="text-xs text-gray-500 mb-1">Side Balance</div>
        <div className="flex h-3 rounded-full overflow-hidden bg-gray-800">
          <div style={{ width: `${yesW}%`, background: CYAN }} title={`Yes: ${formatValue(concentration.yesExposure)}`} />
          <div style={{ width: `${100 - yesW}%`, background: PINK }} title={`No: ${formatValue(concentration.noExposure)}`} />
        </div>
        <div className="flex justify-between text-[10px] text-gray-500 mt-0.5">
          <span>Yes: {formatValue(concentration.yesExposure)}</span>
          <span>No: {formatValue(concentration.noExposure)}</span>
        </div>
      </div>

      {concentration.largestClusterName && (
        <div className="text-xs text-gray-500 mt-2">
          Largest cluster: <span className="text-gray-300">{concentration.largestClusterName}</span>
          {' '}({(concentration.largestClusterWeight * 100).toFixed(0)}% of portfolio)
        </div>
      )}
    </div>
  );
}

// ── Summary Bar ──
function SummaryBar({ summary }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
      <StatCard label="Total Positions" value={summary.totalPositions} />
      <StatCard label="Total Value" value={formatValue(summary.totalValue)} />
      <StatCard
        label="Total P&L"
        value={(summary.totalPnl >= 0 ? '+' : '') + formatValue(summary.totalPnl)}
        color={summary.totalPnl >= 0 ? '#00d4aa' : '#ff4d6a'}
      />
      <StatCard label="Win Rate" value={`${summary.winRate.toFixed(0)}%`} />
      <StatCard
        label="Largest Position"
        value={formatValue(summary.largestValue)}
        subtitle={summary.largestPosition?.market?.question?.slice(0, 30)}
        warning={summary.isConcentrated}
      />
    </div>
  );
}

function StatCard({ label, value, color, subtitle, warning }) {
  return (
    <div className={`rounded-lg border p-3 ${warning ? 'border-amber-700/50' : 'border-[#1f2937]'}`} style={{ background: '#111827' }}>
      <div className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</div>
      <div className="text-lg font-bold mt-0.5" style={{ color: color || '#e5e7eb' }}>{value}</div>
      {subtitle && <div className="text-[10px] text-gray-500 truncate">{subtitle}</div>}
      {warning && <div className="text-[10px] text-amber-400 mt-0.5">{'>'}25% concentration</div>}
    </div>
  );
}

// ── Alerts Panel ──
function AlertsPanel({ alerts, onDismiss }) {
  if (alerts.length === 0) return null;

  const severityBg = {
    critical: 'rgba(239, 68, 68, 0.08)',
    warning: 'rgba(245, 158, 11, 0.08)',
    info: 'rgba(0, 212, 170, 0.08)',
  };
  const severityBorder = {
    critical: '#7f1d1d',
    warning: '#78350f',
    info: '#1f2937',
  };
  const severityText = {
    critical: 'text-red-300',
    warning: 'text-amber-300',
    info: 'text-gray-300',
  };

  return (
    <div className="space-y-2 mb-4">
      {alerts.map((alert, i) => (
        <div
          key={i}
          className="rounded-lg border px-4 py-2.5 flex items-start gap-2"
          style={{ background: severityBg[alert.severity], borderColor: severityBorder[alert.severity] }}
        >
          <span className="text-sm shrink-0 mt-0.5">{alert.icon}</span>
          <span className={`text-xs flex-1 ${severityText[alert.severity]}`}>{alert.text}</span>
          <button
            onClick={() => onDismiss(alert.text)}
            className="text-gray-600 hover:text-gray-400 text-xs shrink-0"
            title="Dismiss"
          >
            X
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Positions Table ──
function PositionsTable({ positions, signals, sortBy, onSortChange, onExpandMarket }) {
  const sorted = [...positions].sort((a, b) => {
    if (sortBy === 'value') return (b.currentValue || 0) - (a.currentValue || 0);
    if (sortBy === 'pnl') return (b.unrealizedPnl || 0) - (a.unrealizedPnl || 0);
    if (sortBy === 'pnlPct') {
      const pctA = a.entryPrice ? (((a.currentPrice || 0) - a.entryPrice) / a.entryPrice) * 100 : 0;
      const pctB = b.entryPrice ? (((b.currentPrice || 0) - b.entryPrice) / b.entryPrice) * 100 : 0;
      return pctB - pctA;
    }
    if (sortBy === 'daysLeft') return (a.market?.daysLeft ?? 999) - (b.market?.daysLeft ?? 999);
    if (sortBy === 'category') return (a.market?.category || '').localeCompare(b.market?.category || '');
    return 0;
  });

  return (
    <div className="rounded-lg border border-[#1f2937] overflow-hidden" style={{ background: '#111827' }}>
      {/* Header */}
      <div className="grid grid-cols-[1fr_50px_60px_60px_60px_70px_60px_70px_70px_60px] gap-1 px-3 py-2 bg-gray-900 border-b border-gray-700 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
        <div>Market</div>
        <div>Side</div>
        <div>Shares</div>
        <div>Entry</div>
        <div>Current</div>
        <div>P&L</div>
        <div>P&L %</div>
        <div>Value</div>
        <div>Category</div>
        <div>Days</div>
      </div>

      {/* Sort controls */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-900/50 border-b border-gray-800 text-xs">
        <span className="text-gray-500">Sort:</span>
        {SORT_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onSortChange(opt.value)}
            className={`px-2 py-0.5 rounded text-xs transition-colors ${sortBy === opt.value ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Rows */}
      <div className="max-h-[400px] overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="text-center text-gray-500 py-8 text-sm">No positions to display.</div>
        ) : sorted.map((pos, i) => {
          const pnlPct = pos.entryPrice
            ? (((pos.currentPrice || 0) - pos.entryPrice) / pos.entryPrice) * 100
            : 0;
          const posSignals = signals?.get(i) || [];

          return (
            <div key={i} className="border-b border-gray-800/50">
              <div
                className="grid grid-cols-[1fr_50px_60px_60px_60px_70px_60px_70px_70px_60px] gap-1 px-3 py-2 items-center text-xs hover:bg-gray-800/30 cursor-pointer transition-colors"
                onClick={() => onExpandMarket && onExpandMarket(pos.market)}
              >
                <div className="truncate text-gray-200 pr-1">
                  {pos.market?.question || 'Unknown'}
                  {pos.source === 'manual' && (
                    <span className="ml-1 text-[9px] text-gray-600 bg-gray-800 px-1 rounded">Manual</span>
                  )}
                </div>
                <div>
                  <span
                    className="text-xs font-semibold"
                    style={{ color: pos.side === 'YES' ? CYAN : PINK }}
                  >
                    {pos.side || '\u2014'}
                  </span>
                </div>
                <div className="text-gray-400">{pos.size?.toFixed(1) || '\u2014'}</div>
                <div className="text-gray-400">{pos.entryPrice != null ? formatPrice(pos.entryPrice) : '\u2014'}</div>
                <div className="text-gray-300">{formatPrice(pos.currentPrice)}</div>
                <div className={pos.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                  {pos.unrealizedPnl >= 0 ? '+' : ''}{formatValue(pos.unrealizedPnl || 0)}
                </div>
                <div className={pnlPct >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                  {pos.entryPrice ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%` : '\u2014'}
                </div>
                <div className="text-gray-300">{formatValue(pos.currentValue || 0)}</div>
                <div className="text-gray-500 truncate text-[10px]">{pos.market?.category || '\u2014'}</div>
                <div className="text-gray-400">{pos.market?.daysLeft ?? '\u2014'}</div>
              </div>

              {/* Action signals */}
              {posSignals.length > 0 && (
                <div className="px-3 pb-1.5 space-y-0.5">
                  {posSignals.map((sig, j) => (
                    <div key={j} className="text-[10px]" style={{ color: sig.color }}>
                      {sig.text}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main Dashboard ──
export default function PortfolioDashboard({ portfolio }) {
  const [sortBy, setSortBy] = useState('value');

  const {
    walletAddress, connectWallet, disconnectWallet,
    loading, error, lastRefresh, refreshPositions,
    allPositions, analysis, activeAlerts, handleDismissAlert,
    summary, hasPortfolio,
  } = portfolio;

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {/* Wallet connection / status */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <WalletConnect
          walletAddress={walletAddress}
          connectWallet={connectWallet}
          disconnectWallet={disconnectWallet}
          error={error}
        />
        {walletAddress && (
          <div className="flex items-center gap-3">
            {lastRefresh && (
              <span className="text-xs text-gray-500">
                Last refresh: {lastRefresh.toLocaleTimeString()}
              </span>
            )}
            <button
              onClick={refreshPositions}
              disabled={loading}
              className="px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-xs text-gray-300 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        )}
      </div>

      {/* Loading state */}
      {loading && !hasPortfolio && (
        <div className="text-center py-8 text-gray-500 text-sm">
          Loading portfolio positions...
        </div>
      )}

      {/* Error state when no wallet */}
      {error && !hasPortfolio && walletAddress && (
        <div className="rounded-lg border border-amber-700/50 p-4 text-xs text-amber-300" style={{ background: 'rgba(245, 158, 11, 0.08)' }}>
          {error}
          <div className="mt-2 text-gray-400">
            You can still add positions manually using the + button on market rows in the Scanner tab.
          </div>
        </div>
      )}

      {/* Portfolio content */}
      {hasPortfolio && (
        <>
          {/* Alerts */}
          <AlertsPanel alerts={activeAlerts} onDismiss={handleDismissAlert} />

          {/* Summary bar + Diversification gauge */}
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
            <div>
              <SummaryBar summary={summary} />
            </div>
            <DiversificationGauge concentration={analysis.concentration} />
          </div>

          {/* Positions table */}
          <PositionsTable
            positions={allPositions}
            signals={analysis.positionSignals}
            sortBy={sortBy}
            onSortChange={setSortBy}
          />

          {/* Correlation Matrix + Clusters */}
          <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
            <CorrelationMatrix
              positions={allPositions}
              correlationMatrix={analysis.correlationMatrix}
              clusters={analysis.clusters}
            />
            <div className="space-y-3">
              <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Correlation Clusters ({analysis.clusters.length})
              </div>
              {analysis.clusters.map((cluster) => (
                <ClusterCard key={cluster.id} cluster={cluster} />
              ))}
            </div>
          </div>

          {/* Decision Journal & Calibration */}
          <CalibrationTracker />
        </>
      )}

      {/* Decision Journal (always visible, independent of wallet) */}
      {!hasPortfolio && (
        <CalibrationTracker />
      )}

      {/* Empty state */}
      {!hasPortfolio && !loading && !error && (
        <div className="text-center py-12 text-gray-500 text-sm">
          {walletAddress
            ? 'No positions found for this wallet. Try adding positions manually from the Scanner tab.'
            : 'Connect a wallet or add positions manually to see portfolio analysis.'
          }
        </div>
      )}
    </div>
  );
}
