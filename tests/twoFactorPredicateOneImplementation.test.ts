import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { libFilesContainingIn, libFilesMatchingIn } from './helpers/twoFactorGuardSweeps';

// Story MOTIR-1213/1214/1215 — THE SECOND-FACTOR PREDICATE HAS ONE
// IMPLEMENTATION, asserted by walking `lib/` rather than by remembering.
//
// ⚠️ SPLIT OUT OF `tests/twoFactorHasSecondFactor.test.ts` BY MOTIR-3649, and
// the reason is a rule this lane enforces. These tests are a whole-tree
// filesystem walk under a budget written for a database query, on a contended
// coverage-instrumented shard — the exact profile `vitest.guards.config.ts`
// exists to keep out of the sharded job. But the lane also refuses any member
// that imports `@/lib`, `@/app` or `@/components`, because a lane member must
// carry no coverage into the merged report — and the EQUIVALENCE tests next
// door import the real predicate and the real mapper, which is the whole point
// of them. One file could satisfy one rule or the other, never both.
//
// So: the equivalence half stays in the sharded run with its coverage; this
// half moved here and joined the lane. `tests/helpers/twoFactorGuardSweeps.ts`
// holds the walk, which is also what lets
// `tests/integration/twoFactorEnforcementStoryGate.test.ts` watch this guard
// FAIL over a synthetic tree.

// The predicate's whole value is that the gate and the pane cannot disagree,
// which survives only while nobody writes a second copy. `twoFactorEnabled` is
// the column a second copy would have to read, so the grep is over that name —
// and it is asserted TIGHT in both directions, so the allowlist cannot rot into
// a mute button: an unlisted reader fails, and a listed one that has gone away
// fails too.

/**
 * Every `.ts` under `lib/` whose source contains `needle`, repo-relative and
 * sorted.
 *
 * A filesystem walk rather than `git grep`, deliberately: `git grep` reads the
 * INDEX, so a file this very card added is invisible to it until it is staged —
 * and a guard that cannot see the newest file is a guard that passes for the
 * wrong reason. (It cost two red runs here before the cause was obvious.)
 */
// ⚠️ THE WALK TAKES A ROOT, and lives in `tests/helpers/twoFactorGuardSweeps.ts`
// so this guard can be WATCHED FAILING over a synthetic tree —
// `tests/integration/twoFactorEnforcementStoryGate.test.ts` builds one holding a
// second implementation of the predicate (MOTIR-3649). A guard nobody has
// watched go red is indistinguishable from one that never runs.

const libFilesContaining = (needle: string): string[] =>
  libFilesContainingIn(process.cwd(), needle);

const libFilesMatching = (pattern: RegExp): string[] => libFilesMatchingIn(process.cwd(), pattern);

const KNOWN_READERS: { file: string; why: string }[] = [
  {
    file: 'lib/twoFactor/hasSecondFactor.ts',
    why: 'THE predicate. Names the column in its own documentation; the function itself takes it as an input.',
  },
  {
    file: 'lib/services/twoFactorService.ts',
    why: "Reads the column ONCE and hands it to `toTwoFactorStatusDTO` — the Security pane's path. It derives no verdict of its own.",
  },
  {
    file: 'lib/repositories/twoFactorPolicyRepository.ts',
    why: 'Selects the column in the hot-path query and hands it to the mapper. Derives no verdict.',
  },
  {
    file: 'lib/mappers/twoFactorMappers.ts',
    why: 'Builds `methods`; the prose contract this predicate was extracted from lives in its comment.',
  },
  {
    file: 'lib/dto/twoFactor.ts',
    why: 'Where the `methods.length > 0` contract is WRITTEN. Documentation only.',
  },
  {
    file: 'lib/dto/twoFactorPolicy.ts',
    why: 'One documentation line warning that a passkey counts even with the column false. No code reads it.',
  },
  {
    file: 'lib/auth/twoFactorGate.ts',
    why: 'One documentation line (MOTIR-3648) stating that compliance is `methods.length > 0` and NOT this column — the gate names it only to say it does not use it.',
  },
  {
    file: 'lib/dto/platform.ts',
    why: "A DISPLAY field on the platform-admin user DTO — 'does this account have 2FA on', shown as a pill. Not a compliance verdict.",
  },
  {
    file: 'lib/mappers/platformMappers.ts',
    why: 'Copies that display field off the row. No derivation.',
  },
  {
    file: 'lib/repositories/userRepository.ts',
    why: 'The WRITE — `setTwoFactorEnabled`. The column has to be set somewhere.',
  },
  {
    file: 'lib/auth/index.ts',
    why: 'Better-Auth wiring comments describing which plugin owns the column.',
  },
];

describe('the second-factor predicate has exactly one implementation', () => {
  it('no file outside the allowlist reads `twoFactorEnabled`', () => {
    const found = libFilesContaining('twoFactorEnabled');

    const allowed = new Set(KNOWN_READERS.map((r) => r.file));
    expect(found.filter((f) => !allowed.has(f))).toEqual([]);
    // Tight the other way: a listed file that no longer reads the column is a
    // stale exemption, and the list must shrink when the tree does.
    expect(KNOWN_READERS.map((r) => r.file).filter((f) => !found.includes(f))).toEqual([]);
  });

  it('exactly two modules DERIVE anything from a passkey count, and they are the pair asserted equivalent above', () => {
    // The statement that actually matters. Naming `passkeyCount` is cheap —
    // every file that passes it along does — so the guard is over a COMPARISON,
    // which is what a second copy of the verdict would have to write.
    //
    // TWO, not one, and the second is not a defect: `toTwoFactorStatusDTO`
    // derives `methods` for the Security pane and the predicate derives the
    // boolean for the gate. They are two answers to different questions that
    // must agree, which is exactly what the equivalence block above measures. A
    // THIRD would have nothing holding it to either.
    expect(readFileSync('lib/twoFactor/hasSecondFactor.ts', 'utf8')).toContain(
      'input.enabled || input.passkeyCount >= 1',
    );

    expect(libFilesMatching(/passkeyCount\s*(?:>=|>|<|!==|===)/)).toEqual([
      'lib/mappers/twoFactorMappers.ts',
      'lib/twoFactor/hasSecondFactor.ts',
    ]);
  });
});
