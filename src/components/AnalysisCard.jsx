/**
 * AnalysisCard — shared shell for all analysis card components.
 *
 * Usage:
 *   <AnalysisCard title="FLB Analysis" badge={<span>...</span>} emptyWhen={!data} emptyMessage="No data">
 *     {card body}
 *   </AnalysisCard>
 */
export default function AnalysisCard({
  title,
  badge,
  children,
  emptyWhen,
  emptyMessage = 'Insufficient data.',
  className = '',
  headerExtra,
}) {
  return (
    <div
      className={`rounded-lg border border-[#1f2937] p-4 ${className}`}
      style={{ background: '#111827' }}
    >
      {/* Header row */}
      {(title || badge || headerExtra) && (
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            {title && (
              <span className="text-xs font-semibold text-gray-400 uppercase">{title}</span>
            )}
            {badge}
          </div>
          {headerExtra}
        </div>
      )}

      {/* Body — either empty message or children */}
      {emptyWhen ? (
        <div className="text-sm text-gray-600">{emptyMessage}</div>
      ) : (
        children
      )}
    </div>
  );
}
