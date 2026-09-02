import { defineConfig, devices } from '@playwright/test';
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import {
  E2E_GITHUB_APP_SLUG,
  E2E_GITHUB_CLIENT_ID,
  E2E_GITHUB_CLIENT_SECRET,
  E2E_GITHUB_TOKEN_ENCRYPTION_KEY,
  E2E_PROVISIONING_ORG,
} from './tests/e2e/_helpers/github-const';
import { E2E_LEGAL_DOCUMENTS_JSON } from './tests/e2e/_helpers/legal-manifest';

// The CLOUD-ON regression lane (Subtask 8.1.10, widened by MOTIR-2849).
//
// ── WHAT THIS LANE IS FOR, AND WHY IT GREW ──────────────────────────────────
//
// It began as the billing lane and is now the home for EVERY regression spec
// whose subject only exists cloud-on. MOTIR-2765 retires the acceptance lane's
// role as a permanent home for specs: once a story's receipt is approved the
// spec that produced it must be PROMOTED into a lane that runs on every PR, or
// retired. For nine of those specs the main lane is not a legal destination —
// it sets none of MOTIR_CLOUD, E2E_TEST_BILLING, MOTIR_AI_URL or
// E2E_TEST_CODE_HEALTH, so the product they assert is switched off there.
//
// ⚠️ AND THEY WOULD NOT GO RED — THEY WOULD GO GREEN. Off-cloud the entitlement
// paths short-circuit to the same inert value they return for an EXEMPT org
// (`billingService.getAiAccess` → `applicable: false`), so an assertion passes
// because billing does not exist rather than because the rule works. That is
// MOTIR-2601, already paid for once. `tests/e2e/ai-callout-gate.spec.ts` states
// the main lane's ground truth from the other side: with Motir AI unconfigured
// there is no orb at all.
//
// WHY WIDEN THIS LANE RATHER THAN BUILD A THIRD (MOTIR-2849). It is already
// cloud-on, already has its own ports and its own CI leg, and the only thing in
// the way was a single hard-coded filename in `testMatch`. A third lane costs a
// third `next build` on every PR, forever, for an env this one already provides.
// Rejected alternatives: adding the flags to the MAIN lane (that turns ~115
// specs cloud-on — a product-posture change smuggled in as a test refactor, and
// it breaks the specs that assert the OFF-cloud shape, `ai-callout-gate` and
// `billing-selfhost` most obviously); and retiring the nine (seven have no twin
// anywhere, and `cloud-acceptance-video.spec.ts` is the only coverage of the
// paid / toggle / pending / upgrade gate states and the board's awaiting badge).
//
// MEMBERSHIP: `billing-cloud.spec.ts` plus the `cloud-*.spec.ts` prefix. The main
// config `testIgnore`s both, so nothing runs twice.
//
// ── The original billing rationale, unchanged ───────────────────────────────
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

// The boundary the mock intercepts — an unresolvable host, so a missing intercept
// fails loud instead of silently escaping to a real network.
const MOTIR_AI_URL = 'http://motir-ai.e2e.local';
const MOTIR_AI_BILLING_FIXTURE_PATH = path.resolve('/tmp/motir-test-billing-fixture.json');
const MOTIR_AI_JOBS_FIXTURE_PATH = path.resolve('/tmp/motir-cloud-ai-jobs-fixture.json');

// ── The boundary fixtures the specs promoted by MOTIR-2849 drive ─────────────
// Carried over from `playwright.acceptance.config.ts` verbatim in intent: each
// is a file the SPEC writes and the SERVER reads, so both sides must agree on
// the path, and both the runner and the webServer must see it.
const CODE_HEALTH_FIXTURE = path.join(__dirname, 'out', 'e2e-code-health-fixture.json');
// The LESSON LIBRARY's boundary fixture (Subtask MOTIR-3340), on the same terms:
// the library's three screens are all SERVER rendered, so `page.route` reaches
// none of them and the spec seeds through this file instead.
const LESSONS_FIXTURE = path.join(__dirname, 'out', 'e2e-lessons-fixture.json');
const MOTIR_GITHUB_CONTROL_PATH = path.resolve('/tmp/motir-cloud-github-control.json');
const MOTIR_GITHUB_JOURNAL_PATH = path.resolve('/tmp/motir-cloud-github-journal.jsonl');
process.env['MOTIR_GITHUB_CONTROL_PATH'] ??= MOTIR_GITHUB_CONTROL_PATH;
process.env['MOTIR_GITHUB_JOURNAL_PATH'] ??= MOTIR_GITHUB_JOURNAL_PATH;

/** The Studio App's credentials. The private key is GENERATED per run rather
 *  than committed: `createAppJwt` really signs RS256 with it (the shipped path
 *  runs unchanged), and a PEM in the repo is a secret-scanner finding for no
 *  benefit. Same decision as the acceptance config. */
const E2E_STUDIO_APP_ID = '424242';
const { privateKey: E2E_STUDIO_APP_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// ⚠️ THE EXECUTOR IS THE ENGINE'S OWN WORKER (MOTIR-3418). This lane used to
// boot a vendor dev server as a second `webServer` and point the runner's SDK
// at it, because seed helpers call services that emit post-commit and a
// key-less SDK threw. An emit is a row in this run's database now, and the
// thing that EXECUTES it is `startJobWorker` in `globalSetup` below — without
// which `email.send` never delivers and every `waitForEmail` in this lane hangs.
// Config-module scope runs before workers fork; they inherit it.
process.env['E2E_JOB_WORKER'] ??= '1';
// The cloud gate the billing surfaces read — also set for the runner process so
// seed-side service reads see the same cloud state the server does.
process.env['MOTIR_CLOUD'] ??= 'true';
// ⚠️ THE LEGAL MANIFEST, ON THE RUNNER TOO — AND IT IS NOT OPTIONAL HERE
// (MOTIR-4015). `motir-core` reads its legal documents from configuration now
// (MOTIR-4007); an unset variable is a VALID state meaning "this operator
// published none", and on that build `outstandingReconsent` has nothing to
// compare and the re-consent gate holds nobody. So without this line
// `cloud-legal-reconsent.spec.ts` does not go red in an informative way — it
// asserts a hold that the build can no longer perform. The runner needs the SAME
// value as the webServer because that spec calls `listLegalDocuments()` itself
// to learn the published versions it then expects on the screen.
process.env['MOTIR_LEGAL_DOCUMENTS'] ??= E2E_LEGAL_DOCUMENTS_JSON;
process.env['MOTIR_AI_BILLING_FIXTURE_PATH'] ??= MOTIR_AI_BILLING_FIXTURE_PATH;
process.env['MOTIR_AI_JOBS_FIXTURE_PATH'] ??= MOTIR_AI_JOBS_FIXTURE_PATH;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: ['**/billing-cloud.spec.ts', '**/cloud-*.spec.ts'],
  // MOTIR-921: resolve `server-only` to an empty stub for the RUNNER only (see
  // tsconfig.node.json). A spec that seeds through a service reaching
  // lib/ai/motirAiClient otherwise dies at import, before collection. Same
  // decision, same stub, as vitest.config.ts and the acceptance config; the Next
  // build still enforces the real boundary.
  tsconfig: './tsconfig.node.json',
  // ⚠️ ADDED BY MOTIR-3418, AND THE LANE DOES NOT WORK WITHOUT IT. `globalSetup`
  // starts the Postgres engine's worker (and `globalTeardown` drains it) — the
  // executor that replaced the vendor dev server this config used to boot as a
  // second `webServer`. It is not a `webServer` entry because it binds no port.
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  // Raised from 30s/5s by MOTIR-2849: the nine promoted specs are long journeys
  // (the repository-set one alone drives nine), and they were authored against
  // the acceptance lane's 90s/20s budget. Lowering their budget as part of a
  // MOVE would be a behaviour change wearing a rename's clothes.
  timeout: 90_000,
  expect: { timeout: 20_000 },
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
      // A PRODUCTION build, not `pnpm dev` (MOTIR-2849, adopting MOTIR-1682's
      // finding). `next dev`'s on-demand compiler made the first test to hit a
      // heavy route pay a cold-compile cost that blew even a 60s assertion
      // timeout under CI load — the original test-1 flake. The nine specs moving
      // in here were authored against a pre-built server for exactly that
      // reason, so the lane they move into has to be one too.
      // ⚠️ `build:worker` IS PART OF THE SERVER COMMAND, and this lane needs it
      // (MOTIR-3418). `globalSetup` starts the engine's worker from the SHIPPED
      // bundle at `.worker/worker.mjs` — never the TypeScript source — so a lane
      // that does not build it fails in globalSetup before a single spec runs.
      // The main config's command has carried this since MOTIR-3427; this one did
      // not need it while the executor was a second `webServer`.
      command: `pnpm exec prisma generate && pnpm exec next build && pnpm run build:worker && pnpm exec next start --port ${PORT}`,
      // The promoted public-redirect regression intentionally redirects `/`.
      url: `${BASE_URL}/sign-in`,
      reuseExistingServer: !process.env['CI'] && !USING_CUSTOM_ORIGIN,
      // Generous: now covers a full `next build` before the server binds.
      timeout: 600_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        // ── The cloud posture ──
        MOTIR_CLOUD: 'true',
        E2E_TEST_BILLING: '1',
        MOTIR_AI_URL,
        // A placeholder service token: motirAiClient.config() requires it to be
        // set, but the boundary mock intercepts every call before it leaves.
        MOTIR_AI_SERVICE_TOKEN: 'e2e-billing-placeholder-token',
        MOTIR_AI_BILLING_FIXTURE_PATH,
        E2E_TEST_AI_JOBS: '1',
        MOTIR_AI_JOBS_FIXTURE_PATH,
        MOTIR_PUBLIC_SITE_URL: 'https://public.motir.e2e',
        // The configured legal manifest (MOTIR-4015) — the same value the runner
        // above reads, from the same module, so the two cannot drift. Its URLs
        // sit under the synthetic public origin on the line above, which is
        // deliberately unreachable: every assertion reads the `href`, none
        // follows it.
        MOTIR_LEGAL_DOCUMENTS: E2E_LEGAL_DOCUMENTS_JSON,
        // ── The prod-build harness (MOTIR-1682) ──
        // `next start` forces NODE_ENV=production; this re-relaxes ONLY the test
        // seams (Secure cookies / the `/api/_test` 404 gate / 'file' email — see
        // lib/e2eProdHarness.ts). The specs here seed via `/api/_test`, so it MUST
        // be set.
        E2E_PROD_HARNESS: '1',
        // `next build` is memory-heavy; and `next start` reads every static chunk
        // through the libuv threadpool, whose default of FOUR queues Prisma's
        // in-flight interactive transactions behind it until they blow the 5s
        // budget and the render 500s (MOTIR-1753 — measured 4 → stalls, 64 → none).
        UV_THREADPOOL_SIZE: '64',
        NODE_OPTIONS: '--max-old-space-size=6144',
        // ── The boundary seams the promoted specs drive (MOTIR-2849) ──
        // Each is the same fixture the acceptance lane provided; a spec that moved
        // here without its seam would assert against a product half switched on.
        E2E_TEST_CODE_HEALTH: '1',
        MOTIR_AI_CODE_HEALTH_FIXTURE_PATH: CODE_HEALTH_FIXTURE,
        E2E_TEST_LESSONS: '1',
        MOTIR_AI_LESSONS_FIXTURE_PATH: LESSONS_FIXTURE,
        E2E_TEST_GITHUB_REPOS: '1',
        MOTIR_GITHUB_CONTROL_PATH,
        MOTIR_GITHUB_JOURNAL_PATH,
        GITHUB_FALLBACK_ORG: E2E_PROVISIONING_ORG,
        GITHUB_STUDIO_APP_ID: E2E_STUDIO_APP_ID,
        GITHUB_STUDIO_APP_PRIVATE_KEY: E2E_STUDIO_APP_PRIVATE_KEY,
        GITHUB_TOKEN_ENCRYPTION_KEY: E2E_GITHUB_TOKEN_ENCRYPTION_KEY,
        GITHUB_APP_SLUG: E2E_GITHUB_APP_SLUG,
        E2E_TEST_OAUTH: '1',
        GITHUB_APP_CLIENT_ID: E2E_GITHUB_CLIENT_ID,
        GITHUB_APP_CLIENT_SECRET: E2E_GITHUB_CLIENT_SECRET,
        // The object store is mocked — CI has no real credentials, and the
        // acceptance panel's player reads through the private content path.
        E2E_TEST_BLOB: '1',
        MOTIR_S3_ENDPOINT: 'https://e2e.s3.invalid',
        MOTIR_S3_REGION: 'auto',
        MOTIR_S3_ACCESS_KEY_ID: 'e2e-playwright-only-placeholder',
        MOTIR_S3_SECRET_ACCESS_KEY: 'e2e-playwright-only-placeholder-secret',
        MOTIR_S3_PRIVATE_BUCKET: 'motir-e2e-private',
        MOTIR_S3_PUBLIC_BUCKET: 'motir-e2e-public',
        MOTIR_S3_PUBLIC_BASE_URL: 'https://e2etest.public.store.invalid',
        // ── The shared E2E server env (mirrors playwright.config.ts) ──
        EMAIL_PROVIDER: 'file',
        EMAIL_OUTBOX_PATH: path.resolve('/tmp/motir-test-emails.jsonl'),
        MOTIR_BASE_URL: BASE_URL,
        E2E_DISABLE_RATE_LIMIT: '1',
        E2E_DISABLE_DEV_INDICATOR: '1',
      },
    },
  ],
});
