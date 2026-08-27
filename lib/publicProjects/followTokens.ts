import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// The two tokens a public follow carries (Story 8.9 · Subtask 8.9.5 ·
// `docs/decisions/public-follow-and-changelog.md` §7).
//
// Both are HIGH-ENTROPY, generated server-side, and stored ONLY as a hash. The
// database never holds a value that could be replayed out of a backup or a log
// line, which matters more here than for a session token: these two are mailed
// to an address, so they live in somebody's inbox for years.
//
// They differ in exactly one way, and it is deliberate:
//
//   * the CONFIRM token EXPIRES (24 hours) and is single-use — it proves an
//     address was reachable at the moment somebody typed it, and that proof
//     goes stale;
//   * the UNSUBSCRIBE token NEVER expires — an unsubscribe link has to work in
//     a mail found two years later, and an expired one would leave a person
//     with no way out except our support inbox.

/** How long a confirmation link stays usable. */
export const CONFIRM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long an UNCONFIRMED follow row survives before the sweep deletes it
 * (ADR §4). Longer than the token's own life, so a person who follows the link
 * late gets an "expired, try again" rather than "we have never heard of you".
 */
export const UNCONFIRMED_FOLLOW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Mint one token. 32 bytes of CSPRNG entropy, base64url so it survives a query
 * string and an email client's link rewriting untouched.
 */
export function mintFollowToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The stored form. SHA-256 is right here and HMAC/argon are not: the input is
 * already 256 bits of uniform randomness, so there is no dictionary to stretch
 * against and no secret to bind to — the only property needed is that the
 * stored value cannot be turned back into the token.
 */
export function hashFollowToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Compare a supplied token against a stored hash in CONSTANT time.
 *
 * The lookup itself is by hash, so an attacker cannot time the DB index — but
 * the comparison is still done this way because the day someone adds a
 * "verify this token against the row we already loaded" path, it should already
 * be safe. Both sides are fixed-length hex, so `timingSafeEqual`'s own
 * length check cannot itself leak.
 */
export function followTokenMatches(token: string, storedHash: string): boolean {
  const supplied = Buffer.from(hashFollowToken(token), 'utf8');
  const stored = Buffer.from(storedHash, 'utf8');
  if (supplied.length !== stored.length) return false;
  return timingSafeEqual(supplied, stored);
}

/**
 * The stored form of an email address: trimmed and LOWERCASED.
 *
 * The unique index is on the stored value, so normalizing here is what stops
 * `Reader@Example.com` and `reader@example.com` becoming two follows of one
 * project by one person — and, more importantly, what stops the second one
 * being able to enumerate the first.
 */
export function normalizeFollowEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Is this plausibly an email address? Deliberately permissive — the real proof
 * that an address exists is the confirmation link, not a regular expression,
 * and a strict pattern here would reject valid addresses while proving nothing
 * about the invalid ones.
 */
export function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email) && email.length <= 254;
}
