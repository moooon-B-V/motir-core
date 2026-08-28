import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
    it('runs everything when the event is not a pull request', () => {
      expect(changesCode).toMatch(/if \[ "\$EVENT" != 'pull_request' \]/);
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
      // Three fail-open branches, each emitting both flags true. If a fourth
      // early exit is added that emits anything else, this count moves and the
      // author lands here.
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
      const runBodies = changesCode
        .split(/^\s*run: \|$/m)
        .slice(1)
        .join('\n');
      expect(runBodies).not.toMatch(/\$\{\{/);
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

    it('runs the app lanes for a content/legal/*.md-only change', () => {
      // The defect. `content/legal/*.md` is not documentation — it is data the
      // app parses and renders (`lib/legal/documents.ts`), and its front-matter
      // `version` drives the re-consent gate. The blanket `*.md` exclusion
      // swallowed it, so PR #2427 — the first-ever revision of a published
      // legal document — skipped the entire Vitest lane, including the seven
      // `tests/legal/` suites that exist to guard exactly that file class.
      for (const path of ['content/legal/privacy.md', 'content/legal/terms.md']) {
        expect(classifiesAsApp(path), path).toBe(true);
      }
    });

    it('places the content arm BEFORE the `*.md` exclusion — the order IS the fix', () => {
      // `content/legal/privacy.md` matches BOTH arms, so the answer is decided
      // entirely by which one the shell reaches first. Move the content arm
      // below the exclusion and the assertion above goes red; this one says why
      // in one line, at the place a reader tidying the `case` would land.
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

    it('runs on push-to-main and on an opted-in PR, and otherwise not at all', () => {
      expect(atScale).toContain("github.event_name == 'push'");
      expect(atScale).toContain(
        "contains(github.event.pull_request.labels.*.name, 'e2e-at-scale')",
      );
    });

    it('still gates the deploy, so `main` cannot release without it', () => {
      // The legs left the PR lane; they did not leave the release gate.
      expect(codeOf(ciJobs.get('deploy') ?? '')).toMatch(/needs:.*\be2e-at-scale\b/);
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
