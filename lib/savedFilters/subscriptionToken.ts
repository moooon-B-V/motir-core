import { createHmac, timingSafeEqual } from 'node:crypto';

// One-click unsubscribe token for filter-subscription emails (Story 6.2 ·
// Subtask 6.2.5). The email's "Unsubscribe" link is clicked OUTSIDE a session
// (a recipient may not be signed in, may be in another browser), so it can't
// rely on `getSession`. Instead it carries a token that AUTHENTICATES the
// specific subscription without granting any other access: an HMAC-SHA256 over
// the subscription id, keyed by `BETTER_AUTH_SECRET` (the app's existing
// signing secret). Verifying it proves the bearer holds a link we generated for
// exactly that subscription — enough to delete that one row, nothing else.
//
// The token is `<subscriptionId>.<hmac-base64url>`; verification recomputes the
// HMAC and compares in constant time. There is no expiry: an unsubscribe link
// staying valid is the desired behaviour (an old digest email's link should
// still work), and the token grants only the idempotent delete of a row the
// recipient already controls. Deleting an already-gone subscription is a no-op
// (the service treats a missing row as success), so a leaked/replayed token
// does nothing once used.

function secret(): string {
  const value = process.env['BETTER_AUTH_SECRET'];
  if (!value) {
    throw new Error('BETTER_AUTH_SECRET is not set — cannot sign unsubscribe tokens.');
  }
  return value;
}

function digest(subscriptionId: string): string {
  return createHmac('sha256', secret()).update(subscriptionId).digest('base64url');
}

/** The signed token to embed in an unsubscribe link. */
export function signUnsubscribeToken(subscriptionId: string): string {
  return `${subscriptionId}.${digest(subscriptionId)}`;
}

/**
 * Verify a token and return the subscription id it authenticates, or `null`
 * when the token is malformed or its signature doesn't match (constant-time
 * compare — no early-out timing leak on the digest).
 */
export function verifyUnsubscribeToken(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const subscriptionId = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = digest(subscriptionId);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? subscriptionId : null;
}
