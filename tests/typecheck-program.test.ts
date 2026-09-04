import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

// Guard for MOTIR-4293: the type-check is a SOLUTION of project references, and
// it cannot silently regress to the one program it was split out of.
//
// ── The hole ────────────────────────────────────────────────────────────────
// `tsconfig.json` used to include `**/*.ts` over the whole repository, so 811
// app files, 1113 `lib/` files, 1814 tests, 116 scripts and the 113-file
// generated Prisma client were ONE `tsc` program. Checker memory is
// proportional to the program, so each of those paid for the others' types:
// `tsc --noEmit --extendedDiagnostics` used 4.42 GB on `main` (`9c077d4c1`)
// against node 22's ~4.05 GB default old-space on the same box. The `build` job hit that ceiling
// at MOTIR-1789 and took a heap bump; the `typecheck` job hit it at MOTIR-3878
// and took the same bump the same day. Every further bump moves the cliff and
// none removes it.
//
// ── Why a TEST and not a review note ────────────────────────────────────────
// The regression is a ONE-LINE, well-meaning edit. Someone whose file is not
// being checked adds `"**/*.ts"` back to `tsconfig.json`'s `include`, or drops
// `"tests"` from its `exclude`, and everything goes green — the program is
// simply large again, and the only symptom is a heap number nobody reads until
// a red pull request names no file. Config files are not typechecked, not
// linted and not executed by any suite, so this file is the only thing standing
// between the split and its own reversal. (MOTIR-4294's tripwire is the other
// half: it reads the heap NUMBER in CI. This one reads the SHAPE.)
//
// ── The four things that must hold ──────────────────────────────────────────
//   1. `tsconfig.json`'s `include` names no whole-tree glob, and its `exclude`
//      names `tests` and `scripts`. That is what makes it the PRODUCT program.
//   2. `tsconfig.solution.json` references EVERY `composite` project in the
//      repository root — a project left off the list is simply not type-checked,
//      silently and greenly, which is the same defect one level up.
//   3. `tsconfig.app.json` EXTENDS `./tsconfig.json` rather than restating its
//      include set, so Next's file and the composite project can never disagree
//      about which files are the app.
//   4. `package.json`'s `typecheck` script builds the solution and carries no
//      `--max-old-space-size`. Reversing MOTIR-3878's stopgap is the whole point
//      of the split; a bump that creeps back in makes the split unmeasurable.
//
// Same mould as `tests/ci-job-timeouts.test.ts`: read the real files, re-derive
// rather than list, and prove each predicate BITES on a synthetic violation —
// a green run must mean "no leak", never "no scan".

const ROOT = process.cwd();

/** Every tsconfig in the repository root, read as JSONC (they carry comments). */
const readTsconfig = (name: string): Record<string, unknown> => {
  const text = readFileSync(join(ROOT, name), 'utf8');
  const parsed = ts.parseConfigFileTextToJson(name, text);
  expect(parsed.error, `${name}: does not parse as JSONC`).toBeUndefined();
  return parsed.config as Record<string, unknown>;
};

const asStrings = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]) : []);

/**
 * Is this filename a tsconfig at the repository ROOT? Exported so the mutation
 * case below can exercise the predicate itself rather than trust it.
 */
export const isRootTsconfig = (name: string): boolean => /^tsconfig(\..+)?\.json$/.test(name);

/**
 * The projects the solution file must compose — DISCOVERED FROM DISK, which is
 * what the comment on this constant used to claim while the list underneath it
 * was hand-written (MOTIR-4363).
 *
 * ⚠️ WHY THE HAND-WRITTEN LIST WAS A HOLE, and it is precisely the hole this
 * file exists to close, one level up. `compositeProjects` is derived from this
 * constant, and the *references EVERY composite project* assertion below is
 * quantified over `compositeProjects`. So a new composite project that nobody
 * added HERE was exempt from that assertion — and the assertion's own comment
 * says a project left off the solution file "is simply not type-checked,
 * silently and greenly". The guard against a silent omission was itself
 * omission-shaped: adding `tsconfig.e2e.json` to the solution and forgetting it
 * here would have gone green, and so would forgetting it in BOTH places.
 *
 * Reading the directory removes the second copy. The non-vacuity floor is
 * `REQUIRED_TSCONFIGS` below — a glob that starts matching nothing must fail
 * loudly rather than pass over an empty set.
 */
const ROOT_TSCONFIGS = readdirSync(ROOT).filter(isRootTsconfig).sort();

/**
 * The root tsconfigs this repository cannot lose without the split being over.
 * This is the FLOOR, not the population: discovery above is the population, and
 * a name here that stops existing fails rather than silently shrinking the set.
 */
const REQUIRED_TSCONFIGS = [
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.base.json',
  'tsconfig.app.json',
  'tsconfig.tests.json',
  'tsconfig.e2e.json',
  'tsconfig.scripts.json',
  'tsconfig.solution.json',
] as const;

// ── The predicates, as functions so the mutation cases can run them ──────────

/**
 * A `tsconfig.json` that has regressed to one program. Either tell is enough:
 * a whole-tree glob in `include`, or an `exclude` that has stopped naming the
 * two directories the split moved out.
 */
export const isOneProgram = (config: {
  include?: unknown;
  exclude?: unknown;
}): { oneProgram: boolean; why: string[] } => {
  const why: string[] = [];
  const include = asStrings(config.include);
  const exclude = asStrings(config.exclude);
  for (const glob of include) {
    // `app/**/*.ts` is fine; `**/*.ts` and `./**/*.tsx` are the whole tree.
    if (/^\.?\/?\*\*\/\*\.(ts|tsx|mts|cts)$/.test(glob)) {
      why.push(`include carries the whole-tree glob ${JSON.stringify(glob)}`);
    }
  }
  for (const dir of ['tests', 'scripts']) {
    if (!exclude.some((e) => e === dir || e === `${dir}/**` || e === `./${dir}`)) {
      why.push(`exclude does not name ${JSON.stringify(dir)}`);
    }
  }
  return { oneProgram: why.length > 0, why };
};

/** The composite projects a solution file must reference. */
export const missingFromSolution = (
  solution: { references?: unknown },
  compositeProjects: string[],
): string[] => {
  const referenced = new Set(
    (Array.isArray(solution.references) ? solution.references : [])
      .map((r) => (r as { path?: string }).path ?? '')
      .map((p) => p.replace(/^\.\//, '')),
  );
  return compositeProjects.filter((p) => !referenced.has(p));
};

/** The heap bump this story reverses, wherever it hides in a script. */
export const carriesHeapBump = (script: string): boolean => /max-old-space-size/.test(script);

// ── The real files ──────────────────────────────────────────────────────────

const configs = new Map(ROOT_TSCONFIGS.map((name) => [name, readTsconfig(name)] as const));

const compositeProjects = ROOT_TSCONFIGS.filter((name) => {
  const options = (configs.get(name)?.compilerOptions ?? {}) as { composite?: boolean };
  return options.composite === true;
});

const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('the type-check is a solution of project references (MOTIR-4293)', () => {
  it('discovers every root tsconfig and at least four composite projects', () => {
    // Without this, a rename or a parser regression would make every assertion
    // below pass vacuously — the failure mode this whole file exists to prevent,
    // one level down. Since ROOT_TSCONFIGS is now READ from disk, comparing it
    // against `configs` would be a tautology; the non-vacuity comes from the
    // floor instead — a glob matching nothing, or a rename, fails HERE.
    for (const name of REQUIRED_TSCONFIGS) {
      expect(ROOT_TSCONFIGS, `${name} is missing from the repository root`).toContain(name);
    }
    expect(ROOT_TSCONFIGS.length).toBeGreaterThanOrEqual(REQUIRED_TSCONFIGS.length);
    expect([...configs.keys()].sort()).toEqual([...ROOT_TSCONFIGS].sort());
    expect(compositeProjects.length).toBeGreaterThanOrEqual(4);
    expect(compositeProjects).toContain('tsconfig.app.json');
    expect(compositeProjects).toContain('tsconfig.tests.json');
    expect(compositeProjects).toContain('tsconfig.e2e.json');
    expect(compositeProjects).toContain('tsconfig.scripts.json');
  });

  it('BITES on a discovery that has stopped seeing the root tsconfigs', () => {
    // The mutation case for the predicate the whole file now depends on. A
    // discovery that silently matched nothing would exempt every project from
    // every assertion below — the same silent-and-green failure one tier up.
    const discover = (names: string[]) => names.filter(isRootTsconfig).sort();
    expect(discover(['tsconfig.json', 'tsconfig.e2e.json', 'package.json'])).toEqual([
      'tsconfig.e2e.json',
      'tsconfig.json',
    ]);
    // …and it does not sweep in the build state or a near-miss neighbour.
    expect(discover(['tsconfig.tsbuildinfo', 'jsconfig.json', 'my-tsconfig.json'])).toEqual([]);
    expect(discover(['README.md'])).toEqual([]);
  });

  it('keeps `tsconfig.json` the PRODUCT program — no whole-tree glob, tests and scripts excluded', () => {
    const verdict = isOneProgram(configs.get('tsconfig.json')!);
    expect(
      verdict.why,
      'tsconfig.json has regressed towards one program — see tsconfig.base.json for why that is expensive',
    ).toEqual([]);
    expect(verdict.oneProgram).toBe(false);
  });

  it('BITES on a config that has regressed to one program', () => {
    // The mutation case. A predicate that never fails is a tautology, not a
    // guard — and the regression this file exists for is exactly a one-line
    // edit to `include`.
    expect(isOneProgram({ include: ['**/*.ts'], exclude: ['tests', 'scripts'] }).why).toEqual([
      'include carries the whole-tree glob "**/*.ts"',
    ]);
    expect(isOneProgram({ include: ['app/**/*.ts'], exclude: ['node_modules'] }).why).toEqual([
      'exclude does not name "tests"',
      'exclude does not name "scripts"',
    ]);
    // …and stays quiet on the shape that is actually correct.
    expect(
      isOneProgram({ include: ['app/**/*.ts', 'lib/**/*.tsx'], exclude: ['tests', 'scripts'] })
        .oneProgram,
    ).toBe(false);
  });

  it('references EVERY composite project from the solution file', () => {
    expect(
      missingFromSolution(configs.get('tsconfig.solution.json')!, compositeProjects),
      'a composite project missing from tsconfig.solution.json is simply never type-checked',
    ).toEqual([]);
    // The solution owns no files of its own — it is a list of projects.
    expect(configs.get('tsconfig.solution.json')!.files).toEqual([]);
  });

  it('BITES on a solution file that has dropped a project', () => {
    expect(
      missingFromSolution({ references: [{ path: './tsconfig.app.json' }] }, [
        'tsconfig.app.json',
        'tsconfig.tests.json',
      ]),
    ).toEqual(['tsconfig.tests.json']);
  });

  it('layers the composite app project ON TOP of Next’s file rather than copying it', () => {
    // If `tsconfig.app.json` restated the include set, Next's file and the
    // project the tests reference could disagree about which files are the app —
    // and the disagreement would show up as a missing declaration, not as an
    // error anyone can read.
    expect(configs.get('tsconfig.app.json')!.extends).toBe('./tsconfig.json');
    expect(configs.get('tsconfig.app.json')!.include).toBeUndefined();
    // A referenced project must EMIT declarations; a `noEmit` reference does not
    // resolve under `tsc -b`.
    const appOptions = configs.get('tsconfig.app.json')!.compilerOptions as Record<string, unknown>;
    expect(appOptions.noEmit).toBe(false);
    expect(appOptions.emitDeclarationOnly).toBe(true);
    expect(appOptions.composite).toBe(true);
    // …and the tests and scripts projects consume it through that emit.
    for (const name of ['tsconfig.tests.json', 'tsconfig.scripts.json'] as const) {
      const refs = (configs.get(name)!.references ?? []) as { path?: string }[];
      expect(
        refs.map((r) => r.path),
        `${name} must reference the app project`,
      ).toContain('./tsconfig.app.json');
    }
  });

  it('builds the solution from `pnpm typecheck`, at the DEFAULT heap', () => {
    // MOTIR-3878's stopgap, reversed. The split is only proven by the bump being
    // gone; a bump that creeps back makes the ceiling unmeasurable again.
    expect(packageJson.scripts.typecheck).toBe('tsc -b tsconfig.solution.json');
    expect(carriesHeapBump(packageJson.scripts.typecheck!)).toBe(false);
    // `next build` runs TypeScript in a build WORKER on top of the compile, and
    // keeps its own ceiling for the reason the `build` job's comment in ci.yml
    // gives. That one is deliberately untouched.
    expect(carriesHeapBump(packageJson.scripts.build!)).toBe(true);
  });

  it('BITES on a `typecheck` script that has taken a heap bump again', () => {
    expect(
      carriesHeapBump('NODE_OPTIONS=--max-old-space-size=6144 tsc -b tsconfig.solution.json'),
    ).toBe(true);
    expect(carriesHeapBump('tsc -b tsconfig.solution.json')).toBe(false);
  });

  it('writes every project’s build state under the git-ignored `.tsout/`', () => {
    // Criterion 6: the per-project `.tsbuildinfo` lands under `.tsout/`, not
    // beside the sources, and nothing from the build is committable.
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    expect(ignore).toMatch(/^\/\.tsout\/$/m);
    for (const name of compositeProjects) {
      const options = configs.get(name)!.compilerOptions as Record<string, unknown>;
      expect(options.outDir, `${name}: must emit into .tsout/`).toMatch(/^\.tsout\//);
      expect(options.tsBuildInfoFile, `${name}: must keep its build state in .tsout/`).toMatch(
        /^\.tsout\//,
      );
    }
  });
});
