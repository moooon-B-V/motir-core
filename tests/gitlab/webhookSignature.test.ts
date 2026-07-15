import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyGitlabWebhookToken } from '@/lib/gitlab/webhookSignature';
import { GitlabWebhookNotConfiguredError, GitlabWebhookSignatureError } from '@/lib/gitlab/errors';

// Story 7.23 · MOTIR-1479 — leaf unit test for `lib/gitlab/webhookSignature.ts`.
// Verifies the `verifyGitlabWebhookToken` function directly (not through the HTTP
// route), covering every branch: not-configured, null token, length mismatch,
// content mismatch, correct token. The constant-time compare uses `timingSafeEqual`
// with a required length guard; both arms are tested explicitly.

const SECRET = 'test-webhook-secret';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('verifyGitlabWebhookToken — leaf unit (MOTIR-1479)', () => {
  it('throws GitlabWebhookNotConfiguredError when the secret is not set', () => {
    vi.stubEnv('GITLAB_WEBHOOK_SECRET', '');
    expect(() => verifyGitlabWebhookToken('anything')).toThrow(GitlabWebhookNotConfiguredError);
  });

  it('throws GitlabWebhookSignatureError when the token header is null', () => {
    vi.stubEnv('GITLAB_WEBHOOK_SECRET', SECRET);
    expect(() => verifyGitlabWebhookToken(null)).toThrow(GitlabWebhookSignatureError);
  });

  it('throws GitlabWebhookSignatureError when the token has wrong length', () => {
    vi.stubEnv('GITLAB_WEBHOOK_SECRET', SECRET);
    // Shorter than the secret — the length guard fires before content compare.
    expect(() => verifyGitlabWebhookToken('short')).toThrow(GitlabWebhookSignatureError);
  });

  it('throws GitlabWebhookSignatureError when the token has same length but wrong content', () => {
    vi.stubEnv('GITLAB_WEBHOOK_SECRET', SECRET);
    // Same length as SECRET, wrong content — the timingSafeEqual arm fires.
    const wrong = 'X'.repeat(SECRET.length);
    expect(wrong.length).toBe(SECRET.length);
    expect(wrong).not.toBe(SECRET);
    expect(() => verifyGitlabWebhookToken(wrong)).toThrow(GitlabWebhookSignatureError);
  });

  it('throws GitlabWebhookSignatureError when the token is an empty string', () => {
    vi.stubEnv('GITLAB_WEBHOOK_SECRET', SECRET);
    // Empty string → length 0 ≠ SECRET.length → length guard fires.
    expect(() => verifyGitlabWebhookToken('')).toThrow(GitlabWebhookSignatureError);
  });

  it('returns void (success) when the token matches the secret exactly', () => {
    vi.stubEnv('GITLAB_WEBHOOK_SECRET', SECRET);
    expect(() => verifyGitlabWebhookToken(SECRET)).not.toThrow();
  });
});
