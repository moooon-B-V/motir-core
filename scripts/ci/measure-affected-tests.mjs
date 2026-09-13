#!/usr/bin/env node
// What `vitest --changed` would select, what its import graph cannot see, and —
// on a pull request — which Vitest files to run
// (MOTIR-5322 / MOTIR-5325 · docs/decisions/ci-affected-tests.md).
//
// ── Two modes, one rule ─────────────────────────────────────────────────────
// MEASURE (the default) prints §3's table: for each of the last merged pull
// requests, what the rule would have selected.
//
//   pnpm exec tsx --tsconfig tsconfig.node.json scripts/ci/measure-affected-tests.mjs
//   pnpm exec tsx --tsconfig tsconfig.node.json scripts/ci/measure-affected-tests.mjs --at f59db9679 --limit 30
//   pnpm exec tsx --tsconfig tsconfig.node.json scripts/ci/measure-affected-tests.mjs --json
//
// SELECT is what `ci.yml`'s `test` legs run on a pull request: the files the
// diff against `<base>` reaches, plus every always-run test, one per line.
//
//   pnpm exec tsx --tsconfig tsconfig.node.json scripts/ci/measure-affected-tests.mjs --select <base-sha> --out <file>
//
// `--head <ref>` (default `HEAD`) diffs against another commit instead, which is
// how the selection for an already-merged pull request is reproduced by hand.
//
// It exits NON-ZERO — and the leg then runs its full shard — when the diff is
// empty or unreadable, or when it touches a force-full path. The `changes` job
// has already routed a force-full diff to the full suite; refusing here too means
// a disagreement between the two readers can only ever run MORE.
//
// The two modes share every line that decides what a pull request selects, which
// is the point: the rule that was measured is the rule that is enforced.
//
// `tsx` rather than `node` because the cost column imports the shard plan's own
// `costSeconds` (a TypeScript module) instead of restating its numbers. Run it
// from the repository root after `pnpm install` (the root `postinstall` builds
// `packages/*/dist`, which is what the app's tests actually import). It needs no
// database: it resolves import graphs and never runs a test.
//
// ── What it replicates ──────────────────────────────────────────────────────
// `VitestSpecifications.filterTestsBySource` from vitest 4.1.7
// (`vitest/dist/chunks/cli-api.*.js`), predicate for predicate:
//   1. a changed path matching `forceRerunTriggers` selects every spec;
//   2. otherwise a spec is selected when it IS a changed path, or a changed path
//      is in `getTestDependencies(spec)` — the Vite SSR transform graph, static
//      and literal-dynamic imports, `node_modules` excluded.
// Vitest's own `getTestDependencies` and its own `picomatch` are called, not
// copies of them.
//
// ⚠️ IN MEASURE MODE THE GRAPH IS BUILT ONCE, AT THE CHECKOUT, not at each pull
// request's merge base — see the ADR's §3 for why that approximation is safe.
// `main` squash-merges, so each first-parent commit whose subject ends `(#<n>)`
// IS one merged pull request, and `<sha>^..<sha>` is its diff as merged.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { createVitest } from 'vitest/node';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const LIMIT = Number(option('--limit') || 30);
const AT = option('--at') || 'HEAD';
const AS_JSON = args.includes('--json');
const SELECT_BASE = option('--select');
const SELECT_OUT = option('--out');
const SELECT_HEAD = option('--head') || 'HEAD';
// A variable, not a literal: `tsconfig.scripts.json` type-checks this file, and a
// literal specifier would pull a `tests/` module into that project (TS6307).
const SHARD_PLAN = '../../tests/helpers/vitestShardPlan.ts';

// §2 of the ADR, part 1 — a change under any of these runs the WHOLE suite. The
// list lives in one data file, read by this script, by `ci.yml`'s `changes` job
// and by the guard; the reason for each entry is in the ADR.
export const FORCE_FULL_FILE = '.github/ci/full-suite-paths.txt';
export const FORCE_FULL_GLOBS = readFileSync(join(ROOT, FORCE_FULL_FILE), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'));

// §2 of the ADR, part 2 — a test that reads the tree or spawns a process, or
// imports a test helper or a `scripts/` module that does, depends on files no
// import names. Such a test runs on every pull request. Matched on file CONTENT
// with comments stripped, so a new one joins itself and a comment that merely
// mentions `readFileSync` does not.
export const ALWAYS_RUN_PATTERN =
  /readFile\(|readFileSync|readdir(Sync)?\(|opendir|existsSync|statSync|lstatSync|globSync|glob\(|tinyglobby|fast-glob|createReadStream|child_process|execSync|execFileSync|spawnSync|spawn\(|execa|import\.meta\.glob|\?raw['"]|new URL\([^)]*import\.meta\.url/;

const git = (...a) =>
  execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const rel = (p) => relative(ROOT, p).split('\\').join('/');

// The picomatch Vitest itself imports — resolved from vitest's real location, so
// a hoisting difference cannot hand us a different matcher.
const vitestRequire = createRequire(
  join(realpathSync(join(ROOT, 'node_modules/vitest')), 'package.json'),
);
const pm = vitestRequire('picomatch');

// The `changes` job's `app` predicate, as `ci.yml` states it. A pull request with
// `app=false` runs no Vitest lane, so it has no ratio to report.
function isAppChange(files) {
  return files.some(
    (f) => f.startsWith('content/') || !/^(docs|design|scripts\/plan-seed)\/|\.md$/.test(f),
  );
}

function nearestRank(sorted, q) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

const ctx = await createVitest('test', { config: 'vitest.config.ts', watch: false, run: true });
try {
  const specs = await ctx.specifications.globTestSpecifications();
  const total = specs.length;
  const project = specs[0].project;

  // One dependency graph per spec, shared transform cache.
  const graphs = new Map();
  for (let i = 0; i < specs.length; i += 32) {
    const batch = specs.slice(i, i + 32);
    const results = await Promise.all(batch.map((s) => ctx.specifications.getTestDependencies(s)));
    batch.forEach((s, j) => graphs.set(rel(s.moduleId), new Set([...results[j]].map(rel))));
  }

  // Everything `setupFiles` / `globalSetup` pull in: every test depends on it,
  // no test's own graph contains it.
  const setupEntries = [...project.config.setupFiles, ...(project.config.globalSetup ?? [])].map(
    (f) => resolve(ROOT, f),
  );
  const setupClosure = new Set();
  for (const entry of setupEntries) {
    setupClosure.add(rel(entry));
    const deps = await ctx.specifications.getTestDependencies(project.createSpecification(entry));
    for (const d of deps) setupClosure.add(rel(d));
  }

  // Block and line comments out, string contents kept — good enough to stop a
  // header that DESCRIBES a `readdirSync` from counting as one.
  const withoutComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  const readsTree = (file) => {
    try {
      return ALWAYS_RUN_PATTERN.test(withoutComments(readFileSync(join(ROOT, file), 'utf8')));
    } catch {
      return false;
    }
  };
  // A reader under these roots is test tooling, so what it reads is the test's
  // input. A reader anywhere else is product code; those are listed for the ADR
  // to classify rather than folded in blind (most read a path from the
  // environment, not from the repository).
  const toolingRoot = (f) => f.startsWith('tests/') || f.startsWith('scripts/');
  const alwaysRun = new Set();
  const runtimeReaders = new Map(); // product modules that read the fs, and how many specs reach them
  const readerCache = new Map();
  const cachedReads = (f) => {
    if (!readerCache.has(f)) readerCache.set(f, readsTree(f));
    return readerCache.get(f);
  };
  for (const [spec, deps] of graphs) {
    if (cachedReads(spec) || [...deps].some((d) => toolingRoot(d) && cachedReads(d)))
      alwaysRun.add(spec);
    for (const d of deps) {
      if (!toolingRoot(d) && cachedReads(d))
        runtimeReaders.set(d, (runtimeReaders.get(d) ?? 0) + 1);
    }
  }

  const vitestTrigger = pm(ctx.config.forceRerunTriggers);
  const forceFull = pm(FORCE_FULL_GLOBS, { dot: true });

  /** The first changed path that forces the full suite, or null. */
  const forceFullPath = (changed) =>
    changed.find((f) => vitestTrigger(resolve(ROOT, f))) ??
    changed.find((f) => forceFull(f)) ??
    changed.find((f) => setupClosure.has(f)) ??
    null;

  /** The rule: the files the diff reaches through the graph, plus every always-run test. */
  const select = (changed) => {
    const changedSet = new Set(changed);
    const graphFiles = [...graphs]
      .filter(([spec, deps]) => changedSet.has(spec) || changed.some((f) => deps.has(f)))
      .map(([spec]) => spec);
    return { graphFiles, union: [...new Set([...graphFiles, ...alwaysRun])].sort() };
  };

  if (SELECT_BASE !== undefined) {
    // ── SELECT ──────────────────────────────────────────────────────────────
    // Two-dot against the base TIP: on a pull request's merge checkout that is
    // the pull request's own change, and if the base moved it also includes what
    // landed since — more files, never fewer.
    if (!SELECT_OUT) throw new Error('--select needs --out <file>');
    const changed = git('diff', '--name-only', SELECT_BASE, SELECT_HEAD)
      .split('\n')
      .filter(Boolean);
    if (changed.length === 0) {
      console.error('select: empty diff against the base — refusing, so the leg runs in full');
      process.exitCode = 3;
    } else if (forceFullPath(changed)) {
      console.error(`select: ${forceFullPath(changed)} is a force-full path — refusing`);
      process.exitCode = 3;
    } else {
      const { graphFiles, union } = select(changed);
      writeFileSync(SELECT_OUT, `${union.join('\n')}\n`);
      console.error(
        `select: ${changed.length} changed files → ${graphFiles.length} by the import graph + ` +
          `${alwaysRun.size} always-run = ${union.length} of ${total} spec files`,
      );
    }
  } else {
    // ── MEASURE ─────────────────────────────────────────────────────────────
    const plan = await import(SHARD_PLAN);
    const costOf = (files) => files.reduce((sum, f) => sum + plan.costSeconds(f), 0);
    const totalCost = costOf([...graphs.keys()]);
    const pinned = git('rev-parse', AT);

    const commits = git('log', '--first-parent', '--format=%H%x09%s', `-n${LIMIT * 3}`, AT)
      .split('\n')
      .map((line) => {
        const [sha, subject] = line.split('\t');
        const m = /\(#(\d+)\)$/.exec(subject ?? '');
        return m ? { sha, pr: Number(m[1]) } : null;
      })
      .filter(Boolean)
      .slice(0, LIMIT);

    const rows = commits.map(({ sha, pr }) => {
      const changed = git('diff', '--name-only', `${sha}^`, sha).split('\n').filter(Boolean);
      const { graphFiles, union } = select(changed);
      return {
        pr,
        sha: sha.slice(0, 9),
        changed: changed.length,
        app: isAppChange(changed),
        forceFull: forceFullPath(changed),
        graphSelected: graphFiles.length,
        selected: union.length,
        ratio: union.length / total,
        costShare: costOf(union) / totalCost,
      };
    });

    const measured = rows.filter((r) => r.app && !r.forceFull);
    const ratios = measured.map((r) => r.ratio).sort((a, b) => a - b);
    const costs = measured.map((r) => r.costShare).sort((a, b) => a - b);
    const graphOnly = measured.map((r) => r.graphSelected / total).sort((a, b) => a - b);
    const summary = {
      pinned,
      vitest: vitestRequire('./package.json').version,
      total,
      alwaysRun: alwaysRun.size,
      setupClosure: [...setupClosure].sort(),
      // Git-ignored files (the generated Prisma client) never appear in a diff,
      // so they need no glob; anything else here is a hole in the force-full list.
      setupClosureUncovered: [...setupClosure]
        .filter((f) => !forceFull(f) && !f.startsWith('generated/'))
        .sort(),
      runtimeReaders: [...runtimeReaders].sort((a, b) => b[1] - a[1]),
      pullRequests: rows.length,
      appFalse: rows.filter((r) => !r.app).length,
      forceFullHits: rows.filter((r) => r.app && r.forceFull).length,
      measured: measured.length,
      medianRatio: nearestRank(ratios, 0.5),
      p90Ratio: nearestRank(ratios, 0.9),
      medianCostShare: nearestRank(costs, 0.5),
      p90CostShare: nearestRank(costs, 0.9),
      medianGraphOnlyRatio: nearestRank(graphOnly, 0.5),
    };

    if (AS_JSON) {
      console.log(JSON.stringify({ summary, rows }, null, 2));
    } else {
      const pct = (x) => (x === null ? '—' : `${(100 * x).toFixed(1)}%`);
      console.log(`Pinned at ${pinned} · vitest ${summary.vitest} · ${total} spec files`);
      console.log(
        `Always-run (reads the tree / spawns): ${alwaysRun.size} · setup closure: ${setupClosure.size} files\n`,
      );
      console.log(
        '| PR | commit | changed | app | force-full on | graph | + always-run | files | cost |',
      );
      console.log('| --- | --- | ---: | :---: | --- | ---: | ---: | ---: | ---: |');
      for (const r of rows) {
        const lane = !r.app ? 'skipped' : r.forceFull ? `\`${r.forceFull}\`` : '—';
        const sel = !r.app ? '—' : r.forceFull ? `${total}` : `${r.selected}`;
        const files = !r.app ? '—' : r.forceFull ? '100%' : pct(r.ratio);
        const cost = !r.app ? '—' : r.forceFull ? '100%' : pct(r.costShare);
        console.log(
          `| #${r.pr} | \`${r.sha}\` | ${r.changed} | ${r.app ? 'yes' : 'no'} | ${lane} | ${r.app && !r.forceFull ? r.graphSelected : '—'} | ${sel} | ${files} | ${cost} |`,
        );
      }
      console.log(
        `\n${summary.pullRequests} pull requests · ${summary.appFalse} run no Vitest lane (app=false) · ` +
          `${summary.forceFullHits} hit the force-full set · ${summary.measured} measured`,
      );
      console.log(
        `selected/total over the measured: median ${pct(summary.medianRatio)} · p90 ${pct(summary.p90Ratio)} ` +
          `(graph alone: median ${pct(summary.medianGraphOnlyRatio)})`,
      );
      console.log(
        `cost share over the measured:     median ${pct(summary.medianCostShare)} · p90 ${pct(summary.p90CostShare)}`,
      );
      console.log(`\nSetup closure:\n${summary.setupClosure.map((f) => `  ${f}`).join('\n')}`);
      console.log(
        `Setup-closure files ${FORCE_FULL_FILE} does not cover: ${summary.setupClosureUncovered.length ? summary.setupClosureUncovered.join(', ') : 'none'}`,
      );
      console.log(
        `\nNon-test modules that read the tree at run time (specs reaching each):\n${summary.runtimeReaders
          .slice(0, 25)
          .map(([f, n]) => `  ${n}\t${f}`)
          .join('\n')}`,
      );
    }
  }
} finally {
  await ctx.close();
}
