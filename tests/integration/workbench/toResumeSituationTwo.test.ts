import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { homeService } from '@/lib/services/homeService';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import type { PlanStatus } from '@/generated/prisma/client';

// TO RESUME LISTS SITUATION 2 (Story MOTIR-7905 · MOTIR-7939), against a REAL Postgres and
// under RLS: each planning-session entry states its FORM, the plan it opens on and the waiting
// plan it names; the ended-`failed` sessions that still hold a waiting plan are a third band
// of the one order; the count equals the list's total; and an entry drops out when its failure
// clears, its session ends, or its waiting plan is decided or carried.

const T = { timeout: 120_000 };

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'SIT' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const hctx = () => ({ ...fx.ctx, projectId: fx.projectId });

let seq = 0;
const at = (minute: number) => new Date(Date.UTC(2026, 9, 9, 10, minute));

interface PlanSpec {
  status: PlanStatus;
  title: string;
  minute: number;
}

/** A session with its plans; `failedMinute` makes it open+failed, `endedMinute` ends it `failed`. */
async function session(opts: {
  ownerId?: string;
  failedMinute?: number;
  endedMinute?: number;
  endReason?: 'failed' | 'idle' | 'restarted';
  origin?: 'conversation' | 'guide';
  plans: PlanSpec[];
}) {
  const row = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: opts.ownerId ?? fx.ownerId,
      scopeKey: `scope-${++seq}`,
      targetKeys: [],
      origin: opts.origin ?? 'conversation',
      ...(opts.failedMinute !== undefined
        ? {
            failedAt: at(opts.failedMinute),
            failedJobId: 'job-x',
            failureReason: 'rate_limited' as const,
          }
        : {}),
      ...(opts.endedMinute !== undefined
        ? { endedAt: at(opts.endedMinute), endReason: opts.endReason ?? ('failed' as const) }
        : {}),
    },
  });
  const planIds: string[] = [];
  for (const p of opts.plans) {
    const plan = await adminDb.plan.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        sessionId: row.id,
        status: p.status,
        title: p.title,
        createdById: opts.ownerId ?? fx.ownerId,
        createdAt: at(p.minute),
      },
    });
    planIds.push(plan.id);
  }
  return { sessionId: row.id, planIds };
}

async function gatedRun(title: string) {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      command: 'run_scope',
      scopeLabel: title,
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
}

/** The full fixture from the card: A, A+, B, B′, C listed; C×, I, R, M, G not. */
async function fixture() {
  const teammate = await createTestUser({ email: `tm-${Date.now()}@example.com`, name: 'tm' });
  await workspacesService.addMember({
    userId: teammate.id,
    workspaceId: fx.workspaceId,
    workspaceRole: 'member',
  });
  const A = await session({
    failedMinute: 50,
    plans: [{ status: 'generating', title: 'A walk', minute: 1 }],
  });
  const Aplus = await session({
    failedMinute: 49,
    plans: [
      { status: 'planned', title: 'A+ waiting', minute: 1 },
      { status: 'generating', title: 'A+ walk', minute: 2 },
    ],
  });
  const B = await session({
    failedMinute: 48,
    plans: [{ status: 'planned', title: 'B waiting', minute: 1 }],
  });
  const Bstale = await session({
    failedMinute: 47,
    plans: [{ status: 'stale', title: 'B stale', minute: 1 }],
  });
  const C = await session({
    endedMinute: 30,
    plans: [
      { status: 'planned', title: 'C waiting', minute: 1 },
      { status: 'declined', title: 'C failed attempt', minute: 2 },
    ],
  });
  await session({ endedMinute: 31, plans: [{ status: 'declined', title: 'Cx', minute: 1 }] });
  await session({
    endedMinute: 32,
    endReason: 'idle',
    plans: [{ status: 'planned', title: 'I', minute: 1 }],
  });
  await session({
    endedMinute: 33,
    endReason: 'restarted',
    plans: [{ status: 'planned', title: 'R', minute: 1 }],
  });
  await session({
    ownerId: teammate.id,
    endedMinute: 34,
    plans: [{ status: 'planned', title: 'M', minute: 1 }],
  });
  await session({
    origin: 'guide',
    failedMinute: 46,
    plans: [{ status: 'generating', title: 'G', minute: 1 }],
  });
  await gatedRun('Run one');
  await gatedRun('Run two');
  return { A, Aplus, B, Bstale, C };
}

describe('the three forms', () => {
  it('lists exactly A, A+, B, B′ and C, each with its form, plan and waiting plan', T, async () => {
    const f = await fixture();

    const page = await homeService.listToResume(hctx(), { limit: 50 });

    expect(page.total).toBe(7);
    expect(page.planningSessions!.map((e) => e.sessionId)).toEqual([
      f.A.sessionId,
      f.Aplus.sessionId,
      f.B.sessionId,
      f.Bstale.sessionId,
      f.C.sessionId,
    ]);
    const [a, aPlus, b, bStale, c] = page.planningSessions!;
    expect(a).toMatchObject({ form: 'failed_walk', planId: f.A.planIds[0], waitingPlan: null });
    expect(a!.progress).not.toBeNull();
    expect(aPlus).toMatchObject({
      form: 'failed_walk',
      planId: f.Aplus.planIds[1],
      waitingPlan: { planId: f.Aplus.planIds[0], status: 'planned', title: 'A+ waiting' },
    });
    expect(b).toMatchObject({
      form: 'failed_beside_waiting_plan',
      planId: f.B.planIds[0],
      waitingPlan: { planId: f.B.planIds[0], status: 'planned' },
      progress: null,
    });
    expect(b!.failure).not.toBeNull();
    expect(bStale).toMatchObject({
      form: 'failed_beside_waiting_plan',
      waitingPlan: { status: 'stale' },
    });
    expect(c).toMatchObject({
      form: 'ended_with_waiting_plan',
      planId: f.C.planIds[0], // NOT its declined latest plan
      failure: null,
      progress: null,
    });
    expect(c!.endedAt).not.toBeNull();
    expect((await homeService.tabCounts(hctx())).toResume).toBe(page.total);
  });

  it('walks every page in band order without repeating or dropping an entry', T, async () => {
    const f = await fixture();
    const seen: string[] = [];
    for (let page = 1; page <= 4; page++) {
      const p = await homeService.listToResume(hctx(), { limit: 2, page });
      expect(p.total).toBe(7);
      seen.push(...(p.planningSessions ?? []).map((e) => e.sessionId));
      seen.push(...p.items.map((i) => `run:${i.id}`));
    }
    expect(seen.slice(0, 5)).toEqual([
      f.A.sessionId,
      f.Aplus.sessionId,
      f.B.sessionId,
      f.Bstale.sessionId,
      f.C.sessionId,
    ]);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });
});

describe('an entry drops out', () => {
  it('when its failure clears (B)', T, async () => {
    const f = await fixture();
    await adminDb.planChangeSession.update({
      where: { id: f.B.sessionId },
      data: { failedAt: null, failedJobId: null, failureReason: null },
    });
    const page = await homeService.listToResume(hctx(), { limit: 50 });
    expect(page.planningSessions!.map((e) => e.sessionId)).not.toContain(f.B.sessionId);
    expect(page.total).toBe(6);
    expect((await homeService.tabCounts(hctx())).toResume).toBe(6);
  });

  it('when its waiting plan is carried to another session (C)', T, async () => {
    const f = await fixture();
    const carried = await session({ plans: [] });
    await adminDb.plan.update({
      where: { id: f.C.planIds[0]! },
      data: { sessionId: carried.sessionId },
    });
    const page = await homeService.listToResume(hctx(), { limit: 50 });
    expect(page.planningSessions!.map((e) => e.sessionId)).not.toContain(f.C.sessionId);
    expect(page.total).toBe(6);
  });

  it('when its waiting plan is decided (C)', T, async () => {
    const f = await fixture();
    await adminDb.plan.update({ where: { id: f.C.planIds[0]! }, data: { status: 'approved' } });
    const page = await homeService.listToResume(hctx(), { limit: 50 });
    expect(page.planningSessions!.map((e) => e.sessionId)).not.toContain(f.C.sessionId);
    expect((await homeService.tabCounts(hctx())).toResume).toBe(6);
  });

  it('when its session ends approved (B′)', T, async () => {
    const f = await fixture();
    await planSessionEndService.endSession(f.Bstale.sessionId, 'approved', {
      workspaceId: fx.workspaceId,
      endedById: fx.ownerId,
      actorId: fx.ownerId,
    });
    const page = await homeService.listToResume(hctx(), { limit: 50 });
    expect(page.planningSessions!.map((e) => e.sessionId)).not.toContain(f.Bstale.sessionId);
    expect(page.total).toBe(6);
  });
});
