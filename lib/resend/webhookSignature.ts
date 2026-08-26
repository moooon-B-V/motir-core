import { createHmac, timingSafeEqual } from 'node:crypto';
import { ResendWebhookNotConfiguredError, ResendWebhookSignatureError } from './errors';

// Resend delivery-webhook signature verification (Bug MOTIR-3507 · Subtask
// MOTIR-3515) — the leaf primitive the webhook route calls BEFORE it parses or
// trusts a delivery. Deliberately the same shape as
// `lib/github/webhookSignature.ts`: a pure `node:crypto` leaf that reads its
// secret at CALL time (never module load), so a self-hosted deploy that never
// wires Resend cannot reach the path rather than crashing on boot.
//
// ⚠️ THE SCHEME IS SVIX, WHICH RESEND USES AS ITS WEBHOOK TRANSPORT — and it is
// NOT GitHub's. Three headers rather than one, a signed payload that includes
// the id and the timestamp rather than the body alone, base64 rather than hex,
// and a SPACE-SEPARATED LIST of versioned signatures rather than a single value:
//
//     signedContent = `${svix-id}.${svix-timestamp}.${rawBody}`
//     signature     = base64(HMAC-SHA256(base64decode(secret without 'whsec_'), signedContent))
//     svix-signature: "v1,<sig> v1,<older-sig> v2,<other-scheme-sig>"
//
// The list exists so a secret can be ROTATED without dropping deliveries: during
// a rotation Resend signs with both and the receiver accepts either. So we must
// match ANY `v1` entry, never just the first — treating the header as one value
// makes every rotation an outage.
//
// ⚠️ CONFIRM THIS AGAINST WHAT THE DASHBOARD ACTUALLY ISSUES BEFORE THE
// ENDPOINT GOES LIVE. This module was written from the Svix scheme as
// documented at the time; the run that registers the endpoint (MOTIR-3518)
// holds the real secret and is the first thing to see a genuine delivery. If
// the format differs, that card says to record what was actually true here and
// on itself — do not adapt the secret to fit this file.

const SECRET_ENV = 'RESEND_WEBHOOK_SECRET';
const SECRET_PREFIX = 'whsec_';
const SIGNATURE_VERSION = 'v1';

/**
 * How far a delivery's timestamp may be from now, in seconds, in EITHER
 * direction. Five minutes is Svix's own documented tolerance.
 *
 * Both directions matter and for different reasons: the past bound is the
 * replay window, and the future bound covers a sender whose clock runs ahead —
 * without it, a delivery stamped hours ahead would be accepted forever.
 */
export const RESEND_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

function secret(): Buffer {
  const value = process.env[SECRET_ENV];
  // Unwired is a server MISCONFIG, not a caller error — its own typed error the
  // route maps to 500 (loud), never a silent 401 that reads like a bad signature.
  if (!value) throw new ResendWebhookNotConfiguredError();
  // The dashboard issues `whsec_<base64>`; the key is the DECODED bytes. A
  // secret without the prefix is taken as already-bare base64 rather than
  // refused, so a value pasted either way verifies.
  const bare = value.startsWith(SECRET_PREFIX) ? value.slice(SECRET_PREFIX.length) : value;
  return Buffer.from(bare, 'base64');
}

/** Constant-time compare that tolerates unequal lengths (`timingSafeEqual` throws). */
function matches(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface ResendWebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/**
 * Verify a delivery's Svix headers against the HMAC of the raw body. Returns
 * void on success; throws {@link ResendWebhookSignatureError} (→ 401) when a
 * header is absent, the timestamp is outside the tolerance window, or no
 * offered signature matches, and {@link ResendWebhookNotConfiguredError}
 * (→ 500) when no secret is configured.
 *
 * `rawBody` MUST be the exact bytes Resend signed — read via `req.text()`
 * BEFORE any JSON parse, because a re-serialized body would not match.
 *
 * `now` is injectable so the timestamp window can be tested without moving the
 * clock; it defaults to the real one and no caller passes it in production.
 */
export function verifyResendWebhookSignature(
  rawBody: string,
  headers: ResendWebhookHeaders,
  now: Date = new Date(),
): void {
  const key = secret();
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) throw new ResendWebhookSignatureError();

  const sentAtSeconds = Number(timestamp);
  if (!Number.isFinite(sentAtSeconds)) throw new ResendWebhookSignatureError();
  const skewSeconds = Math.abs(Math.floor(now.getTime() / 1000) - sentAtSeconds);
  if (skewSeconds > RESEND_WEBHOOK_TOLERANCE_SECONDS) throw new ResendWebhookSignatureError();

  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64');

  // ANY `v1` entry may match — see the rotation note in the header. Entries of
  // another version are ignored rather than refused: an unknown scheme is not
  // a signature we can check, and refusing the delivery over one would break on
  // the day Svix adds `v2` alongside `v1`.
  const offered = signature
    .split(' ')
    .filter((part) => part.startsWith(`${SIGNATURE_VERSION},`))
    .map((part) => part.slice(SIGNATURE_VERSION.length + 1));

  if (!offered.some((candidate) => matches(candidate, expected))) {
    throw new ResendWebhookSignatureError();
  }
}
