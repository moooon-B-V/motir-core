import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// The two tokens a public follow carries (Story 8.9 · Subtask 8.9.5 ·
// `docs/decisions/public-follow-and-changelog.md` §7).
//
// Both are HIGH-ENTROPY, generated server-side, and stored ONLY as a hash. The
// database never holds a value that could be replayed out of a backup or a log
// line, which matters more here than for a session token: these two are mailed
// to an address, so they live in somebody's inbox for years.
//
// ⚠️ THEY ARE TWO DIFFERENT MECHANISMS, not two instances of one, and the
// difference follows from their lifetimes:
//
//   * the CONFIRM token is RANDOM, stored as a hash, EXPIRES in 24 hours and is
//     single-use. It proves an address was reachable at the moment somebody
//     typed it, and that proof goes stale.
//   * the UNSUBSCRIBE token is DERIVED — an HMAC over the follow's id, keyed by
//     the app's existing signing secret — so it is recomputable at any time and
//     valid FOREVER. An unsubscribe link has to work in a mail found two years
//     later; an expired one leaves a person with no way out but our support
//     inbox.
//
// The derived form is why nothing stores an unsubscribe token: a random one
// would have to be either kept in the clear (never) or rotated on each send,
// and rotating breaks exactly the two-year-old mail the rule exists for. This
// mirrors `lib/savedFilters/subscriptionToken.ts`, which solved the same
// problem for filter-subscription emails.

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

function unsubscribeSecret(): string {
  const value = process.env['BETTER_AUTH_SECRET'];
  if (!value) {
    throw new Error('BETTER_AUTH_SECRET is not set — cannot sign unsubscribe tokens.');
  }
  return value;
}

function unsubscribeDigest(followId: string): string {
  return createHmac('sha256', unsubscribeSecret()).update(followId).digest('base64url');
}

/**
 * The unsubscribe token for one follow — `<followId>.<hmac>`.
 *
 * Derived rather than stored, so it can be recomputed for a digest sent years
 * after the follow was created, and so nothing anywhere holds a replayable
 * value. It authenticates exactly one row and grants exactly one idempotent
 * delete: a leaked token can unsubscribe the person it was already going to
 * unsubscribe, and nothing else.
 */
export function signUnsubscribeToken(followId: string): string {
  return `${followId}.${unsubscribeDigest(followId)}`;
}

/**
 * Verify an unsubscribe token and return the follow id it authenticates, or
 * `null` when it is malformed or the signature does not match. Constant-time
 * compare, so the digest cannot be probed a byte at a time.
 */
export function verifyUnsubscribeToken(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const followId = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(unsubscribeDigest(followId));
  if (provided.length !== expected.length) return null;
  return timingSafeEqual(provided, expected) ? followId : null;
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
