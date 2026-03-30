/**
 * Centralized formatting utilities.
 * All display-facing number/price/volume formatting lives here.
 */

export function formatVolume(v) {
  if (v == null || isNaN(v)) return '\u2014';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

export function formatPrice(p) {
  if (p == null || isNaN(p)) return '\u2014';
  return `${(p * 100).toFixed(1)}\u00A2`;
}

export function formatDollars(val) {
  if (val == null || isNaN(val)) return '\u2014';
  if (val >= 1000) return `$${(val / 1000).toFixed(1)}K`;
  return `$${val.toFixed(0)}`;
}

export function formatCents(val) {
  if (val == null || isNaN(val)) return '\u2014';
  return `${(val * 100).toFixed(2)}\u00A2`;
}

export function formatPct(val) {
  if (val == null || isNaN(val)) return '\u2014';
  return `${(val * 100).toFixed(2)}%`;
}

export function formatTimeAgo(timestamp) {
  if (timestamp == null || isNaN(timestamp)) return '\u2014';
  const now = Date.now() / 1000;
  const diff = now - timestamp;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
