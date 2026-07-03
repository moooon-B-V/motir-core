import { createHmac, timingSafeEqual } from 'node:crypto';
import { GithubWebhookNotConfiguredError, GithubWebhookSignatureError } from './errors';

// GitHub webhook signature verification (Story 7.10 · MOTIR-892) — the
// leaf primitive the webhook route calls BEFORE it parses or trusts a delivery.
// Every GitHub delivery is signed: `X-Hub-Signature-256: sha256=<hex>`, an
// HMAC-SHA256 over the EXACT raw request body keyed by the shared
// `GITHUB_WEBHOOK_SECRET` configured on the App. We recompute it over the raw
// body and compare in constant time; a missing or mismatched signature is an
// unauthentic delivery, rejected before the body is parsed.
//
// This is a pure `node:crypto` leaf (the `lib/savedFilters/subscriptionToken.ts`
// shape): the secret is read at CALL time (never module load), so a self-hosted
// deploy that never wires GitHub can't reach the path rather than crashing on
// boot. Verification lives here (not in the GitProvider seam) because the seam
// is a payload normalizer that holds no HTTP/secret concerns; signature is a
// transport concern the route owns and delegates to this helper.

const SECRET_ENV = 'GITHUB_WEBHOOK_SECRET';
const SIGNATURE_PREFIX = 'sha256=';

function secret(): string {
  const value = process.env[SECRET_ENV];
  // Unwired is a server MISCONFIG, not a caller error — surfaced as its own typed
  // error the route maps to 500 (loud), never a silent 401 that reads like a bad
  // signature.
  if (!value) throw new GithubWebhookNotConfiguredError();
  return value;
}

/**
 * Verify a delivery's `X-Hub-Signature-256` header against the HMAC-SHA256 of
 * the raw body. Returns void on success; throws {@link GithubWebhookSignatureError}
 * (→ 401) when the header is absent, malformed, or does not match, and
 * {@link GithubWebhookNotConfiguredError} (→ 500) when no secret is configured.
 *
 * `rawBody` MUST be the exact bytes GitHub signed — read via `req.text()` BEFORE
 * any JSON parse (a re-serialized body would not match). The constant-time
 * compare guards against a timing side-channel on the digest; the length guard
 * is required because `timingSafeEqual` throws on unequal-length buffers.
 */
export function verifyGithubWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): void {
  const expected = `${SIGNATURE_PREFIX}${createHmac('sha256', secret())
    .update(rawBody)
    .digest('hex')}`;
  if (!signatureHeader || !signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    throw new GithubWebhookSignatureError();
  }
  const provided = Buffer.from(signatureHeader);
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length || !timingSafeEqual(provided, expectedBuf)) {
    throw new GithubWebhookSignatureError();
  }
}
