import { describe, expect, it } from 'vitest';
import { hasSecondFactor } from '@/lib/twoFactor/hasSecondFactor';
import { toTwoFactorStatusDTO } from '@/lib/mappers/twoFactorMappers';

// Story MOTIR-1215 · Subtask MOTIR-3645 — the second-factor predicate.
//
// `lib/dto/twoFactor.ts` states the contract in prose: *"the second-factor test
// is `methods.length > 0`, NOT `enabled`"*. MOTIR-3645 extracted it into a
// function because the enforcement gate runs on every page load and cannot
// afford `getStatus`'s three reads and its recovery-code decrypt.
//
// An extraction is only safe while the two agree, and "they agree" is not a
// thing to assert on the case you happened to think of: the input space is
// eight points, so this file walks all eight.

/** `enabled × verified × passkeyCount ∈ {0, 1}` — the whole space, 8 points. */
const INPUT_SPACE = [false, true].flatMap((enabled) =>
  [false, true].flatMap((verified) =>
    [0, 1].map((passkeyCount) => ({ enabled, verified, passkeyCount })),
  ),
);

describe('hasSecondFactor', () => {
  it('agrees with `toTwoFactorStatusDTO(...).methods.length > 0` at every point', () => {
    for (const { enabled, verified, passkeyCount } of INPUT_SPACE) {
      const viaMapper =
        toTwoFactorStatusDTO({
          enabled,
          enrolment: { verified },
          passkeyCount,
          backupCodesRemaining: 0,
          backupCodesTotal: 0,
        }).methods.length > 0;

      expect(hasSecondFactor({ enabled, passkeyCount })).toBe(viaMapper);
    }
  });

  it('agrees with the mapper when there is no enrolment row at all', () => {
    // The other shape `toTwoFactorStatusDTO` takes: `enrolment: null`, an
    // account that never started a TOTP enrolment. Not part of the 8-point grid
    // above because `verified` has no value there, and it is exactly the state a
    // passkey-only account is in.
    for (const enabled of [false, true]) {
      for (const passkeyCount of [0, 1]) {
        const viaMapper =
          toTwoFactorStatusDTO({
            enabled,
            enrolment: null,
            passkeyCount,
            backupCodesRemaining: 0,
            backupCodesTotal: 0,
          }).methods.length > 0;

        expect(hasSecondFactor({ enabled, passkeyCount })).toBe(viaMapper);
      }
    }
  });

  it('is TRUE for a passkey with two-factor OFF — the regression this exists to stop', () => {
    // The account MOTIR-1214 made the most secure, and the one a naive
    // `user.twoFactorEnabled` check locks out of the product.
    expect(hasSecondFactor({ enabled: false, passkeyCount: 1 })).toBe(true);
  });

  it('is FALSE only when nothing is enrolled', () => {
    expect(hasSecondFactor({ enabled: false, passkeyCount: 0 })).toBe(false);
    expect(hasSecondFactor({ enabled: true, passkeyCount: 0 })).toBe(true);
    expect(hasSecondFactor({ enabled: false, passkeyCount: 3 })).toBe(true);
  });

  it('ignores `verified` — a half-finished TOTP enrolment does not change it', () => {
    // Asserted on the MAPPER, where `verified` is actually an input: an enabled
    // account holds `email` regardless, so `methods` is non-empty either way.
    for (const verified of [false, true]) {
      expect(
        toTwoFactorStatusDTO({
          enabled: true,
          enrolment: { verified },
          passkeyCount: 0,
          backupCodesRemaining: 0,
          backupCodesTotal: 0,
        }).methods.length > 0,
      ).toBe(true);
    }
  });
});

// ⚠️ THE ONE-IMPLEMENTATION HALF LIVES IN
// `tests/twoFactorPredicateOneImplementation.test.ts` (Story MOTIR-1215 ·
// MOTIR-3649), and the split is structural rather than cosmetic. That half is a
// whole-tree walk of `lib/`, which belongs in the STRUCTURAL-GUARD LANE
// (`vitest.guards.config.ts`): no database, no coverage instrumentation, one
// filesystem answer. This half imports the real `hasSecondFactor` and the real
// mapper, so it must stay in the sharded run and carry its coverage — and the
// lane's own purity guard, `tests/ci-structural-guards-lane.test.ts`, refuses a
// member that reaches `@/lib`. Keeping them in one file meant one of the two
// rules had to be broken.
