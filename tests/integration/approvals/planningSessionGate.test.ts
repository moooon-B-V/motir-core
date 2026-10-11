import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope } from '@/lib/planChange/scope';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { ApprovalGateVerbNotOfferedError } from '@/lib/approvalGates/errors';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import {
  AWAITING_REPLY_AFTER_MS,
  planningSessionGateService,
} from '@/lib/services/planningSessionGateService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { PlanSessionEndReason } from '@/generated/prisma/client';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE PLANNING-SESSION GATE (Story MOTIR-7905 · MOTIR-7913), against a REAL Postgres: its
// raise on a planner's question and on a waited reply, its clear on the person's turn and
// on the session's end, the Waiting on you read and count admitting only a session that
// still waits, and the verbs it does not have. Counterfactuals sit beside each claim.

const getJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
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

const T = { timeout: 60_000 };
const MIN = 60 * 1000;

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  getJobMock.mockReset();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function me(f: WorkItemFixture = fx): ProjectContext {
  return {
    userId: f.ownerId,
    workspaceId: f.workspaceId,
    projectId: f.projectId,
    project: f.project,
  };
}
const actor = (userId: string = fx.ownerId) => ({
  userId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
});

async function seedCard(): Promise<{ id: string; key: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'The card' },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: dto.id }, data: { status: 'in_progress' } });
  return { id: dto.id, key: dto.identifier };
}

/** The owner's open session through the real first-turn door. */
async function openSession(): Promise<string> {
  const card = await seedCard();
  return (
    await planChangeSessionsService.startWithFirstTurn(me(), buildScope([card.key]), 'Split it')
  ).id;
}

const sessionRow = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });
const gatesOf = (sessionId: string) =>
  adminDb.approvalGate.findMany({
    where: { kind: 'planning_session', subjectId: sessionId },
    orderBy: { createdAt: 'asc' },
  });
const awaitingGates = async (sessionId: string) =>
  (await gatesOf(sessionId)).filter((g) => g.state === 'awaiting');

/** The planner speaks: job `jobId` settles with this utterance and the relay records it. */
async function plannerSpeaks(
  sessionId: string,
  jobId: string,
  message: string,
  question: string | null,
) {
  await adminDb.planChangeSession.update({ where: { id: sessionId }, data: { lastJobId: jobId } });
  getJobMock.mockResolvedValue({
    jobId,
    status: 'succeeded',
    error: null,
    result: { turn: { message, question } },
  });
  return planChangeSessionsService.recordPlannerTurn(jobId, me(), { sessionId });
}

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

describe('the schema admits the kind and only the kinds that may be card-less', () => {
  it(
    'accepts a planning_session row with no work item, and refuses a card-bearing kind without one',
    T,
    async () => {
      const sessionId = await openSession();
      await adminDb.approvalGate.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          workItemId: null,
          kind: 'planning_session',
          subjectId: sessionId,
          state: 'awaiting',
        },
      });

      await expect(
        adminDb.approvalGate.create({
          data: {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            workItemId: null,
            kind: 'design_result',
            subjectId: 'x',
            state: 'awaiting',
          },
        }),
      ).rejects.toThrow(/approval_gate_work_item_iff_not_plan|check constraint/i);
    },
  );
});

describe('the question cause', () => {
  it(
    'marks the session and raises exactly ONE gate, in the owner’s name, with no work item',
    T,
    async () => {
      const sessionId = await openSession();

      await plannerSpeaks(sessionId, 'job-q1', 'Before I split it —', 'Which team owns this?');

      const s = await sessionRow(sessionId);
      expect(s.awaitingPersonCause).toBe('question');
      expect(s.awaitingPersonSince).not.toBeNull();
      const gates = await awaitingGates(sessionId);
      expect(gates).toHaveLength(1);
      expect(gates[0]).toMatchObject({
        kind: 'planning_session',
        subjectId: sessionId,
        workItemId: null,
        routedToId: fx.ownerId,
        state: 'awaiting',
      });
    },
  );

  it('raises no second row when it happens again', T, async () => {
    const sessionId = await openSession();
    await plannerSpeaks(sessionId, 'job-q1', 'First —', 'One?');
    const since = (await sessionRow(sessionId)).awaitingPersonSince;

    await plannerSpeaks(sessionId, 'job-q2', 'Second —', 'Two?');

    expect(await awaitingGates(sessionId)).toHaveLength(1);
    expect((await sessionRow(sessionId)).awaitingPersonSince).toEqual(since);
  });

  it('raises nothing for a planner turn WITHOUT a question', T, async () => {
    const sessionId = await openSession();

    await plannerSpeaks(sessionId, 'job-r1', 'Here is what I found.', null);

    expect((await sessionRow(sessionId)).awaitingPersonSince).toBeNull();
    expect(await gatesOf(sessionId)).toHaveLength(0);
  });

  it('raises nothing on a `guide` session, nor on a failed-waiting one', T, async () => {
    const guide = await openSession();
    await adminDb.planChangeSession.update({ where: { id: guide }, data: { origin: 'guide' } });
    const failed = await openSession();
    await adminDb.planChangeSession.update({
      where: { id: failed },
      data: { failedAt: new Date(), failedJobId: 'j', failureReason: 'internal' },
    });

    await plannerSpeaks(guide, 'job-g', 'Hi', 'Why?');
    await plannerSpeaks(failed, 'job-f', 'Hi', 'Why?');

    for (const id of [guide, failed]) {
      expect((await sessionRow(id)).awaitingPersonSince).toBeNull();
      expect(await gatesOf(id)).toHaveLength(0);
    }
  });
});

describe('the reply cause — raised by the sweep', () => {
  it(
    'raises a conversation the person left, and the idle close in the same sweep does not end it',
    T,
    async () => {
      const sessionId = await openSession();
      await plannerReplyQuietFor(sessionId, AWAITING_REPLY_AFTER_MS + 5 * MIN);

      const out = await planningSessionGateService.raiseAwaitingReplies();
      const idle = await planSessionEndService.closeIdleSessions();

      expect(out.sessionIds).toEqual([sessionId]);
      expect((await sessionRow(sessionId)).awaitingPersonCause).toBe('reply');
      expect(await awaitingGates(sessionId)).toHaveLength(1);
      expect(idle.sessionIds).toEqual([]);
      expect((await sessionRow(sessionId)).endedAt).toBeNull();
    },
  );

  it('is left untouched when quiet for LESS than the threshold', T, async () => {
    const sessionId = await openSession();
    await plannerReplyQuietFor(sessionId, AWAITING_REPLY_AFTER_MS - 3 * MIN);

    expect((await planningSessionGateService.raiseAwaitingReplies()).raised).toBe(0);
    expect(await gatesOf(sessionId)).toHaveLength(0);
  });

  it('is left untouched while a job is in flight', T, async () => {
    const sessionId = await openSession();
    await plannerReplyQuietFor(sessionId, AWAITING_REPLY_AFTER_MS + 5 * MIN);
    await adminDb.plan.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        sessionId,
        status: 'generating',
      },
    });

    expect((await planningSessionGateService.raiseAwaitingReplies()).raised).toBe(0);
    expect(await gatesOf(sessionId)).toHaveLength(0);
  });

  it('is left untouched when the last turn is the PERSON’s', T, async () => {
    const sessionId = await openSession(); // its only turn is the person's first
    await adminDb.planChangeSession.update({
      where: { id: sessionId },
      data: { lastActivityAt: new Date(Date.now() - AWAITING_REPLY_AFTER_MS - 5 * MIN) },
    });

    expect((await planningSessionGateService.raiseAwaitingReplies()).raised).toBe(0);
  });

  it('is idempotent: a second pass raises nothing new', T, async () => {
    const sessionId = await openSession();
    await plannerReplyQuietFor(sessionId, AWAITING_REPLY_AFTER_MS + 5 * MIN);

    await planningSessionGateService.raiseAwaitingReplies();
    const again = await planningSessionGateService.raiseAwaitingReplies();

    expect(again.raised).toBe(0);
    expect(await awaitingGates(sessionId)).toHaveLength(1);
  });
});

describe('the clear', () => {
  it.each(['question', 'reply'] as const)(
    'the person’s next turn supersedes the %s gate `answered` and nulls the marker',
    T,
    async (cause) => {
      const sessionId = await openSession();
      if (cause === 'question') {
        await plannerSpeaks(sessionId, 'job-q', 'Hmm —', 'Which?');
      } else {
        await plannerReplyQuietFor(sessionId, AWAITING_REPLY_AFTER_MS + 5 * MIN);
        await planningSessionGateService.raiseAwaitingReplies();
      }
      expect(await awaitingGates(sessionId)).toHaveLength(1);

      await planChangeSessionsService.appendTurn('The platform team.', me(), { sessionId });

      const s = await sessionRow(sessionId);
      expect(s.awaitingPersonSince).toBeNull();
      expect(s.awaitingPersonCause).toBeNull();
      const gates = await gatesOf(sessionId);
      expect(gates.map((g) => [g.state, g.supersededCause])).toEqual([['superseded', 'answered']]);
    },
  );

  it.each(['restarted', 'declined', 'approved', 'idle', 'failed'] as const)(
    'ending the session as %s supersedes its awaiting gate `session_ended`',
    T,
    async (reason: PlanSessionEndReason) => {
      const sessionId = await openSession();
      await plannerSpeaks(sessionId, 'job-q', 'Hmm —', 'Which?');

      await planSessionEndService.endSession(sessionId, reason, {
        workspaceId: fx.workspaceId,
        endedById: reason === 'restarted' || reason === 'declined' ? fx.ownerId : null,
        actorId: fx.ownerId,
      });

      const s = await sessionRow(sessionId);
      expect(s.endedAt).not.toBeNull();
      expect(s.awaitingPersonSince).toBeNull();
      expect((await gatesOf(sessionId)).map((g) => [g.state, g.supersededCause])).toEqual([
        ['superseded', 'session_ended'],
      ]);
    },
  );
});

describe('Waiting on you — the routing read and its count', () => {
  async function secondMember() {
    const user = await createTestUser({ name: 'Rival' });
    await adminDb.workspaceMembership.create({
      data: { userId: user.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
    });
    return user.id;
  }

  it(
    'lists the awaiting session for its owner with its summary, and for nobody else',
    T,
    async () => {
      const sessionId = await openSession();
      await plannerSpeaks(sessionId, 'job-q', 'Before I split it —', 'Which team owns this?');
      const rival = await secondMember();

      const mine = await approvalGatesService.listAwaitingMe(actor());
      const theirs = await approvalGatesService.listAwaitingMe(actor(rival));

      const row = mine.items.find((i) => i.kind === 'planning_session');
      expect(row?.subject).toMatchObject({
        kind: 'planning_session',
        sessionId,
        cause: 'question',
        question: 'Which team owns this?',
        plannerLine: null,
      });
      expect(theirs.items.some((i) => i.kind === 'planning_session')).toBe(false);
      expect(await approvalGatesService.countAwaitingMe(actor())).toBe(mine.total);
      expect(await approvalGatesService.countAwaitingMe(actor(rival))).toBe(theirs.total);
      expect(mine.total).toBe(1);
      expect(theirs.total).toBe(0);
    },
  );

  it.each([
    [
      'fails (moves to To resume)',
      async (id: string) =>
        adminDb.planChangeSession.update({
          where: { id },
          data: {
            awaitingPersonSince: null,
            awaitingPersonCause: null,
            failedAt: new Date(),
            failedJobId: 'j',
            failureReason: 'internal',
          },
        }),
    ],
    [
      'ends through a raw write that bypasses the clear',
      async (id: string) =>
        adminDb.planChangeSession.update({
          where: { id },
          data: {
            awaitingPersonSince: null,
            awaitingPersonCause: null,
            endedAt: new Date(),
            endReason: 'restarted',
          },
        }),
    ],
  ])('a stale gate row is invisible once the session %s', T, async (_name, strand) => {
    const sessionId = await openSession();
    await plannerSpeaks(sessionId, 'job-q', 'Hmm —', 'Which?');
    expect((await approvalGatesService.listAwaitingMe(actor())).total).toBe(1);

    await strand(sessionId);

    expect((await awaitingGates(sessionId)).length).toBe(1); // the row still says awaiting…
    const after = await approvalGatesService.listAwaitingMe(actor());
    expect(after.items.some((i) => i.kind === 'planning_session')).toBe(false); // …and no read shows it
    expect(after.total).toBe(0);
    expect(await approvalGatesService.countAwaitingMe(actor())).toBe(0);
  });
});

describe('the gate has no verbs', () => {
  it.each(['approve', 'request_changes', 'decline'] as const)(
    '%s is refused through the decide door and the gate stays awaiting',
    T,
    async (decision) => {
      const sessionId = await openSession();
      await plannerSpeaks(sessionId, 'job-q', 'Hmm —', 'Which?');
      const [gate] = await awaitingGates(sessionId);

      const err = await approvalGatesService
        .decide(
          {
            gateId: gate!.id,
            decision,
            source: 'ui',
            noteMd: 'because',
            stamp: DECIDED_WITHOUT_A_READER,
          },
          fx.ctx,
        )
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ApprovalGateVerbNotOfferedError);
      expect((await awaitingGates(sessionId)).map((g) => g.id)).toEqual([gate!.id]);
    },
  );
});

describe('real concurrency — a turn racing the sweep’s raise', () => {
  it(
    'never marks without a gate, never gates without a marker, never throws, 15 times',
    { timeout: 300_000 },
    async () => {
      for (let i = 0; i < 15; i++) {
        await truncateAuthTables();
        fx = await makeWorkItemFixture();
        const sessionId = await openSession();
        await plannerReplyQuietFor(sessionId, AWAITING_REPLY_AFTER_MS + 5 * MIN);

        const results = await Promise.allSettled([
          planChangeSessionsService.appendTurn('I am back.', me(), { sessionId }),
          planningSessionGateService.raiseAwaitingReplies(),
        ]);

        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
        const s = await sessionRow(sessionId);
        const awaiting = await awaitingGates(sessionId);
        if (s.awaitingPersonSince !== null) {
          // The raise won the race: marked, with exactly one awaiting gate.
          expect(awaiting).toHaveLength(1);
        } else {
          // The turn won (or cleared after): unmarked, with none awaiting.
          expect(awaiting).toHaveLength(0);
        }
      }
    },
  );
});
