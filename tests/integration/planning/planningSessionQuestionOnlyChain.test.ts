import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanStatus } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { PLAN_SESSION_STATE_VALUES, type PlanSessionView } from '@/lib/dto/planSessions';
import { buildScope, PROJECT_SCOPE_KEY } from '@/lib/planChange/scope';
import { PLAN_TARGET_LOCK_LEASE_MS } from '@/lib/planChange/targetLock';
import { sessionWaitingState } from '@/lib/planChange/sessionWaitingState';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { homeService } from '@/lib/services/homeService';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { planSessionsService } from '@/lib/services/planSessionsService';
import {
  AWAITING_REPLY_AFTER_MS,
  planningSessionGateService,
} from '@/lib/services/planningSessionGateService';
import { workbenchPlanningService } from '@/lib/services/workbenchPlanningService';
import { workItemsService } from '@/lib/services/workItemsService';
import { planTargetLockSweep } from '@/lib/jobs/definitions/planTargetLockSweep';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { JobTestEngine } from '../../helpers/jobs';
import { truncateAuthTables } from '../../helpers/db';

// THE QUESTION-ONLY CHAIN (Story MOTIR-9217 · MOTIR-9302), against a REAL Postgres. Each of
// the four cards before this one proved ONE door against a fixture built for it: the gate
// refuses a plan-less session (MOTIR-9299), the Plans reads admit only a session holding a
// plan (MOTIR-9300), the strip offers only what those reads can return (MOTIR-9301), and the
// fresh-start pointer names only a conversation that reached planning (MOTIR-9304). This suite
// walks ONE plan-less conversation and ONE plan-having conversation through the shipped
// operations — a turn, a sweep pass, an end, a return — and asserts every reader after every
// step, including that the pointer's id is a row the room's own list returns, in one run.
//
// Two seams are replaced, both inside the vitest process: motir-ai (`getJob`, scripted, with
// the services imported AFTER the mock) and the clock — crossed by BACKDATING `lastActivityAt`
// through `adminDb`, never by sleeping and never with fake timers. Every count is asserted
// beside the list it counts, every spare beside an opposite outcome in the same run, and every
// owner-scoped read beside a second member who sees none of it.

const getJobMock = vi.fn();

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(async () => ({ jobId: 'job-chain' })),
  streamJob: vi.fn(),
  getJob: (...args: unknown[]) => getJobMock(...args),
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
const { contextualPlanningService } = await import('@/lib/services/contextualPlanningService');

const T = { timeout: 180_000 };
const MIN = 60 * 1000;

let fx: WorkItemFixture;
let rivalId: string;

beforeEach(async () => {
  await truncateAuthTables();
  getJobMock.mockReset();
  fx = await makeWorkItemFixture();
  rivalId = await secondMember();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function secondMember(): Promise<string> {
  const user = await createTestUser({ name: 'Rival' });
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
  });
  return user.id;
}

const ownerPctx = (): ProjectContext => ({
  userId: fx.ownerId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
  project: fx.project,
});
/** A member's OWN workspace context — what every Workbench read runs under. */
const actor = (userId: string = fx.ownerId) => ({
  userId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
});
const svc = (userId: string = fx.ownerId) => ({ userId, workspaceId: fx.workspaceId });
const minutesAgo = (n: number) => new Date(Date.now() - n * MIN);

async function card(title: string) {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return { id: dto.id, key: dto.identifier };
}

/** The owner's OPEN conversation on its own card, started the real way: one user turn. */
async function conversation(title: string) {
  const c = await card(title);
  const scope = buildScope([c.key]);
  const s = await planChangeSessionsService.startWithFirstTurn(ownerPctx(), scope, 'What is this?');
  return { sessionId: s.id, scope, card: c };
}

/** Reaching planning, by its settled definition: the session holds a `plan` row. */
async function holdPlan(sessionId: string, status: PlanStatus = 'declined') {
  const plan = await adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      sessionId,
      status,
      createdById: fx.ownerId,
    },
  });
  return plan.id;
}

const age = (sessionId: string, ms: number) =>
  adminDb.planChangeSession.update({
    where: { id: sessionId },
    data: { lastActivityAt: new Date(Date.now() - ms) },
  });

/** A planner turn WITHOUT a question, written the way the record would, `idleMs` ago. */
async function plannerReplyQuietFor(sessionId: string, idleMs: number) {
  const s = await sessionRow(sessionId);
  await adminDb.planChangeTurn.create({
    data: {
      workspaceId: fx.workspaceId,
      sessionId,
      seq: s.turnCount,
      role: 'assistant',
      body: 'Here is what I found.',
    },
  });
  await adminDb.planChangeSession.update({
    where: { id: sessionId },
    data: { turnCount: s.turnCount + 1, lastActivityAt: new Date(Date.now() - idleMs) },
  });
}

/** The planner speaks through the shipped record door: job `jobId` settles with a question. */
async function plannerAsks(sessionId: string, jobId: string) {
  await adminDb.planChangeSession.update({ where: { id: sessionId }, data: { lastJobId: jobId } });
  getJobMock.mockResolvedValue({
    jobId,
    status: 'succeeded',
    error: null,
    result: { turn: { message: 'Which team owns it?', question: 'Which team owns it?' } },
  });
  return planChangeSessionsService.recordPlannerTurn(jobId, ownerPctx(), { sessionId });
}

/** A conversation seeded straight onto the PROJECT scope, ENDED `idle` `minutes` ago. */
async function endedConversation(minutes: number, ownerId: string = fx.ownerId) {
  const s = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: ownerId,
      origin: 'conversation',
      scopeKey: PROJECT_SCOPE_KEY,
      targetKeys: [],
      turnCount: 1,
      lastActivityAt: minutesAgo(minutes),
      endedAt: minutesAgo(minutes),
      endReason: 'idle',
    },
  });
  return s.id;
}

const sessionRow = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });
const gatesOf = (sessionId: string) =>
  adminDb.approvalGate.findMany({ where: { kind: 'planning_session', subjectId: sessionId } });
const awaitingGates = async (sessionId: string) =>
  (await gatesOf(sessionId)).filter((g) => g.state === 'awaiting');
const sweep = () => new JobTestEngine({ function: planTargetLockSweep }).execute();

// ── the READS, each count checked against its own list in the same call ──────────────────────
async function waitingOnYou(userId: string = fx.ownerId) {
  const page = await approvalGatesService.listAwaitingMe(actor(userId));
  expect(await approvalGatesService.countAwaitingMe(actor(userId))).toBe(page.total);
  return page.items.filter((i) => i.kind === 'planning_session');
}
const inWaitingOnYou = async (sessionId: string, userId?: string) =>
  (await waitingOnYou(userId)).some(
    (i) => i.subject?.kind === 'planning_session' && i.subject.sessionId === sessionId,
  );
async function toResumeOf(userId: string = fx.ownerId) {
  const page = await homeService.listToResume(actor(userId), { limit: 50 });
  expect((await homeService.tabCounts(actor(userId))).toResume).toBe(page.total);
  return page;
}
const inToResume = async (sessionId: string, userId?: string) =>
  ((await toResumeOf(userId)).planningSessions ?? []).some((e) => e.sessionId === sessionId);
async function planningOf(userId: string = fx.ownerId) {
  const page = await workbenchPlanningService.listMyPlansBeingWritten(actor(userId), {
    page: 1,
    limit: 50,
  });
  expect((await homeService.tabCounts(actor(userId))).planning).toBe(page.total);
  return page;
}

/**
 * The Plans room as `userId` reads it in the `view` they ASK for: every cursor page under
 * `planState`, beside the counts of the view the read SERVED — and the summed counts are the
 * row total whenever the read is unfiltered.
 */
async function room(
  view: PlanSessionView,
  planState: (typeof PLAN_SESSION_STATE_VALUES)[number] | null = null,
  userId: string = fx.ownerId,
) {
  const ids: string[] = [];
  const states = new Map<string, string>();
  let cursor: string | null = null;
  let served: PlanSessionView | null = null;
  do {
    const page = await planSessionsService.listSessions(fx.projectId, svc(userId), {
      view,
      planState,
      cursor,
      limit: 2,
    });
    served = page.scope;
    for (const s of page.sessions) {
      ids.push(s.id);
      states.set(s.id, s.state);
    }
    cursor = page.nextCursor;
  } while (cursor);
  const counts = await planSessionsService.countSessionsByPlanState(fx.projectId, svc(userId), {
    view: served!,
  });
  const total = Object.values(counts).reduce((a, n) => a + n, 0);
  if (planState === null) expect(total).toBe(ids.length);
  return { ids, states, counts, total, served: served! };
}

/** Every view and every filter value, `null` included: the session is on NO page of any. */
async function absentFromEveryRoom(sessionId: string) {
  for (const view of ['project', 'mine'] as const) {
    for (const planState of [null, ...PLAN_SESSION_STATE_VALUES]) {
      const r = await room(view, planState);
      expect({ view: r.served, planState, listed: r.ids.includes(sessionId) }).toEqual({
        view: r.served,
        planState,
        listed: false,
      });
      expect(r.counts.none).toBe(0);
    }
  }
}

describe('1 · the reply pass never marks a plan-less conversation', () => {
  it(
    'raises the planned counterfactual and leaves the plan-less one open, unmarked, ungated',
    T,
    async () => {
      const planless = await conversation('Plan-less');
      const planned = await conversation('Planned');
      await holdPlan(planned.sessionId, 'declined');
      for (const s of [planless, planned]) {
        await plannerReplyQuietFor(s.sessionId, AWAITING_REPLY_AFTER_MS + 5 * MIN);
      }

      // The reply pass alone: the same predicate, opposite outcomes.
      const first = await planningSessionGateService.raiseAwaitingReplies();
      expect(first).toEqual({ raised: 1, sessionIds: [planned.sessionId] });
      // …and a full sweep pass after it, which has nothing left to raise.
      await sweep();
      const again = await planningSessionGateService.raiseAwaitingReplies();
      expect(again).toEqual({ raised: 0, sessionIds: [] });

      const s = await sessionRow(planless.sessionId);
      expect(s.awaitingPersonSince).toBeNull();
      expect(s.awaitingPersonCause).toBeNull();
      expect(s.endedAt).toBeNull();
      expect(sessionWaitingState(s)).toBe('open');
      expect(await awaitingGates(planless.sessionId)).toHaveLength(0);
      expect(await inWaitingOnYou(planless.sessionId)).toBe(false);

      // COUNTERFACTUAL — the plan-holding one IS marked, gated and listed.
      const p = await sessionRow(planned.sessionId);
      expect(p.awaitingPersonCause).toBe('reply');
      expect(sessionWaitingState(p)).toBe('awaiting_person');
      expect(await awaitingGates(planned.sessionId)).toHaveLength(1);
      expect(await inWaitingOnYou(planned.sessionId)).toBe(true);
    },
  );
});

describe('2 · the question door refuses a plan-less conversation too', () => {
  it('the same recordPlannerTurn call gates the declined-plan session only', T, async () => {
    const planless = await conversation('Plan-less');
    const planned = await conversation('Planned');
    await holdPlan(planned.sessionId, 'declined');

    await plannerAsks(planless.sessionId, 'job-planless');
    await plannerAsks(planned.sessionId, 'job-planned');

    const s = await sessionRow(planless.sessionId);
    expect(s.awaitingPersonSince).toBeNull();
    expect(s.awaitingPersonCause).toBeNull();
    expect(await awaitingGates(planless.sessionId)).toHaveLength(0);
    expect(await inWaitingOnYou(planless.sessionId)).toBe(false);

    const p = await sessionRow(planned.sessionId);
    expect(p.awaitingPersonCause).toBe('question');
    expect(p.awaitingPersonSince).not.toBeNull();
    expect(await awaitingGates(planned.sessionId)).toHaveLength(1);
    expect(await inWaitingOnYou(planned.sessionId)).toBe(true);
  });
});

describe('3 · the idle close ends it at the lease — and not a minute before', () => {
  it('31 minutes: named in sessionIds and ended `idle`; 29 minutes: left open', T, async () => {
    const past = await conversation('Past the lease');
    const inside = await conversation('Inside the lease');
    await age(past.sessionId, PLAN_TARGET_LOCK_LEASE_MS + 1 * MIN);
    await age(inside.sessionId, PLAN_TARGET_LOCK_LEASE_MS - 1 * MIN);

    const out = await planSessionEndService.closeIdleSessions(new Date());
    await sweep();

    expect(out.sessionIds).toEqual([past.sessionId]);
    expect(out.closed).toBe(1);
    const ended = await sessionRow(past.sessionId);
    expect(ended.endedAt).not.toBeNull();
    expect(ended.endReason).toBe('idle');
    expect(ended.failedAt).toBeNull();
    expect(ended.awaitingPersonSince).toBeNull();
    expect(ended.awaitingPersonCause).toBeNull();
    expect(sessionWaitingState(ended)).toBe('ended');

    // The only difference is the age it was given.
    const open = await sessionRow(inside.sessionId);
    expect(open.endedAt).toBeNull();
    expect(sessionWaitingState(open)).toBe('open');
    expect(await gatesOf(inside.sessionId)).toHaveLength(0);
  });

  it('a second close and a second full pass change nothing', T, async () => {
    const past = await conversation('Past the lease');
    await age(past.sessionId, PLAN_TARGET_LOCK_LEASE_MS + 1 * MIN);
    await sweep();
    const endedAt = (await sessionRow(past.sessionId)).endedAt;
    expect(endedAt).not.toBeNull();

    expect(await planSessionEndService.closeIdleSessions(new Date())).toEqual({
      closed: 0,
      sessionIds: [],
    });
    expect(await planningSessionGateService.raiseAwaitingReplies()).toEqual({
      raised: 0,
      sessionIds: [],
    });
    await sweep();

    const s = await sessionRow(past.sessionId);
    expect(s.endedAt).toEqual(endedAt);
    expect(s.awaitingPersonSince).toBeNull();
    expect(await gatesOf(past.sessionId)).toHaveLength(0);
  });
});

describe('3b · a mark left by the old rule does not keep a plan-less conversation open', () => {
  /** A mark written under the OLD rule: marker and awaiting gate row, set directly. */
  async function legacyMark(sessionId: string, quietMs: number) {
    const since = new Date(Date.now() - quietMs);
    await adminDb.planChangeSession.update({
      where: { id: sessionId },
      data: { awaitingPersonSince: since, awaitingPersonCause: 'reply', lastActivityAt: since },
    });
    await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: null,
        kind: 'planning_session',
        subjectId: sessionId,
        routedToId: fx.ownerId,
        state: 'awaiting',
        subjectVersion: since.toISOString(),
      },
    });
  }

  it(
    'one pass ends the marked plan-less one and drops it from Waiting on you; a marked planned one stays',
    T,
    async () => {
      const planless = await conversation('Marked, plan-less');
      const planned = await conversation('Marked, planned');
      await holdPlan(planned.sessionId, 'declined');
      for (const c of [planless, planned]) {
        await legacyMark(c.sessionId, PLAN_TARGET_LOCK_LEASE_MS + 5 * MIN);
      }
      expect(await inWaitingOnYou(planless.sessionId)).toBe(true);

      await sweep();

      const s = await sessionRow(planless.sessionId);
      expect(s.endReason).toBe('idle');
      expect(s.awaitingPersonSince).toBeNull();
      expect(s.awaitingPersonCause).toBeNull();
      expect(await awaitingGates(planless.sessionId)).toHaveLength(0);
      expect(await inWaitingOnYou(planless.sessionId)).toBe(false);

      // COUNTERFACTUAL — a session holding a plan keeps its mark and its row.
      const p = await sessionRow(planned.sessionId);
      expect(p.endedAt).toBeNull();
      expect(p.awaitingPersonCause).toBe('reply');
      expect(await inWaitingOnYou(planned.sessionId)).toBe(true);
    },
  );
});

describe('4 · coming back inside the window resumes the same conversation', () => {
  it('a follow-up at 25 minutes lands on the same id and refreshes the lease', T, async () => {
    const c = await conversation('Returning');
    await age(c.sessionId, 25 * MIN);
    const before = await sessionRow(c.sessionId);

    const resumed = await planChangeSessionsService.findResumable(ownerPctx(), c.scope.scopeKey);
    expect(resumed?.id).toBe(c.sessionId);
    expect(resumed?.turns).toHaveLength(before.turnCount);

    const after = await planChangeSessionsService.startWithFirstTurn(
      ownerPctx(),
      c.scope,
      'It is the billing team.',
    );
    expect(after.id).toBe(c.sessionId);
    expect(after.turnCount).toBe(before.turnCount + 1);
    expect(new Date(after.lastActivityAt).getTime()).toBeGreaterThan(
      before.lastActivityAt.getTime(),
    );

    await sweep();
    const s = await sessionRow(c.sessionId);
    expect(s.endedAt).toBeNull();
    expect(sessionWaitingState(s)).toBe('open');
    expect(await gatesOf(c.sessionId)).toHaveLength(0);
  });

  it(
    'after the idle close a return starts fresh, and the by-id door still opens the ended one',
    T,
    async () => {
      const c = await conversation('Ended');
      await age(c.sessionId, PLAN_TARGET_LOCK_LEASE_MS + 1 * MIN);
      await planSessionEndService.closeIdleSessions(new Date());
      const ended = await sessionRow(c.sessionId);
      expect(ended.endReason).toBe('idle');

      expect(
        await planChangeSessionsService.findResumable(ownerPctx(), c.scope.scopeKey),
      ).toBeNull();
      const fresh = await planChangeSessionsService.startWithFirstTurn(
        ownerPctx(),
        c.scope,
        'Another question',
      );
      expect(fresh.id).not.toBe(c.sessionId);
      const untouched = await sessionRow(c.sessionId);
      expect(untouched.endedAt).toEqual(ended.endedAt);
      expect(untouched.turnCount).toBe(ended.turnCount);

      // The overlay's by-id door stays open on a conversation the room does not list.
      const byId = await planChangeSessionsService.getByIdForReader(ownerPctx(), c.sessionId);
      expect(byId.id).toBe(c.sessionId);
      await absentFromEveryRoom(c.sessionId);
    },
  );
});

describe('5 · the Plans room lists only conversations that reached planning', () => {
  it('a plan-less conversation is on no page, open or ended, in either view', T, async () => {
    const c = await conversation('Only one');

    await absentFromEveryRoom(c.sessionId);
    // The owner's only conversation: their Mine counts are all zero while the project holds it.
    const mine = await room('mine');
    expect(mine.total).toBe(0);
    expect(await adminDb.planChangeSession.count({ where: { id: c.sessionId } })).toBe(1);

    await age(c.sessionId, PLAN_TARGET_LOCK_LEASE_MS + 1 * MIN);
    await sweep();
    expect((await sessionRow(c.sessionId)).endReason).toBe('idle');

    await absentFromEveryRoom(c.sessionId);
    expect((await room('mine')).total).toBe(0);
    expect((await room('project')).total).toBe(0);
  });

  it(
    'the summed counts are the rows, in both views, with a plan-less row in the project',
    T,
    async () => {
      const planless = await conversation('Plan-less');
      const planned = await conversation('Declined');
      await holdPlan(planned.sessionId, 'declined');

      for (const view of ['project', 'mine'] as const) {
        const r = await room(view);
        expect(r.ids).toEqual([planned.sessionId]);
        expect(r.total).toBe(1);
        expect(r.counts.declined).toBe(1);
        expect(r.ids).not.toContain(planless.sessionId);
      }
    },
  );
});

describe('6 · reaching planning flips the same session', () => {
  it(
    'a declined plan makes the reply pass mark it, while a plan-less twin is idle-closed by the same pass',
    T,
    async () => {
      const crossing = await conversation('Crossing');
      const twin = await conversation('Twin');
      expect((await room('project')).ids).not.toContain(crossing.sessionId);

      await holdPlan(crossing.sessionId, 'declined');
      for (const s of [crossing, twin]) await plannerReplyQuietFor(s.sessionId, 40 * MIN);

      await sweep();

      // Raised by the reply pass, so the idle close that runs after it spares it.
      const s = await sessionRow(crossing.sessionId);
      expect(s.endedAt).toBeNull();
      expect(s.awaitingPersonCause).toBe('reply');
      expect(await awaitingGates(crossing.sessionId)).toHaveLength(1);
      expect(await inWaitingOnYou(crossing.sessionId)).toBe(true);
      expect(await inWaitingOnYou(crossing.sessionId, rivalId)).toBe(false);
      const project = await room('project');
      expect(project.ids).toContain(crossing.sessionId);
      expect(project.counts.declined).toBe(1);

      // OPPOSITE OUTCOME, same pass: the plan-less twin is ended `idle`.
      const t = await sessionRow(twin.sessionId);
      expect(t.endReason).toBe('idle');
      expect(await gatesOf(twin.sessionId)).toHaveLength(0);
      expect(project.ids).not.toContain(twin.sessionId);
    },
  );

  it(
    'an undecided plan holds it: neither raised nor closed, listed under its own state',
    T,
    async () => {
      const c = await conversation('Generating');
      expect((await room('project')).ids).not.toContain(c.sessionId);

      const planId = await holdPlan(c.sessionId, 'generating');
      await plannerReplyQuietFor(c.sessionId, PLAN_TARGET_LOCK_LEASE_MS + 10 * MIN);
      await sweep();

      const s = await sessionRow(c.sessionId);
      expect(s.endedAt).toBeNull();
      expect(s.awaitingPersonSince).toBeNull();
      expect(await gatesOf(c.sessionId)).toHaveLength(0);
      const r = await room('project');
      expect(r.ids).toEqual([c.sessionId]);
      expect(r.states.get(c.sessionId)).toBe('generating');
      expect(r.counts.generating).toBe(1);
      expect((await room('project', 'generating')).ids).toEqual([c.sessionId]);
      expect((await planningOf()).items.some((i) => i.planId === planId)).toBe(true);
    },
  );
});

describe('7 · the widened idle read does not over-reach onto a failed attempt', () => {
  it(
    'a failure with no plan row keeps its To resume place; a plan-less twin is ended',
    T,
    async () => {
      const failed = await conversation('Failed');
      const twin = await conversation('Twin');
      await adminDb.planChangeSession.update({
        where: { id: failed.sessionId },
        data: {
          failedAt: new Date(),
          failedJobId: 'job-failed',
          failureReason: 'rate_limited',
          failureStopPhase: 'author',
          failureStopRef: 'planItem:abc',
          failureStopTitle: 'Export a report',
        },
      });
      for (const s of [failed, twin]) await age(s.sessionId, 3 * PLAN_TARGET_LOCK_LEASE_MS);

      await sweep();

      const f = await sessionRow(failed.sessionId);
      expect(f.endedAt).toBeNull();
      expect(sessionWaitingState(f)).toBe('failed');
      expect(await inToResume(failed.sessionId)).toBe(true);
      expect((await sessionRow(twin.sessionId)).endReason).toBe('idle');
    },
  );
});

describe('8 · a second member sees none of it', () => {
  it(
    'every reader is empty for the rival and unchanged for the owner by their calls',
    T,
    async () => {
      const planless = await conversation('Plan-less');
      const raised = await conversation('Raised');
      await holdPlan(raised.sessionId, 'declined');
      await plannerReplyQuietFor(raised.sessionId, 40 * MIN);
      const writing = await conversation('Writing');
      const planId = await holdPlan(writing.sessionId, 'generating');
      const failed = await conversation('Failed');
      await adminDb.planChangeSession.update({
        where: { id: failed.sessionId },
        data: {
          failedAt: new Date(),
          failedJobId: 'job-failed',
          failureReason: 'rate_limited',
          failureStopPhase: 'author',
          failureStopRef: 'planItem:abc',
          failureStopTitle: 'Export a report',
        },
      });
      await sweep();

      const ownerBefore = {
        waiting: (await waitingOnYou()).length,
        toResume: (await toResumeOf()).total,
        planning: (await planningOf()).total,
        room: (await room('mine')).ids,
      };
      expect(ownerBefore.waiting).toBe(1);
      expect(ownerBefore.toResume).toBeGreaterThanOrEqual(1);
      expect(await inToResume(failed.sessionId)).toBe(true);
      expect((await planningOf()).items.some((i) => i.planId === planId)).toBe(true);
      expect(ownerBefore.room).not.toContain(planless.sessionId);

      // The rival: every list empty, every count zero against it.
      expect(await waitingOnYou(rivalId)).toHaveLength(0);
      expect((await toResumeOf(rivalId)).total).toBe(0);
      expect((await planningOf(rivalId)).total).toBe(0);
      const rivalRoom = await room('mine', null, rivalId);
      expect(rivalRoom.ids).toEqual([]);
      expect(rivalRoom.total).toBe(0);

      expect({
        waiting: (await waitingOnYou()).length,
        toResume: (await toResumeOf()).total,
        planning: (await planningOf()).total,
        room: (await room('mine')).ids,
      }).toEqual(ownerBefore);
    },
  );
});

describe('9 · the fresh-start pointer and the room are one fact', () => {
  it('earlier names the OLDER planned conversation, and the room lists exactly it', T, async () => {
    const older = await endedConversation(60);
    await holdPlan(older, 'declined');
    const newer = await endedConversation(5);
    const olderRow = await sessionRow(older);

    const read = await planChangeSessionsService.findResumableWithEarlier(ownerPctx());
    expect(read.session).toBeNull();
    expect(read.earlier?.id).toBe(older);
    expect(read.earlier?.mine).toBe(true);
    expect(read.earlier?.lastActivityAt).toBe(olderRow.lastActivityAt.toISOString());

    for (const view of ['project', 'mine'] as const) {
      const r = await room(view);
      expect(r.ids).toContain(read.earlier!.id);
      expect(r.ids).not.toContain(newer);
    }
  });

  it('only plan-less conversations: no pointer, and no row', T, async () => {
    const own = await endedConversation(10);
    const theirs = await endedConversation(5, rivalId);

    const read = await planChangeSessionsService.findResumableWithEarlier(ownerPctx());
    expect(read.session).toBeNull();
    expect(read.earlier).toBeNull();
    // The copy carry follows its own rule: the owner's own ended conversation.
    expect(read.copyable?.id).toBe(own);

    const r = await room('project');
    expect(r.ids).not.toContain(own);
    expect(r.ids).not.toContain(theirs);
    expect(r.total).toBe(0);
  });

  it(
    'the anchored door inherits the rule, and a named session carries no earlier key',
    T,
    async () => {
      const c = await card('Anchored');
      const scope = buildScope([c.key]);
      const s = await adminDb.planChangeSession.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          createdById: fx.ownerId,
          origin: 'conversation',
          scopeKey: scope.scopeKey,
          targetKeys: [c.key],
          turnCount: 1,
          lastActivityAt: minutesAgo(10),
          endedAt: minutesAgo(10),
          endReason: 'idle',
        },
      });

      const first = await contextualPlanningService.getSessionForWorkItem(
        { anchorId: c.id },
        ownerPctx(),
      );
      expect(first.session).toBeNull();
      expect(first.earlier).toBeNull();

      await holdPlan(s.id, 'declined');
      const second = await contextualPlanningService.getSessionForWorkItem(
        { anchorId: c.id },
        ownerPctx(),
      );
      expect(second.session).toBeNull();
      expect(second.earlier?.id).toBe(s.id);
      expect((await room('project')).ids).toContain(s.id);

      const named = await contextualPlanningService.getSessionForWorkItem(
        { anchorId: c.id, sessionId: s.id },
        ownerPctx(),
      );
      expect(named.session?.id).toBe(s.id);
      expect(named).not.toHaveProperty('earlier');
    },
  );

  it(
    'copyable did not narrow: the own ended plan-less one, beside another member’s planned one',
    T,
    async () => {
      const own = await endedConversation(60);
      const theirs = await endedConversation(5, rivalId);
      await holdPlan(theirs, 'declined');

      const read = await planChangeSessionsService.findResumableWithEarlier(ownerPctx());
      expect(read.copyable).toMatchObject({ id: own, endReason: 'idle' });
      expect(read.earlier).toMatchObject({ id: theirs, mine: false });
      expect((await room('project')).ids).toEqual([theirs]);
    },
  );
});
