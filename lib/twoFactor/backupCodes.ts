import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { BackupCodesUnreadableError } from './errors';

// Encoding and decoding the recovery-code column (Story MOTIR-1213 · Subtask
// MOTIR-1218).
//
// ⚠️ THIS FILE MUST PRODUCE BYTE-COMPATIBLE OUTPUT WITH BETTER-AUTH'S OWN
// `encodeBackupCodes` / `getBackupCodes`, because BOTH write this one column.
// The plugin's `/two-factor/verify-backup-code` endpoint spends a code during
// the LOGIN CHALLENGE — it has to, because only it can mint the session that
// completes the sign-in — while `twoFactorService` spends and mints codes from
// the signed-in Security pane. Two writers, one format.
//
// That is why the crypto here is not re-implemented but IMPORTED: `better-auth/crypto`
// is a public subpath export, and `symmetricEncrypt`/`symmetricDecrypt` are the
// exact functions the plugin calls (xchacha20-poly1305 over a SHA-256 of the
// secret). The only thing this module owns is the shape INSIDE the ciphertext —
// `JSON.stringify(string[])` — which is likewise the plugin's, verified against
// `plugins/two-factor/backup-codes/index.mjs`.
//
// The KEY is `BETTER_AUTH_SECRET`. Better-Auth passes `ctx.context.secretConfig`,
// which equals the plain secret string whenever `secrets` (its key-rotation
// array) is unset — and Motir sets only `secret` (lib/auth/index.ts). If a
// rotation array is ever introduced, this is the second place that has to learn
// about it, and `decodeBackupCodes` fails LOUDLY rather than silently returning
// an empty set, which is what makes that discoverable.

function authSecret(): string {
  const secret = process.env['BETTER_AUTH_SECRET'];
  if (!secret) {
    throw new Error('BETTER_AUTH_SECRET is not set. See .env.example for the required auth vars.');
  }
  return secret;
}

/**
 * Decode the stored column into the unspent code set.
 *
 * Throws `BackupCodesUnreadableError` on anything that is not a decryptable
 * JSON array of strings. Deliberately NOT a silent `[]`: an empty set and an
 * undecryptable one look identical to a caller, and the first means "you have
 * spent them all" while the second means "your secret is wrong" — opposite
 * findings that must not share a code path (`InvalidBackupCodeError` is what a
 * user sees, and an operator's rotated secret is not the user's mistake).
 */
export async function decodeBackupCodes(stored: string): Promise<string[]> {
  let json: string;
  try {
    json = await symmetricDecrypt({ key: authSecret(), data: stored });
  } catch (err) {
    throw new BackupCodesUnreadableError(err);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new BackupCodesUnreadableError(err);
  }
  if (!Array.isArray(parsed) || parsed.some((code) => typeof code !== 'string')) {
    throw new BackupCodesUnreadableError(parsed);
  }
  return parsed as string[];
}

/** Encode a code set back into the stored column form. */
export async function encodeBackupCodes(codes: string[]): Promise<string> {
  return symmetricEncrypt({ key: authSecret(), data: JSON.stringify(codes) });
}

/**
 * How many codes the column holds, or `0` when it cannot be read.
 *
 * The ONE place an unreadable column is answered rather than thrown, because
 * the caller is the status read: a pane that 500s tells a user nothing, while a
 * pane showing "0 of 10 remaining" tells them to regenerate — which is the
 * correct action under a rotated secret as well as under a spent set. Every
 * path that ACTS on the set still throws.
 */
export async function countBackupCodes(stored: string): Promise<number> {
  try {
    return (await decodeBackupCodes(stored)).length;
  } catch {
    return 0;
  }
}

/**
 * Mint a fresh recovery-code set, in Better-Auth's own format: `amount` codes of
 * `2 × 5` lowercase-alphanumeric characters joined by a hyphen (`a1b2c-3d4e5`),
 * which is what `generateBackupCodesFn` produces and therefore what a code the
 * plugin's endpoint accepts looks like.
 *
 * Randomness is `crypto.getRandomValues`, never `Math.random` — these are
 * credentials.
 */
export function generateBackupCodes(amount: number, length = 10): string[] {
  return Array.from({ length: amount }, () => {
    const raw = randomString(length);
    return `${raw.slice(0, Math.ceil(length / 2))}-${raw.slice(Math.ceil(length / 2))}`;
  });
}

// Rejection sampling over a 62-character alphabet: 256 is not a multiple of 62,
// so taking a byte modulo 62 would make the first four characters marginally
// likelier. Discarding the biased tail costs a few extra bytes and removes it.
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LIMIT = Math.floor(256 / ALPHABET.length) * ALPHABET.length;

function randomString(length: number): string {
  let out = '';
  while (out.length < length) {
    const bytes = new Uint8Array(length - out.length + 8);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (out.length === length) break;
      if (byte >= LIMIT) continue;
      out += ALPHABET[byte % ALPHABET.length];
    }
  }
  return out;
}
