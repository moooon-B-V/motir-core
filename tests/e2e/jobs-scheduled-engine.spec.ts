// E2E: a SCHEDULED job fires on the Postgres engine, appears on the jobs
// dashboard, and honours its declared catch-up policy across a worker restart
// (Story MOTIR-3416 · Subtask MOTIR-3473 — the story's `verification_recipe`,
// automated).
//
// ⚠️ THE PACING PROBLEM, NAMED RATHER THAN DISCOVERED. Every one of the fourteen
// shipped cadences is too slow for a spec — the fastest is once a minute — and
// the story's own criterion is that no schedule constant moves, so re-timing a
// production job to make the test convenient is out.
//
// The card offered two honest routes: register a test-only cron job on a fast
// expression, or drive one of the fourteen with the scheduler's injected clock
// advanced. **THIS SPEC TAKES NEITHER, AND THE THIRD ROUTE IS BETTER THAN BOTH.**
// A test-only job would have to live in `lib/jobs/registry.ts` — shipped
// production code carrying a fixture — and an injected clock is unreachable from
// here, because the worker is a separate PROCESS started from a bundle.
//
// What this spec does instead is note that **a scheduled job's most recent fire
// is ALREADY IN THE PAST**, always. Routing `system.attachment-gc` (`30 3 * * *`)
// onto the engine at 14:07 means its 03:30 fire is one nothing was scheduling —
// which is precisely the downtime case the story is about — and a `latest`
// disposition owes it immediately. No cadence is waited out, no constant moves,
// and the job that runs is a REAL one on its REAL schedule.
//
// ⚠️ AND THE `skip` HALF NEEDS ITS OWN WORKER, for a structural reason worth
// stating. `skip` suppresses a fire from before the SCHEDULER started, and the
// lane's shared worker starts in `globalSetup` — before every spec. Through it,
// every observable fire is one it was watching for, so `skip` and `latest` are
// indistinguishable however long a spec waits. The second scenario therefore
// starts its own worker with a PRIVATE routing file (see
// `_helpers/job-worker-process.ts`), which is a worker restart across a fire in
// the only form this lane can express.

import { expect, test, type Page } from '@playwright/test';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { truncateJobRuns } from '@/tests/helpers/db';
import { clearJobRouting, routeJobsToEngine } from './_helpers/job-routing';
import { startSpecJobWorker, stopSpecJobWorker } from './_helpers/job-worker-process';
import { startSignedOut } from './_helpers/shell-session';

// Every direct-DB call is `adminDb`, the owner client — post-condition
// assertions and a TRUNCATE, and `tests/rls/test-singleton-statement-guard.test.ts`
// ratchets singleton statements under `tests/e2e/**` downward.
const PASSWORD = 'scheduled-engine-spec-pass-123';

/**
 * ⚠️ THE OPERATOR HERE IS THE PLATFORM ADMIN, AND THAT IS A PRODUCT FACT RATHER
 * THAN A TEST CONVENIENCE. Every `system.*` job writes `workspace_id = NULL`, and
 * the jobs dashboard's ordinary tab reads `listByWorkspace`, which filters on it
 * — so a workspace operator has never been able to see a cron run, on either
 * engine. The SYSTEM tab (`listAll`, under `withSystemContext`) is where they
 * have always been visible, and it is gated on `PLATFORM_ADMIN_EMAIL`, which
 * `playwright.config.ts` now sets for the lane.
 *
 * This story does NOT change the dashboard, its DTOs or its service, so this is
 * the recipe's step automated against the surface that actually renders it.
 */
const OPERATOR_EMAIL = process.env['PLATFORM_ADMIN_EMAIL'] ?? 'sched-platform-admin@example.com';

/**
 * The `latest` pilot: a REAL job, on its REAL daily schedule, whose handler is a
 * harmless cursor-bounded sweep that returns `{ scanned, deleted, failed }` over
 * an empty table. Its most recent fire is by construction hours old.
 */
const CATCH_UP_JOB = 'system.attachment-gc';
/** The one `skip` job in the fourteen — `* * * * *`, so a fire arrives inside a spec. */
const SKIP_JOB = 'system.ci-runner-provision-sweep';

/** The spec worker's PRIVATE view of the cutover switch. */
const SPEC_ROUTING_FILE = path.resolve('/tmp/motir-spec-job-routing');

test.beforeEach(async () => {
  await resetDatabase();
  await truncateJobRuns();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "job_event", "job_queue", "job_step" RESTART IDENTITY CASCADE',
  );
});

test.afterEach(async () => {
  // Unconditional and in this order: stop the spec worker BEFORE clearing its
  // routing, so it cannot schedule one last tick against a file the next spec
  // owns. Then clear the lane's shared routing — a spec that leaves a job routed
  // hands the next one a server behaving differently from the one it was written
  // against.
  await stopSpecJobWorker();
  await rm(SPEC_ROUTING_FILE, { force: true });
  await clearJobRouting();
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

async function signUp(page: Page, email: string): Promise<void> {
  await startSignedOut(page);
  await page.goto('/sign-up');
  await page.getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Create a password').fill(PASSWORD);
  await page.getByRole('button', { name: /^(Create account|Creating account…)$/ }).click();
  await page.waitForURL('**/home', { timeout: 30_000 });
}

async function gotoJobs(page: Page): Promise<void> {
  await page.goto('/settings/workspace/jobs');
  await expect(page.getByRole('heading', { name: 'Job runs', exact: true })).toBeVisible();
}

/**
 * ⚠️ EVERY CELL LOCATOR BELOW IS `exact: true`, AND IT IS LOAD-BEARING.
 * Playwright's accessible-name matching is SUBSTRING by default, and a scheduled
 * run puts the job id in two cells of the same row — the function column
 * (`system.attachment-gc`) and the event column (`scheduled.system.attachment-gc`).
 * A non-exact `getByRole('cell', { name })` therefore resolves to two elements for
 * ONE run, which reads as a duplicate row and is not one. Found by running the
 * spec; the row count is what these assertions mean.
 */

/** Open the SYSTEM tab — the only one an untenanted `system.*` run appears on. */
async function gotoSystemTab(page: Page): Promise<void> {
  await gotoJobs(page);
  await page.getByRole('link', { name: 'System', exact: true }).click();
  await page.waitForURL(/tab=system/);
}

// ── scenarios ──────────────────────────────────────────────────────────────

test('@smoke a SCHEDULED job fires on the engine and the operator can see the run', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signUp(page, OPERATOR_EMAIL);

  // Route the daily sweep onto the engine MID-SPEC, through the file override the
  // switch documents. Its 03:30 fire has already passed with nothing scheduling
  // it, so a `latest` disposition owes exactly that fire, now.
  await routeJobsToEngine(CATCH_UP_JOB);

  // ── the tick enqueued the MISSED fire ────────────────────────────────────
  // The authoritative signal is the committed row, never a sleep.
  await expect
    .poll(async () => adminDb.jobQueueRun.count({ where: { jobId: CATCH_UP_JOB } }), {
      timeout: 60_000,
      intervals: [500],
    })
    .toBe(1);

  const queued = await adminDb.jobQueueRun.findFirstOrThrow({ where: { jobId: CATCH_UP_JOB } });
  // A scheduled run: no triggering event, no tenant, and a fire instant that is
  // a real 03:30 UTC boundary in the PAST — the tick did not invent "now".
  expect(queued.eventId).toBeNull();
  expect(queued.workspaceId).toBeNull();
  expect(queued.eventName).toBe(`scheduled.${CATCH_UP_JOB}`);
  expect(queued.scheduledFor).not.toBeNull();
  expect(queued.scheduledFor!.getTime()).toBeLessThan(Date.now());
  expect(queued.scheduledFor!.getUTCHours()).toBe(3);
  expect(queued.scheduledFor!.getUTCMinutes()).toBe(30);

  // ── the worker claimed it and the handler ran ────────────────────────────
  await expect
    .poll(
      async () =>
        (await adminDb.jobQueueRun.findFirst({ where: { jobId: CATCH_UP_JOB } }))?.state ??
        'missing',
      { timeout: 60_000, intervals: [500] },
    )
    .toBe('succeeded');

  // ── the LEDGER carries the scheduled provenance three consumers read ─────
  const ledger = await adminDb.jobRun.findFirstOrThrow({ where: { functionId: CATCH_UP_JOB } });
  expect(ledger.eventName).toBe(`scheduled.${CATCH_UP_JOB}`);
  expect(ledger.status).toBe('succeeded');

  // ── and the RECIPE's own step: open the page and see it ──────────────────
  // Asserted against the RENDERED row, not the database — the recipe says *open
  // /settings/workspace/jobs*, and a run an operator cannot see is not a migrated
  // job as far as this story is concerned.
  await gotoSystemTab(page);
  await expect(page.getByRole('cell', { name: CATCH_UP_JOB, exact: true })).toHaveCount(1);

  // Filtered, which is the other half of the recipe's sentence.
  await page.getByRole('link', { name: 'Succeeded' }).click();
  await page.waitForURL(/status=succeeded/);
  await expect(page.getByRole('cell', { name: CATCH_UP_JOB, exact: true })).toHaveCount(1);

  // ⚠️ AND THE WORKSPACE TAB DOES NOT SHOW IT — recorded rather than left to
  // surprise the next reader. This is not a regression this story introduces: a
  // `system.*` run is untenanted on BOTH engines, and the workspace tab filters
  // on `workspace_id`. Named on the card as a finding, not changed here.
  await gotoJobs(page);
  await expect(page.getByRole('cell', { name: CATCH_UP_JOB, exact: true })).toHaveCount(0);
});

test('a worker restart across a fire honours the declared CATCH-UP policies', async ({ page }) => {
  // Up to two minute-boundaries for the `skip` job's control, plus the app.
  test.setTimeout(180_000);
  await signUp(page, OPERATOR_EMAIL);

  // ⚠️ BOTH JOBS ARE ROUTED ON THE SPEC WORKER'S PRIVATE FILE, and neither on the
  // lane's. That is what makes this a restart: this worker's scheduler starts
  // NOW, so every fire before this moment is one it was down for — which is the
  // only way `skip` is distinguishable from `latest` in a lane whose shared
  // worker has been up since `globalSetup`.
  await writeFile(SPEC_ROUTING_FILE, `${CATCH_UP_JOB},${SKIP_JOB}`, 'utf8');
  const startedAt = await startSpecJobWorker(SPEC_ROUTING_FILE);

  // ── the CATCH-UP job runs the fire it was down for ───────────────────────
  await expect
    .poll(async () => adminDb.jobQueueRun.count({ where: { jobId: CATCH_UP_JOB } }), {
      timeout: 60_000,
      intervals: [500],
    })
    .toBe(1);
  const caught = await adminDb.jobQueueRun.findFirstOrThrow({ where: { jobId: CATCH_UP_JOB } });
  // The fire predates the restart — that is the whole claim.
  expect(caught.scheduledFor!.getTime()).toBeLessThan(startedAt.getTime());

  // ── the SKIP job does NOT run the fire it was down for ───────────────────
  // Its cadence is per-minute, so a fire certainly passed before the restart, and
  // `skip` says that one is lost rather than late.
  const missed = await adminDb.jobQueueRun.findFirst({
    where: { jobId: SKIP_JOB, scheduledFor: { lt: startedAt } },
  });
  expect(missed, 'a fire from before the restart must not be enqueued').toBeNull();

  // ── THE CONTROL, and without it the assertion above proves nothing ───────
  // A job that is simply broken also enqueues nothing. So wait out one real
  // minute boundary: a fire that happens ON this scheduler's watch MUST be
  // enqueued, which separates "skipped the missed one" from "never schedules".
  await expect
    .poll(
      async () =>
        adminDb.jobQueueRun.count({
          where: { jobId: SKIP_JOB, scheduledFor: { gte: startedAt } },
        }),
      { timeout: 90_000, intervals: [1_000] },
    )
    .toBe(1);

  // And still nothing for the fire it was down for — the later fire did not drag
  // the earlier one in behind it.
  expect(
    await adminDb.jobQueueRun.count({
      where: { jobId: SKIP_JOB, scheduledFor: { lt: startedAt } },
    }),
  ).toBe(0);

  // The operator surface shows the runs that did happen, unchanged by any of it.
  await gotoSystemTab(page);
  await expect(page.getByRole('cell', { name: CATCH_UP_JOB, exact: true })).toHaveCount(1);
});

test('a scheduled job NOT routed to the engine produces no engine rows at all', async ({
  page,
}) => {
  // The negative direction, driven through the real product: with the routing
  // cleared, the shared worker's scheduler must leave every one of the fourteen
  // alone. This is the guard protecting every job the production cutover has not
  // moved yet, and it is why the switch defaults to Inngest.
  await clearJobRouting();
  await signUp(page, OPERATOR_EMAIL);

  // Long enough for several scheduler ticks of the lane's worker (its idle poll
  // ceiling is 5s), so this is an observation rather than a race won.
  await page.waitForTimeout(15_000);

  expect(await adminDb.jobQueueRun.count({ where: { scheduledFor: { not: null } } })).toBe(0);

  await gotoSystemTab(page);
  await expect(page.getByText('No job runs yet')).toBeVisible();
});
