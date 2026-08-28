import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import {
  E2E_DEFERRING_JOB_ID,
  E2E_DEFERRING_JOB_KIND,
  E2E_DEFERRING_JOB_RELEASE_EVENT,
} from '@/lib/test-deferring-job';
import { POOL_SIZE } from '@/lib/jobs/engine/worker';

// E2E: the fast lane keeps flowing with the WHOLE POOL full of supervisions
// (Story MOTIR-3778 · Subtask MOTIR-3832) — the story's journey step 2,
// automated.
//
//   1. `POOL_SIZE` container supervisions are under way at once;
//   2. a person transitions a parent work item to Done, in the UI;
//   3. its children complete within seconds — WHILE every supervision is still
//      in flight.
//
// ── ⚠️ THE POOL IS THE TEST, AND ONE SLOW JOB IS NOT ────────────────────────
// `cascade-under-load.spec.ts` (MOTIR-3767) already covers ONE long run beside
// the fast lane, and it PASSES on the pre-MOTIR-3778 worker — because MOTIR-3762
// made the batch settle independently, so a single supervisor detains only its
// own slot. Filling the pool with one probe would therefore assert nothing this
// story added.
//
// ── ⚠️ WHY THE PRE-CHANGE WORKER FAILS THIS ONE, named so the assertion cannot
// be mistaken for a tautology ────────────────────────────────────────────────
// Before this story a supervisor held one of the worker's `POOL_SIZE` in-flight
// slots for its container's WHOLE LIFE — thirty-five minutes for a code-graph
// refresh (`docs/decisions/job-lane-occupancy.md`, priced and accepted there).
// With `POOL_SIZE` of them claimed, `freeCapacity` is 0, so `tick()` returns at
// its first line without claiming anything, `loop()` takes the *saturated is not
// idle* branch and waits on `waitForSlot` — for a settle that is half an hour
// away. The `work-item/transitioned` run the parent's Done enqueues is never
// claimed, and the children sit unfinished until a supervisor ends.
//
// After MOTIR-3778 a supervision is a state machine over RUNS: each pass does one
// poll and DEFERS its own queue row, so between polls it occupies no capacity at
// all. Ten of them leave the pool essentially empty, and the cascade lands in the
// gap — which is what step 3 observes.
//
// ── ⚠️ IT IS PINNED, NOT TIMED ───────────────────────────────────────────────
// Written carelessly this spec passes for the wrong reason: if the probes happen
// to have finished before the children are checked, "the children reached Done"
// proves nothing. So no probe ends on a clock — every one ends on a RELEASE ROW
// this spec writes AFTER it has asserted, and the assertion includes that all
// `POOL_SIZE` supervisions are still `watching` at the instant the children are
// observed Done. `waitForTimeout` appears nowhere in this file.
//
// ── The scaffold, VERIFIED on this branch rather than inherited from the card ─
//   * the lane runs a real job worker — `tests/e2e/_helpers/job-worker-process.ts`,
//     started from `globalSetup` because it binds no port;
//   * the probe is `lib/test-deferring-job.ts`, registered in the WORKER only and
//     dormant unless `E2E_TEST_DEFERRING_JOB=1` + `E2E_PROD_HARNESS=1`. It drives
//     the REAL `advanceSupervision`, so it writes a real `job_supervision` row and
//     defers a real `job_queue` row — the card's own first question, answered by
//     reading `lib/test-slow-job.ts`: that probe HOLDS its slot in a `while` loop,
//     which is the behaviour this story removes, so it cannot stand in here;
//   * no fleet, no container provider and no admission path — the probe is a job
//     that defers, not a real index;
//   * the setup transitions use the `_test` transport onto the shipped
//     `workItemsService.updateStatus`, and the ACT — the parent going Done — is
//     driven THROUGH THE UI, because that is the journey's own step.
//
// ⚠️ NO ACCEPTANCE VIDEO AND NO ACCEPTANCE PANEL. This story ships no
// user-observable surface — its deliverable is engine behaviour — so
// `plan-rules/kind-story.md`'s scoped exemption applies. There is deliberately no
// `acceptanceStory(...)` here and this spec does not ride the acceptance lane.
//
// Runtime: bounded by the release, not by any probe's guard. Measured on this
// branch — see the card and `tests/e2e/shard-plan.ts` for the recorded cost.

const PWD = 'supervision-pool-e2e-pass-123';
const PROJECT_KEY = 'SUPLOAD';

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
    name: 'Supervision Pool Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Supervision Pool Project',
    identifier: PROJECT_KEY,
  });
  await adminDb.workspaceMembership.update({
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

/** Enqueue ONE probe supervision, due now, and return its queue-row id. */
async function enqueueProbe(workspaceId: string, n: number): Promise<string> {
  const event = await adminDb.jobEvent.create({
    data: { name: E2E_DEFERRING_JOB_ID, data: { n }, workspaceId },
  });
  const row = await adminDb.jobQueueRun.create({
    data: {
      jobId: E2E_DEFERRING_JOB_ID,
      eventId: event.id,
      eventName: E2E_DEFERRING_JOB_ID,
      // Untenanted, exactly as the supervisors it stands in for: a `system.*`
      // probe belongs to no workspace, and the supervision row denormalises that.
      workspaceId: null,
      runAt: new Date(),
      maxAttempts: 1,
    },
  });
  return row.id;
}

/** How many probe supervisions are advancing — a row that has polled at least once. */
async function advancingProbes(): Promise<number> {
  return adminDb.jobSupervision.count({
    where: { kind: E2E_DEFERRING_JOB_KIND, state: 'watching', pollNumber: { gte: 1 } },
  });
}

/** How many probe supervisions are still in flight, whatever their poll count. */
async function watchingProbes(): Promise<number> {
  return adminDb.jobSupervision.count({
    where: { kind: E2E_DEFERRING_JOB_KIND, state: 'watching' },
  });
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.describe('the fast lane with the whole pool full of supervisions', () => {
  test('@smoke a cascade lands while POOL_SIZE supervisions are in flight', async ({ page }) => {
    const tenant = await seedTenant('supervision-pool@example.com');
    await signIn(page, tenant.ownerEmail, PWD);

    const story = await createItem(page, tenant.projectId, 'story', 'Story under a full pool');
    const childA = await createItem(page, tenant.projectId, 'subtask', 'Child A', story.id);
    const childB = await createItem(page, tenant.projectId, 'subtask', 'Child B', story.id);

    // ── 1 · POOL_SIZE supervisions, all in flight ───────────────────────────
    // Enqueued BEFORE the cascade, which is the incident's shape: on the old
    // worker these ten would have taken every slot and held them.
    const probeRuns: string[] = [];
    for (let n = 0; n < POOL_SIZE; n += 1) {
      probeRuns.push(await enqueueProbe(tenant.workspaceId, n));
    }

    // Wait on an AUTHORITATIVE signal that every probe is genuinely supervising:
    // a `job_supervision` row that has already advanced a poll. A count of
    // claimed queue rows would not do — the point is that they are NOT claimed
    // most of the time.
    await expect
      .poll(advancingProbes, {
        timeout: 60_000,
        message: `awaiting all ${POOL_SIZE} probe supervisions to be advancing`,
      })
      .toBe(POOL_SIZE);

    // ⚠️ AND THE POOL IS FREE WHILE THEY RUN. Ten supervisions in flight, and
    // the queue rows they own are `pending` between polls rather than claimed —
    // which on the pre-change worker was 10 of 10 slots held and `freeCapacity`
    // pinned at zero.
    const claimedDuring = await adminDb.jobQueueRun.count({
      where: { id: { in: probeRuns }, state: 'running' },
    });
    expect(
      claimedDuring,
      'ten supervisions must not hold ten slots — that is the occupancy this story removes',
    ).toBeLessThan(POOL_SIZE);

    // ── 2 · a person transitions the parent to Done, in the UI ───────────────
    // `todo → done` is not a legal edge, so the setup hop uses the transport and
    // the JOURNEY's own act goes through the status control.
    await transition(page, story.id, 'in_progress');
    await page.goto(`/items/${story.identifier}`);
    await page.getByRole('button', { name: 'Edit Status' }).click();
    await page.getByRole('combobox', { name: 'Status' }).click();
    await page.getByRole('option', { name: 'Done' }).click();
    await expect
      .poll(
        async () => (await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } })).status,
        { timeout: 30_000, message: 'awaiting the parent to commit as done' },
      )
      .toBe('done');

    // ── 3 · THE ASSERTION — the children complete, and every probe is STILL in
    //        flight ────────────────────────────────────────────────────────────
    for (const child of [childA, childB]) {
      await expect
        .poll(
          async () =>
            (await adminDb.workItem.findUniqueOrThrow({ where: { id: child.id } })).status,
          {
            timeout: 30_000,
            message: `awaiting the cascade to complete ${child.identifier}`,
          },
        )
        .toBe('done');
    }

    // ⚠️ THE ORDERING PIN. Without it this passes on the pre-change worker
    // whenever the probes happen to have finished first — which is the failure
    // mode a spec like this has, rather than a false red.
    expect(
      await watchingProbes(),
      `all ${POOL_SIZE} supervisions must still be in flight at the moment the children are Done`,
    ).toBe(POOL_SIZE);

    // ── release, and let every probe settle so the lane's worker is free ─────
    await adminDb.jobEvent.create({
      data: { name: E2E_DEFERRING_JOB_RELEASE_EVENT, data: {}, workspaceId: tenant.workspaceId },
    });
    await expect
      .poll(
        async () =>
          adminDb.jobQueueRun.count({ where: { id: { in: probeRuns }, state: 'succeeded' } }),
        { timeout: 60_000, message: 'awaiting every released probe to settle' },
      )
      .toBe(POOL_SIZE);

    // Every probe ended on the RELEASE, not on its runaway guard — a
    // guard-ended run would mean this spec asserted nothing about ordering.
    const ledger = await adminDb.jobRun.findMany({
      where: { functionId: E2E_DEFERRING_JOB_ID, status: 'succeeded' },
    });
    expect(ledger, 'ONE ledger row per probe, however many passes it made').toHaveLength(POOL_SIZE);
    for (const row of ledger) {
      expect(row.output, 'released, not timed out').toMatchObject({ reason: 'completed' });
    }
    // …and the supervision rows are gone with them.
    expect(await watchingProbes()).toBe(0);
  });
});
