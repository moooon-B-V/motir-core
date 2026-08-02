import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guard for MOTIR-2008: `protect-main` (ruleset 17227448) requires exactly ONE
// status check — `CI complete` — and everything in ci.yml is gated THROUGH it.
// That indirection is what finally makes Vitest and E2E block a merge: naming
// jobs directly could only ever cover the five unconditional, non-matrix ones,
// because a skipped MATRIX job reports its check under the raw, un-interpolated
// name (`Vitest (${{ matrix.shard }}/${{ matrix.total }})`) and a skipped
// required check counts as satisfied (MOTIR-2003, measured on PR #1766).
//
// Three things must therefore hold, and nothing else in the repo would notice
// if one stopped: the workflow files are not type-checked, linted, or executed
// by any suite.
//
//   1. `needs` lists EVERY other job. A job added later and left out is
//      silently un-gated — the failure this card exists to prevent, and the
//      reason the assertion is a predicate over the workflow's actual job keys
//      rather than a fixed list of names (a count goes stale the moment a
//      sibling PR merges; MOTIR-1925).
//   2. The job runs on every PR — no branch-prefix `if:`. A required context
//      that goes absent on `docs/`/`design/`/`seed/` PRs wedges them.
//   3. It goes RED, not green, when a need fails. `if: always()` removes the
//      implicit "all needs succeeded" condition, so the explicit result
//      assertion is the whole mechanism, not decoration.
//
// Same mould (and the same no-YAML-dependency constraint — the repo has no YAML
// parser) as `tests/ci-postgres-container.test.ts` and
// `tests/ci-acceptance-lane.test.ts`.

const CI_PATH = join(process.cwd(), '.github/workflows/ci.yml');
const GATE_JOB = 'ci-complete';
const GATE_CONTEXT = 'CI complete';

const ci = readFileSync(CI_PATH, 'utf8');

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
 * prose (this job's own header names `Vitest (${{ matrix.shard }}/…)`, which a
 * raw-text assertion would happily match).
 */
const codeOf = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

const ciJobs = jobsOf(ci);
const gateBody = ciJobs.get(GATE_JOB);
const gateCode = codeOf(gateBody ?? '');

/** The `needs:` entries of the gate job, in whatever YAML form they are written. */
function declaredNeeds(jobCode: string): string[] {
  // Flow form — `needs: [a, b, c]`, possibly wrapped across lines by Prettier.
  const flow = /needs:\s*\[([^\]]*)\]/.exec(jobCode);
  if (flow) {
    return flow[1]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // Block form — `needs:` followed by `- a` items.
  const block = /needs:\s*\n((?:\s*-\s*[A-Za-z0-9_-]+\s*\n?)+)/.exec(jobCode);
  if (block) {
    return [...block[1]!.matchAll(/-\s*([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
  }
  return [];
}

describe('the CI-complete gate (MOTIR-2008)', () => {
  it('finds the job it is meant to guard', () => {
    // A parser regression (or a workflow restructure) would otherwise make every
    // assertion below pass vacuously.
    expect(gateBody).toBeDefined();
    expect(ciJobs.size).toBeGreaterThan(5);
    expect(gateCode).toMatch(new RegExp(`^\\s*name:\\s*${GATE_CONTEXT}\\s*$`, 'm'));
  });

  it('needs EVERY other job in the workflow', () => {
    // The load-bearing assertion, written as a predicate over the workflow's own
    // job keys so it re-derives itself: add a job to ci.yml without adding it
    // here and this fails, instead of the job shipping un-gated behind a green
    // required check.
    const others = [...ciJobs.keys()].filter((id) => id !== GATE_JOB);
    expect(others.length).toBeGreaterThan(5);
    expect(declaredNeeds(gateCode).sort()).toEqual(others.sort());
  });

  it('never depends on itself', () => {
    expect(declaredNeeds(gateCode)).not.toContain(GATE_JOB);
  });

  it('runs on every pull request, whatever the branch prefix', () => {
    // The other lanes skip on `seed/` / `design/` / `docs/`. This one must not:
    // a required context that is never reported blocks the merge forever, which
    // is precisely the trap that kept the shard names out of the ruleset.
    const jobLevelIfs = [...gateCode.matchAll(/^ {4}if:(.*)$/gm)].map((m) => m[1]!.trim());
    expect(jobLevelIfs).toEqual(['always()']);
    expect(gateCode).not.toContain('startsWith(github.head_ref');
  });

  it('fails on a need that neither succeeded nor was skipped', () => {
    // `if: always()` REMOVES the implicit all-needs-succeeded condition, so
    // without this step the job would run and go green with a failed need —
    // strictly worse than not requiring it at all. The step is the gate.
    expect(gateCode).toContain('toJSON(needs)');
    expect(gateCode).toMatch(/\.value\.result\s*!=\s*"success"/);
    expect(gateCode).toMatch(/\.value\.result\s*!=\s*"skipped"/);
    expect(gateCode).toMatch(/exit 1/);
  });

  it('reads the needs context from the environment, not from spliced script', () => {
    // `${{ }}` interpolated into a `run:` body is textual substitution; routing
    // it through `env:` keeps a job name or result from being read as shell.
    expect(gateCode).toMatch(/^\s*NEEDS:\s*\$\{\{\s*toJSON\(needs\)\s*\}\}\s*$/m);
    expect(gateCode).not.toMatch(/echo\s+'?\$\{\{\s*toJSON\(needs\)/);
  });

  it('runs its assertion under a shell that stops on the first failure', () => {
    // A gate whose script swallows an error reports success by accident.
    expect(gateCode).toMatch(/set -euo pipefail/);
  });
});
