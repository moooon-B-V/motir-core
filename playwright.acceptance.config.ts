import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';

// Dedicated ACCEPTANCE-VIDEO E2E lane (Story MOTIR-1627 · Subtask MOTIR-1632;
// per-story support MOTIR-1700).
//
// The main suite records `video: 'retain-on-failure'` — it keeps a clip only
// when a test FAILS. Story acceptance needs the opposite: a clip of the GREEN
// run, published as the story's acceptance receipt. So the acceptance E2E runs
// in its OWN lane with `video: 'on'` + `trace: 'on'`, capped to the ADR's budget
// (≤ ~60s per the spec's own scope, 720p, a few MB), leaving the main lane
// (playwright.config.ts) untouched at retain-on-failure.
//
// `testMatch` catches BOTH the MOTIR-1627 self-test dogfood
// (`acceptance-video.spec.ts`) AND story-specific acceptance specs
// (`acceptance-<story>.spec.ts`) — the planner rule (MOTIR-1644) creates an
// acceptance-video E2E subtask for every user-facing story, and each writes its
// spec using the `acceptance-<area>.spec.ts` naming convention so this lane
// discovers it. The main config (playwright.config.ts) `testIgnore`s the same
// `acceptance*.spec.ts` pattern so acceptance specs never run in the bulk
// shards (video:'retain-on-failure' + no upload step).
//
// The uploader (`scripts/upload-acceptance-video.mjs`) reads this lane's
// `outputDir` after a green run and POSTs the video + trace + chapters to the
// publish endpoint (MOTIR-1631). Each spec declares its target story via the
// `acceptanceStory()` helper → `acceptance-story.json` sidecar; the uploader
// resolves each recorded video's story from its sidecar (→ PR ref → fallback).
// A failing run leaves no video, so the uploader is a no-op — a red acceptance
// E2E publishes nothing.
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
  testMatch: ['**/acceptance*.spec.ts'],
  timeout: 90_000,
  // Assertion headroom for CI load. This lane now runs a PRODUCTION build (see
  // webServer below, MOTIR-1682), so there is NO on-demand cold-compile cost on
  // the first `/items/[id]` hit — the source of the old test-1 flake. A generous
  // 20s is kept anyway as a margin under heavy CI contention (retries:0).
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
      // MOTIR-1682: run the acceptance lane against a PRODUCTION build (`next
      // build` + `next start`), NOT `next dev` — mirroring the main lane
      // (playwright.config.ts, MOTIR-1679). `next dev`'s resident on-demand
      // compiler made the FIRST test to hit `/items/[id]` pay a cold-compile
      // cost that, under CI load, blew even the 60s assertion timeout (the
      // test-1 flake). A production server is fully pre-compiled and stable.
      // `next start` forces NODE_ENV=production; E2E_PROD_HARNESS=1 re-relaxes
      // ONLY the test seams (Secure cookies / `/api/_test` 404 gate / 'file'
      // email — see lib/e2eProdHarness.ts). This lane seeds via `/api/_test`, so
      // it MUST set the flag. `prisma generate` guards a fresh worktree.
      command: `pnpm exec prisma generate && pnpm exec next build && pnpm exec next start --port ${PORT}`,
      url: BASE_URL,
      reuseExistingServer: !process.env['CI'] && !USING_CUSTOM_ORIGIN,
      // Generous: now covers a full `next build` (minutes) before the server binds.
      timeout: 600_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        // MOTIR-1682: production-harness flag — re-relaxes the NODE_ENV=production
        // test seams the prod server trips (see lib/e2eProdHarness.ts). Test-only,
        // never a real deploy.
        E2E_PROD_HARNESS: '1',
        // `next build` is memory-heavy; give V8 old-space headroom (harmless for
        // the lightweight `next start` that follows). Inside the CI 16 GB budget.
        NODE_OPTIONS: '--max-old-space-size=6144',
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
