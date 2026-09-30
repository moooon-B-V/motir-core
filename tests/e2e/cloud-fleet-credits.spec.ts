import { expect, test, type Page, type Response } from '@playwright/test';
import { getGlobalDispatcher, setGlobalDispatcher, type Dispatcher, type MockAgent } from 'undici';
import type { CiRunnerProvisioningIntent } from '@/generated/prisma/client';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import {
  seedBillingOwner,
  setOrgBillingState,
  resetBillingFixture,
  paidOrgState,
  type BillingSeed,
} from './_helpers/billing';
import { E2E_PROVISIONING_ORG } from './_helpers/github-const';
import { installSharedMockAgent } from '@/lib/test-mock-agent';
import { installBillingBoundaryMock } from '@/lib/test-billing-mock';
import { ciLiveChargeService } from '@/lib/services/ciLiveChargeService';
import {
  ciRunnerAdmissionService,
  BALANCE_UNAVAILABLE_DETAIL,
} from '@/lib/services/ciRunnerAdmissionService';
import { ciPeriodUsageRepository } from '@/lib/repositories/ciPeriodUsageRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { periodStartFor } from '@/lib/ciMetering/period';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { FLEET_CONTAINER_SIZE, fakeOrchestrator, type ContainerHandle } from '@motir/orchestrator';

// WHAT THE BILLING PAGE SAYS WHILE MONEY MOVES (Story MOTIR-6906 · MOTIR-6913).
//
// The story adds no surface. Its promise to a customer is carried by one that
// already exists — the billing page's *Motir CI* line and its paused state
// (`ci-minutes-allowance.md` §D) — so this walks that page through a run in
// progress, a balance driven to zero by that run, and a balance nobody can read.
// No acceptance video: nothing new is drawn, so the story accepts on its tests.
//
// ⚠️ THE TICKS ARE DRIVEN FROM THIS PROCESS, and that is deliberate. The live
// charge is a cron job (`system.ci-live-charge`, every debit period) and no
// `_test` route runs a cron job — so, as `reconcile-tick.ts` drives the reconcile
// sweep, this calls the SHIPPED `ciLiveChargeService.tick` in-process with a
// chosen `now`. Everything from the service down is real: the accrual, the
// rollup, the charge through `chargeForMeteredRun`, the stop through
// `fleetStopService`. The lane's job worker cannot fire the same cron behind the
// spec's back: it inherits the runner's env from `globalSetup`, before this file
// sets `GITHUB_FALLBACK_ORG`, so the CI meter is inert there.
//
// ⚠️ THE FAR SIDES ARE FAKED WHERE THE EXISTING BILLING E2E FAKES THEM. motir-ai
// is `lib/test-billing-mock.ts`, installed in THIS process too — the same file
// the app server reads, so a debit a tick makes here is the balance the page
// shows next. The provider is the fake orchestrator. GitHub is never reached: the
// org owns no Motir-hosted repository, so the stop has no workflow run to cancel
// there, and the container record is the run as Motir knows it.
//
// ⚠️ THE CLOCK IS PINNED INSIDE THE CURRENT MONTH. A tick's accrual is a sum over
// `startedAt`, and its idempotency key is the debit period — so two ticks must
// sit in two different periods, and both must meter into the month the page
// reads. Anchoring on the first instant of the current month satisfies both on
// every day of the year, without waiting on a real five minutes.

test.describe.configure({ timeout: 90_000 });

const billingPath = '/settings/organization/billing';
/** The lane's motir-ai origin (`playwright.cloud.config.ts`) — unresolvable, so a
 *  call the mock does not answer fails loud instead of leaving the box. */
const MOTIR_AI_URL = 'http://motir-ai.e2e.local';
/** A one-member org's included pool — the 1,000-minute floor (§1). */
const POOL_MINUTES = 1_000;

const MONTH_START = periodStartFor(new Date());
/** `MONTH_START + minutes`. */
const at = (minutes: number): Date => new Date(MONTH_START.getTime() + minutes * 60_000);

// ── This process's boundaries, scoped to this file ──────────────────────────
//
// A Playwright worker runs many spec files, so nothing set here may outlive the
// file: the env and the global dispatcher are restored in `afterAll`.

const RUNNER_ENV: Record<string, string> = {
  GITHUB_FALLBACK_ORG: E2E_PROVISIONING_ORG,
  MOTIR_AI_URL,
  MOTIR_AI_SERVICE_TOKEN: 'e2e-billing-placeholder-token',
  MOTIR_FLEET_ORCHESTRATOR: 'fake',
};
const savedEnv: Record<string, string | undefined> = {};
let savedDispatcher: Dispatcher;
let agent: MockAgent;

test.beforeAll(() => {
  for (const [key, value] of Object.entries(RUNNER_ENV)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  savedDispatcher = getGlobalDispatcher();
  agent = installSharedMockAgent();
  installBillingBoundaryMock(agent);
});

test.afterAll(async () => {
  setGlobalDispatcher(savedDispatcher);
  await agent.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await db.$disconnect();
});

test.beforeEach(async () => {
  await resetDatabase();
  resetBillingFixture();
  fakeOrchestrator.reset();
});

// ── Seeds ────────────────────────────────────────────────────────────────────

let jobSeq = 0;

async function seedIntent(
  seed: BillingSeed,
  overrides: { status?: string; startedAt?: Date | null; handle?: ContainerHandle } = {},
): Promise<CiRunnerProvisioningIntent> {
  jobSeq += 1;
  const handle = overrides.handle;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: seed.workspaceId,
      organizationId: seed.organizationId,
      projectId: seed.projectId,
      installationId: '556677',
      runId: `e2e-run-${jobSeq}`,
      runAttempt: 1,
      jobId: String(70_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: E2E_PROVISIONING_ORG,
      repoName: 'billing-e2e',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: at(0),
      status: overrides.status ?? 'pending',
      startedAt: overrides.startedAt ?? null,
      containerProvider: handle?.provider ?? null,
      containerId: handle?.id ?? null,
      containerRegion: handle?.region ?? null,
      bootedAt: handle ? at(0) : null,
    },
  });
}

/** A CI job running on a (fake) container since `startedAt`. */
async function runningJob(seed: BillingSeed, startedAt: Date) {
  const handle = await fakeOrchestrator.provision({
    orgId: seed.organizationId,
    workspaceId: seed.workspaceId,
    projectId: seed.projectId,
    repoFullName: `${E2E_PROVISIONING_ORG}/billing-e2e`,
    workload: 'ci_runner',
    workflowJobId: 70_000 + jobSeq + 1,
    image: 'motir/runner@sha256:e2e',
    size: FLEET_CONTAINER_SIZE,
    env: {},
    timeoutSeconds: 3600,
    region: 'iad',
  });
  const intent = await seedIntent(seed, { status: 'running', startedAt, handle });
  return { handle, intent };
}

/** Minutes already metered this month, before the run under test. */
async function alreadyUsed(seed: BillingSeed, minutes: number): Promise<void> {
  await withSystemContext((tx) =>
    ciPeriodUsageRepository.incrementForPeriod(
      {
        workspaceId: seed.workspaceId,
        organizationId: seed.organizationId,
        periodStart: MONTH_START,
        billableMinutes: minutes,
        rawWallClockSeconds: minutes * 60,
        linearEquivalentMinutes: minutes,
      },
      tx,
    ),
  );
}

async function intentRow(id: string) {
  return adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id } });
}

// ── The page ─────────────────────────────────────────────────────────────────

/** Open (or reopen) billing on its AUTHORITATIVE status read. */
async function openBilling(page: Page, seed: BillingSeed): Promise<Response> {
  const read = page.waitForResponse(
    (r) =>
      r.request().method() === 'GET' &&
      new URL(r.url()).pathname === `/api/organizations/${seed.organizationId}/billing`,
  );
  await page.goto(billingPath);
  return read;
}

// Every text read is scoped to the live `main` landmark: the shell streams, and a
// page-rooted `getByText` can match the outgoing copy (MOTIR-5037).
const usedOf = (page: Page, used: number) =>
  page
    .getByRole('main')
    .getByText(`${used.toLocaleString()} of ${POOL_MINUTES.toLocaleString()} minutes`, {
      exact: true,
    });

// ── The cases ────────────────────────────────────────────────────────────────

test('the Motir CI line moves on each tick while the run is still going', async ({ page }) => {
  const seed = await seedBillingOwner(page, 'e2e-fleet-credits-run@example.com');
  setOrgBillingState(seed.organizationId, paidOrgState({ balance: 2_000 }));
  const run = await runningJob(seed, at(1));

  // Before any tick nothing is metered — the line's own "nothing to bill" shape.
  expect((await openBilling(page, seed)).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Motir CI', level: 2 })).toBeVisible();
  await expect(
    page.getByRole('main').getByText("All of this project's repositories are your own,"),
  ).toBeVisible();

  // First debit period: nine whole minutes since the job started.
  expect(await ciLiveChargeService.tick(at(10))).toMatchObject({
    outcome: 'ticked',
    organizations: [{ organizationId: seed.organizationId, accruedMinutes: 9 }],
    stopped: [],
  });
  expect((await openBilling(page, seed)).status()).toBe(200);
  await expect(usedOf(page, 9)).toBeVisible();

  // The next period adds only what the first did not count.
  expect(await ciLiveChargeService.tick(at(20))).toMatchObject({
    organizations: [{ organizationId: seed.organizationId, accruedMinutes: 10 }],
    stopped: [],
  });
  expect((await openBilling(page, seed)).status()).toBe(200);
  await expect(usedOf(page, 19)).toBeVisible();

  // …and all of it while the run is still in progress.
  expect(await intentRow(run.intent.id)).toMatchObject({ status: 'running', settledAt: null });
  expect(fakeOrchestrator.liveContainerIds()).toEqual([run.handle.id]);
  await expect(
    page.getByRole('main').getByText('CI is paused — your credits ran out.'),
  ).toHaveCount(0);
});

test('a run that drives the balance to zero is stopped, and the page shows CI paused', async ({
  page,
}) => {
  const seed = await seedBillingOwner(page, 'e2e-fleet-credits-zero@example.com');
  // Five minutes of pool left, three credits: the run's next nine minutes spend
  // the pool and then four credits the org does not have.
  setOrgBillingState(seed.organizationId, paidOrgState({ balance: 3 }));
  await alreadyUsed(seed, POOL_MINUTES - 5);
  const run = await runningJob(seed, at(1));

  expect((await openBilling(page, seed)).status()).toBe(200);
  await expect(usedOf(page, POOL_MINUTES - 5)).toBeVisible();
  await expect(
    page.getByRole('main').getByText('CI is paused — your credits ran out.'),
  ).toHaveCount(0);

  // ONE tick: the accrual, the debit that takes the balance below zero, and the
  // stop — in that order, in the same tick.
  expect(await ciLiveChargeService.tick(at(10))).toMatchObject({
    outcome: 'ticked',
    organizations: [{ organizationId: seed.organizationId, accruedMinutes: 9, charge: 'charged' }],
    stopped: [seed.organizationId],
  });

  // The run is cancelled: its container is gone and its record says why.
  expect(await intentRow(run.intent.id)).toMatchObject({
    status: 'failed',
    teardownReason: 'credits_exhausted',
  });
  expect(fakeOrchestrator.liveContainerIds()).toEqual([]);

  // And the page says so — the paused card, hoisted, with the minutes that got it there.
  expect((await openBilling(page, seed)).status()).toBe(200);
  await expect(
    page.getByRole('main').getByText('CI is paused — your credits ran out.'),
  ).toBeVisible();
  await expect(page.getByRole('main').getByText('CI paused', { exact: true })).toBeVisible();
  await expect(usedOf(page, POOL_MINUTES + 4)).toBeVisible();
});

test('an unreadable balance pauses nothing, and new work waits for it', async ({ page }) => {
  const seed = await seedBillingOwner(page, 'e2e-fleet-credits-unknown@example.com');
  // Past the pool, so only the balance decides — and nobody can read it.
  await alreadyUsed(seed, POOL_MINUTES + 20);
  const run = await runningJob(seed, at(1));
  setOrgBillingState(seed.organizationId, {
    ...paidOrgState({ balance: 0 }),
    usageUnavailable: true,
  });

  // The page renders its "couldn't load" state — the AI line and the CI line
  // share this one read — and never the paused card, which would be a guess.
  expect((await openBilling(page, seed)).status()).toBe(502);
  await expect(page.getByRole('main').getByText("Couldn't load billing")).toBeVisible();
  await expect(
    page.getByRole('main').getByText('CI is paused — your credits ran out.'),
  ).toHaveCount(0);

  // A tick stops nothing already running on a balance it could not read…
  expect(await ciLiveChargeService.tick(at(10))).toMatchObject({
    outcome: 'ticked',
    stopped: [],
  });
  expect(await intentRow(run.intent.id)).toMatchObject({ status: 'running' });
  expect(fakeOrchestrator.liveContainerIds()).toEqual([run.handle.id]);

  // …and a new job is deferred with the unknown-balance reason, still pending.
  const queued = await seedIntent(seed);
  expect(await ciRunnerAdmissionService.admit(queued)).toEqual({
    outcome: 'deferred',
    reason: 'balance_unavailable',
    detail: BALANCE_UNAVAILABLE_DETAIL,
  });
  expect((await intentRow(queued.id)).status).toBe('pending');

  // Once the balance can be read again, Retry shows the line — and it is NOT
  // paused: the balance came back positive.
  setOrgBillingState(seed.organizationId, paidOrgState({ balance: 500 }));
  const retried = page.waitForResponse(
    (r) =>
      r.request().method() === 'GET' &&
      new URL(r.url()).pathname === `/api/organizations/${seed.organizationId}/billing`,
  );
  await page.getByRole('button', { name: 'Try again' }).click();
  expect((await retried).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Motir CI', level: 2 })).toBeVisible();
  await expect(
    page.getByRole('main').getByText('CI is paused — your credits ran out.'),
  ).toHaveCount(0);
});
