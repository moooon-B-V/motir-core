import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guard for MOTIR-3569: every job in `ci.yml` that runs on a runner declares a
// job-level `timeout-minutes`, and every ceiling is justified where the next
// reader will look for it.
//
// ── The hole ────────────────────────────────────────────────────────────────
// GitHub's default per-job budget is 360 minutes. Eleven of the fourteen
// runner jobs in `ci.yml` inherited it, so a wedged job burned six hours and
// was indistinguishable from a slow one the whole time: a running job's logs
// cannot be downloaded (`BlobNotFound`), so the only readable signal is a step
// poll that says `in_progress` — which is exactly what a hang says. On run
// 32959226187, `Vitest (2/3)` ran 47.5 minutes against its siblings' 20 and 22
// and PASSED; for 45 of those minutes the honest answer to "when will we know?"
// was "in up to six hours". MOTIR-2970 had already paid that budget three times
// in one afternoon and fixed it at the ONE call site that wedged
// (`.github/actions/e2e-setup`), leaving the job-level gap open for the next
// hang anywhere else.
//
// ── The four things that must hold, and why each is here ────────────────────
//   1. Every `runs-on` job declares a ceiling. Re-derived from the workflow, so
//      a job added later is caught rather than inheriting six hours silently —
//      workflow files are not typechecked, linted or executed by any suite.
//   2. The partition is TOTAL. A job with no `runs-on` must be a reusable
//      workflow CALL, which GitHub does not accept `timeout-minutes` on; that
//      is the only reason a job may carry none, and it has to be checkable
//      rather than assumed.
//   3. Every ceiling actually bounds something — a number at or above the
//      360-minute default would satisfy assertion 1 while restoring the defect.
//   4. `test` clears the worst run on record. A ceiling is not a performance
//      target: 45 (the number `e2e` uses, and the tempting one to copy) would
//      have FAILED the healthy 47.5-minute run above, converting a rare stall
//      into frequent false reds — the worse trade.
//
// SCOPE, stated because the invariant is narrower than it reads: this guards
// `ci.yml` ONLY. The repository's eleven other workflow files carry nineteen
// more unbounded runner jobs — including `sandbox-images.yml` and
// `runner-image.yml`, which `ci.yml` itself calls — filed as MOTIR-3768.
//
// Same mould (and the same no-YAML-dependency constraint — the repo has no YAML
// parser) as `tests/ci-complete-gate.test.ts`, which the job-splitting helper
// below is taken from.

const ROOT = process.cwd();
const CI_PATH = join(ROOT, '.github/workflows/ci.yml');

const ci = readFileSync(CI_PATH, 'utf8');

/**
 * Split a workflow's `jobs:` mapping into { jobId → body }. Job ids sit at
 * exactly two spaces of indentation; everything in a job body is indented
 * further. (Copied from `ci-complete-gate.test.ts` — the repo has no YAML
 * parser, and duplicating ten lines beats adding a dependency to read one
 * file.)
 */
function jobsOf(yaml: string): Map<string, string> {
  const lines = yaml.split('\n');
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const jobs = new Map<string, string>();
  if (jobsAt === -1) return jobs;
  let current: string | null = null;
  let body: string[] = [];
  for (const line of lines.slice(jobsAt + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      if (current) jobs.set(current, body.join('\n'));
      current = header[1]!;
      body = [];
      continue;
    }
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    body.push(line);
  }
  if (current) jobs.set(current, body.join('\n'));
  return jobs;
}

/**
 * The same text with whole-line comments dropped. Load-bearing here for the
 * same reason it is in the gate test: the job parser attributes a job's leading
 * comment block to the job before it, and the ceilings this file asserts are
 * quoted in prose all over this workflow — including in the block that explains
 * them. A ceiling that exists only in a comment must not satisfy anything.
 */
const codeOf = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

/** A job-level key sits at exactly four spaces; a step's sits deeper. */
const jobLevel = (body: string, key: string): string | null => {
  const m = new RegExp(`^ {4}${key}:[ \\t]*(.*)$`, 'm').exec(codeOf(body));
  return m ? m[1]!.trim() : null;
};

/**
 * The contiguous block of whole-line comments directly above a job's
 * `timeout-minutes:` — where a reader who has just been cut off by a ceiling
 * will look to decide whether to raise it or to investigate.
 */
const justificationFor = (body: string): string => {
  const lines = body.split('\n');
  const at = lines.findIndex((l) => /^ {4}timeout-minutes:/.test(l));
  if (at === -1) return '';
  const out: string[] = [];
  for (let i = at - 1; i >= 0 && /^\s*#/.test(lines[i]!); i -= 1) out.unshift(lines[i]!);
  return out.join('\n');
};

const jobs = jobsOf(ci);
const runnerJobs = [...jobs.entries()].filter(([, body]) => jobLevel(body, 'runs-on') !== null);
// The jobs that DO carry a ceiling. The assertion below is what fails when one
// is missing; the two that read a ceiling's value narrow to this set so that a
// job added without one produces ONE clear failure rather than three.
const boundedJobs = runnerJobs.filter(([, body]) => jobLevel(body, 'timeout-minutes') !== null);

// GitHub's documented default when a job declares none.
const GITHUB_DEFAULT_MINUTES = 360;

// `Vitest (2/3)` on run 32959226187 — a healthy 47.5-minute pass, the slowest
// run of any job on record. A ceiling below it would have turned that green run
// red, which is the failure mode this card was told not to introduce.
const SLOWEST_HEALTHY_TEST_RUN_MINUTES = 47.5;

describe('every ci.yml job bounds its own runtime (MOTIR-3569)', () => {
  it('finds the workflow and its jobs', () => {
    // A parser regression or a rename would otherwise make every assertion
    // below pass vacuously.
    expect(jobs.size).toBeGreaterThan(10);
    expect(runnerJobs.length).toBeGreaterThan(10);
    expect(jobs.has('test')).toBe(true);
  });

  it('gives EVERY job that runs on a runner a `timeout-minutes`', () => {
    // The load-bearing assertion, as a self-recounting predicate rather than a
    // count: a job added later without a ceiling fails here instead of
    // inheriting six hours in silence.
    const unbounded = runnerJobs
      .filter(([, body]) => jobLevel(body, 'timeout-minutes') === null)
      .map(([id]) => id);
    expect(
      unbounded,
      "these jobs inherit GitHub's 360-minute default — add a `timeout-minutes` with its justification",
    ).toEqual([]);
  });

  it('leaves NO other shape of job — a job without `runs-on` must be a reusable-workflow call', () => {
    // What makes the assertion above TOTAL. `timeout-minutes` is not accepted
    // on a `uses:` job, so calling a reusable workflow is the one legitimate
    // reason a job carries no ceiling — and the ceilings for those live in the
    // called workflow. Any third shape is a job this file is not looking at.
    const neither = [...jobs.entries()]
      .filter(([, body]) => jobLevel(body, 'runs-on') === null && jobLevel(body, 'uses') === null)
      .map(([id]) => id);
    expect(neither).toEqual([]);
  });

  it('sets ceilings that actually bound something', () => {
    // A ceiling at or above the default satisfies the assertion above while
    // restoring the defect exactly.
    for (const [id, body] of boundedJobs) {
      const raw = jobLevel(body, 'timeout-minutes')!;
      expect(raw, id).toMatch(/^\d+$/);
      const minutes = Number(raw);
      expect(minutes, id).toBeGreaterThan(0);
      expect(minutes, id).toBeLessThan(GITHUB_DEFAULT_MINUTES);
    }
  });

  it('keeps `test` above the slowest HEALTHY run on record', () => {
    // AC 3 of MOTIR-3569, as a machine check. The ceiling bounds a hang; it
    // must never cut off a slow-but-working run, and the obvious number to
    // reach for — 45, copied from the `e2e` lane next door — would have failed
    // a green one.
    const minutes = Number(jobLevel(jobs.get('test')!, 'timeout-minutes'));
    expect(minutes).toBeGreaterThan(SLOWEST_HEALTHY_TEST_RUN_MINUTES);
  });

  it('justifies each ceiling where the person it cuts off will read it', () => {
    // The number alone tells the next reader nothing about whether their job
    // grew or their runner wedged. The comment directly above it is the only
    // place that answer can live — a workflow file has nowhere else to put it.
    for (const [id, body] of boundedJobs) {
      const why = justificationFor(body);
      expect(why, `${id}: add a comment above its \`timeout-minutes\``).not.toBe('');
      expect(why, `${id}: say what the job was observed to take`).toMatch(/min/i);
    }
  });
});
