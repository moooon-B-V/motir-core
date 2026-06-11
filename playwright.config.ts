import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';

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
      // The webServer command is the same locally and in CI. Setting
      // EMAIL_PROVIDER=file + EMAIL_OUTBOX_PATH here ensures both
      // environments write reset emails to a file the specs can read.
      // NODE_ENV is left unset (Next dev sets it to 'development') so the
      // 'file' provider's production-guard doesn't fire.
      command: `pnpm dev --port ${PORT}`,
      url: BASE_URL,
      // Reuse a running dev server locally for fast iteration — but NEVER when a
      // custom origin was requested (a worktree run), since the only server that
      // could be reused on that port is a sibling's, running different code.
      reuseExistingServer: !process.env['CI'] && !USING_CUSTOM_ORIGIN,
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
        EMAIL_FAULT_PATH: path.resolve('/tmp/prodect-test-email-fault'),
        // Subtask 1.5.6: hide the Next dev-tools indicator (a bottom-left
        // fixed portal) so it stops occluding the sidebar footer's collapse
        // toggle during the browser-driven shell-flows journey. next.config.ts
        // reads this flag; a normal `pnpm dev` session keeps its indicator.
        E2E_DISABLE_DEV_INDICATOR: '1',
        // Subtask 3.5.1: the board load-model overrides, forwarded from the run's
        // env only when set (empty by default — see BOARD_LOAD_SEAM_ENV above).
        ...BOARD_LOAD_SEAM_ENV,
      },
    },
    {
      // The Inngest dev server = the executor. It discovers this app's
      // functions by syncing the serve route (-u), then invokes `email.send`
      // whenever the Next server publishes an event. It listens on
      // INNGEST_PORT (default :8288 — the SDK dev-mode default); a sibling
      // worktree run sets its own INNGEST_PORT so concurrent E2E runs no
      // longer collide on the executor (Subtask 5.4.11).
      command: `npx --yes inngest-cli@latest dev -u http://localhost:${PORT}/api/inngest --no-discovery -p ${INNGEST_PORT}`,
      url: INNGEST_BASE_URL,
      reuseExistingServer: !process.env['CI'] && !USING_CUSTOM_ORIGIN,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
