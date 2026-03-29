import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, isAbsolute } from 'path';

const resultsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'results');
const baselinePath = join(resultsDir, 'baseline.json');

const runArg = process.argv[2];
if (!runArg) { console.error('Usage: tsx helpers/compare.js <run-file.json>'); process.exit(1); }

// Resolve run file: absolute paths used as-is, relative resolved from resultsDir
const runPath = isAbsolute(runArg) ? runArg : join(resultsDir, runArg);

const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
const current = JSON.parse(readFileSync(runPath, 'utf-8'));
const baselineMap = Object.fromEntries(baseline.map(b => [b.name, b]));
const currentNames = new Set(current.map(e => e.name));

let regressions = 0;

for (const entry of current) {
  const base = baselineMap[entry.name];
  if (!base) { console.log(`NEW: ${entry.name} — ${entry.median.toFixed(2)}`); continue; }
  if (base.median === 0) {
    if (entry.median > 1) {
      console.warn(`WARN: ${entry.name} — baseline was 0 (too fast to measure), now ${entry.median.toFixed(2)}ms — may indicate regression`);
    } else {
      console.log(`SKIP: ${entry.name} — baseline was 0 (too fast to measure), current=${entry.median.toFixed(2)}`);
    }
    continue;
  }
  const ratio = entry.median / base.median;
  const status = ratio > 2 ? 'REGRESSION' : ratio > 1.2 ? 'SLOWER' : ratio < 0.8 ? 'FASTER' : 'OK';
  if (status === 'REGRESSION') regressions++;
  console.log(`${status}: ${entry.name} — ${base.median.toFixed(2)} → ${entry.median.toFixed(2)} (${ratio.toFixed(2)}x)`);
}

// Detect benchmarks that existed in baseline but are missing from the current run
let missing = 0;
for (const base of baseline) {
  if (!currentNames.has(base.name)) {
    missing++;
    console.warn(`MISSING: ${base.name} — was ${base.median.toFixed(2)} in baseline, absent from current run`);
  }
}

if (regressions > 0 || missing > 0) {
  const parts = [];
  if (regressions > 0) parts.push(`${regressions} REGRESSION(s) (>2x baseline)`);
  if (missing > 0) parts.push(`${missing} MISSING benchmark(s)`);
  console.error(`\n${parts.join(', ')}. Exiting with code 1.`);
  process.exit(1);
}
