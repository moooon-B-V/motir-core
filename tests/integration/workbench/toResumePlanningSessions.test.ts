import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { homeService } from '@/lib/services/homeService';
import { workbenchPlanningService } from '@/lib/services/workbenchPlanningService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import type { PlanOrigin, PlanStatus } from '@/generated/prisma/client';

// A FAILED PLANNING SESSION ON TO RESUME (Story MOTIR-7905 · MOTIR-7914), against a REAL
// Postgres and under RLS: the reader's failed-waiting sessions are the FIRST segment of
// the To resume order, windowed with the gated runs under one honest `total`, counted by
// the same predicate; their plans leave the Planning tab's list and count. Every claim
// has its counterfactual in the same fixture.

const T = { timeout: 120_000 };

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const hctx = (fx: WorkItemFixture) => ({ ...fx.ctx, projectId: fx.projectId });

async function enrolMember(fx: WorkItemFixture, slug: string) {
  const user = await createTestUser({ email: `${slug}-${Date.now()}@example.com`, name: slug });
  await workspacesService.addMember({
    userId: user.id,
    workspaceId: fx.workspaceId,
    workspaceRole: 'member',
  });
  return user;
}

interface SessionOpts {
  ownerId: string;
  failed?: boolean;
  awaiting?: boolean;
  ended?: boolean;
  origin?: 'conversation' | 'guide';
  failedAt?: string;
  targetKeys?: string[];
  plan?: {
    status?: PlanStatus;
    title?: string;
    createdById?: string | null;
    origin?: PlanOrigin;
  } | null;
  projectId?: string;
  workspaceId: string;
}

/** A session in the requested state, with its plan; returns both ids. */
async function session(fx: WorkItemFixture, opts: SessionOpts) {
  const row = await adminDb.planChangeSession.create({
    data: {
      workspaceId: opts.workspaceId,
      projectId: opts.projectId ?? fx.projectId,
      createdById: opts.ownerId,
      scopeKey: `scope-${Math.random()}`,
      targetKeys: opts.targetKeys ?? [],
      origin: opts.origin ?? 'conversation',
      ...(opts.failed
        ? {
            failedAt: new Date(opts.failedAt ?? '2026-10-09T10:00:00Z'),
            failedJobId: 'job-x',
            failureReason: 'rate_limited' as const,
            failureStopPhase: 'author' as const,
            failureStopRef: 'planItem:abc',
            failureStopTitle: 'Export a report',
          }
        : {}),
      ...(opts.awaiting
        ? { awaitingPersonSince: new Date(), awaitingPersonCause: 'question' as const }
        : {}),
      ...(opts.ended ? { endedAt: new Date(), endReason: 'restarted' as const } : {}),
    },
  });
  const plan =
    opts.plan === null
      ? null
      : await adminDb.plan.create({
          data: {
            workspaceId: opts.workspaceId,
            projectId: opts.projectId ?? fx.projectId,
            sessionId: row.id,
            status: opts.plan?.status ?? 'generating',
            title: opts.plan?.title ?? 'A plan',
            createdById:
              opts.plan?.createdById === undefined ? opts.ownerId : opts.plan.createdById,
            origin: opts.plan?.origin ?? 'user',
          },
        });
  return { sessionId: row.id, planId: plan?.id ?? null };
}

/** A gated run: a card the reader owns, waiting on a gate, stamped with the run it waits on. */
async function gatedRun(fx: WorkItemFixture, runId: string, title: string) {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  // The run is a real row (`work_item_resume_run_id_fkey`); it names no scope card, so its entry is
  // headed by the first card it carries — the scope-less form `toResumeEntryDto` supports.
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      command: 'run_scope',
      scopeLabel: runId,
      createdById: fx.ownerId,
    },
  });
  await adminDb.workItem.update({
    where: { id: dto.id },
    data: {
      status: 'in_progress',
      assigneeId: fx.ownerId,
      resumeState: 'waiting_on_gate',
      resumeRunId: run.id,
    },
  });
  return dto.id;
}

describe('the reader’s failed sessions are the first segment of To resume', () => {
  it(
    'lists exactly the reader’s failed session, with its record and plan, beside the runs',
    T,
    async () => {
      const fx = await makeWorkItemFixture({ identifier: 'PLN' });
      const teammate = await enrolMember(fx, 'teammate');
      const target = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'The target story' },
        fx.ctx,
      );
      const mine = await session(fx, {
        ownerId: fx.ownerId,
        failed: true,
        workspaceId: fx.workspaceId,
        targetKeys: [target.identifier],
        plan: { title: 'Mine' },
      });
      await session(fx, { ownerId: teammate.id, failed: true, workspaceId: fx.workspaceId });
      await session(fx, {
        ownerId: fx.ownerId,
        ended: true,
        workspaceId: fx.workspaceId,
      });
      await session(fx, { ownerId: fx.ownerId, workspaceId: fx.workspaceId }); // open, not failed
      await session(fx, { ownerId: fx.ownerId, awaiting: true, workspaceId: fx.workspaceId });
      await session(fx, {
        ownerId: fx.ownerId,
        failed: true,
        origin: 'guide',
        workspaceId: fx.workspaceId,
      });
      await gatedRun(fx, 'run-1', 'Run one');
      await gatedRun(fx, 'run-2', 'Run two');

      const page = await homeService.listToResume(hctx(fx));

      expect(page.planningSessions).toHaveLength(1);
      expect(page.planningSessions![0]).toMatchObject({
        sessionId: mine.sessionId,
        planId: mine.planId,
        title: 'Mine',
        targets: [{ key: target.identifier, title: 'The target story' }],
        failure: {
          failedAt: '2026-10-09T10:00:00.000Z',
          reason: 'rate_limited',
          stopPhase: 'author',
          stopRef: 'planItem:abc',
          stopTitle: 'Export a report',
        },
      });
      expect(page.items).toHaveLength(2);
      expect(page.total).toBe(3);
      expect((await homeService.tabCounts(hctx(fx))).toResume).toBe(3);
    },
  );

  it(
    'keeps an entry whose plan has no snapshot, with progress null — never drops it',
    T,
    async () => {
      const fx = await makeWorkItemFixture();
      await session(fx, {
        ownerId: fx.ownerId,
        failed: true,
        workspaceId: fx.workspaceId,
        plan: null,
      });

      const page = await homeService.listToResume(hctx(fx));

      expect(page.planningSessions).toHaveLength(1);
      expect(page.planningSessions![0]).toMatchObject({ planId: null, progress: null });
    },
  );

  it('carries progress for a session whose plan is generating', T, async () => {
    const fx = await makeWorkItemFixture();
    await session(fx, { ownerId: fx.ownerId, failed: true, workspaceId: fx.workspaceId });

    const page = await homeService.listToResume(hctx(fx));

    expect(page.planningSessions![0]!.progress).toMatchObject({ authored: 0, proposed: 0 });
  });

  it('a page of any other tab carries no `planningSessions` key', T, async () => {
    const fx = await makeWorkItemFixture();
    await session(fx, { ownerId: fx.ownerId, failed: true, workspaceId: fx.workspaceId });

    for (const page of [
      await homeService.listToDo(hctx(fx)),
      await homeService.listInProgress(hctx(fx)),
    ]) {
      expect('planningSessions' in page).toBe(false);
    }
  });

  it(
    'a reader with no failed session gets no key, and the badge equals the runs alone',
    T,
    async () => {
      const fx = await makeWorkItemFixture();
      await gatedRun(fx, 'run-1', 'Run one');

      const page = await homeService.listToResume(hctx(fx));

      expect('planningSessions' in page).toBe(false);
      expect(page.total).toBe(1);
      expect((await homeService.tabCounts(hctx(fx))).toResume).toBe(1);
    },
  );
});

describe('one window over two segments', () => {
  it('limit 2: page 1 = the session + the first run, page 2 = the second run', T, async () => {
    const fx = await makeWorkItemFixture();
    const s = await session(fx, { ownerId: fx.ownerId, failed: true, workspaceId: fx.workspaceId });
    await gatedRun(fx, 'run-1', 'Run one');
    await gatedRun(fx, 'run-2', 'Run two');

    const one = await homeService.listToResume(hctx(fx), { limit: 2, page: 1 });
    const two = await homeService.listToResume(hctx(fx), { limit: 2, page: 2 });

    expect(one.planningSessions!.map((e) => e.sessionId)).toEqual([s.sessionId]);
    expect(one.items).toHaveLength(1);
    expect(two.planningSessions ?? []).toHaveLength(0);
    expect(two.items).toHaveLength(1);
    expect(one.total).toBe(3);
    expect(two.total).toBe(3);
    const seen = [...one.items, ...two.items].map((i) => i.id);
    expect(new Set(seen).size).toBe(2); // no run repeats or goes missing
  });

  it('three sessions, limit 2: page 2 = the third session + the first run', T, async () => {
    const fx = await makeWorkItemFixture();
    const ids: string[] = [];
    for (const [i, at] of [
      '2026-10-09T12:00:00Z',
      '2026-10-09T11:00:00Z',
      '2026-10-09T10:00:00Z',
    ].entries()) {
      ids.push(
        (
          await session(fx, {
            ownerId: fx.ownerId,
            failed: true,
            failedAt: at,
            workspaceId: fx.workspaceId,
          })
        ).sessionId,
      );
      void i;
    }
    await gatedRun(fx, 'run-1', 'Run one');

    const one = await homeService.listToResume(hctx(fx), { limit: 2, page: 1 });
    const two = await homeService.listToResume(hctx(fx), { limit: 2, page: 2 });

    // Newest failure first.
    expect(one.planningSessions!.map((e) => e.sessionId)).toEqual([ids[0], ids[1]]);
    expect(one.items).toHaveLength(0);
    expect(two.planningSessions!.map((e) => e.sessionId)).toEqual([ids[2]]);
    expect(two.items).toHaveLength(1);
    expect(two.total).toBe(4);
  });
});

describe('the Planning tab leaves a failed plan out', () => {
  it(
    'lists and counts the open session’s plan and a session-less plan, not the failed one',
    T,
    async () => {
      const fx = await makeWorkItemFixture();
      const failed = await session(fx, {
        ownerId: fx.ownerId,
        failed: true,
        workspaceId: fx.workspaceId,
      });
      const open = await session(fx, { ownerId: fx.ownerId, workspaceId: fx.workspaceId });
      const sessionless = await adminDb.plan.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          status: 'generating',
          createdById: fx.ownerId,
          title: 'No session',
        },
      });

      const page = await workbenchPlanningService.listMyPlansBeingWritten(hctx(fx));

      const planIds = page.items.map((i) => i.planId).sort();
      expect(planIds).toEqual([open.planId!, sessionless.id].sort());
      expect(planIds).not.toContain(failed.planId);
      expect(page.total).toBe(2);
      expect((await homeService.tabCounts(hctx(fx))).planning).toBe(2);
    },
  );
});
