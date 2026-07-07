import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Reversible symmetric encryption for third-party access tokens we must recover
// later to call an external API on a member's behalf (unlike the API-token
// SECRET, which is HASHED because we only ever verify it — see
// lib/apiTokens/token.ts). This module is the ONLY place that touches a token's
// cryptographic shape; a domain service calls `encryptToken` before persisting
// and `decryptToken` when it needs the live token, and nothing else reaches for
// crypto directly.
//
// Originally the GitHub-only `lib/github/tokenCrypto.ts` (Story 7.10 ·
// MOTIR-1498); generalised here (Story 7.16 · MOTIR-1653) so the import-source
// OAuth store can reuse the exact same algorithm/format. The GitHub module now
// re-exports an instance of this factory keyed on its own env var, so every
// existing GitHub caller keeps working byte-for-byte.
//
// AES-256-GCM: authenticated encryption, so a tampered ciphertext fails the
// auth-tag check on decrypt (throws) rather than silently returning garbage. A
// fresh random IV per encryption means the same token never encrypts to the
// same bytes twice. The serialized form is a versioned, dot-separated triple
//   v1.<iv>.<authTag>.<ciphertext>
// (each segment base64url, no padding) so a future algorithm/format change can
// migrate rows by version prefix rather than guessing the layout.

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32; // AES-256

const b64 = (buf: Buffer): string => buf.toString('base64url');

/**
 * The 32-byte symmetric key, resolved from the first of `envKeyNames` that is
 * set — read at CALL time (never module load), so a deployment that hasn't
 * configured the integration doesn't crash on boot; the flow simply isn't
 * reachable. Accepts the key as 64 hex chars OR base64/base64url; both decode to
 * exactly 32 bytes. A missing (none set) or wrong-length key is an operator
 * misconfiguration, so it throws loudly, naming the preferred env var.
 */
function resolveKey(envKeyNames: readonly string[]): Buffer {
  let raw: string | undefined;
  for (const name of envKeyNames) {
    const v = process.env[name];
    if (v) {
      raw = v;
      break;
    }
  }
  if (!raw) {
    const primary = envKeyNames[0];
    throw new Error(`${primary} is not set. See .env.example for the encryption-key env vars.`);
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${envKeyNames[0]} must decode to ${KEY_BYTES} bytes (got ${key.length}); provide 64 hex chars or a 32-byte base64 value.`,
    );
  }
  return key;
}

export interface TokenCrypto {
  /** Encrypt a plaintext token into the versioned `v1.<iv>.<tag>.<ct>` form. */
  encryptToken(plaintext: string): string;
  /**
   * Decrypt a value produced by {@link TokenCrypto.encryptToken}. Throws on an
   * unknown version, a malformed payload, or a failed auth-tag check (tamper /
   * wrong key) — a corrupted secret must never silently decode to a usable
   * string.
   */
  decryptToken(payload: string): string;
}

/**
 * Build an {@link TokenCrypto} bound to one or more candidate env-var names for
 * the 32-byte key. The key is resolved lazily on each call from the FIRST name
 * that is set, so a domain can prefer its own dedicated key but fall back to a
 * shared one (the import store falls back to the GitHub key so existing
 * deployments encrypt with zero new config).
 */
export function createTokenCrypto(envKeyNames: string | readonly string[]): TokenCrypto {
  const names = typeof envKeyNames === 'string' ? [envKeyNames] : envKeyNames;
  if (names.length === 0) {
    throw new Error('createTokenCrypto requires at least one env-var name.');
  }

  return {
    encryptToken(plaintext: string): string {
      const key = resolveKey(names);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return [VERSION, b64(iv), b64(authTag), b64(ciphertext)].join('.');
    },

    decryptToken(payload: string): string {
      const parts = payload.split('.');
      if (parts.length !== 4 || parts[0] !== VERSION) {
        throw new Error('Malformed or unsupported encrypted-token payload.');
      }
      const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
      const key = resolveKey(names);
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ctB64, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
