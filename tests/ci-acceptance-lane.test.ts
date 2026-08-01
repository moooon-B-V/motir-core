import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guard for MOTIR-1949: the acceptance-video lane must be ABSENT — not present
// and skipped — on a PR that changes no `tests/e2e/acceptance*.spec.ts`. Before
// it, the lane was an `e2e` matrix leg with no relevance gate, so every ordinary
// PR paid ~11 minutes (the run's long pole) and a ~419 MB video/trace artifact
// to record eight clips that MOTIR-1937 then correctly refused to publish.
//
// These assertions exist because nothing else would catch a regression: the
// workflow files are not type-checked, linted, or executed by any suite. Same
// mould as `tests/ci-postgres-container.test.ts`, and the same no-YAML-dependency
// constraint — the repo has no YAML parser, so the file is split by indentation.

const CI_PATH = join(process.cwd(), '.github/workflows/ci.yml');
const SETUP_ACTION_PATH = join(process.cwd(), '.github/actions/e2e-setup/action.yml');
const SETUP_ACTION_REF = 'uses: ./.github/actions/e2e-setup';
const ACCEPTANCE_CONFIG = 'playwright.acceptance.config.ts';
const ACCEPTANCE_SPEC_GLOB = "'tests/e2e/acceptance*.spec.ts'";

const source = readFileSync(CI_PATH, 'utf8');

/**
 * Split the workflow's `jobs:` mapping into { jobId → body }. Job ids sit at
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

const jobs = jobsOf(source);
const jobBody = (id: string): string => {
  const body = jobs.get(id);
  if (body === undefined) throw new Error(`ci.yml has no \`${id}\` job`);
  return body;
};

/**
 * The same body with whole-line comments dropped. Needed wherever an assertion
 * asks what a job DOES: the parser above attributes a job's leading comment
 * block to the job before it, and these jobs describe each other in prose.
 */
const codeOf = (body: string): string =>
  body
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

describe('the acceptance-video lane is story-scoped (MOTIR-1949)', () => {
  it('finds the three jobs it is meant to guard', () => {
    // A parser regression (or a workflow restructure) would otherwise make every
    // assertion below pass vacuously.
    expect([...jobs.keys()]).toEqual(
      expect.arrayContaining(['acceptance-specs', 'e2e', 'acceptance']),
    );
  });

  it('runs the acceptance config from ONE job, and it is not an `e2e` matrix leg', () => {
    // A matrix leg cannot be dropped by an expression, so a leg is always a
    // present check. The whole fix is that this lane is its own job.
    expect(codeOf(jobBody('e2e'))).not.toContain(ACCEPTANCE_CONFIG);
    expect(codeOf(jobBody('acceptance'))).toContain(ACCEPTANCE_CONFIG);
    const owners = [...jobs].filter(([, body]) => codeOf(body).includes(ACCEPTANCE_CONFIG));
    expect(owners.map(([id]) => id)).toEqual(['acceptance']);
  });

  it('gates the acceptance job on the specs THIS run changed', () => {
    const body = jobBody('acceptance');
    // The job-level `if:` is what makes the check absent rather than skipped, and
    // it can only read a `needs.*` output — hence the separate detector job.
    expect(body).toMatch(
      /^\s*if:\s*\$\{\{\s*needs\.acceptance-specs\.outputs\.specs\s*!=\s*''\s*\}\}/m,
    );
    expect(body).toMatch(/^\s*needs:\s*\[build,\s*acceptance-specs\]/m);
  });

  it('detects the owned specs from the PR diff, and owns nothing on a push', () => {
    const body = jobBody('acceptance-specs');
    expect(body).toMatch(/^\s*outputs:\s*$/m);
    expect(body).toMatch(/specs:\s*\$\{\{\s*steps\.detect\.outputs\.specs\s*\}\}/);
    expect(body).toContain('BASE_SHA: ${{ github.event.pull_request.base.sha }}');
    expect(body).toContain(`git diff --name-only "\${BASE_SHA}" HEAD -- ${ACCEPTANCE_SPEC_GLOB}`);
    // FAILS CLOSED: a push build (no PR, so no base) owns nothing, which also
    // means no acceptance job on `main` — the PR already published the receipt
    // while the story was in review.
    expect(body).toMatch(
      /if \[ -z "\$\{BASE_SHA\}" \]; then[\s\S]*?echo "specs=" >> "\$GITHUB_OUTPUT"/,
    );
  });

  it('still hands the owned set to the uploader (belt and braces)', () => {
    // The job gate and the uploader's own filter fail differently — the uploader
    // is per-recording and fails closed on a sidecar with no specFile — so a PR
    // that changes ONE spec publishes ONE story's receipt, not all eight it
    // recorded (MOTIR-1937).
    expect(jobBody('acceptance')).toContain(
      'ACCEPTANCE_CHANGED_SPECS: ${{ needs.acceptance-specs.outputs.specs }}',
    );
    expect(jobBody('acceptance')).toContain('node scripts/upload-acceptance-video.mjs');
  });

  it('keeps the publish out of every OTHER job', () => {
    const publishers = [...jobs].filter(([, body]) => body.includes('upload-acceptance-video.mjs'));
    expect(publishers.map(([id]) => id)).toEqual(['acceptance']);
  });

  it('uploads the acceptance report under its own artifact name', () => {
    // upload-artifact@v4+ errors on a duplicate name, and the e2e legs upload
    // `playwright-report-${{ matrix.id }}`.
    expect(jobBody('acceptance')).toContain('name: playwright-report-acceptance-video');
    expect(jobBody('e2e')).not.toContain('name: playwright-report-acceptance-video');
  });

  it('mints an OIDC token only in the job that publishes', () => {
    // Keyless publish (MOTIR-1650) needs `id-token: write`; the e2e legs no
    // longer publish anything, so they no longer ask for one.
    expect(jobBody('acceptance')).toMatch(/^\s*id-token:\s*write/m);
    expect(jobBody('e2e')).not.toMatch(/^\s*id-token:\s*write/m);
  });
});

describe('the shared E2E setup composite (MOTIR-1949)', () => {
  const action = readFileSync(SETUP_ACTION_PATH, 'utf8');

  it('is used by BOTH Playwright jobs', () => {
    // The two lanes must not drift: every past setup fix in here was hard-won
    // (MOTIR-1679's apt-source removal, MOTIR-1706's build-artifact download).
    expect(jobBody('e2e')).toContain(SETUP_ACTION_REF);
    expect(jobBody('acceptance')).toContain(SETUP_ACTION_REF);
  });

  it('is a composite action whose run steps declare a shell', () => {
    expect(action).toMatch(/using:\s*composite/);
    const runs = [...action.matchAll(/^\s{4}- (?:name:.*\n(?:\s{6}.*\n)*?)?\s*run:/gm)];
    expect(runs.length).toBeGreaterThan(0);
    // A composite `run:` without `shell:` is a load-time error for every caller.
    const steps = action.split(/^\s{4}- /m).slice(1);
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
    for (const job of ['e2e', 'acceptance'] as const) {
      expect(jobBody(job)).toMatch(/^\s*-?\s*uses:\s*actions\/checkout/m);
      expect(jobBody(job)).toMatch(/^\s*-?\s*uses:\s*\.\/\.github\/actions\/postgres/m);
    }
  });
});
