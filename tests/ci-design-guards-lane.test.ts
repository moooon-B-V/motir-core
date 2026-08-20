import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Guard for MOTIR-2442: the design-asset guards must run on a `design/*`
// branch, and the branch prefix must still save what it exists to save.
//
// ── The hole ────────────────────────────────────────────────────────────────
// `ci.yml` skips the Vitest, E2E, sandbox and runner-image jobs on
// `seed/` / `design/` / `docs/` branches, because a diff that edits nothing but
// `design/**` has no app code for them to exercise. Two specs in `tests/**`
// read the design ASSETS rather than the app, so for those the skip landed
// exactly backwards: the only pull requests that can break them were the only
// ones that never ran them. MOTIR-2259 merged green on
// `design/MOTIR-2259-roles-permissions`, `main` went red, and it surfaced hours
// later on an unrelated `subtask/*` PR that had touched no design asset
// (MOTIR-2441).
//
// ── The three things that must hold, and why each is here ───────────────────
//   1. The `design-guards` job runs UNCONDITIONALLY. A branch-prefix `if:` on
//      it would restore the hole in one line, and nothing else in the repo
//      would notice — workflow files are not typechecked, linted or executed by
//      any suite.
//   2. The expensive lanes still SKIP on `design/*`. Un-skipping the Playwright
//      matrix or the image builds would "fix" this card by paying the twenty
//      minutes the prefix was created to avoid, and would look like a pass.
//   3. Every spec that reads `design/**` is IN the lane. This is the part a
//      workflow file cannot state: the lane is an explicit `include` list, so
//      the next design-asset guard someone writes is un-run by default. The
//      assertion re-derives the list by scanning `tests/**` rather than
//      restating it, so a new reader fails here instead of shipping unwatched.
//
// Same mould (and the same no-YAML-dependency constraint — the repo has no YAML
// parser) as `tests/ci-complete-gate.test.ts`, which this file's job-splitting
// helper is taken from.

const ROOT = process.cwd();
const CI_PATH = join(ROOT, '.github/workflows/ci.yml');
const DESIGN_CONFIG_PATH = join(ROOT, 'vitest.design.config.ts');
const GUARD_JOB = 'design-guards';
const GATE_JOB = 'ci-complete';

const ci = readFileSync(CI_PATH, 'utf8');
const designConfig = readFileSync(DESIGN_CONFIG_PATH, 'utf8');

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
 * comment block to the job before it, and these comments quote the very
 * expressions the assertions look for (this file's own header names
 * `startsWith(github.head_ref, 'design/')` in prose).
 */
const codeOf = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

const ciJobs = jobsOf(ci);
const guardCode = codeOf(ciJobs.get(GUARD_JOB) ?? '');

/** Every `*.ts` / `*.tsx` file under `tests/`, as a repo-relative POSIX path. */
function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(relative(ROOT, path).split(sep).join('/'));
  }
  return out;
}

/**
 * Does this source build a path INTO the `design/` asset tree?
 *
 * Matching on the path BUILDER rather than the bare string is what makes this
 * total without being noisy. Every read of an asset has to compose the path,
 * and in this repo that is always `join(…)` / `resolve(…)` — while the two
 * things that would otherwise flood the result set do not compose a path at
 * all: `type: 'design'` (a work-item type, in dozens of specs) is a plain
 * value, and `packages/design-system/theme.css` (the token suites) is a quoted
 * string that starts with `packages/`, not `design`.
 */
const READS_DESIGN_TREE = /(?:join|resolve)\(\s*[^)]*?['"]design(?:\/[^'"]*)?['"]/;

/**
 * Specs that match the predicate above but deliberately do NOT belong in the
 * lane, each with the reason. Empty today, and that is the point: it exists so
 * that excluding one is a written decision rather than a silent omission.
 *
 * `tests/fly-runtime-config.test.ts` is NOT here because it does not match —
 * it names `design` as a directory the Dockerfile asserts is ABSENT from the
 * standalone output (it used to PRUNE it; MOTIR-3219 removed the sweep that
 * made a prune necessary), in a regex over the Dockerfile's own text, and never
 * builds a path into the tree.
 */
const DELIBERATELY_OUT: { file: string; why: string }[] = [];

describe('the design-asset guard lane (MOTIR-2442)', () => {
  it('finds the job and the config it is meant to guard', () => {
    // A parser regression or a rename would otherwise make every assertion
    // below pass vacuously.
    expect(ciJobs.has(GUARD_JOB)).toBe(true);
    expect(guardCode).toMatch(/^\s*name:\s*Design asset guards\s*$/m);
    expect(designConfig).toContain('include:');
  });

  it('runs the design config, and nothing that needs a database', () => {
    expect(guardCode).toContain('pnpm vitest run --config vitest.design.config.ts');
    // The two things that would put this lane back in the cost class the
    // `design/*` prefix exists to avoid — and the second of which the root
    // config would otherwise force via its per-worker-database globalSetup.
    expect(guardCode).not.toContain('prisma');
    expect(guardCode).not.toContain('actions/postgres');
  });

  it('carries NO branch-prefix condition — the hole is one `if:` wide', () => {
    // The load-bearing assertion. Everything else in this file is scaffolding
    // around it: a `design/*` PR that does not run this job is the exact state
    // MOTIR-2441 was filed for.
    expect(guardCode).not.toContain('startsWith(github.head_ref');
    expect([...guardCode.matchAll(/^ {4}if:(.*)$/gm)]).toEqual([]);
  });

  it('is gated through `CI complete` like every other job', () => {
    // Not a second required context: `protect-main` requires exactly one, and
    // adding another is what MOTIR-2008 established must not happen. The
    // gate's own test asserts the needs list is TOTAL, so this is the same
    // claim read from this card's side — a job un-needed there is un-gated.
    const gateCode = codeOf(ciJobs.get(GATE_JOB) ?? '');
    expect(gateCode).toMatch(new RegExp(`\\b${GUARD_JOB}\\b`));
  });

  it('leaves the expensive lanes skipped on a design-only diff', () => {
    // The saving the design lane exists for. "Fixing" this card by deleting the
    // skips would make the guards run and cost twenty minutes a design PR —
    // and would look identical to a pass from the guard job's side.
    //
    // The MECHANISM moved in MOTIR-3148 and the CLAIM did not: the lanes used
    // to test the branch PREFIX (`!startsWith(github.head_ref, 'design/')`),
    // which skipped them for a branch NAMED `design/*` whatever it contained.
    // They now read the `changes` job, which computes the same exclusion from
    // the DIFF. So this asserts BOTH halves — that each lane is gated on that
    // job, and that the job's exclusion set still contains design assets.
    // Asserting only the first would pass a `changes` job that had quietly
    // stopped excluding `design/`.
    for (const job of ['test', 'coverage', 'e2e', 'e2e-at-scale']) {
      expect(codeOf(ciJobs.get(job) ?? ''), job).toContain("needs.changes.outputs.app == 'true'");
    }
    for (const job of ['sandbox', 'runner-image']) {
      expect(codeOf(ciJobs.get(job) ?? ''), job).toContain(
        "needs.changes.outputs.images == 'true'",
      );
    }
    const changes = codeOf(ciJobs.get('changes') ?? '');
    expect(changes, 'the changes job exists').not.toBe('');
    expect(changes).toMatch(/docs\/\*\|design\/\*\|scripts\/plan-seed\/\*\|\*\.md/);
  });

  it('lets NO job in ci.yml decide what to run from the branch NAME (MOTIR-3148)', () => {
    // AC 3 of MOTIR-3148, as a self-recounting predicate rather than a count:
    // a job added later that reintroduces a branch-prefix gate fails this too.
    // Scoped to CODE — the comments in this workflow quote the retired
    // expression on purpose, and prose gates nothing.
    const gated = [...ciJobs.entries()]
      .filter(([, body]) => codeOf(body).includes('startsWith(github.head_ref'))
      .map(([id]) => id);
    expect(gated).toEqual([]);
  });

  it('runs EVERY spec that reads the design asset tree', () => {
    // The drift guard, and the reason this test is worth its length. The lane
    // is an explicit `include` list, so a design-asset guard written later is
    // un-run by DEFAULT — the same shape of hole as the one this card closes,
    // one level up. Re-derived from the tree rather than restated, so it
    // cannot agree with a stale list.
    const readers = testFiles(join(ROOT, 'tests')).filter((file) =>
      READS_DESIGN_TREE.test(readFileSync(join(ROOT, file), 'utf8')),
    );
    // If this trips, the PREDICATE broke (a refactor moved the path building),
    // not the lane — and a predicate that matches nothing would make the
    // assertion below vacuous.
    expect(readers.length).toBeGreaterThan(0);

    const excluded = new Set(DELIBERATELY_OUT.map((row) => row.file));
    const missing = readers.filter(
      (file) => !excluded.has(file) && !designConfig.includes(`'${file}'`),
    );
    expect(
      missing,
      'add these to vitest.design.config.ts, or to DELIBERATELY_OUT with a reason',
    ).toEqual([]);
  });

  // ── The design-result publish step (MOTIR-2664 / MOTIR-2668) ──────────────
  //
  // The step lives in THIS job rather than a workflow of its own, so that a
  // design PR gains no new check. That arrangement is only safe while four
  // things hold, and none of them is visible to a typechecker or a linter — a
  // workflow file is not executed by any suite, so this is where they are
  // stated.

  it('publishes the design result from THIS job — no second workflow, no new check', () => {
    expect(guardCode).toContain('scripts/upload-design-assets.mjs');

    // A sibling workflow would mean a new PR check on every design PR, which is
    // the cost the step-in-an-existing-job arrangement exists to avoid.
    const workflows = readdirSync(join(ROOT, '.github/workflows'));
    expect(workflows).not.toContain('design-result.yml');
    expect(workflows).not.toContain('design-assets.yml');
  });

  it('requests `id-token: write`, or the keyless publish cannot authenticate', () => {
    // Without it GitHub injects no OIDC request token, the script finds no
    // identity, and every publish silently degrades to the PAT fallback — which
    // on a repo with no secret set means: no receipts, no error, forever.
    expect(guardCode).toMatch(/permissions:[\s\S]*id-token:\s*write/);
  });

  it('publishes on `pull_request` ONLY — never again on the push to `main`', () => {
    // ci.yml runs on both. Re-publishing an identical result after merge is the
    // behaviour acceptance-video.yml avoids too — and since MOTIR-2760 it avoids
    // it the same way this lane does, by gating its publish step on the event
    // (it now has a `push: main` baseline that tests without publishing). This
    // comment previously said "by having no `push:` trigger at all".
    expect(ci).toMatch(/^on:\s*$/m);
    expect(ci).toMatch(/^\s{2}push:\s*$/m);

    const publishStep = guardCode.slice(guardCode.indexOf('Publish the design result'));
    expect(publishStep).toMatch(/if:\s*github\.event_name == 'pull_request'/);
  });

  it('carries NO `continue-on-error` — a lost publish must be able to go red', () => {
    // MOTIR-2499 removed one from the acceptance publish after it rewrote a
    // failing step's conclusion to `success` for days while two stories lost
    // their receipts. The cases that would justify one (no credential, no
    // resolvable target) are handled inside the script, which exits 0 for each.
    const publishStep = guardCode.slice(guardCode.indexOf('Publish the design result'));
    expect(publishStep).not.toContain('continue-on-error');
  });

  it('keeps the exclusion list honest in both directions', () => {
    // The same tightness `design-asset-addresses.test.ts` holds its own KNOWN
    // table to: a row that no longer describes a real reader is a mute button
    // nobody would notice, so it fails rather than lingers.
    for (const row of DELIBERATELY_OUT) {
      expect(row.why.length, row.file).toBeGreaterThan(20);
      expect(READS_DESIGN_TREE.test(readFileSync(join(ROOT, row.file), 'utf8')), row.file).toBe(
        true,
      );
    }
  });
});
