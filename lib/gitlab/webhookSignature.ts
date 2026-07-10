import { timingSafeEqual } from 'node:crypto';
import { GitlabWebhookNotConfiguredError, GitlabWebhookSignatureError } from './errors';

// GitLab webhook token verification (Story 7.23 · MOTIR-1475) — the leaf
// primitive the GitLab webhook route calls BEFORE it parses or trusts a delivery.
// Unlike GitHub (which HMAC-signs the raw body — `lib/github/webhookSignature.ts`),
// GitLab authenticates a project webhook with a SECRET TOKEN: the value configured
// on the hook is echoed verbatim in the `X-Gitlab-Token` header on every delivery.
// So verification is a constant-time compare of that header against the shared
// `GITLAB_WEBHOOK_SECRET`; there is no body digest to recompute.
//
// A pure `node:crypto` leaf, mirroring the GitHub helper: the secret is read at
// CALL time (never module load), so a self-hosted deploy that never wires GitLab
// can't reach the path rather than crashing on boot. Verification lives here (not
// in the GitProvider seam) because the seam is a payload normalizer that holds no
// HTTP/secret concerns; the token is a transport concern the route owns and
// delegates to this helper.

const SECRET_ENV = 'GITLAB_WEBHOOK_SECRET';

function secret(): string {
  const value = process.env[SECRET_ENV];
  // Unwired is a server MISCONFIG, not a caller error — surfaced as its own typed
  // error the route maps to 500 (loud), never a silent 401 that reads like a bad
  // token.
  if (!value) throw new GitlabWebhookNotConfiguredError();
  return value;
}

/**
 * Verify a delivery's `X-Gitlab-Token` header against the configured
 * `GITLAB_WEBHOOK_SECRET`. Returns void on success; throws
 * {@link GitlabWebhookSignatureError} (→ 401) when the header is absent or does
 * not match, and {@link GitlabWebhookNotConfiguredError} (→ 500) when no secret is
 * configured. The constant-time compare guards against a timing side-channel; the
 * length guard is required because `timingSafeEqual` throws on unequal-length
 * buffers.
 */
export function verifyGitlabWebhookToken(tokenHeader: string | null): void {
  const expected = secret();
  if (!tokenHeader) throw new GitlabWebhookSignatureError();
  const provided = Buffer.from(tokenHeader);
  const expectedBuf = Buffer.from(expected);
  if (provided.length !== expectedBuf.length || !timingSafeEqual(provided, expectedBuf)) {
    throw new GitlabWebhookSignatureError();
  }
}
