import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';

// Playwright doesn't pick up .env automatically the way Next.js does. The
// spec files import @/lib/db (via _helpers/db-reset) for DB assertions,
// which throws at module load if DATABASE_URL is missing. Load .env from
// the repo root before defineConfig() runs.
loadEnv();

/**
 * Playwright config for prodect-core's E2E auth smoke suite.
 *
 * Specs live in tests/e2e/. The webServer block spawns `pnpm dev` on
 * :3000 and waits for it to come up; in CI it's a fresh server per job,
 * locally it reuses an already-running dev server if one is up.
 *
 * Email delivery during E2E uses the dev-only 'file' provider from
 * lib/email.ts (see EMAIL_PROVIDER + EMAIL_OUTBOX_PATH below). The
 * specs read /tmp/prodect-test-emails.jsonl to capture reset links.
 *
 * Tagged-suite convention: tests in this Story carry an `@smoke` tag in
 * their describe/test titles. Playwright doesn't have first-class tag
 * filtering, but CI can use `--grep @smoke` (or set a `grep` here) to
 * filter when a later Story adds non-smoke specs.
 *
 * Workers are pinned to 1 because both specs touch the same auth tables
 * and `truncateAuthTables()` is global — parallel workers would race.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  // Each spec has its own truncate + sign-up flow; 30s is plenty for the
  // longest path (request reset → poll file outbox → follow link → set
  // new password).
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  // CI: fail fast on .only and surface flakes via retry counts. Local:
  // no retries, so flakes don't get silently masked during development.
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: process.env['CI']
    ? [['list'], ['html', { open: 'never', outputFolder: 'out/playwright-report' }]]
    : [['list'], ['html', { open: 'never', outputFolder: 'out/playwright-report' }]],
  outputDir: 'out/playwright-output',
  use: {
    baseURL: 'http://localhost:3000',
    // Trace on failure keeps zips small (one per failing test) while
    // giving full debugging context. `on-first-retry` would also work
    // but we don't always retry; `retain-on-failure` is the safe pick.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // The webServer command is the same locally and in CI. Setting
    // EMAIL_PROVIDER=file + EMAIL_OUTBOX_PATH here ensures both
    // environments write reset emails to a file the specs can read.
    // NODE_ENV is left unset (Next dev sets it to 'development') so the
    // 'file' provider's production-guard doesn't fire.
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      EMAIL_PROVIDER: 'file',
      EMAIL_OUTBOX_PATH: path.resolve('/tmp/prodect-test-emails.jsonl'),
      // E2E_TEST_OAUTH=1 makes instrumentation.ts install an undici
      // MockAgent that intercepts POSTs to oauth2.googleapis.com/token,
      // returning a synthetic id_token. See instrumentation.ts +
      // tests/e2e/auth-google.spec.ts for the wiring. Production builds
      // (and any local dev where this var isn't set) leave the dispatcher
      // untouched.
      E2E_TEST_OAUTH: '1',
      E2E_TEST_OAUTH_USER_PATH: path.resolve('/tmp/prodect-test-oauth-user.json'),
    },
  },
});
