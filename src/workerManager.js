/**
 * Shared analysis Worker singleton.
 * Both useMarkets and RefreshManager import from here
 * so only one Worker thread exists.
 *
 * Uses requestId to prevent concurrent calls from cross-contaminating
 * — each caller only resolves when its own requestId comes back.
 */

let worker = null;
let nextRequestId = 1;

export function getAnalysisWorker() {
  if (!worker) {
    worker = new Worker(
      new URL('./analysisWorker.js', import.meta.url),
      { type: 'module' }
    );
  }
  return worker;
}

export function terminateAnalysisWorker() {
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

const WORKER_TIMEOUT = 30_000; // 30s timeout for Worker processing

/**
 * Process all markets in the Worker with timeout and fallback.
 *
 * Falls back to synchronous main-thread processing if the Worker
 * fails or hangs. The fallback WILL freeze the UI (same as before
 * this migration) — it's a last-resort graceful degradation, not
 * a performant alternative.
 */
export function processAllInWorker(rawMarkets) {
  const requestId = nextRequestId++;

  return new Promise((resolve) => {
    let settled = false;
    let w = null;

    const settle = (results) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (w) {
        try { w.removeEventListener('message', handler); } catch (e) { console.warn('[Worker] Failed to remove message listener:', e); }
        try { w.removeEventListener('error', errorHandler); } catch (e) { console.warn('[Worker] Failed to remove error listener:', e); }
      }
      resolve(results);
    };

    const fallbackToMainThread = (reason) => {
      console.warn(`[Worker] ${reason}, falling back to main thread (UI will freeze briefly)`);
      import('./processMarket').then(({ processMarket }) => {
        settle(rawMarkets.map(m => processMarket(m)));
      });
    };

    // Timeout: if Worker hangs for 30s, fall back to main thread
    const timeout = setTimeout(() => {
      if (!settled) fallbackToMainThread('Timed out after 30s');
    }, WORKER_TIMEOUT);

    try {
      w = getAnalysisWorker();
    } catch (err) {
      clearTimeout(timeout);
      fallbackToMainThread(`Failed to instantiate: ${err.message}`);
      return;
    }

    const handler = (e) => {
      if (e.data.requestId !== requestId) return;
      if (e.data.type === 'COMPLETE') {
        settle(e.data.markets);
      } else if (e.data.type === 'ERROR') {
        fallbackToMainThread(`Worker error: ${e.data.message}`);
      }
    };

    const errorHandler = (err) => {
      // Worker-level errors are global (not per-request), so this may
      // fire from a concurrent request's failure. We fall back anyway
      // since the Worker is likely in a bad state.
      fallbackToMainThread(`Error: ${err.message || err}`);
    };

    w.addEventListener('message', handler);
    w.addEventListener('error', errorHandler);
    w.postMessage({ type: 'PROCESS_ALL', markets: rawMarkets, requestId });
  });
}
