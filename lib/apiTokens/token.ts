import { createHash, randomBytes } from 'node:crypto';

// Personal-access-token primitives (Story 7.8 · Subtask 7.8.1). This module is
// the ONLY place that touches the token's cryptographic shape — generation,
// hashing, and the display prefix — the same single-responsibility invariant
// `lib/auth/passwords.ts` holds for password hashing. The service composes
// these; nothing else reaches for crypto directly.
//
// Why sha-256 (NOT argon2, which passwords use): a PAT is a 32-byte random
// secret with full entropy, so there is nothing to brute-force — a fast hash
// is correct and keeps `verify` cheap on every agent call. argon2's slow KDF
// only earns its cost against low-entropy human passwords.

/** The fixed, greppable prefix (the GitHub `ghp_` rationale — leaked-secret
 * scanners can match on it). */
export const TOKEN_PREFIX = 'motir_pat_';

/** Bytes of randomness behind each secret (≈ 43 base64url body chars). */
const SECRET_BYTES = 32;

/** Chars of the secret stored as the display-only `tokenPrefix`
 * (`motir_pat_` + the first 2 body chars → `motir_pat_Ab…`-style hint). */
export const DISPLAY_PREFIX_LENGTH = 12;

/** Mint a fresh plaintext secret: the fixed prefix + base64url of 32 random
 * bytes. base64url (`A-Za-z0-9-_`) is URL/header-safe and carries the full
 * 256 bits of entropy with no custom encoder. Returned ONCE by the service
 * and never persisted. */
export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(SECRET_BYTES).toString('base64url');
}

/** The sha-256 hex of a secret — the stored lookup key. Deterministic, so
 * `verify` re-hashes the presented plaintext and probes the unique index. */
export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** The display-only prefix stored alongside the hash (never enough to
 * reconstruct the secret). */
export function tokenPrefixOf(plaintext: string): string {
  return plaintext.slice(0, DISPLAY_PREFIX_LENGTH);
}
