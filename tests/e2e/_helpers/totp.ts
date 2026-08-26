import { createHmac } from 'node:crypto';

// A TOTP generator for the 2FA E2E (Story 8.11 · Subtask MOTIR-1223).
//
// ── It stands in for the AUTHENTICATOR APP, not for the server ────────────
// The spec reads the manual setup key off the enrol screen — the same string a
// human would type into 1Password — and computes a code from it exactly as that
// app would: base32-DECODE the key to bytes, HMAC-SHA1 them against the time
// counter, truncate. Nothing here imports the server's own OTP code, so the two
// agree only if the implementation is right, and a change to either side fails
// the spec instead of passing quietly.
//
// ⚠️ THE KEY IS BASE32 AND THE HMAC IS OVER ITS BYTES. Better-Auth builds the
// `otpauth://` URI as `base32.encode(rawSecret)` and verifies by HMAC-ing the
// RAW secret string, so decoding the displayed key recovers exactly those bytes.
// Feeding the base32 text straight into the HMAC would produce codes that never
// match — which is the one mistake worth naming, because the failure looks like
// a broken feature rather than a broken test.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 → bytes. Tolerates padding, spaces and lower case. */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Not base32: ${JSON.stringify(char)} in ${input}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/**
 * The six-digit code an authenticator app would be showing right now for
 * `setupKey` (the base32 string the enrol screen displays).
 *
 * `at` is injectable so a spec can ask for the code of a NEIGHBOURING window
 * without waiting 30 seconds of wall clock.
 */
export function totpFromSetupKey(
  setupKey: string,
  options: { periodSeconds?: number; digits?: number; at?: number } = {},
): string {
  const period = options.periodSeconds ?? 30;
  const digits = options.digits ?? 6;
  const counter = Math.floor((options.at ?? Date.now()) / (period * 1000));

  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));

  const mac = createHmac('sha1', base32Decode(setupKey)).update(counterBytes).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const truncated =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);

  return String(truncated % 10 ** digits).padStart(digits, '0');
}

/**
 * Seconds left in the current window.
 *
 * A code generated with <2s to run can expire between typing it and the server
 * checking it — the one genuinely time-dependent flake this flow can have. A
 * spec calls this and waits out the sliver rather than retrying a failure it
 * cannot tell from a real one.
 */
export function secondsLeftInWindow(periodSeconds = 30, at = Date.now()): number {
  return periodSeconds - (Math.floor(at / 1000) % periodSeconds);
}
