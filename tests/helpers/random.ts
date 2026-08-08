import { randomInt } from 'node:crypto';

// Unique-value generation for fixtures (MOTIR-2418 follow-up). Tests used to
// reach for `Math.random().toString(36).slice(2)` to keep concurrent fixtures
// off each other's unique constraints. That is a fine source of uniqueness and
// a poor source of randomness, and CodeQL cannot tell the two apart: the value
// flows into `usersService.createUser`, whose repository write lands it beside
// a credential row, so `js/insecure-randomness` fires on a sink that really is
// security-sensitive even though the tainted field is only an email address.
//
// The alert sat open on `main` from 2026-07-04 and was attributed to whichever
// large PR happened to touch one of these files. Using the CSPRNG removes the
// source outright, costs nothing at test speed, and means a future fixture
// that DOES feed a password inherits the right primitive by default.
//
// `randomInt` is re-exported so a call site needing a bounded integer imports
// one module rather than reaching into `node:crypto` itself.

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A cryptographically-random lower-case alphanumeric token — the drop-in for
 * `Math.random().toString(36).slice(2, 2 + length)`.
 */
export function randomToken(length = 11): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export { randomInt };
