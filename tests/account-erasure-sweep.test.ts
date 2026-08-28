import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDeletionRequest, Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { JobTestEngine } from './helpers/jobs';
import { jobDefinitions } from '@/lib/jobs/registry';
import { jobSchedules } from '@/lib/jobs/schedules';
import { SCHEDULE_CLUSTER_MINUTES } from '@/lib/jobs/schedules';
import {
  ACCOUNT_ERASURE_SWEEP_CRON,
  accountErasureSweep,
} from '@/lib/jobs/definitions/accountErasureSweep';
import { accountDeletionRequestRepository } from '@/lib/repositories/accountDeletionRequestRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { accountDeletionService } from '@/lib/services/accountDeletionService';
import { accountErasureSweepService } from '@/lib/services/accountErasureSweepService';
import { commentsService } from '@/lib/services/commentsService';
import { organizationsService } from '@/lib/services/organizationsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { ERASED_USER_NAME, erasedEmailFor } from '@/lib/users/accountErasure';
import { createTestProject, createTestUser, createTestWorkItem } from './fixtures';
import type { WorkItemFixture } from './fixtures/workItemFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables, truncateCodeGraphOffboarding, truncateJobRuns } from './helpers/db';

// THE ERASURE SWEEP (Story 8.4 · Subtask MOTIR-3702) —
// `accountErasureSweepService.sweep`, against the real Postgres.
//
// This is the most destructive operation in the product, so the suite is
// organised around what could go wrong rather than around the code:
//
//   1. the SELECT — what is due, and the day-29 cancel that lands between the
//      select and the write;
//   2. DELETED — the credential and auth substrate, and the sole-membership
//      workspaces, which must go through `workspacesService.deleteWorkspace` so
//      the code-graph offboarding queue is fed;
//   3. ANONYMISED — a third party's comments and backlog SURVIVE, counted
//      before and after, with the name gone;
//   4. KEPT — the organization's billing rows are untouched;
//   5. the run's own properties — idempotence, batch isolation, and the
//      side-effect-after-commit ordering.

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await truncateCodeGraphOffboarding();
});

afterEach(async () => {
  vi.restoreAllMocks();
  // `job_run` is untenanted, so the workspace cascade never reaches it — cleared
  // AFTER as well as before, or this file's last run leaks into whatever suite
  // the worker picks up next (`tests/helpers/db.ts`).
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

async function orgIdOfWorkspace(workspaceId: string): Promise<string> {
  const ws = await adminDb.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  return ws.organizationId;
}

/** A `WorkItemFixture` in an EXISTING workspace, acting as `userId` — so the
 *  items it creates are REPORTED by that user (the preview suite's helper). */
async function fixtureFor(
  userId: string,
  workspaceId: string,
  identifier: string,
): Promise<WorkItemFixture> {
  const project = await createTestProject({ workspaceId, actorUserId: userId, identifier });
  return {
    owner: await adminDb.user.findUniqueOrThrow({ where: { id: userId } }),
    workspace: await adminDb.workspace.findUniqueOrThrow({ where: { id: workspaceId } }),
    project,
    ownerId: userId,
    workspaceId,
    projectId: project.id,
    projectIdentifier: project.identifier,
    ctx: { userId, workspaceId },
  };
}

/**
 * Schedule a deletion and back-date it so it is DUE.
 *
 * It goes through the real `scheduleAccountDeletion` — the row a sweep acts on
 * must be the row the product writes, including its `requestedAt` /
 * `erasureDueAt` pair — and is then aged with a direct update, because 30 days
 * is not a thing a test can wait for and moving the clock would move the whole
 * fixture's timestamps with it.
 */
async function scheduleDue(userId: string, daysOverdue = 1): Promise<AccountDeletionRequest> {
  const dto = await accountDeletionService.scheduleAccountDeletion(userId);
  const requestedAt = new Date(Date.now() - (30 + daysOverdue) * DAY_MS);
  return adminDb.accountDeletionRequest.update({
    where: { id: dto.id },
    data: { requestedAt, erasureDueAt: new Date(requestedAt.getTime() + 30 * DAY_MS) },
  });
}

/** The erased profile row, read through the owner client (RLS is not the subject here). */
async function readUser(userId: string) {
  return adminDb.user.findUniqueOrThrow({ where: { id: userId } });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE SELECT — what is due, and the cancel that lands mid-sweep
// ─────────────────────────────────────────────────────────────────────────────

describe('the sweep is a registered cron job on a clustered minute', () => {
  it('is mounted by the registry and self-registers its schedule', () => {
    // `jobDefinitions` is what the serve route mounts — a job absent from it is
    // a cron nobody runs, which for THIS job means a published 30-day erasure
    // promise the product states and never keeps.
    expect(jobDefinitions).toContain(accountErasureSweep);

    const schedule = jobSchedules().find((s) => s.functionId === 'system.account-erasure-sweep');
    expect(schedule?.cron).toBe(ACCOUNT_ERASURE_SWEEP_CRON);
  });

  it('fires on a CLUSTERED minute, so it opens no new wake-minute', () => {
    // `lib/jobs/schedules.ts`'s cluster invariant: the bill is a property of the
    // SET of schedules, and a job on a fresh minute splits a quiet gap. Asserted
    // here as well as in the cluster suite so this job's own file carries it.
    const minute = Number(ACCOUNT_ERASURE_SWEEP_CRON.split(' ')[0]);
    expect(SCHEDULE_CLUSTER_MINUTES).toContain(minute);
  });
});

describe('the due set', () => {
  it('erases a request whose deadline has passed and leaves one still inside its window', async () => {
    const due = await createTestUser();
    const waiting = await createTestUser();
    await scheduleDue(due.id);
    await accountDeletionService.scheduleAccountDeletion(waiting.id);

    const summary = await accountErasureSweepService.sweep();

    expect(summary).toMatchObject({ scanned: 1, erased: 1, failed: 0 });
    expect((await readUser(due.id)).name).toBe(ERASED_USER_NAME);
    expect((await readUser(waiting.id)).name).toBe('Owner');
  });

  it('SKIPS a request cancelled between the SELECT and the write — the day-29 cancel sticks', async () => {
    const user = await createTestUser();
    await scheduleDue(user.id);
    const emailBefore = (await readUser(user.id)).email;

    // The cancel lands in the window the lock exists to close: after the batch
    // SELECT has committed and handed the row over, before the per-user erasure
    // takes its `FOR UPDATE` and re-reads the status. The sweep must notice.
    const realFind = accountDeletionRequestRepository.findDueOrResumable;
    vi.spyOn(accountDeletionRequestRepository, 'findDueOrResumable').mockImplementation(
      async (input, tx: Prisma.TransactionClient) => {
        const rows = await realFind(input, tx);
        await accountDeletionService.cancelAccountDeletion(user.id);
        return rows;
      },
    );

    const summary = await accountErasureSweepService.sweep();

    expect(summary).toMatchObject({ scanned: 1, erased: 0, skipped: 1, failed: 0 });
    const after = await readUser(user.id);
    expect(after.email).toBe(emailBefore);
    expect(after.name).toBe('Owner');
    // The credential survives too — a skipped erasure erases NOTHING, not "less".
    expect(await adminDb.account.count({ where: { userId: user.id } })).toBe(1);
  });

  it('REFUSES to erase the last owner of a shared organization, and leaves the request scheduled', async () => {
    // `scheduleAccountDeletion` refuses this at request time, so the state can
    // only arise by the ownership moving DURING the 30-day window — which is
    // exactly what its own comment hands to this job.
    const user = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: user.id,
    });
    const request = await scheduleDue(user.id);
    await organizationsService.addMember({
      organizationId: await orgIdOfWorkspace(workspace.id),
      userId: (await createTestUser()).id,
      role: 'member',
      actorUserId: user.id,
    });

    const summary = await accountErasureSweepService.sweep();

    expect(summary).toMatchObject({ scanned: 1, erased: 0, blocked: 1, failed: 0 });
    expect((await readUser(user.id)).name).toBe('Owner');
    const after = await adminDb.accountDeletionRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(after.status).toBe('scheduled');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. DELETED — credentials, and the workspaces that go with the account
// ─────────────────────────────────────────────────────────────────────────────

describe('DELETED — what is theirs alone', () => {
  it('removes every credential and auth-substrate row, and lands the request at completed', async () => {
    const user = await createTestUser();
    await adminDb.passkey.create({
      data: {
        userId: user.id,
        name: 'Laptop',
        publicKey: 'pk',
        credentialID: `cred-${user.id}`,
        counter: 0,
        deviceType: 'singleDevice',
        backedUp: false,
        transports: 'internal',
      },
    });
    await adminDb.twoFactor.create({
      data: { userId: user.id, secret: 'sec', backupCodes: 'codes' },
    });
    await adminDb.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true } });
    const request = await scheduleDue(user.id);

    await accountErasureSweepService.sweep();

    expect(await adminDb.account.count({ where: { userId: user.id } })).toBe(0);
    expect(await adminDb.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await adminDb.passkey.count({ where: { userId: user.id } })).toBe(0);
    expect(await adminDb.twoFactor.count({ where: { userId: user.id } })).toBe(0);
    expect(await adminDb.apiToken.count({ where: { userId: user.id } })).toBe(0);

    const after = await readUser(user.id);
    expect(after.twoFactorEnabled).toBe(false);
    expect(after.email).toBe(erasedEmailFor(user.id));
    expect(after.emailVerified).toBe(false);
    expect(after.image).toBeNull();

    const completed = await adminDb.accountDeletionRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).not.toBeNull();
  });

  it('RELEASES the real address, so the person can open a new account with it', async () => {
    const user = await createTestUser({ email: 'leaver@example.com' });
    await scheduleDue(user.id);

    await accountErasureSweepService.sweep();

    expect((await readUser(user.id)).email).not.toBe('leaver@example.com');
    const reborn = await createTestUser({ email: 'leaver@example.com' });
    expect(reborn.id).not.toBe(user.id);
  });

  it('deletes a SOLE-MEMBERSHIP workspace through deleteWorkspace, feeding the offboarding queue', async () => {
    // The card's own contract: routed through `deleteWorkspace`, the existing
    // `workspace_deleted` arm fires and nothing is owed; by any other path the
    // derived graphs become the unreferenced orphans
    // `docs/decisions/code-graph-index-fleet.md` §14 exists to prevent. The
    // assertion is therefore the QUEUE ROW, not the call.
    const user = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Personal',
      ownerUserId: user.id,
    });
    const project = await createTestProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      identifier: 'SOLO',
    });
    await scheduleDue(user.id);

    const summary = await accountErasureSweepService.sweep();

    expect(summary.workspacesDeleted).toBe(1);
    expect(await adminDb.workspace.count({ where: { id: workspace.id } })).toBe(0);

    const queued = await adminDb.codeGraphOffboarding.findMany({
      where: { coreWorkspaceId: workspace.id },
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ reason: 'workspace_deleted', coreProjectId: project.id });
    // IMMEDIATE, not windowed — `isImmediate('workspace_deleted')`.
    expect(queued[0]!.dueAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('leaves a SHARED workspace standing and drops only the erased account’s membership', async () => {
    const owner = await createTestUser();
    const user = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });
    await scheduleDue(user.id);

    const summary = await accountErasureSweepService.sweep();

    expect(summary.workspacesDeleted).toBe(0);
    expect(await adminDb.workspace.count({ where: { id: workspace.id } })).toBe(1);
    expect(await adminDb.workspaceMembership.count({ where: { userId: user.id } })).toBe(0);
    expect(await adminDb.workspaceMembership.count({ where: { userId: owner.id } })).toBe(1);
    expect(await adminDb.codeGraphOffboarding.count()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ANONYMISED — a third party's project keeps its rows
// ─────────────────────────────────────────────────────────────────────────────

describe('ANONYMISED — what is part of someone else’s project', () => {
  it('keeps every comment and attributed work item, by ROW COUNT, with the name removed', async () => {
    const owner = await createTestUser();
    const user = await createTestUser({ name: 'Departing Dana' });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });

    const ownerFx = await fixtureFor(owner.id, workspace.id, 'SHR');
    const userFx = {
      ...ownerFx,
      ownerId: user.id,
      ctx: { userId: user.id, workspaceId: workspace.id },
    };

    const reported = await createTestWorkItem(userFx, { kind: 'task', title: 'Reported by user' });
    const assigned = await createTestWorkItem(ownerFx, { kind: 'task', title: 'Assigned to user' });
    await adminDb.workItem.update({ where: { id: assigned.id }, data: { assigneeId: user.id } });
    await commentsService.addComment(assigned.id, { bodyMd: 'One' }, userFx.ctx);
    await commentsService.addComment(assigned.id, { bodyMd: 'Two' }, userFx.ctx);

    const commentsBefore = await adminDb.comment.count();
    const itemsBefore = await adminDb.workItem.count();
    expect(commentsBefore).toBe(2);
    expect(itemsBefore).toBe(2);

    await scheduleDue(user.id);
    await accountErasureSweepService.sweep();

    // The ROWS survive — deleting a colleague's backlog is data loss for a third
    // party, not erasure. Counted, not name-checked: a name check passes just as
    // happily against a table somebody quietly emptied.
    expect(await adminDb.comment.count()).toBe(commentsBefore);
    expect(await adminDb.workItem.count()).toBe(itemsBefore);
    expect(await adminDb.workItem.count({ where: { id: reported.id } })).toBe(1);

    // And the NAME is gone — from every attribution at once, because they all
    // render through the one profile row.
    const erased = await readUser(user.id);
    expect(erased.name).toBe(ERASED_USER_NAME);
    expect(erased.email).toBe(erasedEmailFor(user.id));

    const stillReported = await adminDb.workItem.findUniqueOrThrow({
      where: { id: reported.id },
      include: { reporter: true },
    });
    expect(stillReported.reporter.name).toBe(ERASED_USER_NAME);
    const comment = await adminDb.comment.findFirstOrThrow({ include: { author: true } });
    expect(comment.author.name).toBe(ERASED_USER_NAME);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. KEPT — Article 17 is not absolute
// ─────────────────────────────────────────────────────────────────────────────

describe('KEPT — what erasure does not reach', () => {
  it('leaves the organization’s billing rows untouched', async () => {
    // In motir-core the billing substrate is ORGANIZATION-scoped — the
    // subscription state on `organization` and the CI charge meters — so the
    // "kept" group survives by construction and this pins that it does.
    const owner = await createTestUser();
    const user = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });
    const organizationId = await orgIdOfWorkspace(workspace.id);

    await adminDb.organization.update({
      where: { id: organizationId },
      data: { scaledTrackerSubscription: { status: 'active', seats: 2 } },
    });
    const charge = await adminDb.ciPeriodCharge.create({
      data: { organizationId, periodStart: new Date('2026-08-01'), chargedCredits: 1200 },
    });

    await scheduleDue(user.id);
    await accountErasureSweepService.sweep();

    const org = await adminDb.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(org.scaledTrackerSubscription).toEqual({ status: 'active', seats: 2 });
    const keptCharge = await adminDb.ciPeriodCharge.findUniqueOrThrow({ where: { id: charge.id } });
    expect(keptCharge.chargedCredits).toBe(1200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The run's own properties
// ─────────────────────────────────────────────────────────────────────────────

describe('the run', () => {
  it('is IDEMPOTENT — a second sweep over the same row changes nothing', async () => {
    const user = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Personal',
      ownerUserId: user.id,
    });
    // A project, so the workspace delete has a graph scope to enqueue — an
    // empty workspace enqueues nothing, which would make the queue assertion
    // below pass for the wrong reason.
    await createTestProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      identifier: 'IDEM',
    });
    await scheduleDue(user.id);

    const first = await accountErasureSweepService.sweep();
    expect(first).toMatchObject({ erased: 1, workspacesDeleted: 1, failed: 0 });
    const afterFirst = await readUser(user.id);

    // The second pass re-visits the row on the RESUME arm (the request is
    // `completed` and recent), re-derives an EMPTY workspace set, and does
    // nothing — which is what makes a retried, partially-completed run safe.
    const second = await accountErasureSweepService.sweep();
    expect(second).toMatchObject({ scanned: 1, resumed: 1, workspacesDeleted: 0, failed: 0 });

    expect(await readUser(user.id)).toEqual(afterFirst);
    expect(await adminDb.workspace.count({ where: { id: workspace.id } })).toBe(0);
    expect(await adminDb.codeGraphOffboarding.count()).toBe(1);
  });

  it('RESUMES a completed request whose workspace delete never ran', async () => {
    // The crash this arm exists for: the erasure transaction committed and the
    // post-commit workspace delete did not.
    const user = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Personal',
      ownerUserId: user.id,
    });
    await createTestProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      identifier: 'RESM',
    });
    await scheduleDue(user.id);

    const boom = vi
      .spyOn(workspacesService, 'deleteWorkspace')
      .mockRejectedValueOnce(new Error('blob store unreachable'));
    const first = await accountErasureSweepService.sweep();
    expect(first).toMatchObject({ failed: 1 });
    // The account IS erased — the transaction committed before the throw.
    expect((await readUser(user.id)).name).toBe(ERASED_USER_NAME);
    expect(await adminDb.workspace.count({ where: { id: workspace.id } })).toBe(1);
    boom.mockRestore();

    const second = await accountErasureSweepService.sweep();

    expect(second).toMatchObject({ resumed: 1, workspacesDeleted: 1, failed: 0 });
    expect(await adminDb.workspace.count({ where: { id: workspace.id } })).toBe(0);
    expect(await adminDb.codeGraphOffboarding.count()).toBe(1);
  });

  it('does NOT abort the batch when one account throws — the second still completes', async () => {
    // The rows are ordered by deadline, so an account that throws every tick
    // would otherwise hold every account behind it past the published 30 days.
    const first = await createTestUser();
    const second = await createTestUser();
    const firstRequest = await scheduleDue(first.id, 3);
    await scheduleDue(second.id, 1);

    const realAnonymise = userRepository.anonymise;
    vi.spyOn(userRepository, 'anonymise').mockImplementation(async (id, data, tx) => {
      if (id === first.id) throw new Error('erasure exploded');
      return realAnonymise(id, data, tx);
    });

    const summary = await accountErasureSweepService.sweep();

    expect(summary).toMatchObject({ scanned: 2, erased: 1, failed: 1 });
    expect(summary.failures).toEqual([{ requestId: firstRequest.id, error: 'erasure exploded' }]);
    // The second account is fully erased…
    expect((await readUser(second.id)).name).toBe(ERASED_USER_NAME);
    // …and the first is untouched and still due, so the next tick retries it.
    expect((await readUser(first.id)).name).toBe('Owner');
    expect(await adminDb.account.count({ where: { userId: first.id } })).toBe(1);
    const stillDue = await adminDb.accountDeletionRequest.findUniqueOrThrow({
      where: { id: firstRequest.id },
    });
    expect(stillDue.status).toBe('scheduled');
  });

  it('runs its side effect AFTER the erasure transaction commits, never inside it', async () => {
    // The acceptance criterion is about the SHAPE of the transaction: it holds
    // DB writes and nothing else, and `deleteWorkspace` — which opens its own
    // transactions and fires the offboarding enqueue — is outside it.
    //
    // Read from an INDEPENDENT connection at the moment `deleteWorkspace` is
    // entered: if the delete were inside the erasure transaction, that
    // transaction would not have committed and this read would still see
    // `scheduled`. Seeing `completed` is the ordering, observed rather than
    // asserted about the source.
    const user = await createTestUser();
    await workspacesService.createWorkspace({ name: 'Personal', ownerUserId: user.id });
    const request = await scheduleDue(user.id);

    let statusWhenSideEffectRan: string | null = null;
    const real = workspacesService.deleteWorkspace;
    vi.spyOn(workspacesService, 'deleteWorkspace').mockImplementation(async (input) => {
      const row = await adminDb.accountDeletionRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      statusWhenSideEffectRan = row.status;
      return real(input);
    });

    await accountErasureSweepService.sweep();

    expect(statusWhenSideEffectRan).toBe('completed');
  });

  it('records a non-Error throw by its string form rather than losing it', async () => {
    // A throw that is not an `Error` still has to reach the ledger: the summary
    // is the ONLY durable record of a failed erasure — `AccountDeletionStatus`
    // has no `failed` member — so a reason that stringifies to `[object Object]`
    // is better than a reason that is dropped.
    const user = await createTestUser();
    const request = await scheduleDue(user.id);
    vi.spyOn(userRepository, 'anonymise').mockImplementation(() => {
      throw 'the database went away';
    });

    const summary = await accountErasureSweepService.sweep();

    expect(summary).toMatchObject({ erased: 0, failed: 1 });
    expect(summary.failures).toEqual([{ requestId: request.id, error: 'the database went away' }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The JOB, driven in-process
// ─────────────────────────────────────────────────────────────────────────────

describe('the scheduled job (driven in-process)', () => {
  it('erases the due account and persists its summary on the job_run ledger row', async () => {
    // The handler itself, not just the service under it: an erasure sweep whose
    // job never runs is a published 30-day promise the product states and never
    // enforces. And the ledger `output` is the ONLY durable record of a
    // per-account failure, since the status enum has no `failed` member — so
    // "what did this tick actually do" has to be answerable from the row.
    const user = await createTestUser();
    // Due against the REAL clock: the handler calls `sweep()` with no argument,
    // so this is the one case that cannot pin `now`.
    await scheduleDue(user.id);

    const engine = new JobTestEngine({ function: accountErasureSweep });
    const { result } = await engine.execute();

    expect(result).toMatchObject({ scanned: 1, erased: 1, failed: 0 });
    expect((await readUser(user.id)).name).toBe(ERASED_USER_NAME);

    const runs = await adminDb.jobRun.findMany();
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.functionId).toBe('system.account-erasure-sweep');
    expect(run.status).toBe('succeeded');
    // Untenanted, like every `system.*` sweep — the due set spans tenants.
    expect(run.workspaceId).toBeNull();
    expect(run.output).toMatchObject({ erased: 1, failed: 0 });
  });
});
