/**
 * Shared fetch utilities.
 * Extracted from api.js so all engines can use the same timeout helper.
 */

/**
 * Returns an AbortSignal that fires after `ms` milliseconds,
 * OR when the caller's own signal aborts — whichever comes first.
 */
export function withTimeout(callerSignal, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  // If the caller provided a signal, chain it
  if (callerSignal) {
    if (callerSignal.aborted) {
      clearTimeout(timer);
      controller.abort();
    } else {
      callerSignal.addEventListener('abort', () => {
        clearTimeout(timer);
        controller.abort();
      }, { once: true });
    }
  }

  // Clean up timer when the signal fires (prevents timer leak)
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });

  return controller.signal;
}

// Common timeout constants for different API types
export const TIMEOUT_DATA_API = 8_000;    // 8s for Data API calls (positions, trades, etc.)
export const TIMEOUT_GAMMA_PAGE = 10_000; // 10s per Gamma API page fetch
