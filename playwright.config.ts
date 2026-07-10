import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import {
  E2E_GITHUB_APP_SLUG,
  E2E_GITHUB_CLIENT_ID,
  E2E_GITHUB_CLIENT_SECRET,
  E2E_GITHUB_TOKEN_ENCRYPTION_KEY,
  E2E_GITHUB_WEBHOOK_SECRET,
} from './tests/e2e/_helpers/github-const';
import {
  E2E_GITLAB_CLIENT_ID,
  E2E_GITLAB_CLIENT_SECRET,
  E2E_GITLAB_TOKEN_ENCRYPTION_KEY,
  E2E_GITLAB_WEBHOOK_SECRET,
} from './tests/e2e/_helpers/gitlab-const';

// Playwright doesn't pick up .env automatically the way Next.js does. The
// spec files import @/lib/db (via _helpers/db-reset) for DB assertions,
// which throws at module load if DATABASE_URL is missing. Load .env from
// the repo root before defineConfig() runs.
loadEnv();

// PRODECT_FINDINGS #8: the suite used to hardcode http://localhost:3000 for
// baseURL, webServer.url, and (implicitly) Better-Auth's trustedOrigins. That
// blocked running the suite from a `git worktree` while a sibling Subtask
// already owned :3000 — the parallel-worktree workflow the manual-merge mode
// assumes. Three things had to move off the fixed port together:
//   1. Playwright baseURL + webServer.url (below).
//   2. Better-Auth's CSRF origin guard — handled by passing BETTER_AUTH_URL
//      into webServer.env; lib/auth/index.ts already threads that through both
//      baseURL and trustedOrigins, so no auth-code change is needed.
//   3. reuseExistingServer — must be off when a custom port is requested, or a
//      worktree could silently reuse a sibling's :3000 server (wrong code).
// Usage from a worktree:  E2E_BASE_URL=http://localhost:3100 pnpm test:e2e
// (or PORT=3100). Default stays :3000 so existing invocations are unchanged.
// E2E_BASE_URL is the single source of truth when set: the dev-server PORT is
// derived FROM it so the spawned server and the URL Playwright drives can't
// disagree (a bare E2E_BASE_URL with a stale PORT would otherwise boot the
// server on one port and drive another).
const USING_CUSTOM_ORIGIN = Boolean(process.env['E2E_BASE_URL']) || Boolean(process.env['PORT']);
const BASE_URL = process.env['E2E_BASE_URL'] ?? `http://localhost:${process.env['PORT'] ?? '3000'}`;
const PORT = new URL(BASE_URL).port || '3000';

// The Inngest dev server's port (Subtask 5.4.11 — the per-run port the :8288
// note below asked for). :8288 was fixed, so two concurrent E2E runs (sibling
// worktrees) collided on the executor even with distinct app PORTs. Setting
// INNGEST_PORT gives this run its own executor: the cli gets `-p`, and the
// Next server + the runner get INNGEST_BASE_URL (the SDK env override for the
// dev-server origin — INNGEST_DEV=1 alone targets the :8288 default). Unset →
// :8288, so existing invocations are unchanged.
const INNGEST_PORT = process.env['INNGEST_PORT'] ?? '8288';
const INNGEST_BASE_URL = `http://localhost:${INNGEST_PORT}`;

// The Inngest dev-server CLI is a pinned `inngest-cli` devDependency (its
// postinstall downloads the standalone Go binary at install time — see
// pnpm-workspace.yaml `allowBuilds`). We invoke the binary by its direct path:
// pnpm's generated `.bin/inngest` shim wraps the target with `node`, but the
// postinstall OVERWRITES bin/inngest with a raw ELF binary, so `pnpm exec
// inngest` would try to parse ELF as JS. This replaced the old `npx --yes
// inngest-cli@<v>` approach, which re-resolved @latest every run, couldn't be
// cached, and cold-downloaded the 95MB binary INSIDE Playwright's 120s
// webServer window (the documented timeout flake). The pinned dep is fetched
// once at install (outside any timeout) and cached via the pnpm store.
const INNGEST_CLI_BIN = 'node_modules/inngest-cli/bin/inngest';

// Subtask 3.5.1 board load-model test seam: forward the cap / Done-age overrides
// to the dev server ONLY when the run sets them, so a targeted
// `BOARD_ISSUE_CAP_OVERRIDE=… pnpm test:e2e --grep board-at-scale` run can reach
// the over-cap banner + Done-age trim with TENS of rows instead of 5,000. Unset
// by default → every other E2E spec (and production) keeps the shipped
// 5,000 / 14 constants (boardsService.resolve{BoardIssueCap,DoneAgeWindowDays}).
const BOARD_LOAD_SEAM_ENV: Record<string, string> = {};
for (const k of ['BOARD_ISSUE_CAP_OVERRIDE', 'DONE_AGE_WINDOW_DAYS_OVERRIDE']) {
  const v = process.env[k];
  if (v !== undefined && v !== '') BOARD_LOAD_SEAM_ENV[k] = v;
}

// The RUNNER process publishes events too (Subtask 5.4.5): seed helpers call
// services directly (e.g. scrum-board-seed's gated updateStatus walk), and
// those service methods emit post-commit (`work-item/transitioned`,
// `work-item/comment.created`). Point the runner's Inngest SDK at the same
// :8288 dev server the Next app uses (the second webServer entry below —
// health-checked before any spec runs), so a seed-level emit publishes
// instead of throwing "no event key". Config-module scope runs in the main
// runner process before workers fork, and workers inherit its env.
process.env['INNGEST_DEV'] ??= '1';
process.env['INNGEST_BASE_URL'] ??= INNGEST_BASE_URL;

/**
 * Playwright config for motir-core's E2E auth smoke suite.
 *
 * Specs live in tests/e2e/. The webServer block spawns `pnpm dev` on
 * :3000 and waits for it to come up; in CI it's a fresh server per job,
 * locally it reuses an already-running dev server if one is up.
 *
 * Email delivery during E2E uses the dev-only 'file' provider from
 * lib/email.ts (see EMAIL_PROVIDER + EMAIL_OUTBOX_PATH below). The
 * specs read /tmp/motir-test-emails.jsonl to capture reset links.
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
  // MOTIR-1565 — the harness readiness gate. Runs AFTER the two webServers
  // below report their `url` ready, but BEFORE the first spec. Playwright's
  // built-in `url` check treats any status < 404 as ready, so a redirecting
  // root URL is "up" the instant the socket binds while `/sign-up` still 404s
  // and inngest's `PUT /api/inngest` sync 404-cascades — which used to red the
  // whole shell-flows suite from one bad shard start. This gate polls the
  // authoritative app + inngest routes with bounded retry/backoff and throws
  // (failing THIS step, not 8 specs) if the server never comes up. See
  // tests/e2e/global-setup.ts + tests/e2e/_helpers/readiness.ts.
  globalSetup: './tests/e2e/global-setup.ts',
  // The cloud-on billing journeys (Subtask 8.1.10) run in their own MOTIR_CLOUD
  // lane (playwright.billing.config.ts) — excluded here so this off-cloud suite
  // never boots them (they 404 without MOTIR_CLOUD, and turning it on globally
  // would break unrelated at-scale/menu specs). The self-host-ABSENT billing spec
  // (billing-selfhost) is off-cloud and DOES run in this lane.
  testIgnore: ['**/billing-cloud.spec.ts', '**/acceptance-video.spec.ts'],
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
    baseURL: BASE_URL,
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
  // TWO servers (Story 1.6.3). Transactional emails are no longer sent inline
  // — password reset + invites enqueue an `email.send` event that a background
  // job delivers. So E2E needs the Inngest dev server (the executor) running
  // alongside `pnpm dev`, or the email never reaches the file outbox the specs
  // poll (waitForEmail would hang). The Next server's INNGEST_DEV=1 points the
  // SDK at the local dev server (default :8288) instead of cloud; the cli `dev`
  // discovers the app via the serve route and invokes the job on each event.
  webServer: [
    {
      // MOTIR-1679: run the E2E suite against a PRODUCTION build (`next build`
      // then `next start`), NOT `next dev`. `next dev` holds a resident on-demand
      // compiler that stalled and dropped connections under bulk-shard load
      // (`net::ERR_CONNECTION_RESET` on a random `page.goto` each run); a
      // production server has everything pre-compiled and is stable under load.
      // The build runs inside this command so the flow is identical locally and
      // in CI (prisma generate guards a fresh worktree that never generated the
      // client). `next start` forces NODE_ENV=production, which would trip the
      // Secure-cookie / `/api/_test` 404 / 'file'-email guards meant for a REAL
      // deploy — E2E_PROD_HARNESS=1 (below) re-relaxes ONLY those test seams,
      // exactly as the sibling E2E_* flags already do (see lib/e2eProdHarness.ts).
      command: `pnpm exec prisma generate && pnpm exec next build && pnpm exec next start --port ${PORT}`,
      url: BASE_URL,
      // Reuse a running dev server locally for fast iteration — but NEVER when a
      // custom origin was requested (a worktree run), since the only server that
      // could be reused on that port is a sibling's, running different code.
      reuseExistingServer: !process.env['CI'] && !USING_CUSTOM_ORIGIN,
      // Generous: this window now covers a full `next build` (minutes) before the
      // server binds, not just a `next dev` boot.
      timeout: 600_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        // MOTIR-1679: run the suite against a production build; this flag
        // re-relaxes the NODE_ENV=production test seams (Secure cookies /
        // /api/_test 404 gate / 'file' email sink) that the production server
        // would otherwise trip. Only ever set here, never in a real deploy.
        E2E_PROD_HARNESS: '1',
        // Give `next build` V8 old-space headroom (it is memory-heavy); harmless
        // for the lightweight `next start` that follows. 6 GB is safely inside
        // the 16 GB `ubuntu-latest` budget shared with Postgres, the Inngest Go
        // binary, the Playwright runner, and Chromium. (An earlier fix bumped
        // this to stop the `next dev` webServer GC-thrashing/OOMing under load;
        // moving to a production build removes that failure mode entirely, but
        // the headroom still helps the build.)
        NODE_OPTIONS: '--max-old-space-size=6144',
        EMAIL_PROVIDER: 'file',
        EMAIL_OUTBOX_PATH: path.resolve('/tmp/motir-test-emails.jsonl'),
        // E2E_TEST_OAUTH=1 makes instrumentation.ts install an undici
        // MockAgent that intercepts POSTs to oauth2.googleapis.com/token,
        // returning a synthetic id_token. See instrumentation.ts +
        // tests/e2e/auth-google.spec.ts for the wiring. Production builds
        // (and any local dev where this var isn't set) leave the dispatcher
        // untouched.
        E2E_TEST_OAUTH: '1',
        E2E_TEST_OAUTH_USER_PATH: path.resolve('/tmp/motir-test-oauth-user.json'),
        // Subtask 5.2.8: E2E_TEST_BLOB=1 makes instrumentation.ts mock the
        // @vercel/blob API (see lib/test-blob-mock.ts), so the attachments
        // journey uploads through the real route without a real blob store —
        // CI deliberately has no real token ("no E2E performs a real
        // upload", ci.yml). The placeholder token only has to PARSE (the SDK
        // derives a store id from it); the network call it authorizes is
        // intercepted before it leaves the process. Forced even when a real
        // token is configured locally, so the suite never writes to (or
        // depends on) a live store.
        E2E_TEST_BLOB: '1',
        BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_e2etest_playwright_only_placeholder',
        // PRODECT_FINDINGS #8: hand the dev server the same origin Playwright
        // drives. lib/auth/index.ts uses BETTER_AUTH_URL as both its baseURL and
        // a trustedOrigins entry, so this is what lets /api/auth/* POSTs pass the
        // CSRF origin guard on a non-default port.
        BETTER_AUTH_URL: BASE_URL,
        // PRODECT_FINDINGS #9: Better-Auth buckets /sign-in + /sign-up into one
        // IP-keyed window (10s / max 3). Multi-user specs sign up several users
        // from localhost inside that window and hit 429s. This flag disables the
        // limiter for the E2E dev server only; lib/auth/index.ts reads it and
        // leaves the limiter fully active everywhere it isn't set (i.e. prod).
        E2E_DISABLE_RATE_LIMIT: '1',
        // Story 1.6.3: route enqueued email.send events to the local Inngest
        // dev server (below), so the job runs and writes the outbox. Without
        // this the SDK targets cloud and no E2E email is ever delivered.
        // INNGEST_BASE_URL points the SDK at THIS run's executor port
        // (Subtask 5.4.11 — a no-op at the :8288 default).
        INNGEST_DEV: '1',
        INNGEST_BASE_URL,
        // Subtask 1.6.6: arm-able deterministic email-fault injector. lib/email.ts
        // reads this file on every send and throws when the recipient matches the
        // armed substring, so the jobs-flow spec can drive the real failure →
        // DLQ → replay path. The file is absent (fault disarmed) unless a spec
        // writes it via tests/e2e/_helpers/email-fault.ts; it is test-only and
        // refused in production.
        EMAIL_FAULT_PATH: path.resolve('/tmp/motir-test-email-fault'),
        // Subtask 1.5.6: hide the Next dev-tools indicator (a bottom-left
        // fixed portal) so it stops occluding the sidebar footer's collapse
        // toggle during the browser-driven shell-flows journey. next.config.ts
        // reads this flag; a normal `pnpm dev` session keeps its indicator.
        E2E_DISABLE_DEV_INDICATOR: '1',
        // Subtask 3.5.1: the board load-model overrides, forwarded from the run's
        // env only when set (empty by default — see BOARD_LOAD_SEAM_ENV above).
        ...BOARD_LOAD_SEAM_ENV,
        // Story 7.10 · MOTIR-897: the GitHub-integration E2E lane. The webhook
        // secret is the SAME value the spec's signWebhook uses (shared via
        // tests/e2e/_helpers/github-const.ts), so the real 7.10.4 signature
        // gate runs against the spec's signed POSTs. The OAuth app creds are
        // synthetic — the code→token exchange + /user read never leave the
        // process (E2E_TEST_OAUTH's MockAgent above intercepts GitHub too).
        GITHUB_WEBHOOK_SECRET: E2E_GITHUB_WEBHOOK_SECRET,
        GITHUB_APP_CLIENT_ID: E2E_GITHUB_CLIENT_ID,
        GITHUB_APP_CLIENT_SECRET: E2E_GITHUB_CLIENT_SECRET,
        GITHUB_TOKEN_ENCRYPTION_KEY: E2E_GITHUB_TOKEN_ENCRYPTION_KEY,
        GITHUB_APP_SLUG: E2E_GITHUB_APP_SLUG,
        // Story 7.23 · MOTIR-1480: the GitLab-integration E2E lane. The webhook
        // secret is the SAME token the spec sends in X-Gitlab-Token (shared via
        // tests/e2e/_helpers/gitlab-const.ts), so the real MOTIR-1475 token gate
        // runs against the spec's deliveries. The OAuth creds are synthetic — the
        // code→token exchange + /api/v4/user read never leave the process
        // (E2E_TEST_OAUTH's MockAgent above intercepts gitlab.com too). GitLab
        // PERSISTS its OAuth tokens, so the connect callback needs the encryption
        // key. GITLAB_BASE_URL is left at its gitlab.com default so the mock host
        // matches.
        GITLAB_WEBHOOK_SECRET: E2E_GITLAB_WEBHOOK_SECRET,
        GITLAB_APP_CLIENT_ID: E2E_GITLAB_CLIENT_ID,
        GITLAB_APP_CLIENT_SECRET: E2E_GITLAB_CLIENT_SECRET,
        GITLAB_TOKEN_ENCRYPTION_KEY: E2E_GITLAB_TOKEN_ENCRYPTION_KEY,
      },
    },
    {
      // The Inngest dev server = the executor. It discovers this app's
      // functions by syncing the serve route (-u), then invokes `email.send`
      // whenever the Next server publishes an event. It listens on
      // INNGEST_PORT (default :8288 — the SDK dev-mode default); a sibling
      // worktree run sets its own INNGEST_PORT so concurrent E2E runs no
      // longer collide on the executor (Subtask 5.4.11).
      command: `${INNGEST_CLI_BIN} dev -u http://localhost:${PORT}/api/inngest --no-discovery -p ${INNGEST_PORT}`,
      url: INNGEST_BASE_URL,
      reuseExistingServer: !process.env['CI'] && !USING_CUSTOM_ORIGIN,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
