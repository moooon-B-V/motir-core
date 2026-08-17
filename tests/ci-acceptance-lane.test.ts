import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
    // …and the lane's OWN definition is a trigger too (MOTIR-2600), or a PR that
    // restructures the lane changes no spec and never runs it. An ordinary
    // feature PR still matches nothing here, so MOTIR-1949's requirement holds.
    for (const path of [
      '.github/workflows/acceptance-video.yml',
      'playwright.acceptance.config.ts',
      'tests/e2e/_helpers/acceptance-video.ts',
    ]) {
      expect(acceptanceWorkflow).toContain(`      - '${path}'`);
    }
    // A JOB-level key sits at exactly four spaces (`jobs:` → id → keys); the
    // step-level `if: success()` / `if: always()` below are at eight and fine.
    //
    // ⚠️ STILL TRUE AFTER MOTIR-2760, and deliberately so. That card added a
    // `push: main` baseline gated by a job-level `if:`, but put it on `build` —
    // which `acceptance` already `needs:` — precisely so this assertion could
    // stay literal. It is what stops a future edit from gating the SHARD job on
    // something that would show a PR a greyed check.
    expect(acceptanceJob).not.toMatch(/^ {4}if:/m);
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

  it('does NOT run the publish under `continue-on-error` (MOTIR-2499)', () => {
    // THE fail-open. `continue-on-error: true` rewrites a step's conclusion to
    // `success` — on the checks UI, in `gh pr checks`, and in the REST API —
    // even on exit 1. Measured: from 2026-08-07 the publish failed on every run
    // ("Published 0 of 2", two `##[error]` lines) and the lane reported `pass`
    // each time, so two stories lost their receipt with nothing saying so.
    //
    // Asserted at the STEP, not the file: the workflow is allowed to keep the
    // key elsewhere, and it is only the publish step whose exit code is the
    // signal. Steps are `- ` items at eight spaces inside `steps:`.
    const steps = acceptanceJob!.split(/^ {6}- /m).slice(1);
    const publish = steps.find((s) => s.includes('node scripts/upload-acceptance-video.mjs'));
    expect(publish).toBeDefined();
    expect(codeOf(publish!)).not.toMatch(/continue-on-error/);
  });

  it('uploads its report under a name the e2e legs cannot collide with', () => {
    // upload-artifact@v4+ errors on a duplicate name; the e2e legs upload
    // `playwright-report-${{ matrix.id }}`.
    expect(acceptanceJob).toContain('name: playwright-report-acceptance-video');
    expect(e2eBody).not.toContain('name: playwright-report-acceptance-video');
  });
});

// ── MOTIR-2600 ───────────────────────────────────────────────────────────────
//
// The lane used to run every acceptance spec in ONE serial job and was
// lengthening with each story that added a spec (22.2 → 23.1 → 26.7 → 29.1 min
// across the runs on record). These assertions guard the shape that replaced it.
// They are here for the same reason the ones above are: workflow files are not
// type-checked, linted, or executed by any suite, so a regression in them is
// invisible until a lane behaves wrongly in production.
describe('the acceptance lane is SHARDED (MOTIR-2600)', () => {
  const acceptanceBuildJob = jobsOf(acceptanceWorkflow).get('build');

  it('builds `.next/` once, in its own job, and the test legs depend on it', () => {
    // One build for the whole fan-out. Without this every shard would pay a full
    // `next build`, which is most of what sharding was supposed to buy back.
    expect(acceptanceBuildJob).toBeDefined();
    expect(acceptanceBuildJob).toContain('pnpm build');
    expect(acceptanceBuildJob).toMatch(/name:\s*next-build/);
    // BOTH edges since MOTIR-2908: `build` for the artifact and the gate it
    // carries, `membership` because a job can only read the outputs of a job it
    // needs and that is where the leg count is derived. Asserted as the pair so
    // dropping either one is a failure rather than a silent behaviour change.
    expect(acceptanceJob).toMatch(/^\s*needs:\s*\[membership, build\]\s*$/m);
  });

  it('runs the suite as a shard matrix, passing the leg through to Playwright', () => {
    // The matrix and the CLI flag have to agree: a matrix that never reaches
    // `--shard` would run the WHOLE suite N times and publish each receipt N
    // times over. Since MOTIR-2908 they agree by reading the SAME output — the
    // matrix is `fromJSON(shards)` and the denominator is `legs`, both from the
    // one gate step, so they cannot drift apart.
    expect(acceptanceJob).toMatch(
      /shard:\s*\$\{\{\s*fromJSON\(needs\.membership\.outputs\.shards\)\s*\}\}/,
    );
    // `--pass-with-no-tests` (MOTIR-2769): the lane's membership is now exactly
    // the stories in review, so an EMPTY lane — and a shard leg that draws zero
    // specs from a small one — is a legitimate state, not a misconfiguration.
    // Without the flag Playwright exits non-zero on "no tests found" and every
    // PR touching this workflow goes red while no story is in flight.
    expect(acceptanceJob).toContain(
      'pnpm test:e2e --config playwright.acceptance.config.ts ' +
        '--pass-with-no-tests --shard=${{ matrix.shard }}/${{ needs.membership.outputs.legs }}',
    );
    // The fixed sizing MOTIR-2600 shipped is GONE, not merely shadowed. A
    // literal matrix left behind alongside the derived one would win silently.
    expect(acceptanceJob).not.toMatch(/shard:\s*\[1, 2, 3, 4\]/);
    expect(acceptanceJob).not.toMatch(/matrix\.total/);
  });

  it('lets every leg finish — a red shard does not cancel the others', () => {
    // `fail-fast: true` (the default) would cancel the sibling legs, and a
    // cancelled leg uploads no report: the run would lose the artifact a red
    // lane is read from, on exactly the runs that need it (MOTIR-1706).
    expect(acceptanceJob).toMatch(/fail-fast:\s*false/);
  });

  it('gives each leg its OWN report artifact name', () => {
    // upload-artifact v4+ REJECTS a second upload under an existing name, so a
    // single name would red-light three of the four legs at their last step.
    expect(acceptanceJob).toContain(
      'name: playwright-report-acceptance-video-shard-${{ matrix.shard }}',
    );
  });

  it('still resolves the owned specs and hands them to the uploader on EVERY leg', () => {
    // The receipts are the lane's product, and the publish step has been the
    // source of two separate defects already (MOTIR-1734 / MOTIR-1937). Each leg
    // publishes the recordings IT produced that this PR owns; the legs' sets are
    // disjoint by `--shard` and cover the suite, so every receipt publishes
    // exactly once. That holds only if every leg still gets the owned list —
    // a leg without it would silently rehearse its share.
    //
    // (The uploader half of this — a leg that recorded none of the changed specs
    // exits 0 rather than failing for another leg's receipt — is asserted
    // against the uploader itself in `tests/acceptance-video-uploader.test.ts`.)
    const steps = acceptanceJob!.split(/^ {6}- /m).slice(1);
    const publish = steps.find((s) => s.includes('node scripts/upload-acceptance-video.mjs'));
    expect(publish).toContain('ACCEPTANCE_CHANGED_SPECS: ${{ steps.owned-specs.outputs.specs }}');
    // Nothing gates the publish on a particular shard — that would make one leg
    // responsible for receipts recorded on another, which it cannot see.
    //
    // Through `codeOf` (MOTIR-2908), for the same reason the `continue-on-error`
    // assertion above uses it: this asks what the step DOES. The splitter
    // attributes a step's leading comment block to the step BEFORE it, so the
    // report-upload step's prose lands in this chunk — and that prose is exactly
    // where `matrix.shard` gets EXPLAINED. A guard that a correct explanation can
    // fail is a guard that pushes the next reader to delete the explanation.
    expect(codeOf(publish!)).not.toMatch(/matrix\.shard/);
  });
});

// ── MOTIR-2760 ───────────────────────────────────────────────────────────────
//
// The lane's `pull_request` filter is blind to the app the specs drive, so an
// app change could break every acceptance spec, merge green, and wait on `main`
// for an unrelated PR to inherit it (measured: MOTIR-2654 broke
// `acceptance-ai-callout.spec.ts` at c6b5d19d; MOTIR-2664's PR #2045 found it).
// The answer is a `push: main` baseline that TESTS and never PUBLISHES, gated on
// the lane actually holding a spec.
//
// These assertions pin the three things that make that affordable and safe, each
// of which is silently reversible by a one-line edit: the gate, the
// never-publish, and the PR-only cancellation.
describe('the MAIN BASELINE runs the lane on `main` (MOTIR-2760)', () => {
  const membershipJob = jobsOf(acceptanceWorkflow).get('membership');
  const buildJob = jobsOf(acceptanceWorkflow).get('build');

  it('triggers on a push to main, in ADDITION to the pull_request filter', () => {
    // Both triggers, and the PR one still first — the `paths:` assertion above
    // matches `on:` → `pull_request:` → `paths:` as adjacent lines.
    expect(codeOf(acceptanceWorkflow)).toMatch(/^\s*push:\s*$/m);
    expect(codeOf(acceptanceWorkflow)).toMatch(/^\s*branches:\s*\[main\]\s*$/m);
  });

  it('does NOT paths-filter the push trigger', () => {
    // While the lane holds a spec, ANY merge could be the one that breaks it,
    // and WHICH sources those specs read is exactly what a filter cannot know —
    // that is the MOTIR-2620 rejection. The membership gate is what bounds the
    // cost instead. A `paths:` under `push:` would silently reopen the gap.
    const push = /^\s*push:\s*\n((?:\s{4,}.*\n|\s*\n)*)/m.exec(codeOf(acceptanceWorkflow));
    expect(push).not.toBeNull();
    expect(push![1]).not.toMatch(/paths:/);
  });

  it('gates the fan-out on the lane actually holding a spec', () => {
    // THE cost control. Measured on run 31740853229 (an empty lane): 6m build +
    // 4x3m shards = 18 machine-minutes to run zero tests, and `main` takes ~20
    // merges/day. Ungated, the baseline would burn ~360 machine-min/day on an
    // empty lane — which, after the MOTIR-2769 triage, is the steady state.
    expect(membershipJob).toBeDefined();
    expect(membershipJob).toMatch(/^\s*run:\s*\$\{\{\s*steps\.gate\.outputs\.run\s*\}\}/m);
    // It must stay CHEAP, or it is just the fan-out with extra steps: a checkout
    // and a glob — no Postgres, no install, no build.
    expect(membershipJob).not.toContain('pnpm install');
    expect(membershipJob).not.toContain('actions/postgres');
    expect(membershipJob).not.toContain('pnpm build');
    // The gate hangs off `build`, and `acceptance` inherits the skip via `needs`.
    // MOTIR-2908 added a SECOND edge, `membership`, for the derived leg count —
    // it changes nothing here: `membership` always runs, so it never skips
    // `acceptance`, and the skip still arrives through `build`.
    expect(buildJob).toMatch(/^\s*needs:\s*membership\s*$/m);
    expect(buildJob).toMatch(/^\s*if:\s*needs\.membership\.outputs\.run == 'true'\s*$/m);
    expect(acceptanceJob).toMatch(/^\s*needs:\s*\[membership, build\]\s*$/m);
  });

  it('matches the lane the Playwright config would actually collect', () => {
    // `testMatch: '**/acceptance*.spec.ts'` matches on the BASENAME, so
    // `epic2-acceptance.spec.ts` is NOT a member (it rides the main lane). A gate
    // that counted `*acceptance*` would hold the baseline permanently ON against
    // an empty lane — the exact cost this job exists to avoid.
    expect(membershipJob).toContain("-name 'acceptance*.spec.ts'");
  });

  it('never lets a PR see a skipped check because of the gate', () => {
    // MOTIR-1949's requirement is about PULL REQUESTS. A `push` event attaches
    // its checks to the commit on `main`, so a skip there costs no PR anything —
    // but only because the gate is unconditionally true for a PR. If that ever
    // becomes conditional, every PR touching the four lane-definition paths
    // grows a greyed check and the requirement is gone.
    expect(membershipJob).toMatch(/EVENT_NAME[\s\S]*=[\s\S]*'pull_request'/);
    expect(membershipJob).toMatch(/RUN=true/);
  });

  it('TESTS on main but never PUBLISHES — both mechanisms', () => {
    // Publishing SUPERSEDES a story's evidence (MOTIR-1937), and the receipt
    // belongs to the moment the story was in review — not to a later merge. Two
    // independent guards, because one wrong answer destroys a receipt.
    const steps = acceptanceJob!.split(/^ {6}- /m).slice(1);
    const publish = steps.find((s) => s.includes('node scripts/upload-acceptance-video.mjs'));
    expect(publish).toBeDefined();
    // 1 — the step itself only runs on a PR.
    expect(publish).toMatch(/if:\s*success\(\) && github\.event_name == 'pull_request'/);
    // 2 — and the owned set is empty on a push anyway, which the uploader fails
    //     closed on, so even a mis-edited `if:` publishes nothing.
    const owned = steps.find((s) => s.includes('owned acceptance specs'));
    expect(owned).toContain('if [ -z "${BASE_SHA}" ]; then');
    expect(owned).toContain('echo "specs=" >> "$GITHUB_OUTPUT"');
  });

  it('cancels superseded runs on a PR but NEVER on main', () => {
    // The baseline's product is knowing WHICH merge broke the lane. Blanket
    // `cancel-in-progress: true` would have back-to-back merges cancel each
    // other and hand back exactly the ambiguity this trigger removes.
    expect(codeOf(acceptanceWorkflow)).toMatch(
      /cancel-in-progress:\s*\$\{\{\s*github\.event_name == 'pull_request'\s*\}\}/,
    );
  });
});

// ── MOTIR-2908 ───────────────────────────────────────────────────────────────
//
// The leg count is DERIVED from the lane's membership instead of fixed at four.
// `4` was right for the 26-spec lane MOTIR-2600 measured and stopped being right
// six days later, when MOTIR-2765 gave an acceptance spec a lifecycle and
// MOTIR-2769 triaged every member out: a leg is ~3 machine-minutes of pure setup,
// so four legs over a lane holding nothing is three copies of a checkout, a
// Postgres, a Playwright install and an artifact download, drawing no tests.
//
// ⚠️ THESE ASSERTIONS RUN THE SHIPPED SHELL — they do not describe it. Every
// other guard in this file is a text match, which is the right tool for a
// STRUCTURE (a `needs:` edge, an artifact name) and the wrong one for
// ARITHMETIC: a regex that agrees with `LEGS="${COUNT}"` agrees just as happily
// with an off-by-one, and the floor and the cap are exactly where an off-by-one
// would sit. So the gate step's `run:` block is extracted from the workflow and
// executed by `bash` against a fabricated lane, and the outputs it writes to
// `$GITHUB_OUTPUT` are read back — the same mechanism the runner uses.
describe('the shard count is DERIVED from the lane (MOTIR-2908)', () => {
  const membershipJob = jobsOf(acceptanceWorkflow).get('membership');

  /**
   * The `gate` step's `run: |` block, dedented — the literal script the runner
   * executes. Anchored on `id: gate` so a second `run:` block in the job cannot
   * be picked up by accident.
   */
  const gateScript = ((): string => {
    const lines = acceptanceWorkflow.split('\n');
    const gateAt = lines.findIndex((l) => /^\s*- id: gate\s*$/.test(l));
    expect(gateAt).toBeGreaterThan(-1);
    const runAt = lines.findIndex((l, i) => i > gateAt && /^\s*run: \|\s*$/.test(l));
    expect(runAt).toBeGreaterThan(gateAt);
    const indent = /^ */.exec(lines[runAt + 1]!)![0].length;
    const body: string[] = [];
    for (const line of lines.slice(runAt + 1)) {
      if (line.trim() !== '' && /^ */.exec(line)![0].length < indent) break;
      body.push(line.slice(indent));
    }
    return body.join('\n');
  })();

  /** Run the shipped gate over a lane holding `specCount` members. */
  function runGate(specCount: number, eventName: 'pull_request' | 'push') {
    const dir = mkdtempSync(join(tmpdir(), 'acceptance-gate-'));
    try {
      mkdirSync(join(dir, 'tests/e2e'), { recursive: true });
      for (let i = 1; i <= specCount; i++) {
        writeFileSync(join(dir, `tests/e2e/acceptance-story-${i}.spec.ts`), '');
      }
      // A member of the MAIN lane, not this one: `testMatch` is on the BASENAME,
      // so `acceptance` must be a PREFIX. Counting it would hold the baseline
      // permanently on — and, now, would also over-size the fan-out.
      writeFileSync(join(dir, 'tests/e2e/epic2-acceptance.spec.ts'), '');
      const outPath = join(dir, 'github-output');
      const summaryPath = join(dir, 'github-step-summary');
      writeFileSync(outPath, '');
      writeFileSync(summaryPath, '');
      execFileSync('bash', ['-c', gateScript], {
        cwd: dir,
        env: {
          ...process.env,
          EVENT_NAME: eventName,
          GITHUB_OUTPUT: outPath,
          GITHUB_STEP_SUMMARY: summaryPath,
        },
        stdio: 'pipe',
      });
      return Object.fromEntries(
        readFileSync(outPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const at = line.indexOf('=');
            return [line.slice(0, at), line.slice(at + 1)] as const;
          }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('publishes the derived fan-out as job outputs', () => {
    // A `steps.*` output is only readable by another job if the JOB re-exports
    // it. Without these two lines the matrix expression below resolves to the
    // empty string and the shard job produces no legs at all.
    expect(membershipJob).toMatch(/^\s*shards:\s*\$\{\{\s*steps\.gate\.outputs\.shards\s*\}\}/m);
    expect(membershipJob).toMatch(/^\s*legs:\s*\$\{\{\s*steps\.gate\.outputs\.legs\s*\}\}/m);
  });

  it('interpolates nothing into the gate script', () => {
    // The script reads its one variable input through `env:` (`EVENT_NAME`). A
    // `${{ }}` inside the `run:` body would be substituted by the runner before
    // bash ever sees it — which would make the executed-script assertions below
    // test something the runner does not run, and is the shape script injection
    // takes in a workflow.
    expect(gateScript).not.toContain('${{');
    expect(membershipJob).toContain('EVENT_NAME: ${{ github.event_name }}');
  });

  it.each([
    { specs: 0, legs: 1 },
    { specs: 1, legs: 1 },
    { specs: 2, legs: 2 },
    { specs: 3, legs: 3 },
    { specs: 4, legs: 4 },
    { specs: 9, legs: 4 },
    { specs: 26, legs: 4 },
  ])('sizes a $specs-spec lane to $legs leg(s)', ({ specs, legs }) => {
    const out = runGate(specs, 'pull_request');
    expect(out.count).toBe(String(specs));
    expect(out.legs).toBe(String(legs));
    // The matrix reads `shards` through `fromJSON`, so it must be a JSON array —
    // and it must enumerate exactly the legs the denominator promises, or
    // Playwright is handed a shard index outside its own partition.
    expect(JSON.parse(out.shards!)).toEqual(Array.from({ length: legs }, (_, i) => i + 1));
  });

  it('keeps MOTIR-2600 whole at the cap — a grown lane gets the sizing it measured', () => {
    // THE regression this cap exists to prevent. MOTIR-2600 sized four legs
    // against 26 specs and 25.7 min of test time; a lane that fills up again
    // must get that shape back byte-for-byte, not a serial run.
    expect(runGate(26, 'pull_request').shards).toBe('[1,2,3,4]');
    expect(runGate(4, 'push').shards).toBe('[1,2,3,4]');
  });

  it('floors an empty lane at ONE leg, and only on a PR', () => {
    // A `push` against an empty lane never reaches the fan-out at all — the
    // MOTIR-2760 gate stops at the ~10s membership job — so the floor is about
    // the PR case: a lane-definition PR runs no tests either way, and the one
    // leg is what still proves the harness BOOTS. Zero legs would prove nothing
    // on precisely the PRs whose subject is this lane.
    const push = runGate(0, 'push');
    expect(push.run).toBe('false');
    expect(push.legs).toBe('1');

    const pr = runGate(0, 'pull_request');
    expect(pr.run).toBe('true');
    expect(pr.legs).toBe('1');
    expect(pr.shards).toBe('[1]');
  });

  it('counts the lane the Playwright config would collect, not the word', () => {
    // Every case above plants an `epic2-acceptance.spec.ts` decoy; this is the
    // one that reads it. A `*acceptance*` match would count it and size a
    // one-spec lane to two legs — and hold the `push` baseline permanently on.
    expect(runGate(0, 'push').count).toBe('0');
    expect(runGate(1, 'pull_request').count).toBe('1');
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

  it('offers both `.next/` sources, and each lane takes the one it can reach', () => {
    // A separate workflow cannot read ANOTHER workflow's artifacts — which is
    // why the `build` input exists at all. It can read its OWN run's, so since
    // MOTIR-2600 the acceptance lane builds once in its own `build` job and its
    // four shards download that, rather than each compiling `.next/` itself.
    expect(action).toMatch(/^\s*next-build:/m);
    expect(action).toContain("if: inputs.next-build == 'download'");
    expect(action).toContain("if: inputs.next-build == 'build'");
    expect(acceptanceJob).toMatch(/next-build:\s*download/);
    expect(acceptanceJob).not.toMatch(/next-build:\s*build/);
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
