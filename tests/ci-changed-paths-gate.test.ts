import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Guard for MOTIR-3148. The expensive lanes in `ci.yml` used to decide whether
// to run from the BRANCH NAME — a `startsWith` test against the `seed/` /
// `design/` / `docs/` prefixes. That is a claim about the diff inferred from a
// naming convention, and it was wrong in both directions: a `subtask/…` PR
// touching only `docs/**` paid for the full E2E matrix, and a `docs/…` branch
// that touched app code SKIPPED the whole test suite and merged unverified.
//
// The `changes` job replaces it with a predicate over the actual diff. That
// makes `changes` load-bearing for the MERGE GATE, not merely for cost, and
// this file is what holds it to that. Three properties, none of which anything
// else in the repo would notice breaking (workflow files are not type-checked,
// linted, or executed by any suite):
//
//   1. It FAILS OPEN. Every path that cannot determine the diff — a
//      non-pull_request event, an unavailable base, a failed `git diff`, an
//      empty file set — must run EVERYTHING. A predicate that fails closed
//      merges untested code, which is the defect the job was written to remove.
//   2. Its IMAGE inputs match what the images are actually built from. The
//      sandbox image builds with `context: .` and `COPY . .`, so a predicate
//      scoped to `packages/cli/sandbox/**` would skip the lane on exactly the
//      changes most able to break it. Re-derived from the image workflows here
//      rather than restated, so a new image lane fails this instead of shipping
//      un-gated.
//   3. Every lane it gates actually READS it. A lane whose `if:` stopped
//      referencing the job would run unconditionally (merely wasteful) or, if
//      its `needs` were dropped, read an empty output and skip forever
//      (silently un-tested).
//
// Same mould, and the same no-YAML-parser constraint, as
// `tests/ci-complete-gate.test.ts` and `tests/ci-design-guards-lane.test.ts`.

const ROOT = process.cwd();
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const ci = read('.github/workflows/ci.yml');
const IMAGE_WORKFLOWS = [
  '.github/workflows/sandbox-images.yml',
  '.github/workflows/runner-image.yml',
];

/** Split a workflow's `jobs:` mapping into { jobId → body }. */
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
 * The same text with whole-line comments dropped. Load-bearing: this job's own
 * header quotes the retired branch-prefix expression and names the very paths
 * the assertions look for, and prose gates nothing.
 */
const codeOf = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

const ciJobs = jobsOf(ci);
const changesCode = codeOf(ciJobs.get('changes') ?? '');

/** The shell `case` patterns that set a given output to true. */
function patternsSetting(flag: string): string[] {
  return [...changesCode.matchAll(new RegExp(`^\\s*([^\\s].*?)\\)\\s*${flag}=true\\s*;;`, 'gm'))]
    .flatMap((m) => m[1]!.split('|'))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Does any `case` pattern match this path? (`*` is the only glob in use.) */
const covers = (patterns: string[], path: string): boolean =>
  patterns.some((p) => matches(p, path));

/** One `case` pattern against one path. In `case`, `*` spans `/` too. */
const matches = (pattern: string, path: string): boolean =>
  new RegExp(`^${pattern.split('*').map(escapeRe).join('.*')}$`).test(path);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The `app` classifier's arms IN ORDER.
 *
 * ⚠️ `patternsSetting` above cannot answer anything about `app`, and the reason
 * is the defect MOTIR-3806 fixed. `case` is FIRST-MATCH-WINS, so an arm's
 * POSITION decides the answer — and `app`'s last arm is the catch-all `*)`,
 * which covers every path there is. "Is there a pattern covering X" is therefore
 * `true` for every X, including the ones the job deliberately excludes. A
 * membership test would have passed just as happily before the fix as after it.
 * So this models the shell instead: arms in source order, each with whether it
 * sets `app`.
 */
const appArms: { patterns: string[]; setsApp: boolean }[] = (() => {
  const blocks = [...changesCode.matchAll(/case "\$f" in\n([\s\S]*?)\n\s*esac/g)].map((m) => m[1]!);
  const block = blocks.find((b) => /\bapp=true\b/.test(b)) ?? '';
  return block.split('\n').flatMap((line) => {
    const arm = /^\s*([^\s].*?)\)\s*(.*?)\s*;;\s*$/.exec(line);
    if (!arm) return [];
    return [
      {
        patterns: arm[1]!
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean),
        setsApp: /\bapp=true\b/.test(arm[2]!),
      },
    ];
  });
})();

/** What the job decides for one path — first matching arm wins, as `case` does. */
const classifiesAsApp = (path: string): boolean =>
  appArms.find((arm) => arm.patterns.some((p) => matches(p, path)))?.setsApp ?? false;

describe('the changed-paths gate (MOTIR-3148)', () => {
  it('finds the job it is meant to guard', () => {
    // A parser regression would otherwise make every assertion below vacuous.
    expect(ciJobs.size).toBeGreaterThan(5);
    expect(changesCode).not.toBe('');
    expect(changesCode).toMatch(/^\s*name:\s*What changed\s*$/m);
  });

  it('is gated through `CI complete` like every other job', () => {
    // Not a second required context — `protect-main` requires exactly one
    // (MOTIR-2008). The gate's own test asserts its needs list is TOTAL; this
    // is the same claim read from this job's side.
    expect(codeOf(ciJobs.get('ci-complete') ?? '')).toMatch(/\bchanges\b/);
  });

  describe('fails OPEN — the direction is the whole safety argument', () => {
    it('runs everything for an event that carries no base/head pair', () => {
      // ⚠️ THE PREDICATE IS NARROWER THAN IT WAS, AND DELIBERATELY (MOTIR-5124).
      // This used to read `if [ "$EVENT" != 'pull_request' ]`, which swept up
      // `merge_group` — an event that carries its own base and head — along with
      // the events that genuinely have none. The fail-open DIRECTION is
      // unchanged and is asserted twice over: the `case` ends in a catch-all
      // that empties the pair, and the emptiness test below is what runs every
      // lane. Both halves are needed; either alone would let a recognised event
      // with an absent payload field fall through to a `git diff ...` that
      // compares the tree with itself and answers "nothing changed".
      expect(changesCode).toMatch(/^\s*\*\)$/m);
      expect(changesCode).toMatch(/if \[ -z "\$base" \] \|\| \[ -z "\$head" \]/);
    });

    it('runs everything when the diff cannot be computed', () => {
      // Captured, THEN tested: a `git diff | …` pipeline would report the wrong
      // command's status under `pipefail` (`notes.html`, the CI-assertion traps).
      expect(changesCode).toMatch(/if ! files=\$\(git diff --name-only/);
    });

    it('runs everything when the changed-file set is empty', () => {
      expect(changesCode).toMatch(/if \[ -z "\$files" \]/);
    });

    it('emits `true true` on every one of those paths, and nowhere assumes false', () => {
      // Still THREE early exits, each emitting both flags true — MOTIR-5124
      // MERGED two cases into one arm rather than adding a fourth: the empty
      // base/head test now covers both the unclassifiable event the old
      // non-pull_request early return handled AND a recognised event whose
      // payload carried no shas, which nothing covered before. If a fourth early
      // exit is added that emits anything else, this count moves and the author
      // lands here. Every one of the three is EXECUTED in `the merge-queue arm`
      // below; this count is what catches an arm added with no case written for
      // it.
      expect([...changesCode.matchAll(/^\s*emit true true$/gm)]).toHaveLength(3);
    });

    it('stops on the first failure', () => {
      expect(changesCode).toMatch(/set -euo pipefail/);
    });
  });

  describe('reads the diff safely', () => {
    it('fetches deep enough for the merge base', () => {
      // `git diff BASE...HEAD` needs the merge base, which a shallow clone
      // lacks — and a failure there would silently take the fail-open path on
      // every PR, quietly restoring the full fan-out.
      expect(changesCode).toMatch(/fetch-depth: 0/);
    });

    it('routes every context value through `env:`, never spliced into the script', () => {
      // `${{ }}` inside a `run:` body is textual substitution, and a branch name
      // is attacker-controlled. Same rule `ci-complete` follows for `needs`.
      expect(changesCode).toMatch(
        /^\s*BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}$/m,
      );
      expect(changesCode).toMatch(
        /^\s*MERGE_BASE_SHA: \$\{\{ github\.event\.merge_group\.base_sha \}\}$/m,
      );
      expect(changesCode).toMatch(
        /^\s*MERGE_HEAD_SHA: \$\{\{ github\.event\.merge_group\.head_sha \}\}$/m,
      );
      const runBodies = changesCode
        .split(/^\s*run: \|$/m)
        .slice(1)
        .join('\n');
      expect(runBodies).not.toMatch(/\$\{\{/);
    });
  });

  // ── The classifier EXECUTED, not read (MOTIR-5124) ────────────────────────
  //
  // Every other assertion in this file is a reading of the workflow's TEXT, and
  // for the `case` arms that is the right instrument — `classifiesAsApp` models
  // first-match-wins precisely and costs nothing. It cannot answer this card's
  // question, which is about the step's CONTROL FLOW: which arm a given event
  // reaches, and what `git diff` it runs once it gets there. A text assertion
  // that `merge_group` appears somewhere in the script is satisfied by a comment
  // ABOUT merge_group, which is the failure mode this block exists to remove.
  //
  // So it runs the shipped bytes. The script is lifted out of `ci.yml` — the
  // same extraction `tests/ci-acceptance-lane.test.ts` does for the acceptance
  // lane's gate — and executed under `bash` in a throwaway git repository, with
  // the five `env:` values the job declares and a `GITHUB_OUTPUT` file to read
  // the answer back from. There is no second copy of the classifier: what is
  // tested here is the text that ships.
  //
  // ⚠️ THE FIXTURE IS SYNTHETIC AND ITS SHAPE IS NOT. `design-and-docs-only`
  // below is the file set of `moooon-B-V/motir-core#2789`, the pull request the
  // queue ejected twice: four files under `design/work-items/` and one under
  // `docs/decisions/`. Measured on the real refs at the time
  // (`git diff b2e93721...fdf871ce`, the base and head the queue branch
  // `gh-readonly-queue/main/pr-2789-b2e937215…` names), which is where the list
  // comes from. A test cannot fetch those commits, so the SHAPE is reproduced
  // locally and the provenance recorded here.
  describe('the merge-queue arm, executed (MOTIR-5124)', () => {
    /** The `classify` step's shell body, de-dented, exactly as it ships. */
    const classifyScript = ((): string => {
      const lines = ci.split('\n');
      const jobAt = lines.findIndex((l) => /^ {2}changes:\s*$/.test(l));
      expect(jobAt, 'no `changes` job in ci.yml').toBeGreaterThan(-1);
      const stepAt = lines.findIndex((l, i) => i > jobAt && /^\s*- id: classify\s*$/.test(l));
      expect(stepAt, 'no `classify` step in the `changes` job').toBeGreaterThan(jobAt);
      const runAt = lines.findIndex((l, i) => i > stepAt && /^\s*run: \|\s*$/.test(l));
      expect(runAt, 'the `classify` step has no block `run:`').toBeGreaterThan(stepAt);
      const indent = /^ */.exec(lines[runAt + 1]!)![0].length;
      const body: string[] = [];
      for (const line of lines.slice(runAt + 1)) {
        if (line.trim() !== '' && /^ */.exec(line)![0].length < indent) break;
        body.push(line.slice(indent));
      }
      return body.join('\n');
    })();

    /**
     * The file sets each fixture head adds on top of the base commit.
     *
     * `design-and-docs-only` is the ejected pull request's own shape (above).
     * The other three are the criterion's two image inputs and one app-only
     * control — the control is what stops `images` widening to "always true",
     * which would make every assertion here pass for the wrong reason.
     */
    const HEADS: Record<string, readonly string[]> = {
      'design-and-docs-only': [
        'design/work-items/design-notes.md',
        'design/work-items/provenance.mock.html',
        'design/work-items/provenance.png',
        'design/work-items/provenance.dark.png',
        'docs/decisions/work-item-provenance.md',
      ],
      'ci-runner-image-input': ['infra/ci-runner/Dockerfile'],
      'runner-image-workflow': ['.github/workflows/runner-image.yml'],
      'app-only': ['app/page.tsx'],
    };

    let repo: string;
    let base: string;
    const head: Record<string, string> = {};

    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();

    beforeAll(() => {
      repo = mkdtempSync(join(tmpdir(), 'changed-paths-gate-'));
      // `-b main` and the explicit identity: a runner with no global git config
      // cannot commit at all, and the default branch name is a user setting.
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'ci@example.invalid');
      git('config', 'user.name', 'CI fixture');
      git('config', 'commit.gpgsign', 'false');
      const write = (path: string): void => {
        const full = join(repo, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, `${path}\n`);
      };
      write('README.md');
      git('add', '-A');
      git('commit', '-qm', 'base');
      base = git('rev-parse', 'HEAD');
      for (const [name, paths] of Object.entries(HEADS)) {
        // Detached at `base` so every head is a SIBLING of the others: the
        // queue's own shape, where each entry is built on the same tip.
        git('checkout', '-q', base);
        for (const path of paths) write(path);
        git('add', '-A');
        git('commit', '-qm', name);
        head[name] = git('rev-parse', 'HEAD');
      }
      git('checkout', '-q', base);
    });

    afterAll(() => {
      if (repo) rmSync(repo, { recursive: true, force: true });
    });

    /** Run the shipped classifier with these `env:` values, and read its outputs. */
    function classify(env: {
      EVENT: string;
      BASE_SHA?: string;
      HEAD_SHA?: string;
      MERGE_BASE_SHA?: string;
      MERGE_HEAD_SHA?: string;
    }): { app: string; images: string; stdout: string } {
      const outPath = join(repo, 'github-output');
      writeFileSync(outPath, '');
      let stdout: string;
      try {
        stdout = execFileSync('bash', ['-c', classifyScript], {
          cwd: repo,
          env: {
            ...process.env,
            // All five are DECLARED in the job's `env:`, so under `set -u` the
            // script may read any of them whatever the event is. GitHub renders
            // an absent context field as the empty string; this mirrors that.
            BASE_SHA: '',
            HEAD_SHA: '',
            MERGE_BASE_SHA: '',
            MERGE_HEAD_SHA: '',
            ...env,
            GITHUB_OUTPUT: outPath,
          },
          stdio: 'pipe',
          encoding: 'utf8',
        });
      } catch (error) {
        const { stderr, stdout: out } = error as { stderr?: string; stdout?: string };
        throw new Error(
          `the classifier exited non-zero\n--- stderr ---\n${stderr ?? ''}\n--- stdout ---\n${out ?? ''}`,
        );
      }
      const outputs = Object.fromEntries(
        readFileSync(outPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const at = line.indexOf('=');
            return [line.slice(0, at), line.slice(at + 1)] as const;
          }),
      ) as Record<string, string>;
      return { app: outputs.app!, images: outputs.images!, stdout };
    }

    const asMergeGroup = (name: string) =>
      classify({ EVENT: 'merge_group', MERGE_BASE_SHA: base, MERGE_HEAD_SHA: head[name]! });
    const asPullRequest = (name: string) =>
      classify({ EVENT: 'pull_request', BASE_SHA: base, HEAD_SHA: head[name]! });

    it('lifted a script that actually runs', () => {
      // Without this the whole block can pass vacuously: an extraction that
      // returned '' would run bash on nothing, write no outputs, and every
      // assertion below would compare `undefined` against `undefined`.
      expect(classifyScript).toMatch(/^set -euo pipefail$/m);
      expect(classifyScript).not.toMatch(/\$\{\{/);
      expect(asMergeGroup('app-only').app).toBe('true');
    });

    it('emits `images=false` for a queue batch that touches no image input', () => {
      // THE DEFECT. Before this card the same call answered `images=true` — the
      // early return ran before any diff — and PR #2789 was ejected twice by a
      // twenty-minute image build its five files provably cannot affect.
      const { app, images } = asMergeGroup('design-and-docs-only');
      expect(images).toBe('false');
      // And the app lanes skip too: this is the design/docs exclusion reaching
      // the queue for the first time, which the `app` half of the job always
      // claimed to do and only ever did on a pull request.
      expect(app).toBe('false');
    });

    it.each([['ci-runner-image-input'], ['runner-image-workflow']])(
      'emits `images=true` for a queue batch touching %s',
      (name) => {
        // The direction that must NOT be lost. A batch that can change the image
        // still pays for the build — which is the one case where waiting for a
        // cold build is the point.
        expect(asMergeGroup(name).images).toBe('true');
      },
    );

    it('answers the same for a queue entry as for the pull request it holds', () => {
      // The whole claim of the fix, stated as one property: `merge_group` is now
      // classified by the SAME predicate over the SAME pair, so the queue can no
      // longer disagree with the pull request that was just reviewed. A future
      // edit that gives the queue its own arm — a different exclusion set, a
      // different default — fails here rather than in the queue.
      for (const name of Object.keys(HEADS)) {
        const queue = asMergeGroup(name);
        const pr = asPullRequest(name);
        expect({ name, ...queue }).toEqual({ name, ...pr });
      }
    });

    describe('and every fail-open arm still fires — executed, not asserted in prose', () => {
      it.each([['push'], ['workflow_dispatch'], ['schedule']])(
        'runs everything on a `%s` event, which carries no base/head',
        (event) => {
          expect(classify({ EVENT: event })).toMatchObject({ app: 'true', images: 'true' });
        },
      );

      it('runs everything when a RECOGNISED event arrives with no shas', () => {
        // The arm the old shape could not have: a `merge_group` payload whose
        // fields are absent renders as two empty strings, and `git diff ...`
        // on those compares the tree with itself and reports NOTHING CHANGED —
        // fail-closed, on the merge gate. Both recognised events are checked,
        // because the emptiness test is shared and a future edit could route
        // one of them around it.
        expect(classify({ EVENT: 'merge_group' })).toMatchObject({
          app: 'true',
          images: 'true',
        });
        expect(classify({ EVENT: 'pull_request' })).toMatchObject({
          app: 'true',
          images: 'true',
        });
      });

      it('runs everything when the diff FAILS', () => {
        // An unavailable base commit — the shallow-clone case `fetch-depth: 0`
        // exists to prevent, and a real possibility in the queue, where the base
        // is a commit on another branch.
        const absent = '0'.repeat(40);
        expect(
          classify({ EVENT: 'merge_group', MERGE_BASE_SHA: absent, MERGE_HEAD_SHA: base }),
        ).toMatchObject({ app: 'true', images: 'true' });
      });

      it('runs everything when the changed-file set is empty', () => {
        expect(
          classify({ EVENT: 'merge_group', MERGE_BASE_SHA: base, MERGE_HEAD_SHA: base }),
        ).toMatchObject({ app: 'true', images: 'true' });
      });
    });
  });

  describe('legal CONTENT counts as app code (MOTIR-3806)', () => {
    it('finds the classifier arms it models', () => {
      // Without this the whole block below passes vacuously: an unmatched
      // regex yields no arms, and `classifiesAsApp` then answers `false` for
      // every path — including the ones asserted `false` here.
      expect(appArms.length).toBeGreaterThan(1);
      expect(appArms.some((arm) => arm.setsApp)).toBe(true);
      expect(appArms.some((arm) => !arm.setsApp)).toBe(true);
    });

    it('runs the app lanes for a `content/**/*.md`-only change', () => {
      // The defect. Markdown under `content/` is not documentation — it is data
      // the app parses, and the blanket `*.md` exclusion swallowed it: PR #2427
      // — a revision of a published legal document, back when `content/legal/`
      // held those documents — skipped the entire Vitest lane, including the
      // seven `tests/legal/` suites written to guard exactly that file class.
      //
      // ⚠️ `content/` IS EMPTY TODAY (MOTIR-4103 — the legal documents moved to
      // `motir-marketing`), which is WHY these paths are written as a shape
      // rather than as the two filenames the defect was observed on. The arm is
      // a SUPPRESSOR: it protects whatever lands under `content/` next, and a
      // sample that names a deleted file reads as a stale assertion somebody
      // should delete. Neither path below needs to exist — `classifiesAsApp` is
      // a pure reading of the `case` in `ci.yml`, and that is the point: the
      // guard survives the directory being empty.
      for (const path of ['content/anything.md', 'content/nested/whatever.md']) {
        expect(classifiesAsApp(path), path).toBe(true);
      }
    });

    it('places the content arm BEFORE the `*.md` exclusion — the order IS the fix', () => {
      // `content/anything.md` matches BOTH arms, so the answer is decided
      // entirely by which one the shell reaches first. Move the content arm
      // below the exclusion and the assertion above goes red; this one says why
      // in one line, at the place a reader tidying the `case` would land — and
      // that reader now arrives at an EMPTY `content/`, which is exactly when
      // an arm like this looks like residue and is not.
      const contentArm = appArms.findIndex((arm) => arm.patterns.includes('content/*'));
      const excludeArm = appArms.findIndex((arm) => arm.patterns.includes('*.md'));
      expect(contentArm, 'a content/* arm exists').toBeGreaterThanOrEqual(0);
      expect(excludeArm, 'the *.md exclusion still exists').toBeGreaterThanOrEqual(0);
      expect(contentArm).toBeLessThan(excludeArm);
    });

    it('still skips the app lanes for genuine documentation', () => {
      // The saving, and the direction this fix must not cost. If these flip,
      // `content/*` was written too wide and every docs-only PR is back on the
      // full matrix.
      for (const path of [
        'docs/decisions/x.md',
        'README.md',
        'design/auth/design-notes.md',
        'scripts/plan-seed/x.ts',
      ]) {
        expect(classifiesAsApp(path), path).toBe(false);
      }
    });

    it('still counts an unanticipated path as code — the fail-open direction', () => {
      for (const path of ['app/page.tsx', 'lib/legal/documents.ts', 'content/anything-else.json']) {
        expect(classifiesAsApp(path), path).toBe(true);
      }
    });
  });

  describe('its IMAGE inputs match what the images are built from', () => {
    const imagePatterns = patternsSetting('images');

    it('covers every Dockerfile the image workflows build', () => {
      // Re-derived from the workflows rather than restated: a new image lane,
      // or one whose Dockerfile moves, fails here instead of shipping un-gated.
      const dockerfiles = [
        ...new Set(
          IMAGE_WORKFLOWS.flatMap((w) =>
            [...read(w).matchAll(/^\s*file: (\S+)$/gm)].map((m) => m[1]!),
          ),
        ),
      ];
      expect(dockerfiles.length).toBeGreaterThan(0);
      for (const f of dockerfiles) expect(covers(imagePatterns, f), `Dockerfile ${f}`).toBe(true);
    });

    it('covers the whole-repo build context the sandbox image actually uses', () => {
      // `context: .` + `COPY . .` + `pnpm install --frozen-lockfile` means the
      // packed CLI, the lockfile and every workspace manifest are inputs. The
      // narrow reading of this job — "the sandbox folder" — is the bug this
      // asserts against.
      const sandbox = read('.github/workflows/sandbox-images.yml');
      expect(sandbox, 'sandbox still builds from the repo root').toMatch(/^\s*context: \.$/m);
      for (const path of [
        'packages/cli/src/index.ts',
        'packages/cli/sandbox/Dockerfile',
        'pnpm-lock.yaml',
        'package.json',
        'prisma/schema.prisma',
      ]) {
        expect(covers(imagePatterns, path), path).toBe(true);
      }
    });

    it('re-proves the images when the workflows that build them change', () => {
      for (const w of [...IMAGE_WORKFLOWS, '.github/workflows/ci.yml']) {
        expect(covers(imagePatterns, w), w).toBe(true);
      }
    });

    it('does NOT run the image lanes for app-only or docs-only changes', () => {
      // The saving. If this starts passing vacuously the job has widened to
      // "always true" and the ten image jobs are back on every PR.
      for (const path of ['app/page.tsx', 'components/ui/Button.tsx', 'docs/decisions/x.md']) {
        expect(covers(imagePatterns, path), path).toBe(false);
      }
    });
  });

  describe('every lane it gates actually reads it', () => {
    it.each([
      ['test', 'app'],
      ['coverage', 'app'],
      ['e2e', 'app'],
      ['e2e-at-scale', 'app'],
      ['sandbox', 'images'],
      ['runner-image', 'images'],
    ])('%s is gated on needs.changes.outputs.%s', (job, flag) => {
      const code = codeOf(ciJobs.get(job) ?? '');
      expect(code, `${job} exists`).not.toBe('');
      expect(code).toContain(`needs.changes.outputs.${flag} == 'true'`);
      // A lane that reads the output without needing the job gets an EMPTY
      // string and skips forever — silently un-tested, the worst outcome here.
      expect(code, `${job} needs the changes job`).toMatch(/^\s*needs:.*\bchanges\b/m);
    });

    it('declares both outputs it is read for', () => {
      expect(changesCode).toMatch(/^\s*app: \$\{\{ steps\.classify\.outputs\.app \}\}$/m);
      expect(changesCode).toMatch(/^\s*images: \$\{\{ steps\.classify\.outputs\.images \}\}$/m);
    });
  });

  describe('the at-scale split (AC 2)', () => {
    const atScale = codeOf(ciJobs.get('e2e-at-scale') ?? '');

    it('runs on a merge-queue entry and on an opted-in PR, and otherwise not at all', () => {
      // ⚠️ `push` UNTIL MOTIR-4050. The legs did not leave the gate, they moved
      // one step earlier: from after the merge to the composed tree that is
      // about to become `main`. MOTIR-3148's property is untouched — still once
      // per merge, still never on an ordinary pull request.
      expect(atScale).toContain("github.event_name == 'merge_group'");
      expect(atScale).not.toContain("github.event_name == 'push'");
      expect(atScale).toContain(
        "contains(github.event.pull_request.labels.*.name, 'e2e-at-scale')",
      );
    });

    it('still gates the MERGE, so nothing reaches `main` without it', () => {
      // The legs left the PR lane, then left the push lane; they did not leave
      // the gate. `deploy` cannot be the assertion any more — the job is skipped
      // on a push, and a skipped `needs` entry would stop the release rather
      // than gate it — so the property is read where it now lives: the required
      // `CI complete` context, which a merge-queue entry must satisfy.
      expect(codeOf(ciJobs.get('deploy') ?? '')).not.toMatch(/needs:.*\be2e-at-scale\b/);
      expect(codeOf(ciJobs.get('ci-complete') ?? '')).toMatch(/\be2e-at-scale\b/);
    });

    it('holds the volume legs and none of the bulk ones', () => {
      const ids = [...atScale.matchAll(/^\s*- id: (\S+)$/gm)].map((m) => m[1]!);
      expect(ids).toEqual(
        expect.arrayContaining([
          'board-at-scale',
          'collab-at-scale',
          'reporting-at-scale',
          'billing-cloud',
        ]),
      );
      expect(ids.filter((id) => id.startsWith('bulk-') || id.startsWith('a11y-'))).toEqual([]);
    });
  });
});
