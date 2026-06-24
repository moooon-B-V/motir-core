import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';

// Dedicated CLOUD-ON E2E lane for the billing journeys (Subtask 8.1.10).
//
// Billing is cloud-only (MOTIR_CLOUD) and turning it on globally would activate
// the §4 entitlement caps (250 work items / 3 projects / 1 workspace) + surface
// the billing menu row — which breaks unrelated specs that seed past those caps
// through the service path (epic6-at-scale's 10k items, workspace-flows' 2nd
// workspace) and the one that asserts the billing row ABSENT off-cloud
// (org-admin). So billing runs in its OWN lane with its OWN cloud-on server,
// leaving the main suite (playwright.config.ts) untouched and off-cloud. The
// self-host-ABSENT scenario is the inverse and stays in the main (off-cloud) lane
// (tests/e2e/billing-selfhost.spec.ts).
//
// The motir-ai side of billing (AI plan/usage + Stripe sessions) is stood in for
// by the E2E_TEST_BILLING boundary mock (instrumentation.ts → lib/test-billing-mock),
// so no live Stripe secret and no motir-ai instance are needed in CI.

loadEnv();

// A SEPARATE default port from the main lane (3000) so the two can run
// concurrently and a stray off-cloud :3000 dev server is never reused here.
const USING_CUSTOM_ORIGIN = Boolean(process.env['E2E_BASE_URL']) || Boolean(process.env['PORT']);
const BASE_URL = process.env['E2E_BASE_URL'] ?? `http://localhost:${process.env['PORT'] ?? '3100'}`;
const PORT = new URL(BASE_URL).port || '3100';

const INNGEST_PORT = process.env['INNGEST_PORT'] ?? '8388';
const INNGEST_BASE_URL = `http://localhost:${INNGEST_PORT}`;
const INNGEST_CLI_BIN = 'node_modules/inngest-cli/bin/inngest';

// The boundary the mock intercepts — an unresolvable host, so a missing intercept
// fails loud instead of silently escaping to a real network.
const MOTIR_AI_URL = 'http://motir-ai.e2e.local';
const MOTIR_AI_BILLING_FIXTURE_PATH = path.resolve('/tmp/motir-test-billing-fixture.json');

// Seed helpers call services that emit post-commit Inngest events; point the
// runner's SDK at this lane's executor so a seed-level emit publishes (mirrors
// the main config). Config-module scope runs before workers fork; they inherit it.
process.env['INNGEST_DEV'] ??= '1';
process.env['INNGEST_BASE_URL'] ??= INNGEST_BASE_URL;
// The cloud gate the billing surfaces read — also set for the runner process so
// seed-side service reads see the same cloud state the server does.
process.env['MOTIR_CLOUD'] ??= 'true';
process.env['MOTIR_AI_BILLING_FIXTURE_PATH'] ??= MOTIR_AI_BILLING_FIXTURE_PATH;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: ['**/billing-cloud.spec.ts'],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'out/playwright-report-billing' }]],
  outputDir: 'out/playwright-output-billing',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `pnpm dev --port ${PORT}`,
      url: BASE_URL,
      reuseExistingServer: !process.env['CI'] && !USING_CUSTOM_ORIGIN,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        // ── The billing lane's distinguishing env ──
        MOTIR_CLOUD: 'true',
        E2E_TEST_BILLING: '1',
        MOTIR_AI_URL,
        // A placeholder service token: motirAiClient.config() requires it to be
        // set, but the boundary mock intercepts every call before it leaves.
        MOTIR_AI_SERVICE_TOKEN: 'e2e-billing-placeholder-token',
        MOTIR_AI_BILLING_FIXTURE_PATH,
        // ── The shared E2E server env (mirrors playwright.config.ts) ──
        EMAIL_PROVIDER: 'file',
        EMAIL_OUTBOX_PATH: path.resolve('/tmp/motir-test-emails.jsonl'),
        BETTER_AUTH_URL: BASE_URL,
        E2E_DISABLE_RATE_LIMIT: '1',
        INNGEST_DEV: '1',
        INNGEST_BASE_URL,
        E2E_DISABLE_DEV_INDICATOR: '1',
      },
    },
    {
      command: `${INNGEST_CLI_BIN} dev -u http://localhost:${PORT}/api/inngest --no-discovery -p ${INNGEST_PORT}`,
      url: INNGEST_BASE_URL,
      reuseExistingServer: !process.env['CI'] && !USING_CUSTOM_ORIGIN,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
