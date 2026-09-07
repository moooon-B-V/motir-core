import { defineConfig, devices } from '@playwright/test';
import { E2E_GITHUB_WEBHOOK_SECRET } from './tests/e2e/_helpers/github-const';
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

// Dedicated ACCEPTANCE E2E lane (Story MOTIR-1627 · Subtask MOTIR-1632;
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
// acceptance E2E subtask for every user-facing story, and each writes its
// spec using the `acceptance-<area>.spec.ts` naming convention so this lane
// discovers it. The main config (playwright.config.ts) `testIgnore`s the same
// `acceptance*.spec.ts` pattern so acceptance specs never run in the bulk
// shards (video:'retain-on-failure' + no upload step).
//
// ⚠️ WHO PUBLISHES — CHANGED 2026-09-01 (MOTIR-4096). This lane's `outputDir`
// used to be read by a CI uploader (`scripts/upload-acceptance-video.mjs`),
// which POSTed the video + trace + chapters to the publish endpoint
// (MOTIR-1631). That uploader is RETIRED: the receipt is published by the AGENT
// that recorded it, and the lane's job now ends at the Playwright report
// artifact the clips and sidecars land in.
//
// ⚠️ AND THE DOOR IT PUBLISHES THROUGH DID NOT EXIST UNTIL MOTIR-4704. This
// paragraph said "through the Motir MCP surface" for four days while the MCP
// surface had no acceptance publisher on it at all — so an agent that read this
// file, searched its tool palette and found nothing had been told, accurately,
// to use a door that was not there. The door is now `create_acceptance_upload`
// + `publish_acceptance_result` (two calls: a recording is far larger than a
// tool argument can carry), and the runner's own dispatch prompt asks for them
// on a card that records one — which is the half that makes this work without
// anybody reading this comment.
// What is unchanged is the PRODUCTION side, and it is what this config still
// owes: each spec declares its target story via the `acceptanceStory()` helper →
// `acceptance-story.json` sidecar, and `chapter()` writes `chapters.json`
// beside it, so whoever publishes can resolve a recording to its story. A
// failing run leaves no video — a red acceptance E2E still produces no receipt.
//
// ── Cloud posture: this lane runs CLOUD-ON ──────────────────────────────────
//
// `MOTIR_CLOUD` is set below on BOTH the runner process and the webServer, like
// playwright.cloud.config.ts. This is the file's ONE statement of its
// posture; the assignment sites point back here rather than restate it. Two
// reasons, and the second is why the paragraph is at the TOP of the file:
//
//  1. REACHABILITY. Acceptance video branches on the paid-AI-plan gate
//     (MOTIR-1630), which is inert off-cloud — an off-cloud run renders the
//     ungated player and can never reach the toggle-off / no-plan panel states
//     these specs are here to record.
//  2. FALSIFIABILITY. Entitlement paths short-circuit to the SAME inert value
//     off-cloud that they return for an EXEMPT organization
//     (`billingService.getAiAccess` → `applicable: false`). So off-cloud, an
//     assertion that a meta org sees no paywall passes because billing does not
//     exist, not because the exemption works — permanently green, and green for
//     a reason it is not testing. Cloud-on is what lets that assertion fail.
//
// The motir-ai side is the E2E_TEST_BILLING boundary mock — no live Stripe, no
// live motir-ai.
//
// (MOTIR-2601: this block used to open by saying the lane ran OFF-cloud. That
// was true for the 77 minutes between the lane landing and the flip to
// cloud-on; it then sat here as the file's first sentence about itself and
// misled a spec author into writing exactly the assertion reason 2 describes.)

loadEnv();

// A SEPARATE default port from the main (3000) and billing (3100) lanes so all
// three can run concurrently and a stray sibling server is never reused here.
const USING_CUSTOM_ORIGIN = Boolean(process.env['E2E_BASE_URL']) || Boolean(process.env['PORT']);
const BASE_URL = process.env['E2E_BASE_URL'] ?? `http://localhost:${process.env['PORT'] ?? '3200'}`;
const PORT = new URL(BASE_URL).port || '3200';

// ⚠️ THE EXECUTOR IS THE ENGINE'S OWN WORKER (MOTIR-3418). This lane used to
// boot a vendor dev server as a second `webServer` and point the runner's SDK
// at it, because seed helpers call services that emit post-commit and a
// key-less SDK threw. An emit is a row in this run's database now, and the
// thing that EXECUTES it is `startJobWorker` in `globalSetup` below — without
// which `email.send` never delivers and every `waitForEmail` in this lane hangs.
process.env['E2E_JOB_WORKER'] ??= '1';

// The cloud posture and the two reasons for it: the "Cloud posture" block in
// this file's header. What follows is that block's mechanics — the boundary
// mock's origin, and the runner-side sets below (MOTIR_CLOUD is set on the
// runner too so seed-side reads like setOrgBillingState match the server).
const MOTIR_AI_URL = 'http://motir-ai.e2e.local';
// The code-health boundary fixture (MOTIR-2253): the audit-coverage spec drives
// the SERVER-rendered /code-health page, whose motir-ai reads no browser
// `page.route` can reach. `lib/test-code-health-mock` answers them from this
// file, which the spec rewrites between steps.
const CODE_HEALTH_FIXTURE = path.join(__dirname, 'out', 'e2e-code-health-fixture.json');
const MOTIR_AI_BILLING_FIXTURE_PATH = path.resolve('/tmp/motir-acceptance-billing-fixture.json');
// The motir-ai JOBS boundary fixture (MOTIR-1823): the ask journey's three
// crossings are server-side, so the spec declares what each job settles as by
// writing this file — re-read on every request, so it can change between turns.
const MOTIR_AI_JOBS_FIXTURE_PATH = path.resolve('/tmp/motir-acceptance-ai-jobs-fixture.json');
process.env['MOTIR_AI_JOBS_FIXTURE_PATH'] ??= MOTIR_AI_JOBS_FIXTURE_PATH;
process.env['MOTIR_CLOUD'] ??= 'true';
process.env['MOTIR_AI_BILLING_FIXTURE_PATH'] ??= MOTIR_AI_BILLING_FIXTURE_PATH;

// ── The GitHub repo-provisioning seam (MOTIR-1785) ───────────────────────────
//
// The repository-set journey establishes repositories SERVER-side, so the fake
// GitHub lives in the Next process (lib/test-github-repos-mock.ts, behind
// E2E_TEST_GITHUB_REPOS=1). NO REAL REPOSITORY IS EVER CREATED by this suite.
//
// The two paths are set on the RUNNER too (not only in `webServer.env`), because
// the spec is the other half of the seam: it WRITES the control file to say what
// GitHub should do, and READS the journal to assert the exact outbound request
// bodies the two boundaries sent. Same split as the billing fixture above.
const MOTIR_GITHUB_CONTROL_PATH = path.resolve('/tmp/motir-acceptance-github-control.json');
const MOTIR_GITHUB_JOURNAL_PATH = path.resolve('/tmp/motir-acceptance-github-journal.jsonl');
process.env['MOTIR_GITHUB_CONTROL_PATH'] ??= MOTIR_GITHUB_CONTROL_PATH;
process.env['MOTIR_GITHUB_JOURNAL_PATH'] ??= MOTIR_GITHUB_JOURNAL_PATH;

/** The Studio App's credentials. The private key is GENERATED per run rather than
 *  committed: `createAppJwt` really signs RS256 with it (the shipped path runs
 *  unchanged), and a PEM in the repo is a secret-scanner finding for no benefit. */
const E2E_STUDIO_APP_ID = '424242';
const { privateKey: E2E_STUDIO_APP_PRIVATE_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: ['**/acceptance*.spec.ts'],
  // MOTIR-921: resolve `server-only` to an empty stub for the RUNNER only (see
  // tsconfig.node.json). A spec that seeds through a service reaching
  // lib/ai/motirAiClient otherwise dies at import, before collection. Same
  // decision, same stub, as vitest.config.ts; the Next build still enforces the
  // real boundary.
  tsconfig: './tsconfig.node.json',
  // ⚠️ ADDED BY MOTIR-3418, AND THE LANE DOES NOT WORK WITHOUT IT. `globalSetup`
  // starts the Postgres engine's worker (and `globalTeardown` drains it) — the
  // executor that replaced the vendor dev server this config used to boot as a
  // second `webServer`. It is not a `webServer` entry because it binds no port.
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
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
      // ⚠️ `build:worker` IS PART OF THE SERVER COMMAND, and this lane needs it
      // (MOTIR-3418). `globalSetup` starts the engine's worker from the SHIPPED
      // bundle at `.worker/worker.mjs` — never the TypeScript source — so a lane
      // that does not build it fails in globalSetup before a single spec runs.
      // The main config's command has carried this since MOTIR-3427; this one did
      // not need it while the executor was a second `webServer`.
      command: `pnpm exec prisma generate && pnpm exec next build && pnpm run build:worker && pnpm exec next start --port ${PORT}`,
      // `/sign-in`, NOT the root: with `MOTIR_PUBLIC_SITE_URL` set (below) the
      // root 308s onto the unreachable public origin, and Playwright's
      // ready-check follows it — so the server would never read as ready. A
      // non-redirected auth route is a stable, 200-answering probe.
      url: `${BASE_URL}/sign-in`,
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
        // MOTIR-1753 — size the libuv THREADPOOL for a Node-served build.
        // `next start` reads every static chunk off disk through the threadpool,
        // whose libuv default is FOUR. Measured here: 125 outstanding
        // `fs/promises` requests against those 4 threads — a ~31x queue depth.
        // Everything else that shares the pool then queues behind it, including
        // the completions Prisma's in-flight INTERACTIVE transactions are waiting
        // on, so a transaction sits `idle in transaction` (Postgres reporting
        // `Client/ClientRead` — waiting on US) until it blows Prisma's 5s budget
        // and the render 500s with P2028 / "commit cannot be executed on an
        // expired transaction". A/B on this lane: pool 4 -> 8s stalls + failure;
        // pool 64 -> zero stalls, green, 4.5x faster.
        // Same exposure applies to any deployment where Node serves the assets
        // (self-host `next start`); behind a CDN the static reads never reach it.
        UV_THREADPOOL_SIZE: '64',
        NODE_OPTIONS: '--max-old-space-size=6144',
        EMAIL_PROVIDER: 'file',
        // The GitHub webhook secret (Story MOTIR-2725 · MOTIR-2730). The
        // acceptance lane had never needed it — no acceptance story drove a
        // webhook until a card's completion depended on TWO merges arriving as
        // real `pull_request` deliveries. Without it `/api/github/webhook`
        // answers 500 `GITHUB_WEBHOOK_NOT_CONFIGURED` before verifying anything.
        //
        // The SAME synthetic literal the main lane sets and the spec signs with
        // (`tests/e2e/_helpers/github-const.ts`), so the real 7.10.4 signature
        // gate runs here exactly as it does there — the acceptance clip records
        // the shipped path, not a relaxed one.
        GITHUB_WEBHOOK_SECRET: E2E_GITHUB_WEBHOOK_SECRET,
        EMAIL_OUTBOX_PATH: path.resolve('/tmp/motir-test-emails.jsonl'),
        MOTIR_BASE_URL: BASE_URL,
        // MOTIR-3886 — the moved public surfaces' redirect destination. A
        // synthetic public origin so the redirect FIRES here and points at a
        // host that need not be reachable (the spec asserts the Location header
        // without following it). Must differ from MOTIR_BASE_URL above, which is
        // the gate `publicSiteRedirect` reads. Test-only, never a real deploy.
        MOTIR_PUBLIC_SITE_URL: 'https://public.motir.e2e',
        E2E_DISABLE_RATE_LIMIT: '1',
        E2E_DISABLE_DEV_INDICATOR: '1',
        // Mock the object store so any in-app upload the spec drives never needs
        // a real store (mirrors the main lane; CI has no real credentials).
        // MOTIR-2389: the store is S3-compatible; the endpoint is the host
        // lib/test-blob-mock.ts intercepts, so it must match there.
        E2E_TEST_BLOB: '1',
        MOTIR_S3_ENDPOINT: 'https://e2e.s3.invalid',
        MOTIR_S3_REGION: 'auto',
        MOTIR_S3_ACCESS_KEY_ID: 'e2e-playwright-only-placeholder',
        MOTIR_S3_SECRET_ACCESS_KEY: 'e2e-playwright-only-placeholder-secret',
        MOTIR_S3_PRIVATE_BUCKET: 'motir-e2e-private',
        MOTIR_S3_PUBLIC_BUCKET: 'motir-e2e-public',
        MOTIR_S3_PUBLIC_BASE_URL: 'https://e2etest.public.store.invalid',
        // ⚠️ THE DOCS ROW IS CONFIGURATION NOW (MOTIR-4167 / #2530, MOTIR-4257).
        //
        // `lib/docs/links.ts` resolves the rail's Docs row from an operator's
        // absolute `MOTIR_DOCS_URL` and returns `null` when it is unset, so the
        // row does not render at all — the shape the Legal row beside it already
        // took when MOTIR-3932 moved the public reading surface to
        // motir-marketing.
        //
        // `acceptance-legal-manifest.spec.ts` reads that row as its CONTROL: its
        // chapter asserts the rail offers Docs and NOT Legal, and the Docs half
        // is what makes Legal's absence mean *this build did not configure it*
        // rather than *the rail is empty*. Once the row became conditional, a
        // lane that configures no URL had no control — and the spec went red on
        // `main` for reasons that had nothing to do with legal documents.
        //
        // This lane is the CLOUD-ON arm, and a cloud build has its docs
        // configured, so setting it is what the arm is supposed to represent.
        // The ASSERTION is untouched: a receipt records what was accepted, and
        // relaxing it to match today is the reflex `acceptance-receipt-lifecycle.md`
        // forbids.
        MOTIR_DOCS_URL: 'https://motir.co/docs',
        // Cloud billing + the motir-ai boundary mock (the billing-lane vocabulary).
        MOTIR_CLOUD: 'true',
        // ── The public-address story's two seams (MOTIR-3878 · MOTIR-4225) ──
        //
        // ⚠️ WITHOUT THESE THE SPEC CANNOT REACH THE STATES IT ASSERTS, and
        // `plan-rules/type-test.md` tell (d) is exactly that: a lane that cannot
        // reach the asserted state stays green for ever.
        //
        // The BASE DOMAIN, because the pane renders an operator explanation and
        // no claim field when it is unset — the walk would film that instead of
        // the room.
        MOTIR_PUBLIC_TENANT_DOMAIN: 'motir.e2e',
        // The two PORTS the flow crosses that leave this machine: the certificate
        // platform and public DNS. `lib/publicAddresses/providers.ts` binds
        // in-memory versions on this flag — and REFUSES to, whatever the flag
        // says, when `NODE_ENV === 'production'`, which is what makes an env var
        // an operator could set by accident harmless. Asserted in
        // `tests/publicAddresses/dnsResolverPort.test.ts`.
        MOTIR_E2E_FAKE_PUBLIC_ADDRESS_PROVIDERS: '1',
        E2E_TEST_BILLING: '1',
        MOTIR_AI_URL,
        E2E_TEST_CODE_HEALTH: '1',
        MOTIR_AI_CODE_HEALTH_FIXTURE_PATH: CODE_HEALTH_FIXTURE,
        E2E_TEST_AI_JOBS: '1',
        MOTIR_AI_JOBS_FIXTURE_PATH,
        MOTIR_AI_SERVICE_TOKEN: 'e2e-acceptance-placeholder-token',
        MOTIR_AI_BILLING_FIXTURE_PATH,
        // The GitHub repo-provisioning + collaborator boundary (MOTIR-1785).
        E2E_TEST_GITHUB_REPOS: '1',
        MOTIR_GITHUB_CONTROL_PATH,
        MOTIR_GITHUB_JOURNAL_PATH,
        GITHUB_FALLBACK_ORG: E2E_PROVISIONING_ORG,
        GITHUB_STUDIO_APP_ID: E2E_STUDIO_APP_ID,
        GITHUB_STUDIO_APP_PRIVATE_KEY: E2E_STUDIO_APP_PRIVATE_KEY,
        // The identity/installation the seed binds are read back on this surface;
        // the App slug is what the settings pane the step hands off to renders.
        GITHUB_TOKEN_ENCRYPTION_KEY: E2E_GITHUB_TOKEN_ENCRYPTION_KEY,
        GITHUB_APP_SLUG: E2E_GITHUB_APP_SLUG,
        // The access step's "connect" is a REAL identity OAuth round-trip, not a
        // seeded row: the recorded journey's whole point is that a user with no
        // GitHub account connects one and the invitation follows. Same seam
        // github.spec.ts drives (test-oauth-mock's synthetic `e2e-octocat`).
        E2E_TEST_OAUTH: '1',
        GITHUB_APP_CLIENT_ID: E2E_GITHUB_CLIENT_ID,
        GITHUB_APP_CLIENT_SECRET: E2E_GITHUB_CLIENT_SECRET,
      },
    },
  ],
});
