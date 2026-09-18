#!/usr/bin/env node
/* eslint-disable no-console -- a CI operator script: console IS its output surface */
// THE HEAP-HEADROOM TRIPWIRE (Story MOTIR-4292 · MOTIR-4294).
//
// It type-checks the repository AND reads the number that decides whether the
// lane is about to stop being able to. `ci.yml`'s `typecheck` job runs this
// instead of `pnpm typecheck`; its exit code IS the step's.
//
// ── Why a tripwire and not a bigger heap ────────────────────────────────────
// The checker's memory reached the default ceiling twice without anyone reading
// it: the `build` job at MOTIR-1789, the `typecheck` job at MOTIR-3878. Both
// times the first signal was a red pull request with `Ineffective mark-compacts
// near heap limit` and NO FILE NAMED — a message that reads like a type error
// and is not one, on somebody's innocent diff. The number was measurable the
// whole time (`tsc --extendedDiagnostics` prints `Memory used`), and nothing
// read it.
//
// ── ONE PROCESS PER PROJECT, and that is the measurement, not a detail ──────
// `tsc -b tsconfig.solution.json` builds every project in ONE node process, so
// its `Memory used` lines are the PROCESS's heap after each project — earlier
// projects' retained memory included. Measured on this repository: 55% / 39% /
// 84% / 92% reading down the blocks, where the last is the whole build rather
// than the package it appears under. That number is real (a local
// `pnpm typecheck` does peak there) but it is not what MOTIR-4293's split
// claims, and a tripwire reading it would report the sum the split exists to
// remove.
//
// So this script builds each project in its OWN process, in the solution's
// order, dependencies first. Each reading is then that project's own — 55% /
// 39% / 84% / 4% on the same tree — and the ceiling is the largest project,
// which is the property the split was for.
//
// ⚠️ AND IT MEASURES COLD, by removing `.tsout/` first. A `tsc -b` whose project
// is up to date prints nothing at all, and a `tsc -p` with a warm
// `.tsbuildinfo` prints an INCREMENTAL reading — 1.20 GB against the same
// project's 2.23 GB cold, measured. Either would hand the gate a number that is
// about the developer's build state rather than about the tree. CI is always
// cold, so this costs the lane nothing and makes a local run answer the same
// question; the price is that the next local `pnpm typecheck` is cold too.
//
// ⚠️ IT DOES NOT RAISE THE HEAP, and it strips `--max-old-space-size` out of the
// NODE_OPTIONS it hands each child. It measures the lane as the lane runs; a
// measurement taken under a raised ceiling would answer a question nobody asked.
// That sentence is about the NUMERATOR — the children's real heap. It says
// nothing about what the percentage is a percentage OF, which is the next block.
//
// ── THE DENOMINATOR IS DECLARED, NOT READ OFF THE MACHINE (MOTIR-5696) ──────
// This used to divide by `v8.getHeapStatistics().heap_size_limit` — node's
// default old-space, which node derives from the machine's RAM. So the 90% line
// was a property of the runner rather than a decision: the same tree read a
// different percentage on a bigger box, and a runner-size change would have
// moved the gate silently in either direction. It now divides by
// DECLARED_HEAP_BUDGET_BYTES, so a reading means the same thing everywhere.
//
// ⚠️ A DECLARED BUDGET IS ONLY HONEST WHILE THE HEAP IT CLAIMS EXISTS, and that
// is what the refusal is for. A budget LARGER than the heap the children really
// get would read a comfortable percentage while a project sits at its actual
// ceiling — the lane then dies with `Ineffective mark-compacts` and no file
// named, the exact failure this tripwire was built to see coming. So before
// building anything the script asks a child — spawned with the children's own
// environment — for ITS `heap_size_limit`, and exits 2 naming both numbers when
// the budget exceeds it. Not this process's limit: an operator's
// `--max-old-space-size` raises that one and is stripped from every child, so it
// is the wrong half of the ratio to check against. A budget BELOW the real heap
// is allowed; it only makes the gate fire early.

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * The fraction of the heap a single project may use before this fails.
 *
 * ⚠️ 90%, RE-AFFIRMED ON A RE-MEASURED SPREAD (MOTIR-4422). MOTIR-4294 derived it
 * from three figures — `ceiling 84.4%`, `run-to-run spread ~1.5 points across four
 * clean builds`, `one story ~1 point` — and the middle one was wrong by about
 * half. Seven runs over ONE unchanged tree at `9d6beace7`, node 22, heap 4.05 GB:
 *
 *   project     files    min      max     spread
 *   app          5530   44.2%    55.9%   11.7 pts
 *   scripts      2026   40.3%    40.5%    0.2
 *   tests        7013   79.9%    82.8%    2.9      ← the ceiling
 *   e2e           934   17.2%    17.6%    0.4
 *   orch          773    4.0%     4.0%    0.0
 *
 * ⚠️ THAT TABLE DESCRIBES A REGRESSED TREE, AND ITS SPREADS ARE NOT THE TREE'S
 * NATURAL VARIANCE (MOTIR-5687). It was measured against prisma 7.8.0, which
 * carried prisma/prisma#29011 — a `= undefined` generic default that stops the
 * checker reusing cached instantiations. On ~7.9.0, four readings of one
 * unchanged `origin/main` give: tests 66.3–72.7% (spread 6.4), app 48.1–48.5%
 * (spread 0.4), scripts 20.2–20.4% (0.2). **The app project's 11.7 points
 * collapsed to 0.4** — so most of what this comment taught as GC noise was the
 * regression re-instantiating payload graphs. The tests project's own spread here
 * is 6.4 points — WIDER than the 2.9 recorded above, not narrower, and said plainly
 * because the convenient reading would be the opposite: a sibling worktree's suite
 * was competing for the box during part of these four, so treat 6.4 as an upper
 * bound on the noise rather than as a property of the version. The number that
 * decides anything is the WORST reading, 72.7%, which is 17 points clear.
 * THRESHOLD is LEFT AT 90%: the gate caught a real defect and is not moved while
 * that defect is being paid down. Re-derive it from a quiet-box distribution, or
 * not at all.
 *
 * 90% is 7.2 points clear of the observed maximum — 2.5x the tests project's
 * measured spread, and roughly seven to twelve stories at ~0.6–1 point each (50
 * new test files are 50 program files, and a program file costs 0.48 MB). It
 * still fires with ~0.3 GB of real heap left, which is the distance between
 * "somebody should look at this" and `Ineffective mark-compacts`. Lowering it to
 * 85% would put the line 2.2 points above the observed maximum — INSIDE the
 * measured spread, on one box's sample of seven — and a gate that fires on GC
 * timing teaches people to re-run it.
 *
 * ⚠️ THE SPREAD IS ONE-SIDED, AND THAT IS THE MORE IMPORTANT HALF. `Memory used`
 * is the heap in use when the compiler finishes, so a collection landing late
 * reads LOW and never high: six of the seven readings sat within 0.3 points of
 * the top, and both outliers were below. The failure this gate is exposed to is
 * therefore a false GREEN — a project genuinely over the line reading under it —
 * which no choice of threshold repairs. Treat one green reading as weak evidence
 * and take the maximum of several; `--help` says so where an operator will see it.
 *
 * ⚠️ AND THE GAP IS CLOSED BY SHRINKING THE PROGRAM, OF WHICH A PROJECT BOUNDARY
 * IS ONE WAY AND NOT AUTOMATICALLY THE BEST. This comment used to say the answer
 * was a boundary, full stop. Priced (MOTIR-4422): splitting `tests/components/**`
 * out of the tests project — 298 of its 1682 bodies, the largest single
 * subdirectory — moves the ceiling 7013 → 6212 files, 82.8% → 77.3%. **5.5
 * points**, because both halves go on importing the same `lib/` surface and the
 * declarations stay on both sides. `tsconfig.base.json`'s header carries the model
 * this rests on; the short form is that the `files` column below is the variable,
 * so any candidate boundary can be priced before it is drawn.
 */
const THRESHOLD = 0.9;

/**
 * THE DENOMINATOR — the heap budget every `Memory used` reading is a fraction of
 * (MOTIR-5696). Bytes.
 *
 * The value is the `heap_size_limit` the CI runner's children actually get: node
 * 22 on the `ubuntu-latest` runner (ubuntu-24.04, image 20260907.300.1), read off
 * the runner by this script's own `children's real heap` line and recorded in
 * MOTIR-5696's pull request. It is node's 4096 MiB old-space cap plus its young
 * generation, and it is the SAME number this box reports — node caps the default
 * there on any machine with enough RAM — which is why the two looked identical and
 * why the dependency on RAM went unnoticed: it only shows on a box below the cap.
 *
 * ⚠️ CHOSEN EQUAL TO THE HEAP EVERY HISTORICAL CI READING WAS DIVIDED BY, SO NO
 * CI PERCENTAGE MOVES. Every figure quoted in this file, in `ci.yml` and in
 * `tsconfig.base.json` was taken at a 4.05 GB heap, and they stay comparable. What
 * changes is readings on OTHER machines: a box whose default heap differs used to
 * report a different percentage of a different number, and now reports the lane's
 * — or refuses, when its heap is smaller than this budget (see the header).
 *
 * ⚠️ RAISING THIS IS NOT RAISING THE HEAP, AND IT IS REFUSED WHEN IT OUTGROWS ONE.
 * The children's heap is whatever node gives them; this only says what the 90% is
 * of. If the runner's heap changes, re-read it on the runner and move this with a
 * pull request that says so — and THRESHOLD is not moved in the same one, or
 * nobody can tell which of the two changed the verdict.
 */
export const DECLARED_HEAP_BUDGET_BYTES = 4_345_298_944;

/**
 * A test hook, and ONLY that: a budget to use INSTEAD of the declared one. It is
 * held to the same refusal — an override larger than the children's heap is the
 * same lie as a declared budget that is.
 */
const LIMIT_OVERRIDE_ENV = 'MOTIR_TYPECHECK_HEAP_LIMIT_BYTES';

const ROOT = process.cwd();
const SOLUTION = 'tsconfig.solution.json';

/**
 * The BASELINE PROBE (MOTIR-4422) — `tsconfig.tests.json` with the bodies taken
 * out, measured only under `--baseline`.
 *
 * It is NOT in the solution and `pnpm typecheck` never builds it: the `typecheck`
 * lane's cost is unchanged by its existence. It is here so that the BASELINE in
 * the derivation above is a figure anybody can re-read in one command, rather
 * than one inferred from the difference between two configurations — which is
 * how the model this comment replaces came to be wrong.
 */
const BASELINE_PROJECT = 'scripts/ci/typecheck-baseline';

if (process.argv.includes('--help')) {
  console.log(`assert-typecheck-headroom — type-check every project and gate on its heap usage

  node scripts/ci/assert-typecheck-headroom.mjs
  node scripts/ci/assert-typecheck-headroom.mjs --baseline

Fails when any project's \`Memory used\` exceeds ${Math.round(THRESHOLD * 100)}% of the DECLARED heap
budget — ${DECLARED_HEAP_BUDGET_BYTES} bytes (${(DECLARED_HEAP_BUDGET_BYTES / 1024 ** 3).toFixed(2)} GB), the CI runner's heap —
naming the project and both numbers. Prints the table either way, so a green run
leaves the readings in the log.

The denominator is a constant, not this machine's heap, so a percentage means the
same thing on every box (MOTIR-5696). It is only honest while the children really
have that much heap, so the script REFUSES (exit 2) before building anything when
the budget exceeds the heap a child actually gets, naming both. On a box below the
budget, pass a smaller one through ${LIMIT_OVERRIDE_ENV} — the gate then
fires early, which is the safe direction.

\`--baseline\` measures ${BASELINE_PROJECT} as well — the tests
project's own options and references with ONE trivial test body instead of 1682.
The gap between it and \`tsconfig.tests.json\` is what the bodies cost; its own
reading is what everything else costs. Not in the solution, so CI never pays for
it; run it when you are about to reason about what a project boundary would buy.

⚠️ READ MORE THAN ONE RUN. \`Memory used\` is the heap in use when the compiler
finishes, so a garbage collection landing just before the end reads LOW — 11.7
points low on the app project, measured over four runs of an unchanged tree
(MOTIR-4422). Take the MAXIMUM of several runs; a single reading can only
understate.

To watch it FIRE without touching the tree, lower the budget — the children still
run at the default heap, so the readings are real:

  ${LIMIT_OVERRIDE_ENV}=3221225472 node scripts/ci/assert-typecheck-headroom.mjs

To watch it REFUSE, claim more heap than a child has:

  ${LIMIT_OVERRIDE_ENV}=17179869184 node scripts/ci/assert-typecheck-headroom.mjs

(\`NODE_OPTIONS=--max-old-space-size=…\` no longer moves anything: it is stripped
from every child, and the denominator is declared rather than read from this
process.)
`);
  process.exit(0);
}

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

// ── The parser, exported so its own guard can exercise it on a captured run ──

/**
 * The `Memory used` and `Files` a `tsc --extendedDiagnostics` run reported.
 *
 * The LAST of each, deliberately: a `tsc -b` that builds a dependency on the way
 * prints one block per project, and the block that describes the project we
 * asked for is the final one. `Aggregate` lines are ignored for the same reason
 * they exist — they describe the build, not a project.
 *
 * @param {string} output
 * @returns {{ memoryKb: number, files: number } | null}
 */
export function parseDiagnostics(output) {
  const memories = [...output.matchAll(/^Memory used:\s+(\d+)K$/gm)].map((m) => Number(m[1]));
  const files = [...output.matchAll(/^Files:\s+(\d+)$/gm)].map((m) => Number(m[1]));
  const memoryKb = memories.at(-1);
  if (memoryKb === undefined) return null;
  return { memoryKb, files: files.at(-1) ?? 0 };
}

/**
 * The projects a config file references, in its declared order.
 *
 * Read from the file rather than listed here: a project added to the solution
 * and forgotten here would be type-checked by `pnpm typecheck` and measured by
 * nothing, which is the same silence one tier down.
 *
 * @param {string} text  a tsconfig's contents (JSONC)
 * @returns {string[]}
 */
export function projectsOf(text) {
  // ⚠️ TypeScript's OWN JSONC parser, not a regex. A stripper that removes
  // `/* … */` cannot tell a comment from a glob: `"scripts/**/*.tsx"` contains
  // the sequence `/**/`, and a regex-based strip silently turns it into
  // `"scripts*.tsx"` — valid-looking JSON describing a different include set.
  // The compiler is already a dependency of this script (it spawns it), and it
  // is the only parser guaranteed to read these files the way `tsc` does.
  const parsed = ts.parseConfigFileTextToJson('tsconfig.json', text);
  if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, ' '));
  /** @type {{ references?: { path: string }[] }} */
  const config = parsed.config ?? {};
  return (config.references ?? []).map((r) => r.path.replace(/^\.\//, ''));
}

/**
 * The projects in DEPENDENCY ORDER — every project after the ones it references.
 *
 * ⚠️ THE ORDER IS WHAT MAKES EACH READING THE PROJECT'S OWN, and getting it
 * wrong is silent rather than loud. `tsc -b <p>` builds `p`'s dependencies too,
 * in the SAME process, so measuring `tsconfig.tests.json` before
 * `tsconfig.scripts.json` reports the two of them together — and then the
 * scripts project, now up to date, prints no diagnostics at all and looks like a
 * parser failure. Built dependencies-first, every invocation builds exactly one
 * project and every number is that project's.
 *
 * @param {string[]} roots  the solution's own references
 * @param {(project: string) => string[]} referencesOf
 * @returns {string[]}
 */
export function inDependencyOrder(roots, referencesOf) {
  /** @type {string[]} */
  const ordered = [];
  const seen = new Set();
  const visit = (project) => {
    if (seen.has(project)) return;
    seen.add(project);
    for (const dep of referencesOf(project)) visit(dep);
    ordered.push(project);
  };
  for (const root of roots) visit(root);
  // Only the solution's OWN references are measured: a project reachable only as
  // somebody's dependency is still built, and is still checked, on the way.
  return ordered.filter((p) => roots.includes(p));
}

/**
 * Why a heap budget cannot be used as the denominator, or `null` when it can.
 *
 * ⚠️ ONLY ONE DIRECTION IS REFUSED, deliberately. A budget at or under the
 * children's real heap makes the gate fire early — conservative, and the way to
 * run on a smaller box. A budget OVER it reports a percentage of heap the
 * children do not have, which turns the tripwire into a rubber stamp: a silent
 * green right up to an OOM with no file named. A budget that is not a positive
 * number is refused too — `NaN` makes every fraction `NaN`, nothing compares
 * greater than the line, and the gate passes everything.
 *
 * @param {number} budgetBytes     the denominator the gate would divide by
 * @param {number} childHeapBytes  `heap_size_limit` as a child actually sees it
 * @returns {string | null}
 */
export function budgetRefusal(budgetBytes, childHeapBytes) {
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) {
    return `the heap budget is not a positive number of bytes (${budgetBytes})`;
  }
  if (budgetBytes <= childHeapBytes) return null;
  return (
    `the declared heap budget is ${budgetBytes} bytes (${gb(budgetBytes)}), but a child ` +
    `type-check runs under ${childHeapBytes} bytes (${gb(childHeapBytes)}). Every percentage ` +
    `would be of heap the children do not have, and a project at its real ceiling would ` +
    `read green until it OOMs`
  );
}

/**
 * Which readings breach the threshold.
 *
 * @param {{ project: string, memoryKb: number }[]} readings
 * @param {number} limitBytes
 * @param {number} threshold
 * @returns {{ project: string, memoryKb: number, fraction: number }[]}
 */
export function overTheLine(readings, limitBytes, threshold) {
  return readings
    .map((r) => ({ ...r, fraction: (r.memoryKb * 1024) / limitBytes }))
    .filter((r) => r.fraction > threshold);
}

/** A solution reference may name a DIRECTORY (`packages/orchestrator`), which
 *  `tsc` resolves to its `tsconfig.json`. Reading the file needs the full path. */
const configPathOf = (project) =>
  project.endsWith('.json') ? project : join(project, 'tsconfig.json');

/** A reference declared inside `dir`, expressed relative to the repository. */
function normaliseRelative(dir, ref) {
  const parts = `${dir}/${ref}`.split('/');
  /** @type {string[]} */
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

// ── The run ──────────────────────────────────────────────────────────────────

/**
 * NODE_OPTIONS with any heap raise removed — the children measure the LANE.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function childEnv(env = process.env) {
  const nodeOptions = (env['NODE_OPTIONS'] ?? '')
    .split(/\s+/)
    .filter((flag) => flag !== '' && !flag.startsWith('--max-old-space-size'))
    .join(' ');
  return { ...env, NODE_OPTIONS: nodeOptions };
}

/**
 * The heap a CHILD type-check really runs under — asked of a child spawned with
 * the children's own environment, because that is the only process whose limit
 * the readings are measured against. This process's own limit is not it: an
 * operator's `--max-old-space-size` raises this one and `childEnv` strips it from
 * every child.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function childHeapLimitBytes(env = process.env) {
  const run = spawnSync(
    process.execPath,
    ['-p', "require('node:v8').getHeapStatistics().heap_size_limit"],
    { encoding: 'utf8', env: childEnv(env) },
  );
  const bytes = Number((run.stdout ?? '').trim());
  if (run.status !== 0 || !Number.isFinite(bytes) || bytes <= 0) {
    throw new Error(
      `could not read a child's heap_size_limit (exit ${run.status}): ${run.stderr ?? ''}`,
    );
  }
  return bytes;
}

function main() {
  // The DENOMINATOR is declared (the header's MOTIR-5696 block); the override is
  // the test hook. Either way it is checked against a child's real heap BEFORE the
  // build, so a refusal costs seconds rather than a full type-check.
  const limitBytes = Number(process.env[LIMIT_OVERRIDE_ENV] ?? DECLARED_HEAP_BUDGET_BYTES);
  const childHeapBytes = childHeapLimitBytes();
  const refusal = budgetRefusal(limitBytes, childHeapBytes);
  if (refusal) {
    console.error(
      `✗ refusing to gate: ${refusal}.\n` +
        `  On a box smaller than the CI runner, pass a budget at or under the child heap ` +
        `through ${LIMIT_OVERRIDE_ENV} — the gate then fires early, never late. ` +
        `If the RUNNER's heap changed, re-read it there and move DECLARED_HEAP_BUDGET_BYTES ` +
        `in its own pull request.`,
    );
    process.exit(2);
  }
  const declared = projectsOf(readFileSync(join(ROOT, SOLUTION), 'utf8'));
  const projects = inDependencyOrder(declared, (project) => {
    // A reference is relative to the config that declares it; the solution's are
    // repo-relative, and a package's point back up. `dirname` + `normalize` is
    // the whole of it, and `posix` because these are config paths, not OS ones.
    const dir = project.replace(/\/[^/]*$/, '');
    return projectsOf(readFileSync(join(ROOT, configPathOf(project)), 'utf8')).map((ref) =>
      dir === project ? ref : normaliseRelative(dir, ref),
    );
  });
  if (projects.length === 0) {
    console.error(`no projects in ${SOLUTION} — nothing to check, which is itself the finding`);
    process.exit(2);
  }
  // The probe goes LAST, after the projects it references have each been built in
  // their own process — so its reading is its own, exactly as every other one is.
  if (process.argv.includes('--baseline')) projects.push(BASELINE_PROJECT);

  // Cold, for the reason in the header: a warm project reports a number about
  // the build state rather than about the tree. Every project's outDir and
  // `.tsbuildinfo` live under `.tsout/` (MOTIR-4293), the package's included.
  rmSync(join(ROOT, '.tsout'), { recursive: true, force: true });

  /** @type {{ project: string, memoryKb: number, files: number }[]} */
  const readings = [];
  for (const project of projects) {
    const run = spawnSync(
      process.execPath,
      [
        join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
        '-b',
        project,
        '--extendedDiagnostics',
      ],
      { cwd: ROOT, encoding: 'utf8', env: childEnv(), maxBuffer: 64 * 1024 * 1024 },
    );
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    if (run.status !== 0) {
      // A type error, or an OOM. Either way the output is the answer and this
      // script must not swallow it — the step's whole job is that the lane's
      // verdict is legible.
      process.stdout.write(output);
      console.error(`\n✗ type-check FAILED for ${project} (exit ${run.status})`);
      process.exit(run.status ?? 1);
    }
    const parsed = parseDiagnostics(output);
    if (!parsed) {
      console.error(
        `✗ no \`Memory used\` line in ${project}'s diagnostics — the parser and the pinned ` +
          `TypeScript have drifted, and a tripwire that cannot read its number is not one`,
      );
      process.exit(2);
    }
    readings.push({ project, ...parsed });
  }

  console.log(`\nTypeScript heap headroom — one process per project, at the default heap`);
  console.log(
    `heap budget: ${gb(limitBytes)} (${limitBytes} bytes, ` +
      `${process.env[LIMIT_OVERRIDE_ENV] === undefined ? 'declared' : `${LIMIT_OVERRIDE_ENV} override`}) · ` +
      `children's real heap: ${gb(childHeapBytes)} (${childHeapBytes} bytes) · ` +
      `fail above ${Math.round(THRESHOLD * 100)}%\n`,
  );
  console.log(`  project                                   files      used   of budget`);
  for (const r of readings) {
    const used = r.memoryKb * 1024;
    const pct = ((used / limitBytes) * 100).toFixed(1).padStart(6);
    console.log(
      `  ${r.project.padEnd(40)} ${String(r.files).padStart(6)}  ${gb(used).padStart(8)}  ${pct}%`,
    );
  }

  const breached = overTheLine(readings, limitBytes, THRESHOLD);
  if (breached.length === 0) {
    console.log(`\n✓ every project is under ${Math.round(THRESHOLD * 100)}% of the heap budget`);
    return;
  }
  const worst = breached[0];
  console.error(
    `\n✗ ${worst.project} used ${gb(worst.memoryKb * 1024)} — ${(worst.fraction * 100).toFixed(1)}% ` +
      `of the ${gb(limitBytes)} heap budget, over the ${Math.round(THRESHOLD * 100)}% line.\n` +
      `  There are TWO levers, and the cheap one is not the \`files\` column (MOTIR-5687).\n` +
      `  A bigger heap is neither of them: every bump moves the cliff by one story.\n\n` +
      `  1. TYPE INSTANTIATIONS — what the program costs PER FILE. Check this FIRST: it\n` +
      `     is usually one declaration, it can be worth more than any boundary, and a\n` +
      `     boundary drawn over an inflated per-file cost leaves the inflation on both\n` +
      `     sides of the line. The tell is a reading that moved while \`files\` did not,\n` +
      `     or a wide run-to-run spread. The instrument is \`--extendedDiagnostics\`'s\n` +
      `     \`Instantiations\` / \`Types\`, and \`--generateTrace\` for where. Measured:\n` +
      `     prisma 7.8.0 -> 7.9.0 took this project 90.8% -> 72.7% with \`files\`\n` +
      `     UNCHANGED, against 5.5 points for the largest boundary available.\n` +
      `  2. THE PROGRAM — the \`files\` column above, declarations included, ~0.48 MB\n` +
      `     each. A project boundary is worth exactly the files it removes from THIS\n` +
      `     project, which you can price before you draw it (a candidate config's file\n` +
      `     count; \`--baseline\` for the floor).\n\n` +
      `  Read the number twice before acting on it — a late GC reads LOW, never high.\n` +
      `  See tsconfig.base.json for the model and the readings, MOTIR-4294 for why this\n` +
      `  number is 90%, MOTIR-4422 for the spread it was re-affirmed against and\n` +
      `  MOTIR-5687 for why that spread was itself a symptom.`,
  );
  process.exit(1);
}

// Importable by its guard without running the build.
if (process.argv[1] && process.argv[1].endsWith('assert-typecheck-headroom.mjs')) main();
