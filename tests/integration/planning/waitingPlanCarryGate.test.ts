import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope } from '@/lib/planChange/scope';
import {
  EmptyPlanChangeTurnError,
  PlanAgainNotAvailableError,
  PlanSessionEndedError,
  PlanSessionNotCopyableError,
  PlanSessionNotFoundError,
  PlanSessionPlanDecidedError,
  PlanSessionPlanStaleError,
  PlanTargetLockedError,
} from '@/lib/planChange/errors';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import {
  PlanNotEditableError,
  PlanNotFoundError,
  PlanRevisionInFlightError,
} from '@/lib/plans/errors';
import { planRevisionRepository } from '@/lib/repositories/planRevisionRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';

// THE STORY INTEGRATION GATE for "a waiting plan whose session has ended keeps its
// conversation" (Story MOTIR-7928 · MOTIR-7933), against a REAL Postgres with RLS on.
//
// The code cards' own suites prove each branch in one process: the carry
// (`tests/planning/planSessionCarry.test.ts`, MOTIR-7930) and the session revise on
// an ordinary open session (`sessionTurnOnWaitingPlan.test.ts`, MOTIR-7945). This
// gate proves what only the ASSEMBLED path can show:
//
//   * situation 1 is produced by the SHIPPED end (`endSession` → `endSessionWithin`)
//     over a plan the shipped doors planned, never by a hand-written ended row;
//   * the carry is ONE transaction — a refused hold leaves no session, turn, move,
//     trail row or lock behind;
//   * racing first turns, a racing approve and a racing double Plan it again each
//     resolve to one outcome on separate connections, looped so the race happens;
//   * the carried plan is the one the NEXT turn revises, and a carried STALE plan is
//     answered without a write and replaced by ONE fresh plan without being touched;
//   * the plan's `plan_approval` gate still waits in Waiting on you across the end
//     and the carry, and approves through the gate afterwards.
//
// Only the motir-ai boundary (`submitJob`) and the two cookie resolvers the routes
// read (`getSession`, `getActiveProject`) are stubbed; every service, repository,
// lock and trail row underneath is real. motir-ai's own revise is not called — see
// case 7 for why the job core sends is the whole of what decides it.

let jobSeq = 0;
const submitJobMock = vi.fn(async () => ({ jobId: `job-${++jobSeq}` }));

vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  submitJob: (...args: unknown[]) => submitJobMock(...(args as [])),
}));

const routeSession = {
  current: null as { user: { id: string; email: string; name: string } } | null,
};
const routeProject = { current: null as ProjectContext | null };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => routeSession.current,
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: async () => routeProject.current,
}));

const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { plansService } = await import('@/lib/services/plansService');
const { planDriftService } = await import('@/lib/services/planDriftService');
const { planSessionEndService } = await import('@/lib/services/planSessionEndService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { aiPlanEditsService } = await import('@/lib/services/aiPlanEditsService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { usersService } = await import('@/lib/services/usersService');
const { POST: copyRoute } = await import('@/app/api/ai/plan-change/session/route');
const { POST: submitRoute } = await import('@/app/api/ai/plan-change/session/submit/route');

const T = { timeout: 120_000 };
const LOOP_T = { timeout: 600_000 };
/** How many times each race is run. A race test passes vacuously when the race
 *  never happens, so each one is looped and asserts both outcomes were seen. */
const RACE_ITERATIONS = Number(process.env.GATE_RACE_ITERATIONS ?? 20);

let fx: WorkItemFixture;

beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  submitJobMock.mockReset();
  submitJobMock.mockImplementation(async () => ({ jobId: `job-${++jobSeq}` }));
  fx = await makeWorkItemFixture();
  routeSession.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
  routeProject.current = me();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function me(): ProjectContext {
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

// ── fixtures, every one through the shipped services ──────────────────────────

async function card(title: string) {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);
}

interface Waiting {
  /** The ended source session. */
  sourceId: string;
  /** The plan it holds, `planned` (or `stale` once its target finishes). */
  planId: string;
  /** The card the conversation is anchored on and the plan modifies. */
  target: Awaited<ReturnType<typeof card>>;
}

/**
 * A `conversation` session anchored on a fresh card, whose plan proposes to
 * `modify` that card and has reached `planned` (which raises its `plan_approval`
 * gate). Ended by the SHIPPED end when `end` is given.
 */
async function conversationWithPlannedPlan(
  title: string,
  end: 'restarted' | 'failed' | 'idle' | null = 'restarted',
): Promise<Waiting> {
  const target = await card(title);
  const s = await planChangeSessionsService.startWithFirstTurn(
    me(),
    buildScope([target.identifier]),
    'Split the export work',
  );
  const first = await planChangeSessionsService.submit(me(), { sessionId: s.id });
  await planChangeSessionsService.appendAnswerTurn(
    { jobId: first.jobId, body: 'CSV goes first.' },
    me(),
    { sessionId: s.id },
  );
  await plansService.addProposals(
    first.planId,
    [{ op: 'modify', workItemId: target.id, patch: { title: `${title} (revised)` } }],
    fx.ctx,
  );
  await plansService.markPlanned(first.planId, fx.ctx);
  if (end) await endShipped(s.id, end);
  return { sourceId: s.id, planId: first.planId, target };
}

/** The shipped end: `endSession` → `endSessionWithin`, signed by the owner. */
async function endShipped(sessionId: string, reason: 'restarted' | 'failed' | 'idle') {
  const out = await planSessionEndService.endSession(sessionId, reason, {
    workspaceId: fx.workspaceId,
    endedById: reason === 'restarted' ? fx.ownerId : null,
    actorId: fx.ownerId,
  });
  expect(out.ended).toBe(true);
}

/** A work item finished through the shipped transition, then the drift consumer
 *  of that transition's event (`plan-drift/transitioned`) run as Inngest runs it. */
async function finishThroughTransition(workItemId: string) {
  // The default workflow walks a card to Done through In Progress and In Review.
  let from = (await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } })).status;
  for (const to of ['in_progress', 'in_review', 'done']) {
    await workItemsService.updateStatus(workItemId, to, fx.ctx);
    await planDriftService.markStaleForTerminalTarget(workItemId, fx.workspaceId, {
      fromStatusKey: from,
      toStatusKey: to,
    });
    from = to;
  }
}

async function member(email: string): Promise<string> {
  const u = await usersService.createUser({
    email,
    password: 'correct-horse-battery-staple-9',
    name: 'Mate',
  });
  await adminDb.workspaceMembership.create({
    data: { userId: u.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
  });
  await addToProjectAs({
    key: fx.project.identifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: u.id,
    role: 'member',
  });
  return u.id;
}

// ── reads, all of them rows ───────────────────────────────────────────────────

const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });
const carriedRows = (planId: string) =>
  adminDb.planRevision.findMany({ where: { planId, changeKind: 'session_carried' } });
const copiesOf = (sourceId: string) =>
  adminDb.planChangeSession.findMany({ where: { copiedFromSessionId: sourceId } });
const plansIn = (sessionId: string) => adminDb.plan.count({ where: { sessionId } });
const markers = (sessionId: string) =>
  adminDb.planChangeTurn.findMany({ where: { sessionId, role: 'system' } });
/** The plan's content trail, read the way the product reads it: in a tx, under RLS. */
const trailOf = (planId: string) =>
  withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    planRevisionRepository.listByPlan(planId, tx),
  );
const planGate = (planId: string) =>
  adminDb.approvalGate.findFirst({
    where: { kind: 'plan_approval', subjectId: planId },
    orderBy: { createdAt: 'desc' },
  });

/** The `plan_approval` subjects the Workbench's to-approve read lists for the owner. */
async function toApprove(): Promise<Map<string, { planId: string; sessionId: string | null }>> {
  const queue = await approvalGatesService.listAwaitingMe({
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
  });
  const out = new Map<string, { planId: string; sessionId: string | null }>();
  for (const row of queue.items) {
    if (row.subject?.kind === 'plan_approval') out.set(row.subject.planId, row.subject);
  }
  return out;
}

/** Approve through the `plan_approval` gate, as the overlay's Approve press does. */
async function approveThroughGate(planId: string) {
  const gate = await planGate(planId);
  expect(gate?.state).toBe('awaiting');
  return approvalGatesService.decide(
    { stamp: DECIDED_WITHOUT_A_READER, gateId: gate!.id, decision: 'approve', source: 'ui' },
    fx.ctx,
  );
}

function copyReq(body: Record<string, unknown>): Request {
  return new Request('http://localhost:3000/api/ai/plan-change/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function submitReq(body: Record<string, unknown>): Request {
  return new Request('http://localhost:3000/api/ai/plan-change/session/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── the cases ─────────────────────────────────────────────────────────────────

describe('case 1 — situation 1 is carried in one transaction', () => {
  it(
    'a new session with the turns, the plan moved on the trail, the scope held, the source untouched',
    T,
    async () => {
      const { sourceId, planId, target } = await conversationWithPlannedPlan('CSV export');
      const source = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sourceId } });
      expect(source).toMatchObject({ endReason: 'restarted' });
      expect(source.endedAt).not.toBeNull();
      expect((await planRow(planId)).status).toBe('planned');
      // The shipped end gave the scope's card back.
      expect(await adminDb.planTargetLock.count({ where: { sessionId: sourceId } })).toBe(0);
      const sourceTurns = await adminDb.planChangeTurn.findMany({
        where: { sessionId: sourceId },
        orderBy: { seq: 'asc' },
      });

      const out = await planChangeSessionsService.startCopied(me(), sourceId, {
        body: 'Keep the PDF report',
      });

      // The new session: the source's user / assistant turns in seq order, then the new turn.
      const turns = await adminDb.planChangeTurn.findMany({
        where: { sessionId: out.id },
        orderBy: { seq: 'asc' },
      });
      expect(turns.map((t) => [t.role, t.body])).toEqual([
        ...sourceTurns
          .filter((t) => t.role === 'user' || t.role === 'assistant')
          .map((t) => [t.role, t.body]),
        ['user', 'Keep the PDF report'],
      ]);
      expect(turns.map((t) => t.seq)).toEqual(turns.map((_, i) => i));
      const created = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: out.id } });
      expect(created).toMatchObject({
        copiedFromSessionId: sourceId,
        endedAt: null,
        origin: 'conversation',
      });

      // The plan moved, on the trail, once, signed by the caller.
      expect((await planRow(planId)).sessionId).toBe(out.id);
      const carried = await carriedRows(planId);
      expect(carried).toHaveLength(1);
      expect(carried[0]!.diff).toEqual({ fromSessionId: sourceId, toSessionId: out.id });
      expect(carried[0]!.changedById).toBe(fx.ownerId);

      // A live SESSION hold (session set, plan null) on every non-terminal scope card.
      const locks = await adminDb.planTargetLock.findMany({ where: { sessionId: out.id } });
      expect(locks.map((l) => [l.workItemId, l.planId])).toEqual([[target.id, null]]);

      // The source is exactly as the end left it, and no longer names a plan.
      const after = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sourceId } });
      expect(after.endedAt).toEqual(source.endedAt);
      expect(after.endReason).toBe(source.endReason);
      expect(await adminDb.planChangeTurn.count({ where: { sessionId: sourceId } })).toBe(
        sourceTurns.length,
      );
      expect((await planChangeSessionsService.getById(me(), sourceId)).pendingPlanId).toBeNull();
      expect((await planChangeSessionsService.getById(me(), out.id)).pendingPlanId).toBe(planId);
    },
  );
});

describe('case 2 — one transaction: a refused carry leaves nothing', () => {
  it('another member’s live hold refuses it, and every table is as it was', T, async () => {
    const { sourceId, planId, target } = await conversationWithPlannedPlan('Held by a mate');
    const mate = await member('mate@example.com');
    const mateSession = await planChangeSessionsService.startWithFirstTurn(
      { ...me(), userId: mate },
      buildScope([target.identifier]),
      'Mine now',
    );
    const counts = async () => ({
      sessions: await adminDb.planChangeSession.count(),
      turns: await adminDb.planChangeTurn.count(),
      carried: await adminDb.planRevision.count({ where: { changeKind: 'session_carried' } }),
      locks: await adminDb.planTargetLock.findMany({ orderBy: { id: 'asc' } }),
    });
    const before = await counts();
    expect(before.locks.map((l) => l.sessionId)).toEqual([mateSession.id]);

    await expect(
      planChangeSessionsService.startCopied(me(), sourceId, { body: 'Back to it' }),
    ).rejects.toBeInstanceOf(PlanTargetLockedError);

    expect(await counts()).toEqual(before);
    expect(await copiesOf(sourceId)).toHaveLength(0);
    expect((await planRow(planId)).sessionId).toBe(sourceId);
  });
});

describe('case 3 — two racing first turns make ONE session', () => {
  it(
    `on separate connections, ${RACE_ITERATIONS} times: one fresh, one taken back, one move`,
    LOOP_T,
    async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const { sourceId, planId } = await conversationWithPlannedPlan(`Race ${i}`);

        const results = await Promise.allSettled([
          planChangeSessionsService.startCopied(me(), sourceId, { body: 'a' }),
          planChangeSessionsService.startCopied(me(), sourceId, { body: 'b' }),
        ]);

        // Neither caller saw an error (no deadlock, no unique violation).
        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
        const [a, b] = results.map(
          (r) => (r as PromiseFulfilledResult<{ id: string; takenBack?: boolean }>).value,
        );
        expect(a!.id).toBe(b!.id);
        expect([a!.takenBack === true, b!.takenBack === true].sort()).toEqual([false, true]);

        const copies = await copiesOf(sourceId);
        expect(copies).toHaveLength(1);
        const userTurns = await adminDb.planChangeTurn.findMany({
          where: { sessionId: copies[0]!.id, role: 'user' },
          orderBy: { seq: 'asc' },
        });
        expect(
          userTurns
            .slice(-2)
            .map((t) => t.body)
            .sort(),
        ).toEqual(['a', 'b']);
        expect((await planRow(planId)).sessionId).toBe(copies[0]!.id);
        expect(await carriedRows(planId)).toHaveLength(1);
      }
    },
  );
});

describe('case 4 — an open session on the scope wins', () => {
  it(
    'Plan something new left an open session: the turn lands there and nothing moves',
    T,
    async () => {
      // The Plan something new path: `restart` ends the session (`restarted`, by the
      // owner) and opens the owner's next session on the same scope.
      const { sourceId: liveId, planId } = await conversationWithPlannedPlan('Planned again', null);
      const restarted = await planChangeSessionsService.restart(me(), { sessionId: liveId });
      const openId = restarted.session.id;
      expect(openId).not.toBe(liveId);
      const locksBefore = await adminDb.planTargetLock.findMany({ orderBy: { id: 'asc' } });
      const sessionsBefore = await adminDb.planChangeSession.count();

      const out = await planChangeSessionsService.startCopied(me(), liveId, { body: 'Back to it' });

      expect(out.id).toBe(openId);
      expect(out.takenBack).toBe(true);
      const newest = await adminDb.planChangeTurn.findFirst({
        where: { sessionId: openId },
        orderBy: { seq: 'desc' },
      });
      expect(newest).toMatchObject({ role: 'user', body: 'Back to it' });
      expect(await adminDb.planChangeSession.count()).toBe(sessionsBefore);
      expect((await planRow(planId)).sessionId).toBe(liveId);
      expect(await adminDb.planTargetLock.findMany({ orderBy: { id: 'asc' } })).toEqual(
        locksBefore,
      );
      expect(await carriedRows(planId)).toHaveLength(0);
    },
  );
});

describe('case 5 — a decided plan refuses', () => {
  it(
    'approved through its gate first: refused, nothing written, the route answers 409',
    T,
    async () => {
      const { sourceId, planId } = await conversationWithPlannedPlan('Approved first');
      await approveThroughGate(planId);
      expect((await planRow(planId)).status).toBe('approved');
      const before = {
        sessions: await adminDb.planChangeSession.count(),
        turns: await adminDb.planChangeTurn.count(),
        revisions: await adminDb.planRevision.count({ where: { planId } }),
      };

      // `planId` names the plan the overlay was looking at — the decided-under-the-
      // lock refusal rather than the generic not-copyable one.
      await expect(
        planChangeSessionsService.startCopied(me(), sourceId, { body: 'More', planId }),
      ).rejects.toBeInstanceOf(PlanSessionPlanDecidedError);
      expect({
        sessions: await adminDb.planChangeSession.count(),
        turns: await adminDb.planChangeTurn.count(),
        revisions: await adminDb.planRevision.count({ where: { planId } }),
      }).toEqual(before);
      expect((await planRow(planId)).sessionId).toBe(sourceId);
      expect(await copiesOf(sourceId)).toHaveLength(0);

      const res = await copyRoute(copyReq({ copyFrom: sourceId, body: 'More', planId }));
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('PLAN_SESSION_PLAN_DECIDED');
      expect(await copiesOf(sourceId)).toHaveLength(0);
    },
  );

  it(
    `an approve racing the carry, ${RACE_ITERATIONS} times: never a planned plan moved beside an approved gate, never two sessions`,
    LOOP_T,
    async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const { sourceId, planId } = await conversationWithPlannedPlan(`Approve race ${i}`);

        const [carry, approve] = await Promise.allSettled([
          planChangeSessionsService.startCopied(me(), sourceId, { body: 'Change it', planId }),
          approveThroughGate(planId),
        ]);

        const plan = await planRow(planId);
        const gate = await adminDb.approvalGate.findFirst({
          where: { kind: 'plan_approval', subjectId: planId },
          orderBy: { createdAt: 'desc' },
        });
        const copies = await copiesOf(sourceId);
        expect(copies.length).toBeLessThanOrEqual(1);
        // The invariant: a gate that reads approved means an approved plan.
        expect(gate?.state === 'approved' && plan.status !== 'approved').toBe(false);
        if (carry.status === 'rejected') {
          expect(carry.reason).toBeInstanceOf(PlanSessionPlanDecidedError);
          expect(copies).toHaveLength(0);
          expect(plan).toMatchObject({ status: 'approved', sessionId: sourceId });
        } else {
          expect(copies).toHaveLength(1);
          expect(plan.sessionId).toBe(copies[0]!.id);
          expect(await carriedRows(planId)).toHaveLength(1);
          if (approve.status === 'fulfilled') expect(plan.status).toBe('approved');
        }
      }
    },
  );
});

describe('case 6 — a pre-MOTIR-7905 `failed` source carries its EARLIER plan', () => {
  it('the planned plan moves; the attempt the end declined stays', T, async () => {
    const { sourceId, planId } = await conversationWithPlannedPlan('Failed later', null);
    // The pre-MOTIR-7905 shape: a later attempt in the same session, still
    // generating when the session failed. (Since MOTIR-7945 a turn over a planned
    // plan revises it, so no shipped door opens this second plan any more; the row
    // stands in for the history the end then acts on.)
    const later = await adminDb.plan.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        sessionId: sourceId,
        status: 'generating',
        createdById: fx.ownerId,
      },
    });
    await endShipped(sourceId, 'failed');
    expect((await planRow(later.id)).status).toBe('declined');

    const out = await planChangeSessionsService.startCopied(me(), sourceId, { body: 'Go on' });

    expect((await planRow(planId)).sessionId).toBe(out.id);
    expect((await planRow(later.id)).sessionId).toBe(sourceId);
    expect(await carriedRows(later.id)).toHaveLength(0);
  });
});

describe('case 7 — the carried plan is revised, not forked, by a real next turn', () => {
  it(
    'the next turn keys the revise job on the carried plan, and the plan approves through its gate',
    T,
    async () => {
      const { sourceId, planId, target } = await conversationWithPlannedPlan('Revise me');
      const out = await planChangeSessionsService.startCopied(me(), sourceId, {
        body: 'Keep the PDF report',
      });
      const contextual = vi.spyOn(aiPlanEditsService, 'submitContextual');
      const augment = vi.spyOn(aiPlanEditsService, 'submitAugment');
      submitJobMock.mockClear();
      const plansBefore = await adminDb.plan.count();

      const turn = await planChangeSessionsService.submit(me(), { sessionId: out.id });

      expect(turn.planId).toBe(planId);
      // Exactly one job left for motir-ai: a `plan` job keyed on the carried plan.
      // motir-ai's `readerForPlan` (src/jobs/handlers/plan.ts:646) routes ANY job
      // carrying `context.planId` to the revise reader, which addresses the plan
      // through the job — never through the session — so this field is the whole
      // of what decides that the carried plan is the one revised.
      expect(submitJobMock).toHaveBeenCalledTimes(1);
      const [kind, , context] = submitJobMock.mock.calls[0] as unknown as [
        string,
        unknown,
        { planId?: string },
      ];
      expect(kind).toBe('plan');
      expect(context.planId).toBe(planId);
      expect(contextual).not.toHaveBeenCalled();
      expect(augment).not.toHaveBeenCalled();

      const started = (await trailOf(planId)).filter((r) => r.changeKind === 'revision_started');
      expect(started).toHaveLength(1);
      expect((started[0]!.diff as { jobId?: string }).jobId).toBe(turn.jobId);
      expect(await plansIn(out.id)).toBe(1);
      expect(await adminDb.plan.count()).toBe(plansBefore);
      expect(
        (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: out.id } })).lastJobId,
      ).toBe(turn.jobId);

      // The pass finishes as a revision's final append does: the lease is released.
      const released = await plansService.releaseRevisionLease(
        planId,
        fx.ctx,
        { source: 'native', harness: 'Motir', model: null },
        { proposalCount: 0 },
      );
      expect(released.released).toBe(true);
      expect(await adminDb.planTargetLock.count({ where: { sessionId: out.id } })).toBe(1);

      await approveThroughGate(planId);

      expect((await planRow(planId)).status).toBe('approved');
      const materialized = await adminDb.workItem.findUniqueOrThrow({ where: { id: target.id } });
      expect(materialized.title).toBe('Revise me (revised)');
      // The approval ends the new session and gives its holds back, as any approval does.
      const ended = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: out.id } });
      expect(ended.endReason).toBe('approved');
      expect(await adminDb.planTargetLock.count({ where: { sessionId: out.id } })).toBe(0);
    },
  );
});

describe('case 8 — situation 1 still waits in Waiting on you', () => {
  it(
    'the gate awaits and lists after the end, and after the carry names the same plan',
    T,
    async () => {
      const { sourceId, planId } = await conversationWithPlannedPlan('Still waiting');

      const gateAfterEnd = await planGate(planId);
      expect(gateAfterEnd?.state).toBe('awaiting');
      const listedAfterEnd = (await toApprove()).get(planId);
      expect(listedAfterEnd).toBeDefined();
      expect(listedAfterEnd!.sessionId).toBe(sourceId);

      const out = await planChangeSessionsService.startCopied(me(), sourceId, { body: 'One more' });

      const gateAfterCarry = await planGate(planId);
      expect(gateAfterCarry?.id).toBe(gateAfterEnd!.id);
      expect(gateAfterCarry?.state).toBe('awaiting');
      const listedAfterCarry = (await toApprove()).get(planId);
      expect(listedAfterCarry).toBeDefined();
      expect(listedAfterCarry!.planId).toBe(planId);
      // The read follows the plan to the session it now lives in.
      expect(listedAfterCarry!.sessionId).toBe(out.id);
    },
  );
});

describe('case 9 — the unchanged neighbours', () => {
  it('a `restarted` source with no undecided plan is not copyable', T, async () => {
    const target = await card('Nothing waits');
    const s = await planChangeSessionsService.startWithFirstTurn(
      me(),
      buildScope([target.identifier]),
      'Just talking',
    );
    await endShipped(s.id, 'restarted');
    await expect(
      planChangeSessionsService.startCopied(me(), s.id, { body: 'x' }),
    ).rejects.toBeInstanceOf(PlanSessionNotCopyableError);
    expect(await copiesOf(s.id)).toHaveLength(0);
  });

  it('an `approved` or `declined` source is not copyable', T, async () => {
    const approved = await conversationWithPlannedPlan('Approved', null);
    await approveThroughGate(approved.planId);
    const declined = await conversationWithPlannedPlan('Declined', null);
    await plansService.declinePlan(declined.planId, fx.ctx);
    for (const { sourceId, reason } of [
      { sourceId: approved.sourceId, reason: 'approved' },
      { sourceId: declined.sourceId, reason: 'declined' },
    ]) {
      const row = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sourceId } });
      expect(row.endReason).toBe(reason);
      await expect(
        planChangeSessionsService.startCopied(me(), sourceId, { body: 'x' }),
      ).rejects.toBeInstanceOf(PlanSessionNotCopyableError);
      expect(await copiesOf(sourceId)).toHaveLength(0);
    }
  });

  it.each(['idle', 'failed'] as const)(
    'an `%s` source with no waiting plan copies the turns only and moves nothing',
    T,
    async (reason) => {
      const target = await card(`Talk ${reason}`);
      const s = await planChangeSessionsService.startWithFirstTurn(
        me(),
        buildScope([target.identifier]),
        'Thinking out loud',
      );
      await endShipped(s.id, reason);
      const read = await planChangeSessionsService.findResumableWithEarlier(
        me(),
        target.identifier,
      );
      expect(read.copyable).toMatchObject({ id: s.id, waitingPlanId: null });
      const plansBefore = await adminDb.plan.count();

      const out = await planChangeSessionsService.startCopied(me(), s.id, { body: 'Again' });

      expect(out.turns.map((t) => t.body)).toEqual(['Thinking out loud', 'Again']);
      expect(await adminDb.plan.count()).toBe(plansBefore);
      expect(await adminDb.planRevision.count({ where: { changeKind: 'session_carried' } })).toBe(
        0,
      );
    },
  );

  it('another member gets NOT FOUND, and the route says 404', T, async () => {
    const { sourceId } = await conversationWithPlannedPlan('Not yours');
    const mate = await member('mate@example.com');
    await expect(
      planChangeSessionsService.startCopied({ ...me(), userId: mate }, sourceId, { body: 'x' }),
    ).rejects.toBeInstanceOf(PlanSessionNotFoundError);
    routeSession.current = { user: { id: mate, email: 'mate@example.com', name: 'Mate' } };
    routeProject.current = { ...me(), userId: mate };
    const res = await copyRoute(copyReq({ copyFrom: sourceId, body: 'x' }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('PLAN_SESSION_NOT_FOUND');
    expect(await copiesOf(sourceId)).toHaveLength(0);
  });
});

describe('case 11 — a carried STALE plan is said, then replaced by ONE fresh plan', () => {
  /** Situation 1, the target finished through the shipped transition, carried. */
  async function carriedStale(title: string) {
    const waiting = await conversationWithPlannedPlan(title);
    const gateBefore = await planGate(waiting.planId);
    await finishThroughTransition(waiting.target.id);
    const stale = await planRow(waiting.planId);
    expect(stale.status).toBe('stale');
    const superseded = await adminDb.approvalGate.findUniqueOrThrow({
      where: { id: gateBefore!.id },
    });
    expect(superseded.state).toBe('superseded');
    // A stale plan is undecided, so it is copyable and moves like case 1.
    const out = await planChangeSessionsService.startCopied(me(), waiting.sourceId);
    expect((await planRow(waiting.planId)).sessionId).toBe(out.id);
    await planChangeSessionsService.appendTurn('Make the import faster', me(), {
      sessionId: out.id,
    });
    return { ...waiting, sessionId: out.id };
  }

  const planSnapshot = async (planId: string) => ({
    plan: await planRow(planId),
    items: await adminDb.planItem.findMany({ where: { planId }, orderBy: { id: 'asc' } }),
    planHolds: await adminDb.planTargetLock.findMany({ where: { planId }, orderBy: { id: 'asc' } }),
  });

  it(
    'the turn is answered stale, names the finished work item, and writes nothing',
    T,
    async () => {
      const { sessionId, planId, target } = await carriedStale('Finished meanwhile');
      const sessionBefore = await adminDb.planChangeSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      const markersBefore = (await markers(sessionId)).length;
      const snapshot = await planSnapshot(planId);
      submitJobMock.mockClear();

      const err = await planChangeSessionsService
        .submit(me(), { sessionId })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PlanSessionPlanStaleError);
      expect(submitJobMock).not.toHaveBeenCalled();
      expect((await markers(sessionId)).length).toBe(markersBefore);
      expect(
        (await trailOf(planId)).filter((r) => r.changeKind === 'revision_started'),
      ).toHaveLength(0);
      expect(await plansService.readRevisionLease(planId, me())).toBeNull();
      const sessionAfter = await adminDb.planChangeSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      expect(sessionAfter.lastJobId).toBe(sessionBefore.lastJobId);
      expect(sessionAfter.lastSubmittedAt).toEqual(sessionBefore.lastSubmittedAt);
      expect(await planSnapshot(planId)).toEqual(snapshot);

      const res = await submitRoute(submitReq({ sessionId }));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'PLAN_SESSION_PLAN_STALE',
        planId,
        finishedCards: [
          { id: target.id, key: target.identifier, title: target.title, status: 'done' },
        ],
      });
      expect(submitJobMock).not.toHaveBeenCalled();
      expect(await planSnapshot(planId)).toEqual(snapshot);
    },
  );

  it(
    `two Plan it again presses at once, ${RACE_ITERATIONS} times: one job, one plan, the stale plan untouched`,
    LOOP_T,
    async () => {
      for (let i = 0; i < RACE_ITERATIONS; i += 1) {
        const { sessionId, planId } = await carriedStale(`Again race ${i}`);
        const snapshot = await planSnapshot(planId);
        const markersBefore = (await markers(sessionId)).length;
        const plansBefore = await plansIn(sessionId);
        submitJobMock.mockClear();

        const results = await Promise.allSettled([
          planChangeSessionsService.submit(me(), { sessionId }, undefined, { planAgainOf: planId }),
          planChangeSessionsService.submit(me(), { sessionId }, undefined, { planAgainOf: planId }),
        ]);

        const won = results.filter((r) => r.status === 'fulfilled');
        const lost = results.filter((r) => r.status === 'rejected');
        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(1);
        const refusal = (lost[0] as PromiseRejectedResult).reason;
        expect(refusal).toBeInstanceOf(PlanAgainNotAvailableError);
        expect((refusal as { code?: string }).code).toBe('PLAN_SESSION_PLAN_AGAIN_NOT_AVAILABLE');
        expect(submitJobMock).toHaveBeenCalledTimes(1);
        const fresh = (won[0] as PromiseFulfilledResult<{ planId: string; jobId: string }>).value;
        expect(fresh.planId).not.toBe(planId);
        expect(await plansIn(sessionId)).toBe(plansBefore + 1);
        expect((await planRow(fresh.planId)).status).toBe('generating');
        const newMarkers = await markers(sessionId);
        expect(newMarkers).toHaveLength(markersBefore + 1);
        expect(newMarkers.filter((m) => m.jobId === fresh.jobId)).toHaveLength(1);
        // The stale plan: same status, proposals, session and plan-held rows; no decline.
        expect(await planSnapshot(planId)).toEqual(snapshot);
        expect(
          (await trailOf(planId)).filter(
            (r) => r.changeKind === 'declined' || r.changeKind === 'discarded',
          ),
        ).toHaveLength(0);

        if (i === RACE_ITERATIONS - 1) {
          // The fresh plan reaches `planned` through the final append's close, and the
          // next turn revises IT — not the stale plan.
          const other = await card('Import speed');
          await plansService.addProposals(
            fresh.planId,
            [{ op: 'modify', workItemId: other.id, patch: { title: 'Faster import' } }],
            fx.ctx,
          );
          await plansService.markPlanned(fresh.planId, fx.ctx);
          await planChangeSessionsService.appendTurn('Tweak it', me(), { sessionId });
          const next = await planChangeSessionsService.submit(me(), { sessionId });
          expect(next.planId).toBe(fresh.planId);
          const startedOnFresh = (await trailOf(fresh.planId)).filter(
            (r) => r.changeKind === 'revision_started',
          );
          expect(startedOnFresh).toHaveLength(1);
          expect((startedOnFresh[0]!.diff as { jobId?: string }).jobId).toBe(next.jobId);
          expect(
            (await trailOf(planId)).filter((r) => r.changeKind === 'revision_started'),
          ).toHaveLength(0);
        }
      }
    },
  );
});

describe('the doors — what the routes add over the services', () => {
  it('the copy door carries with the turn and answers the new session', T, async () => {
    const { sourceId, planId } = await conversationWithPlannedPlan('Through the door');
    const res = await copyRoute(
      copyReq({
        copyFrom: ` ${sourceId} `,
        body: 'Keep the PDF',
        isAnswer: false,
        anchorKey: null,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const dto = (await res.json()) as { id: string; turns: { body: string }[] };
    expect(dto.id).not.toBe(sourceId);
    expect(dto.turns.at(-1)?.body).toBe('Keep the PDF');
    expect((await planRow(planId)).sessionId).toBe(dto.id);
  });

  it('the copy door refuses a malformed body and writes nothing', T, async () => {
    const { sourceId } = await conversationWithPlannedPlan('Malformed');
    for (const body of [
      { copyFrom: '' },
      { copyFrom: 42 },
      { copyFrom: sourceId, body: 7 },
      { copyFrom: sourceId, anchorKey: 7 },
      { copyFrom: sourceId, planId: 7 },
    ]) {
      const res = await copyRoute(copyReq(body));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('BAD_REQUEST');
    }
    expect(await copiesOf(sourceId)).toHaveLength(0);
  });

  it('the submit door reads a blank planAgainOf as an ordinary turn', T, async () => {
    const { sourceId, planId } = await conversationWithPlannedPlan('Blank again');
    const out = await planChangeSessionsService.startCopied(me(), sourceId, { body: 'Change it' });
    const res = await submitRoute(submitReq({ sessionId: out.id, planAgainOf: '   ' }));
    expect(res.status).toBe(200);
    // An ordinary turn over the carried planned plan revises it.
    expect(((await res.json()) as { planId: string }).planId).toBe(planId);
    expect(await plansIn(out.id)).toBe(1);
  });

  it('the submit door answers Plan it again, and its refusal, as the hook expects', T, async () => {
    const waiting = await conversationWithPlannedPlan('Again through the door');
    await finishThroughTransition(waiting.target.id);
    const out = await planChangeSessionsService.startCopied(me(), waiting.sourceId, {
      body: 'Again',
    });

    const first = await submitRoute(submitReq({ sessionId: out.id, planAgainOf: waiting.planId }));
    expect(first.status).toBe(200);
    const fresh = (await first.json()) as { planId: string };
    expect(fresh.planId).not.toBe(waiting.planId);

    const second = await submitRoute(submitReq({ sessionId: out.id, planAgainOf: waiting.planId }));
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      code: 'PLAN_SESSION_PLAN_AGAIN_NOT_AVAILABLE',
      latestPlanId: fresh.planId,
    });
  });
});

describe('the edges around the carry — what an old tab or a second press meets', () => {
  it('a blank first turn is refused before anything is read or written', T, async () => {
    const { sourceId, planId } = await conversationWithPlannedPlan('Blank');
    await expect(
      planChangeSessionsService.startCopied(me(), sourceId, { body: '   ' }),
    ).rejects.toBeInstanceOf(EmptyPlanChangeTurnError);
    expect(await copiesOf(sourceId)).toHaveLength(0);
    expect((await planRow(planId)).sessionId).toBe(sourceId);
  });

  it(
    'an old tab naming a plan an earlier carry already moved is refused, not stranded',
    T,
    async () => {
      const { sourceId, planId } = await conversationWithPlannedPlan('Moved twice');
      const first = await planChangeSessionsService.startCopied(me(), sourceId, { body: 'Go' });
      // That carried session ends too (Motir closes it idle), so no open session wins.
      await endShipped(first.id, 'idle');

      await expect(
        planChangeSessionsService.startCopied(me(), sourceId, { body: 'Again', planId }),
      ).rejects.toBeInstanceOf(PlanSessionNotCopyableError);
      expect(await copiesOf(sourceId)).toHaveLength(1);
      expect((await planRow(planId)).sessionId).toBe(first.id);
      expect(await carriedRows(planId)).toHaveLength(1);

      await expect(
        planChangeSessionsService.startCopied(me(), sourceId, {
          body: 'Again',
          planId: 'no-such-plan',
        }),
      ).rejects.toBeInstanceOf(PlanSessionNotFoundError);
    },
  );

  it(
    'Plan it again on the ENDED source says ended, and after the carry names no plan',
    T,
    async () => {
      const waiting = await conversationWithPlannedPlan('Old tab');
      await finishThroughTransition(waiting.target.id);
      // Before the carry: the stale plan is still the source's, undecided — ended.
      await expect(
        planChangeSessionsService.submit(me(), { sessionId: waiting.sourceId }, undefined, {
          planAgainOf: waiting.planId,
        }),
      ).rejects.toBeInstanceOf(PlanSessionEndedError);
      await planChangeSessionsService.startCopied(me(), waiting.sourceId);
      // After it: the plan is no longer the source's, so the old tab learns nothing about it.
      await expect(
        planChangeSessionsService.submit(me(), { sessionId: waiting.sourceId }, undefined, {
          planAgainOf: waiting.planId,
        }),
      ).rejects.toBeInstanceOf(PlanNotFoundError);
      expect(submitJobMock).toHaveBeenCalledTimes(1);
    },
  );

  it(
    'a second send while the carried plan is being revised is refused before a job is spent',
    T,
    async () => {
      const { sourceId, planId } = await conversationWithPlannedPlan('In flight');
      const out = await planChangeSessionsService.startCopied(me(), sourceId, { body: 'One' });
      await planChangeSessionsService.submit(me(), { sessionId: out.id });
      await planChangeSessionsService.appendTurn('Two', me(), { sessionId: out.id });
      submitJobMock.mockClear();

      await expect(
        planChangeSessionsService.submit(me(), { sessionId: out.id }),
      ).rejects.toBeInstanceOf(PlanRevisionInFlightError);
      expect(submitJobMock).not.toHaveBeenCalled();
      expect(
        (await trailOf(planId)).filter((r) => r.changeKind === 'revision_started'),
      ).toHaveLength(1);
    },
  );

  it('a revise whose job never starts leaves the carried plan unleased', T, async () => {
    const { sourceId, planId } = await conversationWithPlannedPlan('Unreachable');
    const out = await planChangeSessionsService.startCopied(me(), sourceId, { body: 'One' });
    submitJobMock.mockRejectedValueOnce(new Error('motir-ai unreachable'));

    await expect(planChangeSessionsService.submit(me(), { sessionId: out.id })).rejects.toThrow(
      'motir-ai unreachable',
    );
    expect(await plansService.readRevisionLease(planId, me())).toBeNull();
    expect((await trailOf(planId)).filter((r) => r.changeKind === 'revision_started')).toHaveLength(
      0,
    );
    // The next send revises it.
    const next = await planChangeSessionsService.submit(me(), { sessionId: out.id });
    expect(next.planId).toBe(planId);
  });

  it('the revise door refuses a stale plan before it spends a job', T, async () => {
    const waiting = await conversationWithPlannedPlan('Stale revise');
    await finishThroughTransition(waiting.target.id);
    submitJobMock.mockClear();
    await expect(
      aiPlanEditsService.submitSessionRevision(waiting.planId, 'Change it', me()),
    ).rejects.toBeInstanceOf(PlanNotEditableError);
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('a failed job releases only the revision IT started', T, async () => {
    const { sourceId, planId } = await conversationWithPlannedPlan('Failed revise');
    const out = await planChangeSessionsService.startCopied(me(), sourceId, { body: 'One' });
    const turn = await planChangeSessionsService.submit(me(), { sessionId: out.id });

    expect(
      await planSessionEndService.releaseRevisionForFailedJob('job-nobody-knows', fx.workspaceId),
    ).toBeNull();
    expect(
      await planSessionEndService.releaseRevisionForFailedJob(turn.jobId, fx.workspaceId),
    ).toEqual({ planId, released: true });
    // Nothing held any more: a second delivery of the same failure writes nothing.
    expect(
      await planSessionEndService.releaseRevisionForFailedJob(turn.jobId, fx.workspaceId),
    ).toEqual({ planId, released: false });
    const ended = (await trailOf(planId)).filter((r) => r.changeKind === 'revision_ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]!.diff).toMatchObject({ jobId: turn.jobId, failed: true });
  });
});
