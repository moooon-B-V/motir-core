import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guard for MOTIR-1949: a PR that changes no `tests/e2e/acceptance*.spec.ts`
// must see NO acceptance check at all. Before it, the lane was an `e2e` matrix
// leg with no relevance gate, so every ordinary PR paid ~11 minutes (the run's
// long pole) and a ~419 MB video/trace artifact to record eight clips that
// MOTIR-1937 then correctly refused to publish.
//
// The mechanism is load-bearing and non-obvious, which is why it is asserted
// here: a job-level `if:` is NOT enough — a job whose `if:` is false is still
// reported, as a greyed `Skipped` check (measured on PR #1751). A matrix leg
// cannot be dropped by an expression either. Only a workflow that is never
// TRIGGERED leaves nothing behind, so the lane lives in its own file with a
// `paths:` filter.
//
// These assertions exist because nothing else would catch a regression: the
// workflow files are not type-checked, linted, or executed by any suite. Same
// mould as `tests/ci-postgres-container.test.ts`, and the same no-YAML-dependency
// constraint — the repo has no YAML parser, so the file is split by indentation.

const CI_PATH = join(process.cwd(), '.github/workflows/ci.yml');
const ACCEPTANCE_WORKFLOW_PATH = join(process.cwd(), '.github/workflows/acceptance-video.yml');
const SETUP_ACTION_PATH = join(process.cwd(), '.github/actions/e2e-setup/action.yml');
const SETUP_ACTION_REF = 'uses: ./.github/actions/e2e-setup';
const ACCEPTANCE_CONFIG = 'playwright.acceptance.config.ts';
const ACCEPTANCE_SPEC_GLOB = "'tests/e2e/acceptance*.spec.ts'";

const ci = readFileSync(CI_PATH, 'utf8');
const acceptanceWorkflow = readFileSync(ACCEPTANCE_WORKFLOW_PATH, 'utf8');

/**
 * Split a workflow's `jobs:` mapping into { jobId → body }. Job ids sit at
 * exactly two spaces of indentation; everything in a job body is indented
 * further. (Copied from ci-postgres-container.test.ts — the repo has no YAML
 * dependency, and two small parsers beat one shared test-helper import that
 * couples the two guards.)
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
 * The same text with whole-line comments dropped. Needed wherever an assertion
 * asks what a workflow DOES: these files describe each other in prose, and the
 * parser above attributes a job's leading comment block to the job before it.
 */
const codeOf = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

const ciJobs = jobsOf(ci);
const acceptanceJob = jobsOf(acceptanceWorkflow).get('acceptance');
const e2eBody = ciJobs.get('e2e');

describe('the acceptance-video lane is story-scoped (MOTIR-1949)', () => {
  it('finds the jobs it is meant to guard', () => {
    // A parser regression (or a workflow restructure) would otherwise make every
    // assertion below pass vacuously.
    expect(e2eBody).toBeDefined();
    expect(acceptanceJob).toBeDefined();
  });

  it('runs the acceptance lane from its OWN workflow, never from ci.yml', () => {
    // ci.yml runs on every PR and every push to main. Anything acceptance-shaped
    // in it is a check on PRs that do not want one — which is the whole bug.
    expect(codeOf(ci)).not.toContain(ACCEPTANCE_CONFIG);
    expect(codeOf(acceptanceWorkflow)).toContain(ACCEPTANCE_CONFIG);
  });

  it('is triggered by a `paths:` filter, not by a job-level `if:`', () => {
    // THE mechanism. A `paths:`-filtered workflow that does not match is never
    // triggered, so no check appears. A job-level `if:` would still report a
    // greyed `Skipped` — the thing this card exists to remove.
    expect(acceptanceWorkflow).toMatch(
      /on:\s*\n\s*pull_request:\s*\n\s*paths:\s*\n\s*- ['"]tests\/e2e\/acceptance\*\.spec\.ts['"]/,
    );
    // A JOB-level key sits at exactly four spaces (`jobs:` → id → keys); the
    // step-level `if: success()` / `if: always()` below are at eight and fine.
    expect(acceptanceJob).not.toMatch(/^ {4}if:/m);
    // No `push:` trigger — `main` never runs the lane (the PR already published
    // the receipt while its story was in review).
    expect(codeOf(acceptanceWorkflow)).not.toMatch(/^\s*push:/m);
  });

  it('the e2e matrix carries no acceptance leg', () => {
    // A matrix leg is always a present check — it cannot be pruned by an
    // expression, which is why the lane had to leave the matrix.
    expect(codeOf(e2eBody!)).not.toMatch(/id:\s*acceptance/);
  });

  it('still hands the owned set to the uploader (belt and braces)', () => {
    // The `paths:` filter says "at least one spec"; the uploader needs WHICH.
    // Publishing SUPERSEDES a story's evidence and each recording targets its OWN
    // declared story, so a run that published everything it recorded would
    // replace receipts it has nothing to do with (MOTIR-1937).
    expect(acceptanceJob).toContain(
      `git diff --name-only "\${BASE_SHA}" HEAD -- ${ACCEPTANCE_SPEC_GLOB}`,
    );
    expect(acceptanceJob).toContain('BASE_SHA: ${{ github.event.pull_request.base.sha }}');
    expect(acceptanceJob).toContain(
      'ACCEPTANCE_CHANGED_SPECS: ${{ steps.owned-specs.outputs.specs }}',
    );
    expect(acceptanceJob).toContain('node scripts/upload-acceptance-video.mjs');
  });

  it('keeps the publish out of ci.yml entirely', () => {
    const publishers = [...ciJobs].filter(([, body]) =>
      codeOf(body).includes('upload-acceptance-video.mjs'),
    );
    expect(publishers.map(([id]) => id)).toEqual([]);
  });

  it('mints an OIDC token only in the workflow that publishes', () => {
    // Keyless publish (MOTIR-1650) needs `id-token: write`; ci.yml's E2E legs no
    // longer publish anything, so they no longer ask for one.
    expect(acceptanceJob).toMatch(/^\s*id-token:\s*write/m);
    expect(e2eBody).not.toMatch(/^\s*id-token:\s*write/m);
  });

  it('uploads its report under a name the e2e legs cannot collide with', () => {
    // upload-artifact@v4+ errors on a duplicate name; the e2e legs upload
    // `playwright-report-${{ matrix.id }}`.
    expect(acceptanceJob).toContain('name: playwright-report-acceptance-video');
    expect(e2eBody).not.toContain('name: playwright-report-acceptance-video');
  });
});

describe('the shared E2E setup composite (MOTIR-1949)', () => {
  const action = readFileSync(SETUP_ACTION_PATH, 'utf8');

  it('is used by BOTH Playwright lanes', () => {
    // The two lanes must not drift: every past setup fix in here was hard-won
    // (MOTIR-1679's apt-source removal, MOTIR-1706's build-artifact download).
    expect(e2eBody).toContain(SETUP_ACTION_REF);
    expect(acceptanceJob).toContain(SETUP_ACTION_REF);
  });

  it('lets the acceptance lane BUILD `.next/` instead of downloading it', () => {
    // A separate workflow cannot read another workflow's artifacts, so the
    // download path would silently fail there.
    expect(action).toMatch(/^\s*next-build:/m);
    expect(action).toContain("if: inputs.next-build == 'download'");
    expect(action).toContain("if: inputs.next-build == 'build'");
    expect(acceptanceJob).toMatch(/next-build:\s*build/);
    expect(codeOf(e2eBody!)).not.toMatch(/next-build:/); // the default: download
  });

  it('is a composite action whose run steps declare a shell', () => {
    expect(action).toMatch(/using:\s*composite/);
    // A composite `run:` without `shell:` is a load-time error for every caller.
    const steps = action.split(/^\s{4}- /m).slice(1);
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      if (/(^|\n)\s*run:/.test(step)) expect(step).toMatch(/shell:\s*bash/);
    }
  });

  it('carries the setup the lanes depend on', () => {
    expect(action).toContain('name: next-build'); // the pre-built .next/ (MOTIR-1706)
    expect(action).toContain('pnpm prisma migrate deploy');
    expect(action).toContain('packages.microsoft.com'); // MOTIR-1679
    expect(action).toContain('playwright install --with-deps chromium');
  });

  it('leaves checkout and Postgres to the caller', () => {
    // A local action cannot run before the repo is checked out, and the DB
    // container's lifetime belongs where its DATABASE_URL is set. (Both are
    // named in the action's prose, so match the `uses:` that would run them.)
    expect(action).not.toMatch(/^\s*-?\s*uses:\s*actions\/checkout/m);
    expect(action).not.toMatch(/^\s*-?\s*uses:\s*\.\/\.github\/actions\/postgres/m);
    for (const body of [e2eBody, acceptanceJob]) {
      expect(body).toMatch(/^\s*-?\s*uses:\s*actions\/checkout/m);
      expect(body).toMatch(/^\s*-?\s*uses:\s*\.\/\.github\/actions\/postgres/m);
    }
  });
});
