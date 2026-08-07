import { describe, expect, it } from 'vitest';
import { isEmailShape } from '@/lib/utils/email';

// MOTIR-2418 follow-up — `isEmailShape` replaced two byte-identical copies of
// `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` (usersService's EMAIL_RE and
// workspaceInvitesService's EMAIL_SHAPE), both flagged `js/polynomial-redos`.
//
// The rewrite is only safe if it accepts EXACTLY what the regex accepted, so
// the old pattern is kept here as the oracle and the two are compared on every
// case rather than the new behaviour being asserted from first principles.
const LEGACY = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CASES = [
  // Accepted
  'a@b.c',
  'owner+xyz@example.com',
  'first.last@sub.domain.co.uk',
  'a@.b.c', // a dot at index 0 is fine as long as ANOTHER dot has chars both sides
  'a@b..c',
  // Rejected
  '',
  'a',
  'a@',
  '@b.c',
  'a@b',
  'a@.c',
  'a@b.',
  'a@@b.c',
  'a@b@c.d',
  'a b@c.d',
  'a@b .c',
  'a\t@b.c',
  'a@b.c\n',
  '.@b.c',
];

describe('isEmailShape', () => {
  it('accepts and rejects exactly what the replaced regex did', () => {
    for (const value of CASES) {
      expect(isEmailShape(value), `disagreed on ${JSON.stringify(value)}`).toBe(LEGACY.test(value));
    }
  });

  it('rejects the ReDoS witness promptly', () => {
    // CodeQL names the prefix — a string starting `!@!.` with many repetitions
    // of `!.` — but that prefix on its own MATCHES, and a matching input is
    // fast. The quadratic blow-up needs the match to FAIL after the engine has
    // walked the domain: a trailing space leaves `[^\s@]+\.[^\s@]+$` retrying
    // every one of the domain's dots as the `\.`, each retry rescanning the
    // rest. That is the input below.
    //
    // The oracle is deliberately NOT run on it — `LEGACY.test(witness)` is the
    // hang this change removes. The assertion is therefore two things at once:
    // the answer is `false`, AND the test returns at all. Vitest's default
    // timeout is what fails this if linearity is ever lost, so there is no
    // wall-clock threshold to flake on a loaded runner.
    const witness = `!@!.${'!.'.repeat(50_000)} `;
    expect(isEmailShape(witness)).toBe(false);
  });

  it('stays linear on a long ACCEPTED address too', () => {
    const long = `${'a'.repeat(50_000)}@${'b'.repeat(50_000)}.com`;
    expect(isEmailShape(long)).toBe(true);
  });
});
