// Shared constants for the GitLab-integration E2E lane (Story 7.23 · MOTIR-1480) —
// the GitLab mirror of github-const.ts.
//
// This module is import-light ON PURPOSE: playwright.config.ts imports it to hand
// the dev server the SAME webhook secret / OAuth-app credentials the spec uses, and
// the config is parsed before any env/DB wiring exists — so nothing here may import
// app code (services, prisma, next). The seed helper (`gitlab-seed.ts`) imports the
// heavier service graph instead.
//
// All values are synthetic test-only literals. Unlike GitHub (which HMAC-signs the
// raw body), GitLab authenticates a project webhook with a SECRET TOKEN echoed
// verbatim in the `X-Gitlab-Token` header, so the webhook secret is the value BOTH
// sides use: playwright.config.ts sets it as GITLAB_WEBHOOK_SECRET on the dev
// server (the real MOTIR-1475 token gate runs), and the spec sends it as the
// header — a missing/wrong token 401s.

export const E2E_GITLAB_WEBHOOK_SECRET = 'e2e-gitlab-webhook-secret';

// OAuth app credentials: any non-empty values satisfy `resolveConfig()`; the actual
// code→token exchange + `/api/v4/user` read never leave the process (the
// E2E_TEST_OAUTH MockAgent in instrumentation.ts intercepts gitlab.com).
export const E2E_GITLAB_CLIENT_ID = 'e2e-gitlab-client-id';
export const E2E_GITLAB_CLIENT_SECRET = 'e2e-gitlab-client-secret';

// 64 hex chars → the required 32-byte token-encryption key (tokenCrypto.ts). GitLab
// PERSISTS its OAuth access + refresh tokens (unlike GitHub's on-demand App
// tokens), so the connect callback encrypts them with this key on the dev server.
export const E2E_GITLAB_TOKEN_ENCRYPTION_KEY =
  'e2e1e2e1e2e1e2e1e2e1e2e1e2e1e2e1e2e1e2e1e2e1e2e1e2e1e2e1e2e1e2e1';

// The synthetic GitLab identity the mocked `GET /api/v4/user` returns — what the
// connected panel binds to (as `@username`) after the OAuth round-trip.
export const E2E_GITLAB_USER = { id: 771234, username: 'e2e-glcat' };

// The seeded connected project the MR webhooks reference. `providerRepoId` is the
// GitLab numeric project id, carried as our stored string `repoId`.
export const E2E_GITLAB_PROJECT = {
  providerRepoId: '880042',
  owner: 'moooon-e2e',
  name: 'motir-gitlab-demo',
  defaultBranch: 'main',
} as const;
