import { hashToken } from '@/lib/apiTokens/token';

// Reading the PRESENTED credential off a `/api/v1` request (Story 11.1 ·
// Subtask 11.1.2 — MOTIR-1858).
//
// ⚠️ This module does NOT authenticate anything. The auth DECISION —
// parsing the secret's prefix, hashing it, looking it up, and rejecting an
// unknown / revoked / expired token — lives entirely in the shipped
// `authenticateApiToken` (`lib/apiTokens/routeAuth.ts`) and is not
// re-implemented here (ADR §2).
//
// What it does is narrower and unavoidable: the wrapper needs the token's
// IDENTITY, and the shipped gate deliberately returns only
// `{ userId, workspaceId }`. Two v1 requirements need more than that:
//
//   * the rate limiter (MOTIR-1860) keys per TOKEN, so two tokens held by the
//     same user in the same workspace must get independent budgets — a
//     `userId:workspaceId` key would merge them;
//   * `GET /api/v1/me` reports the token's GRANTED SCOPES, which is how a
//     client discovers what its own credential may do without probing
//     endpoints and collecting 403s.
//
// So the header is read a second time for the credential itself. Everything
// downstream of that read still goes through the shipped service.

/**
 * The bearer secret presented on this request, or `undefined` when the header
 * is absent or not a `Bearer` challenge.
 *
 * Deliberately NOT validated: an unparseable or bogus value is simply
 * `undefined` / a string that `authenticateApiToken` will reject. This
 * function's answer never decides whether a request is authorised.
 */
export function presentedBearerToken(req: Request): string | undefined {
  const header = req.headers.get('authorization');
  if (!header) return undefined;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer') return undefined;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : undefined;
}

/**
 * A stable, non-reversible per-token key.
 *
 * Reuses the shipped `hashToken` (sha-256 hex — the same value stored as the
 * token's lookup key), so the rate limiter can key per token WITHOUT holding
 * the plaintext secret in a map, in a log line, or in a heap dump. Same token
 * → same key across processes and restarts; different tokens never collide.
 */
export function tokenFingerprint(presentedToken: string): string {
  return hashToken(presentedToken);
}
