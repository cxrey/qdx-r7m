/**
 * Lightweight performance monitoring for development.
 * Wraps performance.mark/measure to track key operations.
 * Disabled in production builds (tree-shaken via import.meta.env.DEV).
 */

const IS_DEV = typeof import.meta !== 'undefined' && import.meta.env?.DEV;

// Rolling averages for repeated operations
const _averages = new Map();

/**
 * Start a named performance mark.
 */
export function perfStart(label) {
  if (!IS_DEV) return;
  try {
    performance.mark(`${label}-start`);
  } catch { /* ignore */ }
}

/**
 * End a named performance mark and log if slow.
 * @param {string} label - Must match a prior perfStart call
 * @param {number} [warnMs=16] - Log warning if duration exceeds this (ms)
 */
export function perfEnd(label, warnMs = 16) {
  if (!IS_DEV) return;
  try {
    performance.mark(`${label}-end`);
    const measure = performance.measure(label, `${label}-start`, `${label}-end`);
    const duration = measure.duration;

    // Update rolling average (last 20 samples)
    let avg = _averages.get(label);
    if (!avg) {
      avg = { samples: [], sum: 0 };
      _averages.set(label, avg);
    }
    avg.samples.push(duration);
    avg.sum += duration;
    if (avg.samples.length > 20) {
      avg.sum -= avg.samples.shift();
    }

    if (duration > warnMs) {
      const avgMs = (avg.sum / avg.samples.length).toFixed(1);
      console.warn(`[Perf] ${label}: ${duration.toFixed(1)}ms (avg: ${avgMs}ms)`);
    }

    // Cleanup marks
    performance.clearMarks(`${label}-start`);
    performance.clearMarks(`${label}-end`);
    performance.clearMeasures(label);
  } catch { /* ignore */ }
}

/**
 * Wrap an operation with performance monitoring.
 * @param {string} label
 * @param {Function} fn - Synchronous function to measure
 * @param {number} [warnMs=16]
 * @returns The return value of fn
 */
export function perfWrap(label, fn, warnMs = 16) {
  if (!IS_DEV) return fn();
  perfStart(label);
  const result = fn();
  perfEnd(label, warnMs);
  return result;
}

/**
 * Get rolling average for a label (dev only).
 */
export function perfAvg(label) {
  if (!IS_DEV) return null;
  const avg = _averages.get(label);
  if (!avg || avg.samples.length === 0) return null;
  return avg.sum / avg.samples.length;
}

/**
 * Dump all tracked averages to console.
 */
export function perfDump() {
  if (!IS_DEV) return;
  console.group('[Perf] Rolling averages');
  for (const [label, avg] of _averages) {
    if (avg.samples.length > 0) {
      const avgMs = (avg.sum / avg.samples.length).toFixed(1);
      const maxMs = Math.max(...avg.samples).toFixed(1);
      console.log(`  ${label}: avg=${avgMs}ms, max=${maxMs}ms, samples=${avg.samples.length}`);
    }
  }
  console.groupEnd();
}
