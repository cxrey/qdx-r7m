/**
 * Shared analysis Worker pool.
 * Both useMarkets and RefreshManager import from here, so one pool serves
 * the initial load and Tier 3 refreshes.
 *
 * processMarket costs ~0.5ms per market, so a single Worker needs ~40s for a
 * large catalog — past the per-request timeout, which then redid ALL the work
 * on the main thread. The pool splits the batch into contiguous chunks, one
 * per Worker, and reassembles the results in their original order.
 *
 * Uses requestId to prevent concurrent calls from cross-contaminating —
 * each chunk only resolves when its own requestId comes back.
 */

// Leave a core for the UI thread; more than 8 Workers stops paying off
// (structured-clone transfer and memory grow, per-chunk work shrinks).
export const POOL_SIZE = Math.max(1, Math.min(8, (globalThis.navigator?.hardwareConcurrency || 2) - 1));

// Below this many markets per Worker, spinning up more Workers isn't worth it
const MIN_CHUNK_SIZE = 2_000;

const WORKER_TIMEOUT = 30_000; // 30s timeout per chunk

const pool = []; // pool[slot] → Worker (created lazily)
let nextRequestId = 1;

function getWorker(slot) {
  if (!pool[slot]) {
    pool[slot] = new Worker(
      new URL('./analysisWorker.js', import.meta.url),
      { type: 'module' }
    );
  }
  return pool[slot];
}

function terminateWorker(slot) {
  if (pool[slot]) {
    pool[slot].terminate();
    pool[slot] = null;
  }
}

/** Terminate every Worker in the pool (e.g. on unmount). */
export function terminateAnalysisWorker() {
  for (let slot = 0; slot < pool.length; slot++) terminateWorker(slot);
}

/** Split `items` into `count` contiguous chunks of near-equal size. */
export function splitIntoChunks(items, count) {
  const size = Math.ceil(items.length / count);
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** How many Workers to use for a batch of `n` markets. */
export function workerCountFor(n, poolSize = POOL_SIZE) {
  return Math.max(1, Math.min(poolSize, Math.ceil(n / MIN_CHUNK_SIZE)));
}

/**
 * Process one chunk in the Worker at `slot`, with timeout and fallback.
 *
 * Falls back to synchronous main-thread processing of THIS chunk if its
 * Worker fails or hangs. The fallback will freeze the UI briefly — it's a
 * last-resort graceful degradation, not a performant alternative.
 */
function processChunk(chunk, slot) {
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
      if (settled) return;
      console.warn(`[Worker ${slot}] ${reason}, falling back to main thread for ${chunk.length} markets (UI will freeze briefly)`);
      import('./processMarket').then(({ processMarket }) => {
        settle(chunk.map((m) => processMarket(m)));
      });
    };

    // Timeout: terminate a hung Worker so the next call gets a fresh one —
    // otherwise every later request to this slot would time out too.
    const timeout = setTimeout(() => {
      if (!settled) {
        terminateWorker(slot);
        fallbackToMainThread('Timed out after 30s');
      }
    }, WORKER_TIMEOUT);

    try {
      w = getWorker(slot);
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
      // Worker-level errors aren't per-request; the Worker is likely in a bad
      // state, so replace it and fall back for this chunk.
      terminateWorker(slot);
      fallbackToMainThread(`Error: ${err.message || err}`);
    };

    w.addEventListener('message', handler);
    w.addEventListener('error', errorHandler);
    w.postMessage({ type: 'PROCESS_ALL', markets: chunk, requestId });
  });
}

/**
 * Process all markets across the Worker pool. Results keep input order.
 * Never rejects: a failing chunk falls back to the main thread.
 */
export async function processAllInWorker(rawMarkets) {
  if (rawMarkets.length === 0) return [];
  const chunks = splitIntoChunks(rawMarkets, workerCountFor(rawMarkets.length));
  const results = await Promise.all(chunks.map((chunk, slot) => processChunk(chunk, slot)));
  return results.flat();
}
