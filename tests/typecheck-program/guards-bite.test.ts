import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STRUCTURAL_GUARD_SPECS } from '../helpers/structuralGuardLane';

// THE STORY'S GUARDS, IN ONE PLACE (Story MOTIR-4292 · MOTIR-4300) — criterion 3.
//
// MOTIR-4292 ships four boundary guards, and every one of them protects a
// property that has no other signal: a green run of any of them means "no leak",
// and a guard that has stopped scanning is indistinguishable from one that found
// nothing. That is the failure this file is about.
//
// ── What it asserts, and what it deliberately does NOT ──────────────────────
// Each guard PROVES ITSELF, beside the predicate it exercises — that is the
// mould's convention (`tests/ciFleet/orchestratorPortBoundary.test.ts`) and it
// is the right place for a proof: the planted violation sits next to the tell it
// fires. Re-running those four proofs here would be a copy that drifts.
//
// What no individual guard can assert is the property this file owns:
//
//   1. **all four still exist** — a guard deleted in a refactor takes its
//      mutation case with it, so the deletion removes the alarm and the alarm's
//      alarm in one commit;
//   2. **each is in the LANE ITS COST BELONGS TO** — a whole-tree scanner left in
//      the sharded, database-backed, coverage-instrumented job is the MOTIR-3144
//      cost class; one that is in NEITHER list runs nowhere at all while looking
//      exactly like a guard; and a CHEAP guard in the lane makes the lane's
//      membership stop meaning "this walks the tree". Three of the four walk it;
//      the fourth reads eight named files, and the census asserts that too. It is
//      what found `orchestratorPortBoundary` still in the sharded job after
//      MOTIR-4299 gave it a fourth root to scan;
//   3. **each still carries a mutation case with a real planted violation** — the
//      one edit that turns a guard into a tautology is deleting its `BITES` test,
//      and nothing else in the suite notices, because everything left is green.
//
// ── Why the list is DECLARED rather than derived ────────────────────────────
// A derived census would have to answer "which files are this story's guards?",
// and no property of the tree says so. The four below are a closed set fixed by
// the story: one per pillar plus the relocated one. A fifth guard is a fifth
// story, and it will want its own census entry argued for rather than inherited.

const ROOT = process.cwd();

interface Guard {
  /** Repo-relative path. */
  spec: string;
  /**
   * Does it WALK the tree?
   *
   * The lane is for guards whose cost is a function of the repository rather
   * than of what else is running (MOTIR-3144). A guard that reads eight named
   * config files is not one of those, and putting it in the lane would be cargo
   * cult — so the census asserts the answer BOTH ways rather than demanding lane
   * membership uniformly.
   */
  wholeTree: boolean;
  /** What its green run is a claim about. */
  protects: string;
  /** A phrase its mutation case's own title must carry. */
  mutationTitle: RegExp;
  /** Something the planted violation must contain — the tell, in the test. */
  plant: RegExp;
}

const GUARDS: readonly Guard[] = [
  {
    spec: 'tests/typecheck-program.test.ts',
    // Eight named files, no walk: `tsconfig.*.json`, `package.json`, `.gitignore`.
    wholeTree: false,
    protects:
      'the type-check is a SOLUTION of project references and cannot regress to the one program it was split out of (MOTIR-4293)',
    mutationTitle: /BITES on a config that has regressed to one program/,
    plant: /\*\*\/\*\.ts/,
  },
  {
    spec: 'tests/prisma/typeBoundary.test.ts',
    wholeTree: true,
    protects:
      "the generated client's payload and input generics are named only under `lib/repositories/**` (MOTIR-4296)",
    mutationTitle: /the guard actually detects a leak \(mutation check\)/,
    plant: /Prisma\.WorkItem(Unchecked)?(Create|Update)Input/,
  },
  {
    spec: 'tests/packages/importDirection.test.ts',
    wholeTree: true,
    protects:
      'no package imports the app, and nothing reaches past a package barrel (MOTIR-4299, the ADR §3)',
    mutationTitle: /the guard actually detects both directions \(mutation check\)/,
    plant: /@motir\/orchestrator\/src/,
  },
  {
    spec: 'tests/ciFleet/orchestratorPortBoundary.test.ts',
    wholeTree: true,
    protects:
      'no `fly` escapes the adapter directory — the port boundary, which MOVED with the package and had to be re-pointed at it (MOTIR-4299)',
    mutationTitle: /the guard actually detects a leak \(mutation check\)/,
    plant: /adapters\/fly/,
  },
];

const sourceOf = (spec: string): string => readFileSync(join(ROOT, spec), 'utf8');

describe('every guard this story ships is present, lane-resident, and proven to bite', () => {
  it('names four guards, and they are four distinct files', () => {
    // The census is only worth reading if it is a census: a duplicated entry
    // would let one guard stand in for two.
    expect(GUARDS).toHaveLength(4);
    expect(new Set(GUARDS.map((g) => g.spec)).size).toBe(4);
  });

  for (const guard of GUARDS) {
    describe(guard.spec, () => {
      it(`still exists — it is what says: ${guard.protects}`, () => {
        // `readFileSync` throws on a missing file, which is the assertion; the
        // length check is what catches an emptied one.
        expect(sourceOf(guard.spec).length).toBeGreaterThan(500);
      });

      it(
        guard.wholeTree
          ? 'walks the tree, so it runs in the structural-guard lane'
          : 'reads named files, so it stays in the ordinary lane',
        () => {
          // Both directions matter. A whole-tree parse left in the sharded job
          // runs under v8 instrumentation against Postgres suites (MOTIR-3144's
          // cost class, three timeouts in four days); and a guard in NEITHER
          // list does not run at all, which is green for ever. A CHEAP guard in
          // the lane is the mirror mistake — the lane's membership is a claim
          // about cost, and one that stops being true stops being readable.
          if (guard.wholeTree) {
            expect(
              STRUCTURAL_GUARD_SPECS as readonly string[],
              `${guard.spec} walks the tree and is not in the structural-guard lane`,
            ).toContain(guard.spec);
          } else {
            expect(
              STRUCTURAL_GUARD_SPECS as readonly string[],
              `${guard.spec} reads named files — the lane is for whole-tree scans`,
            ).not.toContain(guard.spec);
          }
        },
      );

      it('carries a mutation case, with a planted violation still in it', () => {
        const source = sourceOf(guard.spec);
        expect(
          guard.mutationTitle.test(source),
          `${guard.spec} has lost its mutation case — a guard nobody has watched fail may be matching nothing`,
        ).toBe(true);
        expect(
          guard.plant.test(source),
          `${guard.spec}'s mutation case no longer plants a violation the guard's tells can see`,
        ).toBe(true);
      });
    });
  }

  it('BITES on a census entry whose guard has gone quiet', () => {
    // The census's own mutation case, and the reason it is not circular: the
    // predicates above are two regex tests over a file, and this proves both
    // answer FALSE for a file that has lost the thing they look for. Without it
    // a typo in `mutationTitle` would make the whole census pass vacuously.
    const emptied = '// a guard with its mutation case deleted\nexport {};\n';
    for (const guard of GUARDS) {
      expect(guard.mutationTitle.test(emptied), guard.spec).toBe(false);
      expect(guard.plant.test(emptied), guard.spec).toBe(false);
    }
    expect(STRUCTURAL_GUARD_SPECS as readonly string[]).not.toContain(
      'tests/this-guard-does-not-exist.test.ts',
    );
  });
});
