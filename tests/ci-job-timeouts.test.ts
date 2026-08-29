import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guard for MOTIR-3569 (ci.yml) and MOTIR-3768 (every other workflow): EVERY
// job in `.github/workflows/` that runs on a runner declares a job-level
// `timeout-minutes`, and every ceiling is justified where the next reader will
// look for it.
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
// ── Why this file no longer reads one workflow ──────────────────────────────
// MOTIR-3569 closed `ci.yml` and this guard was scoped to it, which left the
// repository's eleven other workflow files carrying nineteen unbounded runner
// jobs — and made them HARDER to see, because the file everybody reads was
// fully bounded and a green guard asserted an invariant narrower than it read.
// Two of the nineteen sat inside a CI run: `ci.yml`'s `sandbox` and
// `runner-image` jobs are `uses:` calls, GitHub does not accept
// `timeout-minutes` on a `uses:` job, and `ci-complete` needs both — so a wedge
// in a sandbox image build held a pull request's only required check
// unresolved for up to six hours, which is the exact state MOTIR-3569 was filed
// about. MOTIR-3768 widened both the ceilings and this file to the whole
// directory, so the scope of the guard now matches the scope of the harm.
//
// ── The four things that must hold, and why each is here ────────────────────
//   1. Every `runs-on` job declares a ceiling. Re-derived from each workflow,
//      so a job added later — in ANY file, including one added after this was
//      written — is caught rather than inheriting six hours silently. Workflow
//      files are not typechecked, linted or executed by any suite.
//   2. The partition is TOTAL. A job with no `runs-on` must be a reusable
//      workflow CALL, which GitHub does not accept `timeout-minutes` on; that
//      is the only reason a job may carry none, and it has to be checkable
//      rather than assumed. It is also what makes case 1 meaningful across
//      `release-sandbox.yml` and `release-runner-image.yml`, whose real work
//      happens in a called workflow that is itself covered here.
//   3. Every ceiling actually bounds something — a number at or above the
//      360-minute default would satisfy assertion 1 while restoring the defect.
//   4. `test` clears the worst run on record. A ceiling is not a performance
//      target: 45 (the number `e2e` uses, and the tempting one to copy) would
//      have FAILED the healthy 47.5-minute run above, converting a rare stall
//      into frequent false reds — the worse trade. The same discipline is why
//      `acceptance-video.yml`'s legs are sized from their own runs rather than
//      from `e2e`'s, and why four lanes with no healthy run on record say so in
//      their comment and take a stated floor.
//
// The file DISCOVERS the workflows rather than listing them, for the same
// reason it re-derives the jobs: a thirteenth workflow added next month is
// covered without anyone remembering this file exists.
//
// Same mould (and the same no-YAML-dependency constraint — the repo has no YAML
// parser) as `tests/ci-complete-gate.test.ts`, which the job-splitting helper
// below is taken from.

const ROOT = process.cwd();
const WORKFLOW_DIR = join(ROOT, '.github/workflows');

const workflowFiles = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort();

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
 * quoted in prose all over these workflows — including in the block that
 * explains them. A ceiling that exists only in a comment must not satisfy
 * anything.
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

type Job = { file: string; id: string; body: string };

/** Every job in every workflow, addressed as `<file>:<jobId>` in failures. */
const allJobs: Job[] = workflowFiles.flatMap((file) => {
  const jobs = jobsOf(readFileSync(join(WORKFLOW_DIR, file), 'utf8'));
  return [...jobs.entries()].map(([id, body]) => ({ file, id, body }));
});

const where = (j: Job): string => `${j.file}:${j.id}`;

const runnerJobs = allJobs.filter((j) => jobLevel(j.body, 'runs-on') !== null);
// The jobs that DO carry a ceiling. The assertions below that read a ceiling's
// VALUE narrow to this set so that a job added without one produces ONE clear
// failure rather than three.
const boundedJobs = runnerJobs.filter((j) => jobLevel(j.body, 'timeout-minutes') !== null);

const ciJobs = allJobs.filter((j) => j.file === 'ci.yml');

// GitHub's documented default when a job declares none.
const GITHUB_DEFAULT_MINUTES = 360;

// `Vitest (2/3)` on run 32959226187 — a healthy 47.5-minute pass, the slowest
// run of any job on record. A ceiling below it would have turned that green run
// red, which is the failure mode these cards were told not to introduce.
const SLOWEST_HEALTHY_TEST_RUN_MINUTES = 47.5;

describe('every workflow job bounds its own runtime (MOTIR-3569, MOTIR-3768)', () => {
  it('finds every workflow and its jobs', () => {
    // A parser regression, a rename, or a directory read that silently returned
    // less than the tree holds would otherwise make every assertion below pass
    // vacuously — and the widened form has more ways to go quiet than the
    // single-file one did.
    expect(workflowFiles.length).toBeGreaterThanOrEqual(12);
    expect(workflowFiles).toContain('ci.yml');
    expect(runnerJobs.length).toBeGreaterThanOrEqual(33);
    expect(ciJobs.some((j) => j.id === 'test')).toBe(true);
    // Every discovered file contributed at least one job: a file whose `jobs:`
    // mapping did not parse would otherwise vanish from the count in silence.
    for (const file of workflowFiles) {
      expect(
        allJobs.filter((j) => j.file === file).length,
        `${file}: parsed ZERO jobs — the parser, not the workflow, is what to look at`,
      ).toBeGreaterThan(0);
    }
  });

  it('gives EVERY job that runs on a runner a `timeout-minutes`', () => {
    // The load-bearing assertion, as a self-recounting predicate rather than a
    // count: a job added later without a ceiling — in any workflow, including
    // one that does not exist yet — fails here instead of inheriting six hours
    // in silence.
    const unbounded = runnerJobs
      .filter((j) => jobLevel(j.body, 'timeout-minutes') === null)
      .map(where);
    expect(
      unbounded,
      "these jobs inherit GitHub's 360-minute default — add a `timeout-minutes` with its justification",
    ).toEqual([]);
  });

  it('leaves NO other shape of job — a job without `runs-on` must be a reusable-workflow call', () => {
    // What makes the assertion above TOTAL. `timeout-minutes` is not accepted
    // on a `uses:` job, so calling a reusable workflow is the one legitimate
    // reason a job carries no ceiling — and the ceilings for those live in the
    // called workflow, which this file now also reads. Any third shape is a job
    // this file is not looking at.
    const neither = allJobs
      .filter((j) => jobLevel(j.body, 'runs-on') === null && jobLevel(j.body, 'uses') === null)
      .map(where);
    expect(neither).toEqual([]);
  });

  it('sets ceilings that actually bound something', () => {
    // A ceiling at or above the default satisfies the assertion above while
    // restoring the defect exactly.
    for (const j of boundedJobs) {
      const raw = jobLevel(j.body, 'timeout-minutes')!;
      expect(raw, where(j)).toMatch(/^\d+$/);
      const minutes = Number(raw);
      expect(minutes, where(j)).toBeGreaterThan(0);
      expect(minutes, where(j)).toBeLessThan(GITHUB_DEFAULT_MINUTES);
    }
  });

  it('keeps `test` above the slowest HEALTHY run on record', () => {
    // AC 3 of MOTIR-3569, as a machine check. The ceiling bounds a hang; it
    // must never cut off a slow-but-working run, and the obvious number to
    // reach for — 45, copied from the `e2e` lane next door — would have failed
    // a green one. Still pinned to `ci.yml`'s `test` specifically: it is the
    // one job whose slowest healthy run this repository has actually measured.
    const test = ciJobs.find((j) => j.id === 'test')!;
    const minutes = Number(jobLevel(test.body, 'timeout-minutes'));
    expect(minutes).toBeGreaterThan(SLOWEST_HEALTHY_TEST_RUN_MINUTES);
  });

  it('justifies each ceiling where the person it cuts off will read it', () => {
    // The number alone tells the next reader nothing about whether their job
    // grew or their runner wedged. The comment directly above it is the only
    // place that answer can live — a workflow file has nowhere else to put it.
    // Four lanes have no healthy run to quote (`release-brand`,
    // `release-design-system`, `release-sandbox`'s `readme`, `sandbox-staleness`);
    // they say so and name the floor they took, which is why this asserts a
    // justification exists rather than that a duration was measured.
    for (const j of boundedJobs) {
      const why = justificationFor(j.body);
      expect(why, `${where(j)}: add a comment above its \`timeout-minutes\``).not.toBe('');
      expect(why, `${where(j)}: say what the job was observed to take`).toMatch(/min/i);
    }
  });
});
