import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Shared benchmark directory — avoids repeating fileURLToPath/dirname in every bench file
const benchDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Resolve a results filename to its absolute path in the results/ directory. */
export function resultsPath(filename) {
  return join(benchDir, 'results', filename);
}

export function benchSync(name, fn, { iterations = 100, warmup = 10 } = {}) {
  for (let i = 0; i < warmup; i++) fn();
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  return report(name, times, iterations);
}

export async function benchAsync(name, fn, { iterations = 100, warmup = 10 } = {}) {
  for (let i = 0; i < warmup; i++) await fn();
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  return report(name, times, iterations);
}

// For benchmarks that need per-iteration metadata (e.g., benchmark 6).
// Runs warmup and measurement separately so callers can collect side-channel
// data only during measured iterations.
export async function benchAsyncManual(name, fn, { iterations = 20, warmup = 3 } = {}) {
  for (let i = 0; i < warmup; i++) await fn({ warmup: true });
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn({ warmup: false });
    times.push(performance.now() - start);
  }
  return report(name, times, iterations);
}

function report(name, times, iterations) {
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const result = { name, median, p95, mean, iterations };
  console.log(`${name}: median=${median.toFixed(2)}ms  p95=${p95.toFixed(2)}ms  mean=${mean.toFixed(2)}ms  n=${iterations}`);
  return result;
}

export function writeResults(results, filepath) {
  mkdirSync(dirname(filepath), { recursive: true });
  const output = results.map(({ name, median, p95, mean, iterations }) => ({
    name, median, p95, mean, iterations, timestamp: new Date().toISOString()
  }));
  writeFileSync(filepath, JSON.stringify(output, null, 2));
}
