#!/usr/bin/env node
// How often the Playwright lane runs on a diff a browser cannot reach
// (MOTIR-6222 · docs/decisions/ci-e2e-path-gate.md).
//
// The question: `ci.yml`'s `changes` job emits ONE `app` boolean and six jobs
// read it, so a `packages/cli/**`-only pull request runs twelve Playwright legs.
// If that happened often enough, `e2e` would be worth its own narrower flag.
// This script measures how often it happens.
//
//   node scripts/ci/measure-e2e-reachability.mjs
//   node scripts/ci/measure-e2e-reachability.mjs --at origin/main --limit 300
//   node scripts/ci/measure-e2e-reachability.mjs --limit 300 --json
//
// ⚠️ NO CI STEP RUNS IT, AND NO `app_e2e` FLAG EXISTS. The ADR measured the
// share at 13.1% over 300 merged pull requests against the 25% its card read off
// a 40-pull-request sample, and declined the gate. This script is kept as the
// instrument that RE-OPENS that decision — re-run it over at least the last 100
// pull requests, and if the share is durably back at or above 25%, the gate can
// be written without re-deriving any of the ADR.
//
// ── What it measures, and with whose instrument ─────────────────────────────
// `app` is NOT re-implemented here. The `classify` step's shell body is LIFTED
// out of `.github/workflows/ci.yml` and executed, so what this scores is the
// classifier that ships — the same extraction `tests/ci-changed-paths-gate.test.ts`
// makes, for the same reason: a second copy of a `case` block whose arms are
// first-match-wins is a second thing to keep true.
//
// `main` squash-merges, so each first-parent commit whose subject ends `(#<n>)`
// IS one merged pull request, and `<sha>^...<sha>` is its diff as merged. That
// is the same derivation `measure-affected-tests.mjs` uses, and it needs no
// network and no credential.
//
// ⚠️ E2E_REACHABLE IS THE PREDICATE THE ANSWER TURNS ON, AND IT IS EVIDENCE,
// NOT TASTE. Every entry below is a path the Playwright run demonstrably reads:
// the Next bundle the lane builds and serves, the specs it executes, what those
// specs import, and the lane's own setup. It is deliberately WIDE — a path
// wrongly called reachable costs a lane that was going to run anyway, and a path
// wrongly called unreachable is a green pull request nobody tested. The ADR's
// §2 table is generated from this list and `tests/ci-changed-paths-gate.test.ts`
// asserts the two agree, so widening one without the other goes red.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const AT = option('--at') || 'origin/main';
const LIMIT = Number(option('--limit') || 300);
const AS_JSON = args.includes('--json');

/**
 * Every path a Playwright run reads. Ordered by how it is reached, and each
 * group carries the evidence that put it here — see the header.
 */
const E2E_REACHABLE = [
  // The Next application the lane builds and serves.
  'app/**',
  'components/**',
  'hooks/**',
  'lib/**',
  'messages/**',
  'prisma/**',
  'public/**',
  // Workspace packages the app imports. `packages/cli/**` is the ONE package
  // nothing in the bundle or the specs reads — which is what makes it the only
  // population a narrower flag could ever have skipped.
  'packages/brand/**',
  'packages/design-system/**',
  'packages/orchestrator/**',
  // The specs themselves, and what they import outside their own tree:
  // `tests/helpers/adminDb`, `tests/fixtures`, `scripts/seedLargeBoard`.
  'tests/e2e/**',
  'tests/helpers/**',
  'tests/fixtures/**',
  'scripts/**',
  // Root modules the build and the served app load.
  'instrumentation.ts',
  'instrumentation-client.ts',
  'next.config.ts',
  'playwright.config.ts',
  'postcss.config.mjs',
  'proxy.ts',
  'sentry.edge.config.ts',
  'sentry.server.config.ts',
  // Anything that changes what gets installed or compiled changes the bundle.
  'package.json',
  'patches/**',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig*.json',
  // The lane's own definition and setup.
  '.github/actions/e2e-setup/**',
  '.github/actions/postgres/**',
  '.github/workflows/ci.yml',
];

/** One glob against one path. `**` spans `/`, `*` does not. */
const matches = (glob, path) =>
  new RegExp(
    `^${glob
      .split('**')
      .map((part) => part.split('*').map(escapeRe).join('[^/]*'))
      .join('.*')}$`,
  ).test(path);

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

const isReachable = (path) => E2E_REACHABLE.some((glob) => matches(glob, path));

const git = (...a) =>
  execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

/**
 * The `classify` step's shell body, de-dented, exactly as it ships. The same
 * lift `tests/ci-changed-paths-gate.test.ts` makes — there is no second copy of
 * the classifier in this repository.
 */
function liftClassifyScript() {
  const lines = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8').split('\n');
  const jobAt = lines.findIndex((l) => /^ {2}changes:\s*$/.test(l));
  const stepAt = lines.findIndex((l, i) => i > jobAt && /^\s*- id: classify\s*$/.test(l));
  const runAt = lines.findIndex((l, i) => i > stepAt && /^\s*run: \|\s*$/.test(l));
  if (jobAt < 0 || stepAt < 0 || runAt < 0) throw new Error('no `classify` step in ci.yml');
  const indent = /^ */.exec(lines[runAt + 1])[0].length;
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== '' && /^ */.exec(line)[0].length < indent) break;
    body.push(line.slice(indent));
  }
  const script = body.join('\n');
  // Without this the whole run passes vacuously: an extraction that returned ''
  // would run bash on nothing and read every flag back as undefined.
  if (!/^set -euo pipefail$/m.test(script)) throw new Error('lifted nothing that runs');
  return script;
}

/** Run the shipped classifier over one merged pull request's own diff. */
function classify(scriptPath, outPath, base, head) {
  writeFileSync(outPath, '');
  execFileSync('bash', [scriptPath], {
    cwd: ROOT,
    env: {
      ...process.env,
      EVENT: 'pull_request',
      BASE_SHA: base,
      HEAD_SHA: head,
      MERGE_BASE_SHA: '',
      MERGE_HEAD_SHA: '',
      GITHUB_OUTPUT: outPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
  });
  return Object.fromEntries(
    readFileSync(outPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
}

const work = mkdtempSync(join(tmpdir(), 'e2e-reachability-'));
try {
  const scriptPath = join(work, 'classify.sh');
  writeFileSync(scriptPath, liftClassifyScript());
  const outPath = join(work, 'github-output');

  const merged = git('log', '--first-parent', AT, `--max-count=${LIMIT}`, '--format=%H%x09%s')
    .split('\n')
    .map((line) => {
      const [sha, subject] = line.split('\t');
      const pr = /\(#(\d+)\)$/.exec(subject ?? '');
      return pr ? { sha, pr: Number(pr[1]), subject } : null;
    })
    .filter(Boolean);

  const rows = merged.map(({ sha, pr, subject }) => {
    const { app } = classify(scriptPath, outPath, `${sha}^`, sha);
    const files = git('diff', '--name-only', `${sha}^...${sha}`).split('\n').filter(Boolean);
    const unreachable = files.filter((f) => !isReachable(f));
    return {
      pr,
      sha: sha.slice(0, 9),
      subject,
      changed: files.length,
      app: app === 'true',
      // The whole question: did ANY changed file reach the browser?
      e2eReachable: files.length !== unreachable.length,
      unreachableOnly: app === 'true' && files.length === unreachable.length,
      sample: unreachable.slice(0, 3),
    };
  });

  const ran = rows.filter((r) => r.app);
  const wasted = ran.filter((r) => r.unreachableOnly);
  const share = ran.length ? (100 * wasted.length) / ran.length : 0;

  if (AS_JSON) {
    console.log(JSON.stringify({ at: git('rev-parse', AT), rows, share }, null, 2));
  } else {
    console.log(`at ${git('rev-parse', AT)} · ${rows.length} merged pull requests\n`);
    console.log(`  sampled                      : ${rows.length}`);
    console.log(`  app=true  (Playwright ran)   : ${ran.length}`);
    console.log(`    …touching a reachable path : ${ran.length - wasted.length}`);
    console.log(
      `    …with NO reachable path    : ${wasted.length} = ${share.toFixed(1)}% of app=true`,
    );
    console.log('\n  the pull requests a narrower flag would have skipped:');
    for (const r of wasted) console.log(`    #${r.pr}  ${r.sample.join(', ')}`);
    console.log('\n  consecutive windows of 40, newest first:');
    for (let i = 0; i + 40 <= rows.length; i += 40) {
      const win = rows.slice(i, i + 40);
      const a = win.filter((r) => r.app);
      const w = a.filter((r) => r.unreachableOnly);
      const pct = a.length ? ((100 * w.length) / a.length).toFixed(0) : '—';
      console.log(`    #${win[0].pr}..#${win.at(-1).pr}: ${w.length}/${a.length} = ${pct}%`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
