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
// The one thing an operator's `--max-old-space-size` DOES change is this
// script's own limit, which is the threshold it compares against — which is what
// makes the tripwire demonstrable (see `--help`).

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import v8 from 'node:v8';
import ts from 'typescript';

/**
 * The fraction of the heap a single project may use before this fails.
 *
 * ⚠️ 90%, AND THE NUMBER IS DERIVED RATHER THAN INHERITED (MOTIR-4294). The card
 * asked for 80%, reasoning that it "leaves roughly one story's worth of growth
 * as warning" — which was the right rule read against the PRE-SPLIT world, where
 * MOTIR-3878 moved the one program's reading by 0.9 GB (22 points) in a single
 * story. After MOTIR-4293 a story does not do that: ~50 new test files are 2.7%
 * of the tests project's 1814 bodies, which is about ONE point. Three numbers,
 * all measured on this repository:
 *
 *   ceiling today      84.4% — the tests project, the largest of the four
 *   run-to-run spread  ~1.5 points across four clean builds
 *   one story          ~1 point
 *
 * 80% is therefore below the floor the tree already stands on: it would fail on
 * arrival, and a lane that is red before anyone has done anything is not a
 * warning, it is a broken gate. 90% clears the spread, leaves roughly five
 * stories of growth as warning, and still fires with ~0.4 GB of real heap left —
 * which is the distance between "somebody should split a project" and
 * `Ineffective mark-compacts`.
 *
 * ⚠️ AND THE RIGHT ANSWER TO THE GAP IS A PROJECT BOUNDARY, NOT A BIGGER NUMBER.
 * The tests project at 84.4% is the one that will hit this first, and splitting
 * it is filed rather than left in this comment.
 */
const THRESHOLD = 0.9;

/** A test hook, and ONLY that: the byte limit to compare against. */
const LIMIT_OVERRIDE_ENV = 'MOTIR_TYPECHECK_HEAP_LIMIT_BYTES';

const ROOT = process.cwd();
const SOLUTION = 'tsconfig.solution.json';

if (process.argv.includes('--help')) {
  console.log(`assert-typecheck-headroom — type-check every project and gate on its heap usage

  node scripts/ci/assert-typecheck-headroom.mjs

Fails when any project's \`Memory used\` exceeds ${Math.round(THRESHOLD * 100)}% of the heap
this process runs under, naming the project and both numbers. Prints the table
either way, so a green run leaves the readings in the log.

To watch it FIRE without touching the tree, lower the threshold's basis — the
children still run at the default heap, so the readings are real:

  NODE_OPTIONS=--max-old-space-size=1024 node scripts/ci/assert-typecheck-headroom.mjs
  ${LIMIT_OVERRIDE_ENV}=3221225472 node scripts/ci/assert-typecheck-headroom.mjs
`);
  process.exit(0);
}

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

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

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

/** NODE_OPTIONS with any heap raise removed — the children measure the LANE. */
function childEnv() {
  const nodeOptions = (process.env['NODE_OPTIONS'] ?? '')
    .split(/\s+/)
    .filter((flag) => flag !== '' && !flag.startsWith('--max-old-space-size'))
    .join(' ');
  return { ...process.env, NODE_OPTIONS: nodeOptions };
}

function main() {
  const limitBytes = Number(
    process.env[LIMIT_OVERRIDE_ENV] ?? v8.getHeapStatistics().heap_size_limit,
  );
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
  console.log(`heap limit: ${gb(limitBytes)} · fail above ${Math.round(THRESHOLD * 100)}%\n`);
  console.log(`  project                                   files      used     of heap`);
  for (const r of readings) {
    const used = r.memoryKb * 1024;
    const pct = ((used / limitBytes) * 100).toFixed(1).padStart(6);
    console.log(
      `  ${r.project.padEnd(40)} ${String(r.files).padStart(6)}  ${gb(used).padStart(8)}  ${pct}%`,
    );
  }

  const breached = overTheLine(readings, limitBytes, THRESHOLD);
  if (breached.length === 0) {
    console.log(`\n✓ every project is under ${Math.round(THRESHOLD * 100)}% of the heap`);
    return;
  }
  const worst = breached[0];
  console.error(
    `\n✗ ${worst.project} used ${gb(worst.memoryKb * 1024)} — ${(worst.fraction * 100).toFixed(1)}% ` +
      `of the ${gb(limitBytes)} heap, over the ${Math.round(THRESHOLD * 100)}% line.\n` +
      `  The answer is another PROJECT BOUNDARY, not a bigger heap: every bump moves the\n` +
      `  cliff by one story and none removes it. See docs/decisions/app-shell-over-packages.md\n` +
      `  and tsconfig.base.json for the shape, and MOTIR-4294 for why this number is 90%.`,
  );
  process.exit(1);
}

// Importable by its guard without running the build.
if (process.argv[1] && process.argv[1].endsWith('assert-typecheck-headroom.mjs')) main();
