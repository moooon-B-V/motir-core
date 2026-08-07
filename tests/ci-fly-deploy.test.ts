import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guard for MOTIR-2390: the deploy that replaced Vercel's. Its acceptance
// criterion is that the ordering is "asserted by reading the workflow file, not
// by watching a merge" — which is what this file does, because nothing else
// would: workflow YAML is neither type-checked, linted, nor executed by any
// suite (the same premise as `tests/ci-complete-gate.test.ts`,
// `tests/ci-postgres-container.test.ts` and `tests/ci-buildkit-registry.test.ts`,
// and the same no-YAML-dependency constraint — the repo has no YAML parser).
//
// Four things must hold, and each has a named failure behind it:
//
//   1. The gates run FIRST. `needs:` the Vitest and Playwright jobs, and NO
//      `always()`, so a red suite means nothing ships (ADR §6 / Q5).
//   2. Only the default branch deploys. A `push:`-triggered workflow that also
//      runs on pull requests would otherwise ship from any branch.
//   3. The Inngest sync is a STEP of the deploy and FAILS the job. It used to
//      ride `deployment_status` — an event Vercel raises and Fly does not — so
//      leaving that trigger would have stopped the sync silently, reproducing
//      the fault MOTIR-1970 fixed (five production jobs dead for a month).
//   4. Verification reads the PLATFORM, never `fly.toml`. A config file is a
//      claim about the deployment, not a reading of it — MOTIR-2102 verbatim.

const CI_PATH = join(process.cwd(), '.github/workflows/ci.yml');
const SYNC_WORKFLOW_PATH = join(process.cwd(), '.github/workflows/inngest-sync.yml');
const SYNC_ACTION_PATH = join(process.cwd(), '.github/actions/inngest-sync/action.yml');
const SYNC_ACTION_REF = 'uses: ./.github/actions/inngest-sync';

const DEPLOY_JOB = 'deploy';
/** The Vitest matrix and the Playwright matrix — "the existing gates". */
const GATE_JOBS = ['test', 'e2e'];

const ci = readFileSync(CI_PATH, 'utf8');
const syncWorkflow = readFileSync(SYNC_WORKFLOW_PATH, 'utf8');
const syncAction = readFileSync(SYNC_ACTION_PATH, 'utf8');

/**
 * Split a workflow's `jobs:` mapping into { jobId → body }. Job ids sit at
 * exactly two spaces of indentation; everything in a job body is indented
 * further.
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
 * The same text with whole-line comments dropped. Every assertion about what a
 * job DOES runs through this: the parser above attributes a job's leading
 * comment block to the job before it, and these files describe each other in
 * prose — this job's own header names `deployment_status`, which a raw-text
 * assertion would happily match.
 */
const codeOf = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

/** The `needs:` entries of a job, in whatever YAML form they are written. */
function declaredNeeds(jobCode: string): string[] {
  const flow = /needs:\s*\[([^\]]*)\]/.exec(jobCode);
  if (flow) {
    return flow[1]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const block = /needs:\s*\n((?:\s*-\s*[A-Za-z0-9_-]+\s*\n?)+)/.exec(jobCode);
  if (block) {
    return [...block[1]!.matchAll(/-\s*([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
  }
  return [];
}

const ciJobs = jobsOf(ci);
const deployCode = codeOf(ciJobs.get(DEPLOY_JOB) ?? '');
const deployNeeds = declaredNeeds(deployCode);

describe('the Fly deploy runs after the existing gates (MOTIR-2390)', () => {
  it('finds the job it is meant to guard', () => {
    // A parser regression or a workflow restructure would otherwise make every
    // assertion below pass vacuously — the negative control.
    expect(ciJobs.size).toBeGreaterThan(5);
    expect(ciJobs.has(DEPLOY_JOB)).toBe(true);
    expect(deployCode).toMatch(/^\s*name:\s*Deploy to Fly\s*$/m);
  });

  it('waits for the Vitest and Playwright jobs, and for jobs that exist', () => {
    // The whole point of the ordering: everything that can fail cheaply fails
    // before anything is shipped. A `needs` entry naming a job that no longer
    // exists is a workflow load error, so the second assertion is not pedantry.
    for (const gate of GATE_JOBS) expect(deployNeeds).toContain(gate);
    for (const need of deployNeeds) expect(ciJobs.has(need)).toBe(true);
    expect(deployNeeds).not.toContain(DEPLOY_JOB);
  });

  it('is skipped — not run — when a gate fails', () => {
    // `always()` (or `if: success() ||`) would remove the implicit all-needs-
    // succeeded condition and ship a build the suite just rejected. The gate
    // job two doors down needs `always()` for the opposite reason; this one
    // must never have it.
    expect(deployCode).not.toContain('always()');
  });

  it('deploys only from the default branch, and only on a real push', () => {
    // ci.yml triggers on `pull_request` too, so without this the deploy would
    // fire from every branch that opened one.
    const jobLevelIfs = [...deployCode.matchAll(/^ {4}if:(.*)$/gm)].map((m) => m[1]!.trim());
    expect(jobLevelIfs).toHaveLength(1);
    expect(jobLevelIfs[0]).toContain("github.ref == 'refs/heads/main'");
    expect(jobLevelIfs[0]).toContain("github.event_name == 'push'");
  });

  it('is never cancelled mid-release by a newer push', () => {
    // The workflow-level concurrency cancels in-progress runs, which is right
    // for a test run and wrong for a release — a half-applied deploy is worse
    // than a slow one.
    expect(deployCode).toMatch(/concurrency:\s*\n\s*group:\s*fly-deploy/);
    expect(deployCode).toMatch(/cancel-in-progress:\s*false/);
  });
});

describe('the Inngest sync moved into the deploy (MOTIR-2390 / MOTIR-1970)', () => {
  it('runs as a step of the deploy job', () => {
    expect(deployCode).toContain(SYNC_ACTION_REF);
    expect(existsSync(SYNC_ACTION_PATH)).toBe(true);
  });

  it('runs AFTER the release, never before it', () => {
    // Registering a function list the release has not shipped yet tells the
    // cloud about the wrong app.
    const releaseAt = deployCode.indexOf('flyctl deploy');
    const syncAt = deployCode.indexOf(SYNC_ACTION_REF);
    expect(releaseAt).toBeGreaterThan(-1);
    expect(syncAt).toBeGreaterThan(releaseAt);
  });

  it('registers the custom domain, not a per-deployment hostname', () => {
    // Deployment URLs are what the Vercel integration probed, and what
    // Deployment Protection answered with a login redirect. Inngest invokes the
    // functions at the public domain, so that is the only URL worth registering.
    expect(deployCode).toMatch(/serve-url:.*app\.motir\.co\/api\/inngest/);
  });

  it('FAILS the job when the sync does not succeed', () => {
    // Its entire history is of a failure that produced no signal at all. A red
    // check is the signal.
    expect(syncAction).toContain('"$code" = "200"');
    expect(syncAction).toMatch(/::error::.*Inngest registration failed/);
    expect(syncAction).toMatch(/exit 1\s*$/m);
  });

  it('is one definition with two entry points', () => {
    // The deploy step and the manual workflow both call the composite action,
    // so the retry loop and the 200 assertion cannot drift between two copies.
    expect(codeOf(syncWorkflow)).toContain(SYNC_ACTION_REF);
    expect(syncAction).toMatch(/using:\s*composite/);
    // A composite `run:` without `shell:` is a load-time error for every caller.
    const steps = syncAction.split(/^\s{4}- /m).slice(1);
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      if (/(^|\n)\s*run:/.test(step)) expect(step).toMatch(/shell:\s*bash/);
    }
  });

  it('no longer triggers on Vercel’s deployment_status event', () => {
    // Fly raises no such event. Leaving the trigger would have stopped the sync
    // silently — the exact fault MOTIR-1970 fixed.
    expect(codeOf(syncWorkflow)).not.toContain('deployment_status');
    expect(codeOf(syncWorkflow)).toMatch(/^\s*workflow_dispatch:\s*$/m);
  });
});

describe('post-deploy verification reads the platform (MOTIR-2390 / MOTIR-2102)', () => {
  it('asserts the release answers over its own Fly hostname', () => {
    // The custom domain still pointed at Vercel until the cutover, so a check
    // against it would have proved a DNS record rather than this release.
    expect(deployCode).toContain('.fly.dev');
  });

  it('reads the machine count from Fly’s API, never from fly.toml', () => {
    // `auto_start_machines` NEVER creates a machine, so a fly.toml that
    // describes a pool of N is a claim, not a behaviour: motir-ai ran ONE
    // machine for weeks behind a config that said otherwise.
    expect(deployCode).toContain('https://api.machines.dev/v1/apps/');
    expect(deployCode).toContain('machine_count');
    expect(deployCode).not.toContain('fly.toml');
  });

  it('fails on a machine-count mismatch', () => {
    // A verification step that reads a number and does not compare it is a log
    // line, not a check.
    expect(deployCode).toMatch(/if \[ "\$actual" != "\$EXPECTED" \]/);
    expect(deployCode).toMatch(/::error::.*expected/);
  });
});
