import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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

// ── There is exactly ONE implementation ─────────────────────────────────────
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
function libFilesWhere(predicate: (source: string) => boolean): string[] {
  const root = process.cwd();
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith('.ts') && predicate(readFileSync(p, 'utf8')))
        out.push(relative(root, p).split(sep).join('/'));
    }
  };
  walk(join(root, 'lib'));
  return out.sort();
}

const libFilesContaining = (needle: string): string[] =>
  libFilesWhere((source) => source.includes(needle));

const libFilesMatching = (pattern: RegExp): string[] =>
  libFilesWhere((source) => pattern.test(source));

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
