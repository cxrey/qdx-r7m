/**
 * PortfolioImpact — Shows how adding a market would affect portfolio.
 * Displayed in the scanner's expanded market detail panel.
 */

const FIT_STYLES = {
  GOOD_FIT: { border: '#00d4aa', bg: 'rgba(0, 212, 170, 0.06)', label: 'Good Fit' },
  NEUTRAL: { border: '#f59e0b', bg: 'rgba(245, 158, 11, 0.06)', label: 'Neutral' },
  INCREASES_CONCENTRATION: { border: '#ef4444', bg: 'rgba(239, 68, 68, 0.06)', label: 'Increases Concentration' },
  OPPOSING: { border: '#818cf8', bg: 'rgba(129, 140, 248, 0.06)', label: 'Opposing / Hedge' },
};

export default function PortfolioImpact({ screening }) {
  if (!screening) return null;

  const style = FIT_STYLES[screening.fit] || FIT_STYLES.NEUTRAL;
  const divScoreDelta = screening.newDivScore - screening.currentDivScore;
  const divArrow = divScoreDelta >= 0 ? '+' : '-';

  return (
    <div
      className="rounded-lg border p-4"
      style={{ background: style.bg, borderColor: style.border }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-semibold text-gray-300 uppercase">Portfolio Impact</span>
      </div>

      <div className="space-y-1.5 text-xs">
        {screening.maxCorrelation > 0 && (
          <div className="text-gray-400">
            Correlation with existing positions:{' '}
            <span className="text-gray-200 font-medium">{screening.maxCorrelation.toFixed(2)}</span>
            {screening.maxCorrelationMarket && (
              <span className="text-gray-500"> with "{screening.maxCorrelationMarket.question?.slice(0, 40)}"</span>
            )}
          </div>
        )}

        {screening.clusterName && (
          <div className="text-gray-400">
            Would join cluster:{' '}
            <span className="text-gray-200">{screening.clusterName}</span>
          </div>
        )}

        <div className="text-gray-400">
          Impact:{' '}
          <span style={{ color: style.border }} className="font-semibold">
            {style.label}
          </span>
        </div>

        <div className="text-gray-400">
          Diversification score:{' '}
          <span className="text-gray-200">
            {screening.currentDivScore} &rarr; {screening.newDivScore}
          </span>
          <span className={divScoreDelta >= 0 ? 'text-emerald-400' : 'text-red-400'}>
            {' '}({divArrow}{Math.abs(divScoreDelta)})
          </span>
        </div>

        <div className="text-gray-300 mt-1">
          {screening.text}
        </div>
      </div>
    </div>
  );
}
