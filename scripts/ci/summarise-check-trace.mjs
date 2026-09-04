#!/usr/bin/env node
// Pair a TypeScript `--generateTrace` run's `checkSourceFile` events and print
// the files the checker spent the most time in (MOTIR-4295).
//
// ── Why this is committed rather than retyped ───────────────────────────────
// `tsc --extendedDiagnostics` says how long the CHECK took; it never says WHERE.
// `--generateTrace` does, but only as a raw Chrome trace: thousands of
// begin/end event pairs whose durations have to be reconstructed. Every time
// somebody has needed that answer they have written the same twenty lines, run
// it once, and thrown it away — so the numbers in a pull-request body could not
// be reproduced by the person reading them. This makes the measurement a
// command.
//
//   tsc -p tsconfig.app.json --generateTrace .tsout/trace-before
//   node scripts/ci/summarise-check-trace.mjs .tsout/trace-before
//
// It prints a Markdown table (paste it straight into a PR body) and the median,
// which is the number that says whether an outlier is still an outlier.
//
// ⚠️ IT MEASURES ONE PROGRAM. Under project references there are three, and a
// file is checked by exactly one of them — so point it at the project whose
// files you are paying down (`tsconfig.app.json` for `lib/`), not at the
// solution file, which produces one trace directory per project.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const limit = Number(process.argv[3] ?? 10);
if (!dir) {
  console.error('usage: summarise-check-trace.mjs <trace-dir> [top-n]');
  process.exit(2);
}

const tracePath = existsSync(join(dir, 'trace.json')) ? join(dir, 'trace.json') : dir;
if (!existsSync(tracePath)) {
  console.error(`no trace at ${tracePath} — did the tsc run write --generateTrace ${dir}?`);
  process.exit(2);
}

/**
 * Pair `checkSourceFile` begin/end events into per-file durations.
 *
 * The trace is a flat, time-ordered event list; a `B` event opens a scope on the
 * thread and the next `E` on that thread closes it. `checkSourceFile` does not
 * nest inside itself, so one open frame per thread is enough — and keeping a
 * STACK rather than a single slot is what makes that assumption checkable
 * instead of assumed (an unbalanced trace leaves frames behind, and we say so).
 */
function checkDurationsByFile(events) {
  const open = new Map(); // thread id → stack of begin events
  const totals = new Map(); // file path → microseconds
  for (const e of events) {
    if (e.name !== 'checkSourceFile') continue;
    const tid = e.tid ?? 0;
    if (e.ph === 'B') {
      if (!open.has(tid)) open.set(tid, []);
      open.get(tid).push(e);
      continue;
    }
    if (e.ph !== 'E') continue;
    const stack = open.get(tid);
    const begin = stack?.pop();
    if (!begin) continue;
    const path = begin.args?.path ?? '(unknown)';
    totals.set(path, (totals.get(path) ?? 0) + (e.ts - begin.ts));
  }
  const dangling = [...open.values()].reduce((n, s) => n + s.length, 0);
  return { totals, dangling };
}

const events = JSON.parse(readFileSync(tracePath, 'utf8'));
const { totals, dangling } = checkDurationsByFile(events);
if (totals.size === 0) {
  console.error('no checkSourceFile events in the trace — nothing to report');
  process.exit(1);
}

const root = process.cwd() + '/';
const rows = [...totals.entries()]
  .map(([path, us]) => ({
    path: path.startsWith(root) ? path.slice(root.length) : path,
    ms: us / 1000,
  }))
  .sort((a, b) => b.ms - a.ms);

const sorted = rows.map((r) => r.ms).sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
const repoRows = rows.filter((r) => r.path.startsWith('lib/repositories/'));
const repoSorted = repoRows.map((r) => r.ms).sort((a, b) => a - b);
const repoMedian = repoSorted[Math.floor(repoSorted.length / 2)] ?? 0;

console.log(`| file | check ms |`);
console.log(`| --- | --- |`);
for (const r of rows.slice(0, limit)) console.log(`| \`${r.path}\` | ${r.ms.toFixed(0)} |`);
console.log(`| _(median over all ${rows.length} files)_ | ${median.toFixed(0)} |`);
console.log(
  `| _(median over the ${repoRows.length} \`lib/repositories/\` files)_ | ${repoMedian.toFixed(0)} |`,
);
console.log(
  `\ntotal check time in checkSourceFile: ${(rows.reduce((n, r) => n + r.ms, 0) / 1000).toFixed(1)} s`,
);
if (dangling > 0)
  console.error(`\n⚠️ ${dangling} unbalanced checkSourceFile frames — the trace is truncated`);
