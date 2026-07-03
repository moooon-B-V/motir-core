import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Reversible symmetric encryption for the GitHub user access token
// (Story 7.10 · MOTIR-1498). Unlike the API-token secret (which is HASHED,
// because we only ever verify it — see lib/apiTokens/token.ts), the GitHub
// user token must be recovered later to call GitHub on the member's behalf, so
// it is ENCRYPTED at rest, never plaintext (the card's hard requirement). This
// module is the ONLY place that touches the token's cryptographic shape;
// the service (githubIdentityService) calls `encryptToken` before persisting
// and `decryptToken` when it needs the live token, and nothing else reaches
// for crypto directly.
//
// AES-256-GCM: authenticated encryption, so a tampered ciphertext fails the
// auth-tag check on decrypt (throws) rather than silently returning garbage.
// A fresh random IV per encryption means the same token never encrypts to the
// same bytes twice. The serialized form is a versioned, dot-separated triple
//   v1.<iv>.<authTag>.<ciphertext>
// (each segment base64url, no padding) so a future algorithm/format change can
// migrate rows by version prefix rather than guessing the layout.

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32; // AES-256
const ENV_KEY = 'GITHUB_TOKEN_ENCRYPTION_KEY';

/**
 * The 32-byte symmetric key, read from `GITHUB_TOKEN_ENCRYPTION_KEY` at call
 * time (never module load — the GitHub routes are optional, so a deployment
 * that hasn't configured GitHub must not crash on boot). Accepts the key as
 * 64 hex chars OR base64/base64url; both decode to exactly 32 bytes. A missing
 * or wrong-length key is an operator misconfiguration, so it throws loudly.
 */
function resolveKey(): Buffer {
  const raw = process.env[ENV_KEY];
  if (!raw) {
    throw new Error(`${ENV_KEY} is not set. See .env.example for the GitHub integration env vars.`);
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${ENV_KEY} must decode to ${KEY_BYTES} bytes (got ${key.length}); provide 64 hex chars or a 32-byte base64 value.`,
    );
  }
  return key;
}

const b64 = (buf: Buffer): string => buf.toString('base64url');

/** Encrypt a plaintext token into the versioned `v1.<iv>.<tag>.<ct>` form. */
export function encryptToken(plaintext: string): string {
  const key = resolveKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [VERSION, b64(iv), b64(authTag), b64(ciphertext)].join('.');
}

/**
 * Decrypt a value produced by {@link encryptToken}. Throws on an unknown
 * version, a malformed payload, or a failed auth-tag check (tamper / wrong
 * key) — a corrupted secret must never silently decode to a usable string.
 */
export function decryptToken(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Malformed or unsupported encrypted-token payload.');
  }
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const key = resolveKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
