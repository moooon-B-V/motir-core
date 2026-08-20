import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { DATABASE_BOUND_GUARDS, STRUCTURAL_GUARD_SPECS } from './helpers/structuralGuardLane';

// MOTIR-3144 — the guard ON the structural-guard lane.
//
// ── What this file exists to prevent ────────────────────────────────────────
// The lane is an explicit `include` list, which is the right shape (a glob over
// `tests/rls/**` would sweep up the two guards that legitimately need a
// database) and the wrong shape for staying complete. A whole-tree guard written
// next month lands in `tests/**`, runs inside the sharded database job by
// default, and nothing says otherwise until it times out on somebody else's pull
// request — which is precisely the bug this card fixed, one level up.
//
// So membership is DERIVED here and compared against the list. A new guard fails
// this test, with the file named, until it is either added to the lane or
// declared in `DATABASE_BOUND_GUARDS` with a reason.
//
// ── The predicate, and the line it deliberately draws ───────────────────────
// A file is a CANDIDATE when it imports a scanner module — a module under
// `tests/` that walks the source tree and parses it with the TypeScript
// compiler API. That is the expensive shape, it is the shape every instance of
// this flake has had (MOTIR-2815, MOTIR-3067, and this card), and it derives
// exactly and without false positives.
//
// ⚠️ Deliberately NOT "everything under tests/rls/". That directory holds
// database-backed policy suites as well as scanners, and both exceptions below
// are in it. Naming a directory would have been easier and would have been wrong.
//
// ⚠️ AND NOT "anything that calls readdirSync over a source root" — measured,
// that predicate matches THIRTY-ONE files, including story-gates and several
// database-backed integration suites. Most walk a handful of directories and
// have never been implicated in a timeout; moving them would be a different and
// much larger change than this card, with real risk. The lane's four
// non-scanner members (the rate-limit and ink-contrast guards) are therefore
// listed explicitly and asserted present below, rather than derived. If a
// future instance of this flake lands on a guard outside the scanner set, that
// wider population is where to look — it is recorded on MOTIR-3144.

const ROOT = resolve(__dirname, '..');
const TESTS = join(ROOT, 'tests');
const GUARDS_CONFIG = readFileSync(join(ROOT, 'vitest.guards.config.ts'), 'utf8');
const ROOT_CONFIG = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
const CI = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const PACKAGE_JSON = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/** Every `.ts`/`.tsx` file under `tests/`, repo-relative with forward slashes. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(relative(ROOT, full).split(sep).join('/'));
  }
  return out;
}

const ALL_TEST_FILES = walk(TESTS);

/** A module under `tests/` that itself walks the source tree. */
const SCANNER_MODULES = ALL_TEST_FILES.filter((f) => {
  if (/\.test\.tsx?$/.test(f)) return false;
  const src = readFileSync(join(ROOT, f), 'utf8');
  return /createSourceFile|SCAN_ROOTS/.test(src) && /readdirSync/.test(src);
});

/** `tests/rls/bareTransactionScan.ts` → `bareTransactionScan`. */
const SCANNER_BASENAMES = SCANNER_MODULES.map((f) =>
  f
    .split('/')
    .pop()!
    .replace(/\.tsx?$/, ''),
);

function importsScanner(file: string): boolean {
  if (!/\.test\.tsx?$/.test(file)) return false;
  const src = readFileSync(join(ROOT, file), 'utf8');
  return SCANNER_BASENAMES.some((name) => new RegExp(`from\\s+['"][^'"]*${name}['"]`).test(src));
}

/** Every guard that reaches a whole-tree AST scan — derived, not listed. */
const CANDIDATES = ALL_TEST_FILES.filter(importsScanner);

/**
 * The lane members that do their OWN text walk rather than importing a scanner.
 * Listed because the mechanical predicate for "walks a tree" is far broader than
 * this class (see the header), so these are asserted present instead of derived.
 */
const SELF_WALKING_MEMBERS = [
  'tests/rateLimit/one-counter-guard.test.ts',
  'tests/rateLimit/storeDeadline.test.ts',
  'tests/theme/inkContrastLint.test.ts',
  'tests/theme/inkContrastScan.test.ts',
  'tests/theme/shellViewportUnits.test.ts',
] as const;

describe('the structural-guard lane (MOTIR-3144)', () => {
  it('finds scanners and candidates at all — the predicate is not vacuous', () => {
    // Without this, every assertion below passes on an empty set, which is the
    // way a totality test dies quietly.
    expect(SCANNER_MODULES.length).toBeGreaterThanOrEqual(7);
    expect(CANDIDATES.length).toBeGreaterThanOrEqual(6);
  });

  it('runs EVERY whole-tree guard, or says why one stays behind', () => {
    const inLane = new Set<string>(STRUCTURAL_GUARD_SPECS);
    const declared = new Set(Object.keys(DATABASE_BOUND_GUARDS));
    const unaccounted = CANDIDATES.filter((f) => !inLane.has(f) && !declared.has(f));

    // The message is the point: a new guard names itself here rather than
    // timing out on an unrelated pull request weeks later.
    expect(
      unaccounted,
      `These files scan the source tree but are in neither the structural-guard lane nor ` +
        `DATABASE_BOUND_GUARDS. Add each to STRUCTURAL_GUARD_SPECS in ` +
        `tests/helpers/structuralGuardLane.ts, or — if it genuinely needs a database — to ` +
        `DATABASE_BOUND_GUARDS with the reason.`,
    ).toEqual([]);
  });

  it('carries the self-walking guards too — the half the predicate cannot derive', () => {
    // These do their own `readdirSync` rather than importing a scanner, so
    // nothing derives them. If one is dropped from the lane it lands back in the
    // sharded job silently, which is the failure this whole card is about.
    for (const spec of SELF_WALKING_MEMBERS) {
      expect(STRUCTURAL_GUARD_SPECS as readonly string[], `${spec} left the lane`).toContain(spec);
    }
  });

  it('every file in the lane EXISTS and is a test', () => {
    // A rename that misses this list would silently shrink the lane to nothing,
    // and Vitest exits 0 on an `include` that matches no files.
    for (const spec of STRUCTURAL_GUARD_SPECS) {
      expect(ALL_TEST_FILES, `${spec} is listed in the lane but not present`).toContain(spec);
    }
  });

  it('the two exceptions are REAL — each named file actually binds a database', () => {
    // Otherwise `DATABASE_BOUND_GUARDS` becomes a place to park anything
    // inconvenient, which is how an exception list stops meaning anything.
    for (const [file, reason] of Object.entries(DATABASE_BOUND_GUARDS)) {
      expect(ALL_TEST_FILES, `${file} is declared an exception but does not exist`).toContain(file);
      const src = readFileSync(join(ROOT, file), 'utf8');
      expect(
        /helpers\/adminDb|@\/lib\/db|\.\.\/fixtures/.test(src),
        `${file} is declared database-bound but imports no database`,
      ).toBe(true);
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  it('NOTHING in the lane reaches lib/, app/ or components/', () => {
    // Two properties at once: the lane needs no Prisma client to start, and it
    // can carry no coverage out of the merged report when it leaves the
    // `--coverage` shards. `storeDeadline` violated both through a single
    // constant until MOTIR-3144 moved it to a dependency-free module.
    for (const spec of STRUCTURAL_GUARD_SPECS) {
      const src = readFileSync(join(ROOT, spec), 'utf8');
      const imports = [...src.matchAll(/^import[^;]*?from\s+'([^']+)';/gm)].flatMap((m) =>
        m[1] === undefined ? [] : [m[1]],
      );
      const reaching = imports.filter((i) => /^@\/(lib|app|components)\//.test(i));
      expect(reaching, `${spec} imports app code: ${reaching.join(', ')}`).toEqual([]);
    }
  });

  it('the root config EXCLUDES exactly what this lane includes', () => {
    // The two must be the same list, which is why it is one import in both.
    expect(ROOT_CONFIG).toContain("from './tests/helpers/structuralGuardLane'");
    expect(ROOT_CONFIG).toContain('...STRUCTURAL_GUARD_SPECS');
    // `exclude` REPLACES Vitest's default, so dropping `defaultExclude` would
    // put node_modules back into the run.
    expect(ROOT_CONFIG).toContain('...defaultExclude');
    expect(GUARDS_CONFIG).toContain('...STRUCTURAL_GUARD_SPECS');
  });

  it('has a CI job of its own, with no database and no coverage', () => {
    expect(CI).toMatch(/^ {2}structural-guards:$/m);
    expect(CI).toMatch(/^ {4}name: Structural guards$/m);

    const job = CI.slice(CI.indexOf('\n  structural-guards:'), CI.indexOf('\n  typecheck:'));
    expect(job).toContain('pnpm test:guards');
    // The whole point of the lane is that it costs an install and ~20 seconds.
    // Either of these would put it back in the class it was moved out of.
    expect(job).not.toContain('prisma');
    expect(job).not.toContain('actions/postgres');
    expect(job).not.toContain('--coverage');
    // No branch-prefix condition: a structural guard is exactly as relevant on a
    // `docs/` or `design/` branch, and cheap enough to always run.
    expect([...job.matchAll(/^ {4}if:(.*)$/gm)]).toEqual([]);
  });

  it('is gated through `CI complete`, like every other job', () => {
    // A job absent from `needs` is a job whose failure merges.
    const gate = CI.slice(CI.indexOf('\n  ci-complete:'));
    expect(gate).toMatch(/\bstructural-guards\b/);
  });

  it('`pnpm test:guards` runs the guards config', () => {
    expect(PACKAGE_JSON.scripts['test:guards']).toBe('vitest run --config vitest.guards.config.ts');
  });
});
