import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// A plain-node CI script with JSDoc types, imported here so its parser is
// exercised by the suite rather than only by CI. `allowJs` + `checkJs` off means
// TypeScript reads its JSDoc and types these four — which is why every reading
// below has to answer the `| null` the parser really returns.
import {
  inDependencyOrder,
  overTheLine,
  parseDiagnostics,
  projectsOf,
} from '../scripts/ci/assert-typecheck-headroom.mjs';

// Guard for MOTIR-4294 — the heap-headroom tripwire, in three parts:
//
//   1. the `typecheck` job actually RUNS the script (a tripwire nothing invokes
//      is a file);
//   2. `package.json`'s `typecheck` script carries no `--max-old-space-size`
//      (MOTIR-4293 removed it, and a bump that creeps back makes every reading
//      below meaningless — the lane would be measuring a ceiling somebody
//      raised rather than the one it runs under);
//   3. the PARSER reads a real `--extendedDiagnostics` run, and the threshold
//      comparison bites.
//
// Mould: `tests/ci-job-timeouts.test.ts` — read the real workflow text, strip
// comments so a ceiling quoted in prose satisfies nothing, and prove each
// predicate on a synthetic violation.
//
// ── The fixtures are CAPTURED, not written ──────────────────────────────────
// `tests/fixtures/typecheckHeadroom/*.txt` are the verbatim stdout of two real
// `tsc -b … --extendedDiagnostics` runs on this repository, at the TypeScript
// version `package.json` pins. That matters more than it looks: the parser's
// whole job is to read a format nobody controls, and a hand-written fixture
// tests the parser against the author's memory of that format rather than
// against the format. The scripts-project capture also carries TWO blocks — its
// dependency was built on the way — which is exactly the case the parser's
// "take the LAST" rule exists for, and it is the case a hand-written fixture
// would not have thought to include.

const ROOT = process.cwd();
const WORKFLOW = join(ROOT, '.github/workflows/ci.yml');
const SCRIPT = 'scripts/ci/assert-typecheck-headroom.mjs';

const codeOf = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

/** The `typecheck` job's body, comments stripped. */
function typecheckJob(): string {
  const yaml = readFileSync(WORKFLOW, 'utf8');
  const lines = yaml.split('\n');
  const at = lines.findIndex((l) => /^ {2}typecheck:\s*$/.test(l));
  expect(at, 'no `typecheck` job in ci.yml').toBeGreaterThan(-1);
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) break;
    body.push(line);
  }
  return codeOf(body.join('\n'));
}

const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

const fixture = (name: string): string =>
  readFileSync(join(ROOT, 'tests/fixtures/typecheckHeadroom', name), 'utf8');

// The two captures, and the limit that puts one over the line and the other
// under it. 3.4 GiB is chosen so the comparison is a real one: the tests project
// measured 3.41 GB and the scripts project 2.03 GB in these very runs.
const SCRIPTS_CAPTURE = fixture('scripts-project.txt');
const TESTS_CAPTURE = fixture('tests-project.txt');
const LIMIT_BYTES = 3.4 * 1024 ** 3;

describe('the typecheck lane reads its own heap number (MOTIR-4294)', () => {
  it('runs the headroom script as its type-check step', () => {
    const job = typecheckJob();
    expect(job, `the \`typecheck\` job must run ${SCRIPT}`).toContain(SCRIPT);
    // …and NOT a bare `pnpm typecheck` beside it. The script subsumes it; running
    // both would type-check the repository twice and report the number once.
    expect(job, 'the script subsumes `pnpm typecheck` — do not run both').not.toMatch(
      /^\s*-\s*run:\s*pnpm typecheck\s*$/m,
    );
  });

  // ⚠️ THE `packages/*` BUILD THIS LANE NEEDS IS PINNED IN
  // `tests/ci-package-build.test.ts`, not here. It began as a typecheck-lane
  // assertion, because the typecheck lane is where the missing `dist` first went
  // red (`TS2305: … has no exported member 'Button'` across files the diff never
  // touched). It is the same defect in four lanes — the git-ignored `dist` is
  // built by the root `postinstall`, and every lane skips its install on a
  // node_modules cache hit — so the assertion belongs where it can be made once
  // over all of them, with the lanes that do NOT need it argued for.

  it('BITES on a workflow whose typecheck job runs a bare `pnpm typecheck`', () => {
    // The mutation case for the workflow half: the predicate is two `toContain`s,
    // and a predicate never watched to fail may be matching nothing.
    const regressed = codeOf(['    steps:', '      - run: pnpm typecheck'].join('\n'));
    expect(regressed).not.toContain(SCRIPT);
    expect(regressed).toMatch(/^\s*-\s*run:\s*pnpm typecheck\s*$/m);
  });

  it('keeps the heap bump out of `package.json`’s typecheck script', () => {
    expect(packageJson.scripts.typecheck).toBe('tsc -b tsconfig.solution.json');
    expect(packageJson.scripts.typecheck).not.toMatch(/max-old-space-size/);
    // The BUILD script keeps its own, for the reason the `build` job's comment
    // gives: `next build` runs TypeScript in a build worker on top of the
    // compile, in one process. Pinned so "remove the bumps" never takes that one.
    expect(packageJson.scripts.build).toMatch(/max-old-space-size/);
  });

  it('BITES on a `typecheck` script that has taken a bump again', () => {
    const regressed = 'NODE_OPTIONS=--max-old-space-size=6144 tsc -b tsconfig.solution.json';
    expect(regressed).toMatch(/max-old-space-size/);
  });

  it('parses a REAL `--extendedDiagnostics` run at the pinned TypeScript version', () => {
    const scripts = parseDiagnostics(SCRIPTS_CAPTURE);
    const tests = parseDiagnostics(TESTS_CAPTURE);
    expect(scripts, 'the pinned TypeScript stopped printing `Memory used`').not.toBeNull();
    expect(tests).not.toBeNull();
    if (!scripts || !tests) throw new Error('unreachable — asserted above');
    // Real numbers from those runs, so a parser that started matching the wrong
    // line (the `Aggregate Memory used` one, say) fails here rather than
    // reporting a plausible number.
    expect(scripts.memoryKb).toBe(2130498);
    expect(scripts.files).toBe(1998);
    expect(tests.memoryKb).toBe(3576854);
    expect(tests.files).toBe(7139);
  });

  it('takes the LAST block, because a dependency is built in the same process', () => {
    // The scripts capture carries TWO blocks: `tsc -b tsconfig.scripts.json`
    // built the app project on the way. The first block is the app's (5511
    // files); the answer is the second.
    expect(SCRIPTS_CAPTURE.match(/^Memory used:/gm)).toHaveLength(2);
    expect(SCRIPTS_CAPTURE).toContain('Files:                         5511');
    expect(parseDiagnostics(SCRIPTS_CAPTURE)?.files).toBe(1998);
  });

  it('returns null on output that carries no reading at all', () => {
    // What an up-to-date `tsc -b` prints: nothing. The script treats that as a
    // hard failure rather than as a pass, because a tripwire that cannot read
    // its number is not one.
    expect(parseDiagnostics('')).toBeNull();
    expect(parseDiagnostics('Projects in this build:\n  * tsconfig.app.json\n')).toBeNull();
  });

  it('fails the reading that is over the line and passes the one that is under', () => {
    const readings = [
      { project: 'tsconfig.scripts.json', memoryKb: parseDiagnostics(SCRIPTS_CAPTURE)!.memoryKb },
      { project: 'tsconfig.tests.json', memoryKb: parseDiagnostics(TESTS_CAPTURE)!.memoryKb },
    ];
    const breached = overTheLine(readings, LIMIT_BYTES, 0.9);
    expect(breached.map((b) => b.project)).toEqual(['tsconfig.tests.json']);
    expect(breached[0]!.fraction).toBeGreaterThan(0.9);
    // …and nothing is over the line when the heap is the real one.
    expect(overTheLine(readings, 4.05 * 1024 ** 3, 0.9)).toEqual([]);
  });

  it('reads the solution’s projects and orders them dependencies-first', () => {
    const declared = projectsOf(readFileSync(join(ROOT, 'tsconfig.solution.json'), 'utf8'));
    expect(declared).toContain('tsconfig.app.json');
    expect(declared).toContain('tsconfig.tests.json');
    expect(declared.length).toBeGreaterThanOrEqual(4);

    // ⚠️ THE ORDER IS LOAD-BEARING AND ITS FAILURE IS SILENT. `tsc -b <p>` builds
    // `p`'s dependencies in the SAME process, so measuring the tests project
    // before the scripts project reports the two together — and the scripts
    // project, now up to date, then prints no diagnostics and looks like a
    // parser fault. Both halves of that were observed while this was written.
    const refs: Record<string, string[]> = {
      a: [],
      b: ['a'],
      c: ['a', 'b'],
    };
    expect(inDependencyOrder(['c', 'b', 'a'], (p: string) => refs[p] ?? [])).toEqual([
      'a',
      'b',
      'c',
    ]);
    // A project reachable only as somebody's dependency is built on the way and
    // is not measured twice.
    expect(inDependencyOrder(['c'], (p: string) => refs[p] ?? [])).toEqual(['c']);
  });

  it('parses the diagnostics of an ACTUAL `tsc` run, not only the captured one', () => {
    // ⚠️ THE SEAM (MOTIR-4300). Every assertion above reads a FIXTURE, and a
    // fixture is a photograph: it proves the parser reads the format as it was
    // on the day it was captured, and it will keep proving that after a
    // TypeScript upgrade changes the format. This is the assertion that goes red
    // instead — it runs the compiler that `package.json` pins, right now, and
    // parses what it actually printed.
    //
    // The SMALLEST project, into a THROWAWAY outDir: the package is ~3 s cold,
    // and writing somewhere else means this test neither reads nor invalidates
    // the `.tsout/` state a concurrent `pnpm typecheck` is using.
    const out = mkdtempSync(join(tmpdir(), 'typecheck-headroom-'));
    try {
      const output = execFileSync(
        process.execPath,
        [
          join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
          '-p',
          join(ROOT, 'packages/orchestrator/tsconfig.json'),
          '--outDir',
          out,
          '--tsBuildInfoFile',
          join(out, 'tsconfig.tsbuildinfo'),
          '--extendedDiagnostics',
        ],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
      );

      const parsed = parseDiagnostics(output);
      expect(parsed, 'the pinned TypeScript stopped printing `Memory used`').not.toBeNull();
      if (!parsed) throw new Error('unreachable — asserted above');
      // Real numbers, so a parser that matched the wrong line still fails: the
      // package is small but not empty, and it does allocate.
      expect(parsed.files).toBeGreaterThan(100);
      expect(parsed.memoryKb).toBeGreaterThan(50_000);
      // …and the reading is a plausible fraction of a real heap rather than a
      // number in the wrong unit, which is the other way a parser goes wrong
      // quietly (bytes read as kilobytes gates on nothing for ever).
      expect((parsed.memoryKb * 1024) / 1024 ** 3).toBeLessThan(4);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);

  it('parses a tsconfig whose include glob contains `/**/`', () => {
    // The regression this file's own parser hit: a comment-stripping regex turns
    // `"scripts/**/*.tsx"` into `"scripts*.tsx"`, because `/**/` is a valid
    // empty block comment. The script uses TypeScript's own JSONC parser for
    // exactly this, and the assertion pins it against a re-introduced regex.
    const withGlob = `{
      // a comment
      "include": ["scripts/**/*.tsx"],
      "references": [{ "path": "./tsconfig.app.json" }]
    }`;
    expect(projectsOf(withGlob)).toEqual(['tsconfig.app.json']);
  });
});
