import { spawnSync } from 'child_process';
import { readdirSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const benchDir = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(benchDir, 'results');
mkdirSync(resultsDir, { recursive: true });

// Clean stale per-file results before running
for (const f of readdirSync(resultsDir)) {
  if (f !== 'baseline.json' && f.endsWith('.json') && !f.startsWith('run-')) {
    rmSync(join(resultsDir, f));
  }
}

const benchFiles = readdirSync(benchDir)
  .filter(f => f.endsWith('.bench.js'))
  .sort();

const failures = [];
for (const file of benchFiles) {
  const needsGC = file === 'memory.bench.js' || file === 'memoryCreep.bench.js';
  const args = [...(needsGC ? ['--expose-gc'] : []), join(benchDir, file)];
  console.log(`\n--- ${file} ---`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', ...args], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`FAILED: ${file} (exit code ${result.status})`);
    failures.push(file);
  }
}

// Aggregate per-file results into one timestamped run file
const combined = [];
for (const f of readdirSync(resultsDir)) {
  if (f === 'baseline.json' || f.startsWith('run-') || !f.endsWith('.json')) continue;
  try { combined.push(...JSON.parse(readFileSync(join(resultsDir, f), 'utf-8'))); }
  catch { /* skip malformed */ }
}
const runFile = join(resultsDir, `run-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.json`);
writeFileSync(runFile, JSON.stringify(combined, null, 2));
console.log(`\nResults: ${runFile}`);

if (failures.length > 0) {
  console.error(`${failures.length} failed: ${failures.join(', ')}`);
  process.exit(1);
}
