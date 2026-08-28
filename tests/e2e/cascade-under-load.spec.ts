import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { E2E_SLOW_JOB_ID, E2E_SLOW_JOB_RELEASE_EVENT } from '@/lib/test-slow-job';

// E2E: a STATUS CASCADE lands while a LONG-RUNNING JOB is in flight
// (Story MOTIR-3758 · Subtask MOTIR-3767) — the story's own journey, automated.
//
//   1. a long-running job is in flight on the engine;
//   2. a person transitions a parent work item to Done, in the UI;
//   3. its children complete WHILE that job is still running;
//   4. the queue's depth/age reading stays healthy from outside the engine.
//
// Step 3 is the assertion the whole story exists for, and it is the one that
// would have failed on 2026-08-28.
//
// ── ⚠️ THE ORDERING IS THE TEST, AND IT IS PINNED RATHER THAN TIMED ──────────
// Written carelessly this spec passes on the pre-change worker: if the long job
// happens to finish before the children are checked, "the children reached Done"
// proves nothing at all. So the probe does not end on a clock — it ends on a
// RELEASE ROW this spec writes AFTER it has asserted, and the assertion is that
// the probe is still `running` at the instant the children are observed Done.
//
// That also removes the flake this spec would otherwise carry. A fixed-duration
// probe races the cascade's own latency, which is ~0.5–0.9 s here and can be many
// seconds on a loaded runner — green locally, red where it is least debuggable.
//
// ── ⚠️ WHY THE OLD WORKER FAILS IT, stated so the assertion is not mistaken for
// a tautology ────────────────────────────────────────────────────────────────
// `tick()` used to end `await Promise.all(claimed.map((run) => this.settle(run)))`.
// The batch-mates of a slow run were never the victims — they settle
// CONCURRENTLY — the victim is everything enqueued AFTERWARDS, because the loop
// cannot issue another tick until the slowest member of the current batch
// settles. So the order here matters: the probe is claimed FIRST and the cascade
// is enqueued SECOND, which is exactly the shape the incident had.
//
// ── The scaffold, VERIFIED on this branch rather than inherited from the card ─
//   * the lane runs a real job worker — `tests/e2e/_helpers/job-worker-process.ts`,
//     started from `globalSetup` because it binds no port;
//   * the long job is `lib/test-slow-job.ts`, registered in the WORKER only and
//     dormant unless `E2E_TEST_SLOW_JOB=1` + `E2E_PROD_HARNESS=1`. No fleet, no
//     container provider, no admission path — the card rules those out by name;
//   * the driving transitions use the `_test` transport, which calls the same
//     shipped `workItemsService.updateStatus` the UI does (the
//     `status-derivation.spec.ts` precedent), and the ACT — the parent going Done
//     — is driven THROUGH THE UI, because that is the journey's own step 2.
//
// Runtime: bounded by the release, not by the probe's guard. Measured on this
// branch — see the card and `tests/e2e/shard-plan.ts` for the recorded cost.

const PWD = 'cascade-load-e2e-pass-123';
const PROJECT_KEY = 'CULOAD';

test.describe.configure({ timeout: 120_000, mode: 'serial' });

interface Tenant {
  workspaceId: string;
  projectId: string;
  ownerEmail: string;
}

async function seedTenant(ownerEmail: string): Promise<Tenant> {
  const owner = await usersService.createUser({
    email: ownerEmail,
    password: PWD,
    name: 'Olivia Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Cascade Load Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Cascade Load Project',
    identifier: PROJECT_KEY,
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  return { workspaceId: workspace.id, projectId: project.id, ownerEmail };
}

async function createItem(
  page: Page,
  projectId: string,
  kind: string,
  title: string,
  parentId?: string,
): Promise<{ id: string; identifier: string }> {
  const res = await page.request.post('/api/_test/work-items', {
    data: { projectId, kind, title, ...(parentId ? { parentId } : {}) },
  });
  expect(res.status(), `create ${kind} "${title}"`).toBe(201);
  return (await res.json()) as { id: string; identifier: string };
}

async function transition(page: Page, id: string, statusKey: string): Promise<void> {
  const res = await page.request.patch(`/api/_test/work-items?id=${id}&status=${statusKey}`);
  expect(res.status(), `transition ${id} → ${statusKey}`).toBe(200);
}

/** Enqueue ONE probe run, due now, and return its queue-row id. */
async function enqueueProbe(workspaceId: string): Promise<string> {
  const event = await adminDb.jobEvent.create({
    data: { name: E2E_SLOW_JOB_ID, data: {}, workspaceId },
  });
  const row = await adminDb.jobQueueRun.create({
    data: {
      jobId: E2E_SLOW_JOB_ID,
      eventId: event.id,
      eventName: E2E_SLOW_JOB_ID,
      workspaceId,
      runAt: new Date(),
      maxAttempts: 1,
    },
  });
  return row.id;
}

async function probeState(runId: string): Promise<string> {
  return (await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: runId } })).state;
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.describe('a status cascade under a long-running job', () => {
  test('@smoke the children reach Done WHILE the long job is still in flight', async ({ page }) => {
    const tenant = await seedTenant('cascade-load@example.com');
    await signIn(page, tenant.ownerEmail, PWD);

    const story = await createItem(page, tenant.projectId, 'story', 'Story under load');
    const childA = await createItem(page, tenant.projectId, 'subtask', 'Child A', story.id);
    const childB = await createItem(page, tenant.projectId, 'subtask', 'Child B', story.id);

    // ── 1 · a long-running job is IN FLIGHT ─────────────────────────────────
    // Claimed BEFORE the cascade is enqueued, which is the incident's shape:
    // the old loop could not tick again until this settled.
    const probeRun = await enqueueProbe(tenant.workspaceId);
    await expect
      .poll(() => probeState(probeRun), {
        timeout: 30_000,
        message: 'awaiting the long-running probe to be CLAIMED',
      })
      .toBe('running');

    // ── 4a · the queue reads healthy from OUTSIDE the engine, mid-flight ─────
    // A busy worker must not read as a stalled queue: the backlog counts what is
    // WAITING, and this run is claimed.
    const during = await page.request.get('/api/health/queue');
    expect(during.status(), 'the queue reading while a long job runs').toBe(200);
    expect((await during.json())['state']).toBe('healthy');

    // ── 2 · a person transitions the parent to Done, in the UI ───────────────
    // `todo → done` is not a legal edge, so the setup hop uses the transport and
    // the JOURNEY's own act goes through the status control.
    await transition(page, story.id, 'in_progress');
    await page.goto(`/items/${story.identifier}`);
    await page.getByRole('button', { name: 'Edit Status' }).click();
    await page.getByRole('combobox', { name: 'Status' }).click();
    await page.getByRole('option', { name: 'Done' }).click();
    await expect
      .poll(async () => (await db.workItem.findUniqueOrThrow({ where: { id: story.id } })).status, {
        timeout: 30_000,
        message: 'awaiting the parent to commit as done',
      })
      .toBe('done');

    // ── 3 · THE ASSERTION — the children complete, and the probe is STILL running
    for (const child of [childA, childB]) {
      await expect
        .poll(
          async () => (await db.workItem.findUniqueOrThrow({ where: { id: child.id } })).status,
          {
            timeout: 30_000,
            message: `awaiting the cascade to complete ${child.identifier}`,
          },
        )
        .toBe('done');
    }

    // ⚠️ THE ORDERING PIN. Without this the test passes on the pre-change worker
    // whenever the probe happens to have finished first — which is the failure
    // mode a spec like this has, rather than a false red.
    expect(
      await probeState(probeRun),
      'the long job must still be in flight at the moment the children are Done',
    ).toBe('running');

    // ── 4b · still healthy, and still answering from outside ────────────────
    const after = await page.request.get('/api/health/queue');
    expect(after.status()).toBe(200);
    expect((await after.json())['state']).toBe('healthy');

    // ── release, and let the probe settle so the lane's worker is free ───────
    await adminDb.jobEvent.create({
      data: { name: E2E_SLOW_JOB_RELEASE_EVENT, data: {}, workspaceId: tenant.workspaceId },
    });
    await expect
      .poll(() => probeState(probeRun), {
        timeout: 30_000,
        message: 'awaiting the released probe to settle',
      })
      .toBe('succeeded');
    // It ended on the RELEASE, not on its runaway guard — a guard-ended run would
    // mean this spec asserted nothing about ordering.
    const ledger = await adminDb.jobRun.findFirstOrThrow({
      where: { functionId: E2E_SLOW_JOB_ID },
    });
    expect(ledger.output).toMatchObject({ releasedEarly: true });
  });
});
