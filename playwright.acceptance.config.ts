import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';

// Dedicated ACCEPTANCE-VIDEO E2E lane (Story MOTIR-1627 · Subtask MOTIR-1632).
//
// The main suite records `video: 'retain-on-failure'` — it keeps a clip only
// when a test FAILS. Story acceptance needs the opposite: a clip of the GREEN
// run, published as the story's acceptance receipt. So the acceptance E2E runs
// in its OWN lane with `video: 'on'` + `trace: 'on'`, capped to the ADR's budget
// (≤ ~60s per the spec's own scope, 720p, a few MB), leaving the main lane
// (playwright.config.ts) untouched at retain-on-failure.
//
// The uploader (`scripts/upload-acceptance-video.mjs`) reads this lane's
// `outputDir` after a green run and POSTs the video + trace + chapters to the
// publish endpoint (MOTIR-1631). A failing run leaves no video, so the uploader
// is a no-op — a red acceptance E2E publishes nothing.
//
// Runs OFF-CLOUD (no MOTIR_CLOUD): acceptance video is ungated off-cloud
// (applicable:false ⇒ eligible), so the panel renders the player with no billing
// chrome — the simplest surface for the spec + the self-test dogfood.

loadEnv();

// A SEPARATE default port from the main (3000) and billing (3100) lanes so all
// three can run concurrently and a stray sibling server is never reused here.
const USING_CUSTOM_ORIGIN = Boolean(process.env['E2E_BASE_URL']) || Boolean(process.env['PORT']);
const BASE_URL = process.env['E2E_BASE_URL'] ?? `http://localhost:${process.env['PORT'] ?? '3200'}`;
const PORT = new URL(BASE_URL).port || '3200';

const INNGEST_PORT = process.env['INNGEST_PORT'] ?? '8488';
const INNGEST_BASE_URL = `http://localhost:${INNGEST_PORT}`;
const INNGEST_CLI_BIN = 'node_modules/inngest-cli/bin/inngest';

// Seed helpers emit post-commit Inngest events; point the runner's SDK at this
// lane's executor so a seed-level emit publishes (mirrors the main config).
process.env['INNGEST_DEV'] ??= '1';
process.env['INNGEST_BASE_URL'] ??= INNGEST_BASE_URL;

// CLOUD-ON, like playwright.billing.config.ts: acceptance video branches on the
// paid-AI-plan gate (MOTIR-1630), which is inert off-cloud — so the E2E must run
// cloud-on to exercise the toggle-off / no-plan panel states. The motir-ai side
// is the E2E_TEST_BILLING boundary mock (no live Stripe / motir-ai). Set on the
// runner too so seed-side reads (setOrgBillingState) match the server.
const MOTIR_AI_URL = 'http://motir-ai.e2e.local';
const MOTIR_AI_BILLING_FIXTURE_PATH = path.resolve('/tmp/motir-acceptance-billing-fixture.json');
process.env['MOTIR_CLOUD'] ??= 'true';
process.env['MOTIR_AI_BILLING_FIXTURE_PATH'] ??= MOTIR_AI_BILLING_FIXTURE_PATH;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: ['**/acceptance-video.spec.ts'],
  timeout: 90_000,
  // Generous assertion timeout: this lane runs `next dev` (below), which compiles
  // routes ON-DEMAND, so the FIRST test to hit `/items/[id]` pays a cold-compile
  // cost that can exceed the 5s default under CI load (only the first — the route
  // is warm for the rest). With retries:0, one cold-compile overrun would red the
  // whole leg, so give the panel-load assertions headroom (MOTIR-1648).
  expect: { timeout: 20_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0, // never retry — a retry would record a second (confusing) clip
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'out/playwright-report-acceptance' }],
  ],
  outputDir: 'out/playwright-output-acceptance',
  use: {
    baseURL: BASE_URL,
    // Record the GREEN run — the whole point of this lane. 720p keeps the clip a
    // few MB (the ADR's budget); the acceptance spec keeps itself short (≤ ~60s).
    video: { mode: 'on', size: { width: 1280, height: 720 } },
    trace: 'on',
    screenshot: 'only-on-failure',
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
        EMAIL_PROVIDER: 'file',
        EMAIL_OUTBOX_PATH: path.resolve('/tmp/motir-test-emails.jsonl'),
        BETTER_AUTH_URL: BASE_URL,
        E2E_DISABLE_RATE_LIMIT: '1',
        INNGEST_DEV: '1',
        INNGEST_BASE_URL,
        E2E_DISABLE_DEV_INDICATOR: '1',
        // Mock @vercel/blob so any in-app upload the spec drives never needs a
        // real store (mirrors the main lane; CI has no real token).
        E2E_TEST_BLOB: '1',
        BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_e2etest_playwright_only_placeholder',
        // Cloud billing + the motir-ai boundary mock (the billing-lane vocabulary).
        MOTIR_CLOUD: 'true',
        E2E_TEST_BILLING: '1',
        MOTIR_AI_URL,
        MOTIR_AI_SERVICE_TOKEN: 'e2e-acceptance-placeholder-token',
        MOTIR_AI_BILLING_FIXTURE_PATH,
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
