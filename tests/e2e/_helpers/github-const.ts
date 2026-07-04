// Shared constants for the GitHub-integration E2E lane (Story 7.10 · MOTIR-897).
//
// This module is import-light ON PURPOSE: playwright.config.ts imports it to
// hand the dev server the SAME webhook secret / OAuth app credentials the spec
// signs with, and the config is parsed before any env/DB wiring exists — so
// nothing here may import app code (services, prisma, next). The seed helper
// (`github-seed.ts`) imports the heavier service graph instead.
//
// All values are synthetic test-only literals. The webhook secret is the HMAC
// key BOTH sides use: playwright.config.ts sets it as GITHUB_WEBHOOK_SECRET on
// the dev server (the real 7.10.4 verification path runs), and the spec's
// `signWebhook` computes x-hub-signature-256 with it — an unsigned POST 401s.

export const E2E_GITHUB_WEBHOOK_SECRET = 'e2e-github-webhook-secret';

// OAuth app credentials: any non-empty values satisfy `resolveConfig()`; the
// actual code→token exchange never leaves the process (instrumentation.ts's
// E2E_TEST_OAUTH MockAgent intercepts GitHub's token + user endpoints).
export const E2E_GITHUB_CLIENT_ID = 'e2e-github-client-id';
export const E2E_GITHUB_CLIENT_SECRET = 'e2e-github-client-secret';

// 64 hex chars → the required 32-byte token-encryption key (tokenCrypto.ts).
export const E2E_GITHUB_TOKEN_ENCRYPTION_KEY =
  'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0';

// App slug so the settings page renders the install link-out (Panel 1's
// "Install the Motir GitHub App" affordance).
export const E2E_GITHUB_APP_SLUG = 'motir-e2e-app';

// The synthetic GitHub identity the mocked /user endpoint returns — what the
// connected panel shows as the bound identity after the OAuth round-trip.
export const E2E_GITHUB_USER = { id: 583231, login: 'e2e-octocat' };

// The seeded App installation + selected repo the webhooks reference.
export const E2E_INSTALLATION_ID = '99000001';
export const E2E_REPO = {
  providerRepoId: '88000001',
  owner: 'moooon-e2e',
  name: 'motir-demo',
  defaultBranch: 'main',
} as const;
export const E2E_INSTALLATION_ACCOUNT = { login: 'moooon-e2e', type: 'Organization' } as const;
