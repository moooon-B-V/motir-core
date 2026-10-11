import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope } from '@/lib/planChange/scope';
import {
  PlanAgainNotAvailableError,
  PlanSessionAwaitingResumeError,
  PlanSessionPlanStaleError,
} from '@/lib/planChange/errors';
import { abandonedPlanService } from '@/lib/services/abandonedPlanService';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { homeService } from '@/lib/services/homeService';
import { planDriftService } from '@/lib/services/planDriftService';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE SITUATION-2 CHAIN (Story MOTIR-7905 · MOTIR-7942), against a REAL Postgres: a failure
// beside a waiting plan → the session waits in To resume → the person's next turn revises
// that plan in the same session → the entry clears → the plan is approved. Plus the stale
// variant, the pre-story ended-`failed` form, the per-owner count and five races. Only the
// motir-ai boundary client is stubbed; every service runs for real.

let jobSeq = 0;
const submitJobMock = vi.fn(async () => ({ jobId: `job-${++jobSeq}` }));

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...(args as [])),
  streamJob: vi.fn(),
  getJob: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  refreshCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  getPreplanState: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');

const T = { timeout: 180_000 };
// Measured: a fixture (session + plan + gate + locks) is ~0.4 s; the heaviest race builds 20 of
// them and runs two concurrent writers each. 240 s leaves shard headroom.
const RACE = { timeout: 240_000 };
const ITERATIONS = 20;
const MIN = 60 * 1000;

let fx: WorkItemFixture;

beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateAuthTables();
  submitJobMock.mockReset();
  submitJobMock.mockImplementation(async () => ({ jobId: `job-${++jobSeq}` }));
  fx = await makeWorkItemFixture({ identifier: 'SIT' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const me = (): ProjectContext => ({
  userId: fx.ownerId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
  project: fx.project,
});
const hctx = () => ({ ...fx.ctx, projectId: fx.projectId });
const sctx = () => ({ userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId });
const readJob = async () => ({ error: { code: 'rate_limited' }, walkStop: null });

async function card(title: string) {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);
}

/** An OPEN conversation scoped to a card (so it holds a session lock), whose plan is `planned`
 *  with a `modify` proposal on that card and its `plan_approval` gate awaiting. */
async function openWithPlanned(title = 'CSV export') {
  const target = await card(title);
  await adminDb.planChangeSession.updateMany({
    where: { endedAt: null },
    data: { endedAt: new Date(), endReason: 'restarted' },
  });
  const s = await planChangeSessionsService.startWithFirstTurn(
    me(),
    buildScope([target.identifier]),
    'Rework it',
  );
  const first = await planChangeSessionsService.submit(me(), { sessionId: s.id });
  await plansService.addProposals(
    first.planId,
    [{ op: 'modify' as const, workItemId: target.id, patch: { title: 'New' } }],
    fx.ctx,
  );
  await plansService.markPlanned(first.planId, fx.ctx);
  return { sessionId: s.id, planId: first.planId, target };
}

/** The revision of P a reviewer asked for through the plan-page path, answered `jobId`. */
async function reviseThroughPlanPage(planId: string, jobId: string) {
  submitJobMock.mockResolvedValueOnce({ jobId });
  await aiPlanEditsService.submitRevise(planId, 'Change it', me());
}

/** Chain 1 steps 1–2: S open and failed beside P, through the revise relay's settle. */
async function failedRevisionBeside(planId: string, jobId: string) {
  await reviseThroughPlanPage(planId, jobId);
  return planSessionEndService.settleFailedJob(jobId, sctx(), { status: 'failed' }, { readJob });
}

const sessionRow = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });
const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });
const trail = (planId: string, kind: string) =>
  adminDb.planRevision.count({ where: { planId, changeKind: kind } });
const locksOf = (sessionId: string) => adminDb.planTargetLock.count({ where: { sessionId } });
const gateOf = (planId: string) =>
  adminDb.approvalGate.findFirst({ where: { kind: 'plan_approval', subjectId: planId } });
const listed = async (ctx = hctx()) => {
  const page = await homeService.listToResume(ctx, { limit: 50 });
  // The honest count: the badge equals the list's total at every read.
  expect((await homeService.tabCounts(ctx)).toResume).toBe(page.total);
  return page;
};
const entryOf = async (sessionId: string) =>
  (await listed()).planningSessions?.find((e) => e.sessionId === sessionId);

describe('chain 1 — a failed revision of a planned plan (form B)', () => {
  it(
    'keeps session, plan and cards; lists once; the turn revises in place; then approves',
    T,
    async () => {
      const { sessionId, planId } = await openWithPlanned();
      const proposals = await adminDb.planItem.count({ where: { planId } });
      const locks = await locksOf(sessionId);
      expect(locks).toBeGreaterThan(0);
      expect((await gateOf(planId))?.state).toBe('awaiting');

      const settled = await failedRevisionBeside(planId, 'job-r1');

      expect(settled?.settled).toBe('recorded');
      const s = await sessionRow(sessionId);
      expect(s.endedAt).toBeNull();
      expect(s.failedJobId).toBe('job-r1');
      expect(s.failureReason).toBeTruthy();
      const p = await planRow(planId);
      expect(p.status).toBe('planned');
      expect(await adminDb.planItem.count({ where: { planId } })).toBe(proposals);
      const ended = await adminDb.planRevision.findFirst({
        where: { planId, changeKind: 'revision_ended' },
      });
      expect(ended?.diff).toMatchObject({ failed: true });
      expect(await plansService.readRevisionLease(planId, me())).toBeNull();
      expect((await gateOf(planId))?.state).toBe('awaiting');
      expect(await locksOf(sessionId)).toBe(locks);

      const before = await listed();
      const entry = before.planningSessions!.filter((e) => e.sessionId === sessionId);
      expect(entry).toHaveLength(1);
      expect(entry[0]).toMatchObject({
        form: 'failed_beside_waiting_plan',
        planId,
        waitingPlan: { planId },
        progress: null,
      });

      const sessionsBefore = await adminDb.planChangeSession.count();
      await planChangeSessionsService.appendTurn('Make it a PDF', me(), { sessionId });
      submitJobMock.mockResolvedValueOnce({ jobId: 'job-r2' });
      const out = await planChangeSessionsService.submit(me(), { sessionId });

      expect(out).toMatchObject({ jobId: 'job-r2', planId });
      expect(await adminDb.plan.count({ where: { sessionId } })).toBe(1);
      expect(await adminDb.planChangeSession.count()).toBe(sessionsBefore);
      expect((await planRow(planId)).sourceJobId).toBe('job-r2');
      const bound = await sessionRow(sessionId);
      expect(bound.failedAt).toBeNull();
      expect(bound.failedJobId).toBeNull();

      const after = await listed();
      expect(after.planningSessions?.some((e) => e.sessionId === sessionId) ?? false).toBe(false);
      expect(after.total).toBe(before.total - 1);

      // The revision lands: its final append closes the lease. Then the plan is approved.
      await adminDb.planRevision.create({
        data: { planId, changeKind: 'revision_ended', diff: { revision: true, jobId: 'job-r2' } },
      });
      await plansService.approvePlan(planId, fx.ctx);
      expect((await planRow(planId)).status).toBe('approved');
      expect((await sessionRow(sessionId)).endReason).toBe('approved');
    },
  );
});

describe('chain 2 — a failed newer run beside a waiting plan', () => {
  async function aWaitingThenBGenerating() {
    const { sessionId, planId: A } = await openWithPlanned('Two plans');
    const B = await adminDb.plan.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        sessionId,
        status: 'generating',
        sourceJobId: 'gen-b',
        createdById: fx.ownerId,
      },
    });
    await adminDb.planItem.create({
      data: {
        workspaceId: fx.workspaceId,
        planId: B.id,
        op: 'add',
        proposedFields: { title: 'Half-written', kind: 'subtask' },
        blockedByRefs: [],
      },
    });
    await adminDb.planChangeSession.update({
      where: { id: sessionId },
      data: { lastJobId: 'gen-b' },
    });
    return { sessionId, A, B: B.id };
  }

  it(
    'records the failure, lists ONE failed_walk naming A, and refuses an ordinary turn',
    T,
    async () => {
      const { sessionId, A, B } = await aWaitingThenBGenerating();
      const locks = await locksOf(sessionId);

      await planSessionEndService.settleFailedJob(
        'gen-b',
        sctx(),
        { status: 'failed' },
        { readJob },
      );

      const s = await sessionRow(sessionId);
      expect(s.endedAt).toBeNull();
      expect(s.failedJobId).toBe('gen-b');
      expect((await planRow(A)).status).toBe('planned');
      expect((await gateOf(A))?.state).toBe('awaiting');
      expect((await planRow(B)).status).toBe('generating');
      expect(await adminDb.planItem.count({ where: { planId: B } })).toBe(1);
      expect(await locksOf(sessionId)).toBe(locks);

      const entries = (await listed()).planningSessions!.filter((e) => e.sessionId === sessionId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        form: 'failed_walk',
        planId: B,
        waitingPlan: { planId: A },
      });

      await planChangeSessionsService.appendTurn('Try again', me(), { sessionId });
      submitJobMock.mockClear();
      await expect(planChangeSessionsService.submit(me(), { sessionId })).rejects.toBeInstanceOf(
        PlanSessionAwaitingResumeError,
      );
      expect(submitJobMock).not.toHaveBeenCalled();
    },
  );

  // Declining the failed walk's plan is the person's own decision on the session's LATEST plan,
  // and on `main` a decision on the latest plan ENDS the session (`declineWithin` → the end
  // operation, reason `declined`). So the named post-state is: the session has left the list.
  it(
    'declining B (the latest plan) ends the session, so it leaves To resume; A stays planned',
    T,
    async () => {
      const { sessionId, A, B } = await aWaitingThenBGenerating();
      await planSessionEndService.settleFailedJob(
        'gen-b',
        sctx(),
        { status: 'failed' },
        { readJob },
      );

      await plansService.declinePlan(B, fx.ctx);

      expect((await planRow(A)).status).toBe('planned');
      expect((await sessionRow(sessionId)).endReason).toBe('declined');
      expect(await entryOf(sessionId)).toBeUndefined();
    },
  );
});

describe('chain 3 — a canceled attempt beside a waiting plan', () => {
  it(
    'declines only the attempt, keeps the session open with no record, absent from To resume',
    T,
    async () => {
      const { sessionId, planId: A } = await openWithPlanned('Cancel me');
      const B = await adminDb.plan.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          sessionId,
          status: 'generating',
          sourceJobId: 'gen-c',
          createdById: fx.ownerId,
        },
      });
      await adminDb.planChangeSession.update({
        where: { id: sessionId },
        data: { lastJobId: 'gen-c' },
      });
      const locks = await locksOf(sessionId);

      await planSessionEndService.settleFailedJob('gen-c', sctx(), { status: 'canceled' });

      expect((await planRow(B.id)).status).toBe('declined');
      expect((await planRow(B.id)).decisionReason).toBe('abandoned');
      expect((await planRow(A)).status).toBe('planned');
      const s = await sessionRow(sessionId);
      expect(s.endedAt).toBeNull();
      expect(s.failedAt).toBeNull();
      expect(await locksOf(sessionId)).toBe(locks);
      expect(await entryOf(sessionId)).toBeUndefined();
    },
  );
});

describe('chain 4 — the unwatched revision (sweep backstop)', () => {
  it('reconciles revision_failed, lists form B, then the turn and approve succeed', T, async () => {
    const { sessionId, planId } = await openWithPlanned('Unwatched');
    submitJobMock.mockResolvedValueOnce({ jobId: 'job-u1' });
    await aiPlanEditsService.submitRevise(planId, 'Change it', me());
    // The revision started longer ago than the grace, and no relay ever settled it.
    await adminDb.planRevision.updateMany({
      where: { planId, changeKind: 'revision_started' },
      data: { changedAt: new Date(Date.now() - 30 * MIN) },
    });

    const summary = await abandonedPlanService.reconcileAbandoned({
      deps: {
        resolveJobState: async () =>
          ({
            jobId: 'job-u1',
            reachable: true,
            status: 'failed',
            failure: { code: 'boom', message: 'boom' },
          }) as never,
      },
    });

    expect(summary.outcomes).toContainEqual(
      expect.objectContaining({ planId, outcome: 'revision_failed' }),
    );
    expect(await trail(planId, 'revision_ended')).toBe(1);
    expect((await sessionRow(sessionId)).failedJobId).toBe('job-u1');
    expect((await entryOf(sessionId))?.form).toBe('failed_beside_waiting_plan');

    await planChangeSessionsService.appendTurn('Go on', me(), { sessionId });
    submitJobMock.mockResolvedValueOnce({ jobId: 'job-u2' });
    expect(await planChangeSessionsService.submit(me(), { sessionId })).toMatchObject({ planId });
    expect((await sessionRow(sessionId)).failedAt).toBeNull();
    expect(await entryOf(sessionId)).toBeUndefined();
  });
});

describe('chain 5 — a session ended `failed` before this story (form C)', () => {
  /** The pre-story rows: ended `failed`, a declined latest plan, an older plan `waiting`. */
  async function endedWithWaiting(
    opts: {
      endReason?: 'failed' | 'idle' | 'restarted';
      plans: Array<'planned' | 'declined' | 'generating'>;
    },
    ownerId = fx.ownerId,
  ) {
    const row = await adminDb.planChangeSession.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        createdById: ownerId,
        scopeKey: `scope-${Math.random()}`,
        targetKeys: [],
        origin: 'conversation',
        endedAt: new Date(),
        endReason: opts.endReason ?? 'failed',
      },
    });
    const ids: string[] = [];
    let minute = 0;
    for (const status of opts.plans) {
      const p = await adminDb.plan.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          sessionId: row.id,
          status,
          createdById: ownerId,
          createdAt: new Date(Date.UTC(2026, 9, 1, 0, ++minute)),
        },
      });
      ids.push(p.id);
    }
    return { sessionId: row.id, planIds: ids };
  }

  it(
    'lists on the waiting plan, drops when carried or decided, and never lists the absent forms',
    T,
    async () => {
      const E = await endedWithWaiting({ plans: ['planned', 'declined'] });
      await endedWithWaiting({ endReason: 'idle', plans: ['planned'] });
      await endedWithWaiting({ endReason: 'restarted', plans: ['planned'] });
      await endedWithWaiting({ plans: ['declined'] });
      await endedWithWaiting({ plans: ['generating'] });

      const page = await listed();
      expect(page.planningSessions!.map((e) => e.sessionId)).toEqual([E.sessionId]);
      expect(page.planningSessions![0]).toMatchObject({
        form: 'ended_with_waiting_plan',
        planId: E.planIds[0], // NOT the declined latest plan
        failure: null,
      });
      expect(page.planningSessions![0]!.endedAt).not.toBeNull();

      // Carried: the carry's observable effect is `Plan.sessionId` moving to a new open session.
      const carried = await adminDb.planChangeSession.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          createdById: fx.ownerId,
          scopeKey: 'carried',
          targetKeys: [],
          origin: 'conversation',
        },
      });
      await adminDb.plan.update({ where: { id: E.planIds[0]! }, data: { sessionId: carried.id } });
      expect((await listed()).total).toBe(page.total - 1);

      // Decided: approve, and a second copy declined.
      for (const status of ['approved', 'declined'] as const) {
        const copy = await endedWithWaiting({ plans: ['planned', 'declined'] });
        expect((await listed()).total).toBe(1);
        await adminDb.plan.update({ where: { id: copy.planIds[0]! }, data: { status } });
        expect((await listed()).total).toBe(0);
      }
    },
  );
});

describe('chain 6 — a failure beside a waiting plan that has gone STALE', () => {
  async function failedBesideStale() {
    const { sessionId, planId, target } = await openWithPlanned('Goes stale');
    await failedRevisionBeside(planId, `job-s-${++jobSeq}`);
    await adminDb.workItem.update({ where: { id: target.id }, data: { status: 'done' } });
    await planDriftService.markStaleForTerminalTarget(target.id, fx.workspaceId, {
      fromStatusKey: 'todo',
      toStatusKey: 'done',
    });
    return { sessionId, planId, target };
  }

  it(
    'stays listed, answers stale without a write, then Plan it again opens ONE fresh plan',
    T,
    async () => {
      const { sessionId, planId, target } = await failedBesideStale();
      expect((await planRow(planId)).status).toBe('stale');
      expect((await gateOf(planId))?.state).toBe('superseded');
      const before = await listed();
      expect(await entryOf(sessionId)).toMatchObject({
        form: 'failed_beside_waiting_plan',
        waitingPlan: { planId, status: 'stale' },
      });

      await planChangeSessionsService.appendTurn('Change it anyway', me(), { sessionId });
      const failedBefore = await sessionRow(sessionId);
      const markersBefore = await adminDb.planChangeTurn.count({
        where: { sessionId, role: 'system' },
      });
      submitJobMock.mockClear();
      const stale = await planChangeSessionsService.submit(me(), { sessionId }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(stale).toBeInstanceOf(PlanSessionPlanStaleError);
      expect((stale as PlanSessionPlanStaleError).finishedCards.map((c) => c.id)).toContain(
        target.id,
      );
      expect(submitJobMock).not.toHaveBeenCalled();
      const unchanged = await sessionRow(sessionId);
      expect(unchanged.failedAt).toEqual(failedBefore.failedAt);
      expect(unchanged.failedJobId).toBe(failedBefore.failedJobId);
      expect(await adminDb.planChangeTurn.count({ where: { sessionId, role: 'system' } })).toBe(
        markersBefore,
      );
      expect((await planRow(planId)).status).toBe('stale');
      expect(await entryOf(sessionId)).toBeDefined();
      expect((await listed()).total).toBe(before.total);

      const proposals = await adminDb.planItem.count({ where: { planId } });
      const [a, b] = await Promise.allSettled([
        planChangeSessionsService.submit(me(), { sessionId }, undefined, { planAgainOf: planId }),
        planChangeSessionsService.submit(me(), { sessionId }, undefined, { planAgainOf: planId }),
      ]);
      const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);
      const refused = [a, b].find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toBeInstanceOf(PlanAgainNotAvailableError);

      const fresh = await adminDb.plan.findMany({ where: { sessionId, status: 'generating' } });
      expect(fresh).toHaveLength(1);
      expect((await sessionRow(sessionId)).failedAt).toBeNull();
      expect(await entryOf(sessionId)).toBeUndefined();
      expect((await listed()).total).toBe(before.total - 1);
      const p = await planRow(planId);
      expect(p.status).toBe('stale');
      expect(p.sessionId).toBe(sessionId);
      expect(await adminDb.planItem.count({ where: { planId } })).toBe(proposals);
    },
  );
});

describe('an honest count per owner', () => {
  it(
    'O and M each see only their own sessions, never the other’s or the guide session',
    T,
    async () => {
      const m = await createTestUser({ email: `m-${Date.now()}@example.com`, name: 'M' });
      await workspacesService.addMember({
        userId: m.id,
        workspaceId: fx.workspaceId,
        workspaceRole: 'member',
      });
      const mine = await openWithPlanned('Owner plan');
      await failedRevisionBeside(mine.planId, `job-o-${++jobSeq}`);

      // M's form-B session and form-C session, and a guide session that failed — as rows.
      const mkSession = (
        extra: Record<string, unknown>,
        origin: 'conversation' | 'guide' = 'conversation',
      ) =>
        adminDb.planChangeSession.create({
          data: {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            createdById: m.id,
            scopeKey: `m-${Math.random()}`,
            targetKeys: [],
            origin,
            ...extra,
          },
        });
      const mkPlan = (
        sessionId: string,
        status: 'planned' | 'declined' | 'generating',
        by: string,
      ) =>
        adminDb.plan.create({
          data: {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            sessionId,
            status,
            createdById: by,
          },
        });
      const mB = await mkSession({
        failedAt: new Date(),
        failedJobId: 'm-job',
        failureReason: 'rate_limited',
      });
      await mkPlan(mB.id, 'planned', m.id);
      const mC = await mkSession({ endedAt: new Date(), endReason: 'failed' });
      await mkPlan(mC.id, 'planned', m.id);
      const guide = await mkSession(
        { failedAt: new Date(), failedJobId: 'g', failureReason: 'rate_limited' },
        'guide',
      );
      await mkPlan(guide.id, 'generating', m.id);

      const ownerPage = await listed();
      expect(ownerPage.planningSessions!.map((e) => e.sessionId)).toEqual([mine.sessionId]);

      const mCtx = { userId: m.id, workspaceId: fx.workspaceId, projectId: fx.projectId };
      const mPage = await homeService.listToResume(mCtx, { limit: 50 });
      expect(mPage.planningSessions!.map((e) => e.sessionId).sort()).toEqual([mB.id, mC.id].sort());
      expect((await homeService.tabCounts(mCtx)).toResume).toBe(mPage.total);
    },
  );
});

describe('races (real transactions, ≥ 20 iterations)', () => {
  async function fresh() {
    await truncateAuthTables();
    fx = await makeWorkItemFixture({ identifier: 'SIT' });
  }

  it(
    'the revise relay’s settle vs the sweep’s revision arm: one revision_ended, one record',
    RACE,
    async () => {
      for (let i = 0; i < ITERATIONS; i++) {
        await fresh();
        const { sessionId, planId } = await openWithPlanned();
        const jobId = `job-race-${i}`;
        await reviseThroughPlanPage(planId, jobId);
        await adminDb.planRevision.updateMany({
          where: { planId, changeKind: 'revision_started' },
          data: { changedAt: new Date(Date.now() - 30 * MIN) },
        });

        await Promise.all([
          planSessionEndService.settleFailedJob(jobId, sctx(), { status: 'failed' }, { readJob }),
          abandonedPlanService.reconcileAbandoned({
            deps: {
              resolveJobState: async () =>
                ({ jobId, reachable: true, status: 'failed', failure: null }) as never,
            },
          }),
        ]);

        expect(await trail(planId, 'revision_ended')).toBe(1);
        const s = await sessionRow(sessionId);
        expect(s.failedJobId).toBe(jobId);
        expect(s.endedAt).toBeNull();
      }
    },
  );

  it('two submits on one form-B session: exactly one binds and clears', RACE, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      await fresh();
      const { sessionId, planId } = await openWithPlanned();
      await failedRevisionBeside(planId, `job-b-${i}`);
      const started = await trail(planId, 'revision_started');
      await planChangeSessionsService.appendTurn('Go', me(), { sessionId });

      const results = await Promise.allSettled([
        planChangeSessionsService.submit(me(), { sessionId }),
        planChangeSessionsService.submit(me(), { sessionId }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await trail(planId, 'revision_started')).toBe(started + 1);
      expect((await sessionRow(sessionId)).failedAt).toBeNull();
    }
  });

  it('a submit racing approvePlan: never approved AND leased', RACE, async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      await fresh();
      const { sessionId, planId } = await openWithPlanned();
      await failedRevisionBeside(planId, `job-a-${i}`);
      await planChangeSessionsService.appendTurn('Go', me(), { sessionId });

      const [turn] = await Promise.allSettled([
        planChangeSessionsService.submit(me(), { sessionId }),
        plansService.approvePlan(planId, fx.ctx),
      ]);

      const p = await planRow(planId);
      const lease = await plansService.readRevisionLease(planId, me());
      const s = await sessionRow(sessionId);
      if (p.status === 'approved') {
        // The decision won: no lease is held, the session ended `approved` (which also nulls the
        // failure record), and the turn either never bound or its lease was closed first.
        expect(lease).toBeNull();
        expect(s.endReason).toBe('approved');
      } else {
        // The turn won: P is leased to the new job and this turn cleared the failure.
        expect(turn.status).toBe('fulfilled');
        expect(p.status).toBe('planned');
        expect(lease).not.toBeNull();
        expect(s.failedAt).toBeNull();
      }
    }
  });

  it(
    'a submit racing a restart: never ended AND cleared by this turn, and not listed as form B after',
    RACE,
    async () => {
      for (let i = 0; i < ITERATIONS; i++) {
        await fresh();
        const { sessionId, planId } = await openWithPlanned();
        await failedRevisionBeside(planId, `job-e-${i}`);
        await planChangeSessionsService.appendTurn('Go', me(), { sessionId });

        const [turn] = await Promise.allSettled([
          planChangeSessionsService.submit(me(), { sessionId }),
          planSessionEndService.endSession(sessionId, 'restarted', {
            workspaceId: fx.workspaceId,
            endedById: fx.ownerId,
            actorId: fx.ownerId,
          }),
        ]);

        const s = await sessionRow(sessionId);
        expect(s.failedAt).toBeNull();
        if (turn.status === 'rejected') expect(s.endedAt).not.toBeNull();
        const entry = await entryOf(sessionId);
        expect(entry?.form).not.toBe('failed_beside_waiting_plan');
        expect(entry?.form === 'ended_with_waiting_plan').toBe(false); // ended `restarted`, not `failed`
        expect(await planRow(planId)).toBeDefined();
      }
    },
  );

  it(
    'two Plan-it-again submits on the stale fixture: one plan, one job, failure cleared once',
    RACE,
    async () => {
      for (let i = 0; i < ITERATIONS; i++) {
        await fresh();
        const { sessionId, planId, target } = await openWithPlanned();
        await failedRevisionBeside(planId, `job-p-${i}`);
        await adminDb.workItem.update({ where: { id: target.id }, data: { status: 'done' } });
        await planDriftService.markStaleForTerminalTarget(target.id, fx.workspaceId, {
          fromStatusKey: 'todo',
          toStatusKey: 'done',
        });
        await planChangeSessionsService.appendTurn('Again', me(), { sessionId });
        submitJobMock.mockClear();

        const results = await Promise.allSettled([
          planChangeSessionsService.submit(me(), { sessionId }, undefined, { planAgainOf: planId }),
          planChangeSessionsService.submit(me(), { sessionId }, undefined, { planAgainOf: planId }),
        ]);

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(submitJobMock).toHaveBeenCalledTimes(1);
        expect(await adminDb.plan.count({ where: { sessionId, status: 'generating' } })).toBe(1);
        expect((await sessionRow(sessionId)).failedAt).toBeNull();
        expect((await planRow(planId)).status).toBe('stale');
      }
    },
  );
});
