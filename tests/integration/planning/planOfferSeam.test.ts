import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { PlanChangeTurnDto } from '@/lib/dto/planChange';
import { pendingPlanOfferOf, planOfferStateOf } from '@/lib/planChange/planOffer';
import { buildScope } from '@/lib/planChange/scope';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';

// THE PLAN OFFER AS ONE SEAM (Story MOTIR-9219 · MOTIR-9295), on REAL Postgres. The
// offer stored on its answer, stated into the next turn, confirmed, and started —
// exactly once per offer, whichever door reaches it. Each card's own suite proves its
// half; this one proves the halves resolve ONE record: the turn settle wrote is the
// turn the read returns, the confirm is the plan the datastore holds, and a second door
// counts zero at the boundary AND zero in the tables.
//
// Mocked: only the motir-ai boundary (`submitJob` captured, `getJob` from a map). No
// cookie-only resolver is reached — every door below is called as a service with its
// ProjectContext — so none is mocked. Every plan, session and turn is the real row.
//
// ── THE STORY'S CRITERIA, WALKED ──────────────────────────────────────────────────
//   An answer may end with ONE offer to plan, stored on its turn ......... § the offer, stored
//   The offer reads back in one of four states, only `undecided` pending  § the four states
//   A later answer retires an older offer; it can no longer start ........ § the four states
//   The pending offer is stated into the next turn's job ................. § the next turn's context
//   An offer alone plans nothing ......................................... § the offer, stored
//   Confirm starts exactly one plan; two doors still start one .......... § exactly once
//   A typed yes starts the same plan as Confirm, never a second one ...... § exactly once
//   "Plan this" on a target the caller can browse starts at once ......... § the targeted start
//   Asking to plan something else mid-planning restarts, once ............ § mid-planning
//   Declining keeps talking and stores the decline ....................... planOfferRefusals.test.ts
//   Every refusal and cannot-start reason, and the isolation arms ........ planOfferRefusals.test.ts
//   Whether a turn ends with an offer / a reply agrees (the model) ....... motir-ai MOTIR-9296
//   The Confirm / Decline row, its states and copy ....................... MOTIR-9294 (rail), copy card
//   The browser walk, en/zh, the acceptance video ......................... MOTIR-9297 (story E2E)

const submitJobMock = vi.fn();
const jobs = new Map<string, unknown>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: async (jobId: string) =>
    jobs.get(jobId) ?? { jobId, status: 'running', result: null, error: null },
  streamJob: vi.fn(),
}));

const { aiAskService } = await import('@/lib/services/aiAskService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { planOfferService } = await import('@/lib/services/planOfferService');
const { planOfferStartService } = await import('@/lib/services/planOfferStartService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { PlanOfferStartRefusedError } = await import('@/lib/planChange/errors');

const T = { timeout: 120_000 };
const REQUEST = 'Plan custom fields in the CSV export.';

let fx: WorkItemFixture;
let jobSeq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  jobs.clear();
  jobSeq = 0;
  submitJobMock.mockReset();
  submitJobMock.mockImplementation(async () => ({ jobId: `job-${++jobSeq}` }));
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'token');
  fx = await makeWorkItemFixture();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await truncateJobRuns();
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

async function task(title = 'CSV export') {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);
}

/** Type `body`, settle its job with `ask`, and return what settle answered. */
async function turn(
  ask: Record<string, unknown>,
  sessionId?: string,
  body = 'Can we export custom fields?',
) {
  const submitted = await aiAskService.submitTurn(body, me(), sessionId ? { sessionId } : {});
  if (!('jobId' in submitted) || !submitted.jobId) throw new Error('not an ask');
  const jobId = submitted.jobId;
  jobs.set(jobId, { jobId, status: 'succeeded', result: { ask }, error: null });
  const settled = await aiAskService.settle(jobId, me(), { sessionId: submitted.session.id });
  return { jobId, sessionId: submitted.session.id, settled };
}

const answerWith = (extra: Record<string, unknown> = {}) => ({
  intent: 'ask',
  answer: 'Here is how the export works.',
  citations: [],
  ...extra,
});
const planOffer = (targetKey?: string, extra: Record<string, unknown> = {}) => ({
  kind: 'plan',
  requestText: REQUEST,
  ...(targetKey ? { targetKey } : {}),
  immediate: false,
  ...extra,
});

function lastAnswer(turns: readonly PlanChangeTurnDto[]): PlanChangeTurnDto {
  return turns.filter((t) => t.role === 'assistant').at(-1)!;
}

/** An answered turn carrying an offer: the conversation, the offer's turn and its job. */
async function offered(targetKey?: string, sessionId?: string) {
  const {
    jobId,
    sessionId: conversationId,
    settled,
  } = await turn(answerWith({ offer: planOffer(targetKey) }), sessionId);
  const answer = lastAnswer(settled.session.turns);
  return { jobId, conversationId, offerTurnId: answer.id, offerSeq: answer.seq };
}

async function threadOf(sessionId: string) {
  return (await planChangeSessionsService.getById(me(), sessionId)).turns;
}

async function rawOffer(turnId: string) {
  const row = await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: turnId } });
  return row.answerOffer as Record<string, unknown> | null;
}

/** Plan-edit submissions counted at the boundary — every submit that is not an ask. */
function planSubmits(): number {
  return submitJobMock.mock.calls.filter((c) => c[0] !== 'ask_project').length;
}

/** The context the LAST ask submit sent to motir-ai. */
function lastAskContext(): Record<string, unknown> {
  const call = submitJobMock.mock.calls.filter((c) => c[0] === 'ask_project').at(-1)!;
  return call[2] as Record<string, unknown>;
}

describe('the offer, stored', () => {
  it('lands on the answer turn and reads back on the SAME turn id settle returned', T, async () => {
    const target = await task();
    const { sessionId: conversationId, settled } = await turn(
      answerWith({ offer: planOffer(target.identifier) }),
    );
    const offerTurnId = lastAnswer(settled.session.turns).id;
    expect(settled.outcome).toBe('answered');

    const row = await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: offerTurnId } });
    expect(row.role).toBe('assistant');
    expect(row.answerOffer).toMatchObject({
      kind: 'plan',
      requestMd: REQUEST,
      targetKey: target.identifier,
    });
    // One record: the assistant turns are exactly the one settle wrote.
    expect(
      await adminDb.planChangeTurn.count({
        where: { sessionId: conversationId, role: 'assistant' },
      }),
    ).toBe(1);
    const read = (await threadOf(conversationId)).find((t) => t.id === offerTurnId)!;
    expect(read.offer).toMatchObject({
      requestMd: REQUEST,
      targetKey: target.identifier,
      state: 'undecided',
      cannotStart: null,
    });
  });

  it(
    'an answer with no offer stores none, and reads exactly as an answer did before',
    T,
    async () => {
      const { sessionId, settled } = await turn(answerWith());
      const answer = lastAnswer(settled.session.turns);
      expect(
        (await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: answer.id } })).answerOffer,
      ).toBeNull();
      const turns = await threadOf(sessionId);
      expect(turns.map((t) => [t.role, t.offer])).toEqual([
        ['user', null],
        ['assistant', null],
      ]);
      expect(lastAnswer(turns).body).toBe('Here is how the export works.');
    },
  );

  it(
    'an offer alone plans nothing: zero planner submissions at settle, no plan row',
    T,
    async () => {
      const target = await task();
      // No `plan_change` intent anywhere in the result — the offer is the only signal.
      const { settled } = await turn(answerWith({ offer: planOffer(target.identifier) }));
      expect(settled.outcome).toBe('answered');
      expect(planSubmits()).toBe(0);
      expect(submitJobMock.mock.calls.map((c) => c[0])).toEqual(['ask_project']);
      expect(await adminDb.plan.count()).toBe(0);
    },
  );
});

describe('the four states', () => {
  it('undecided: derived, no write, and the only state pendingPlanOfferOf answers', T, async () => {
    const { conversationId, offerTurnId } = await offered();
    const turns = await threadOf(conversationId);
    expect(planOfferStateOf(turns, offerTurnId)).toBe('undecided');
    expect(turns.find((t) => t.id === offerTurnId)!.offer?.state).toBe('undecided');
    expect(pendingPlanOfferOf(turns)?.turnId).toBe(offerTurnId);
    const stored = (await rawOffer(offerTurnId))!;
    expect([stored['declinedAt'], stored['confirmedAt'], stored['confirmedSessionId']]).toEqual([
      null,
      null,
      null,
    ]);
  });

  it(
    'superseded: a newer answer retires the older offer with NO write, and its confirm starts nothing',
    T,
    async () => {
      const older = await offered();
      const storedBefore = await rawOffer(older.offerTurnId);
      await turn(answerWith(), older.conversationId, 'And what about imports?');

      const turns = await threadOf(older.conversationId);
      expect(planOfferStateOf(turns, older.offerTurnId)).toBe('superseded');
      expect(turns.find((t) => t.id === older.offerTurnId)!.offer?.state).toBe('superseded');
      expect(pendingPlanOfferOf(turns)).toBeNull();
      expect(await rawOffer(older.offerTurnId)).toEqual(storedBefore);

      const err = await planOfferStartService
        .confirmPlanOffer(me(), {
          conversationId: older.conversationId,
          offerTurnId: older.offerTurnId,
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PlanOfferStartRefusedError);
      expect(planSubmits()).toBe(0);
      expect(await adminDb.plan.count()).toBe(0);
    },
  );

  it('declined: stored through the offer write, read back, and no longer pending', T, async () => {
    const { conversationId, offerTurnId } = await offered();
    await planOfferService.declinePlanOffer(offerTurnId, me(), { sessionId: conversationId });
    expect((await rawOffer(offerTurnId))!['declinedAt']).toEqual(expect.any(String));
    const turns = await threadOf(conversationId);
    expect(turns.find((t) => t.id === offerTurnId)!.offer?.state).toBe('declined');
    expect(pendingPlanOfferOf(turns)).toBeNull();
  });

  it('confirmed: stored through the offer write, read back, and no longer pending', T, async () => {
    const { conversationId, offerTurnId } = await offered();
    const started = await planOfferStartService.confirmPlanOffer(me(), {
      conversationId,
      offerTurnId,
    });
    expect((await rawOffer(offerTurnId))!['confirmedSessionId']).toBe(started.sessionId);
    const turns = await threadOf(conversationId);
    expect(turns.find((t) => t.id === offerTurnId)!.offer?.state).toBe('confirmed');
    expect(pendingPlanOfferOf(turns)).toBeNull();
  });
});

describe('the next turn’s context', () => {
  it('carries the pending offer’s request text, read from the captured submit', T, async () => {
    const target = await task();
    const { conversationId, offerSeq } = await offered(target.identifier);
    await turn(answerWith(), conversationId, 'Tell me more.');
    expect(lastAskContext()['pendingPlanOffer']).toEqual({
      kind: 'plan',
      requestText: REQUEST,
      targetKey: target.identifier,
      seq: offerSeq,
    });
  });

  it(
    'carries no pending offer when none is stored, it was declined, or it was superseded',
    T,
    async () => {
      // None stored.
      const plain = await turn(answerWith());
      await turn(answerWith(), plain.sessionId, 'Next.');
      expect('pendingPlanOffer' in lastAskContext()).toBe(false);

      // Declined.
      const d = await offered(undefined, plain.sessionId);
      await planOfferService.declinePlanOffer(d.offerTurnId, me(), { sessionId: d.conversationId });
      await turn(answerWith(), d.conversationId, 'Never mind.');
      expect('pendingPlanOffer' in lastAskContext()).toBe(false);

      // Superseded: the answer after the offer carried none, so the turn after THAT
      // states nothing.
      const s = await offered(undefined, plain.sessionId);
      await turn(answerWith(), s.conversationId, 'Hmm.');
      expect(lastAskContext()['pendingPlanOffer']).toMatchObject({ seq: s.offerSeq });
      await turn(answerWith(), s.conversationId, 'Something else.');
      expect('pendingPlanOffer' in lastAskContext()).toBe(false);
    },
  );
});

describe('exactly once', () => {
  it(
    'Confirm on a targeted offer starts ONE planning run, and the session names its plan',
    T,
    async () => {
      const target = await task();
      const { conversationId, offerTurnId } = await offered(target.identifier);
      const started = await planOfferStartService.confirmPlanOffer(me(), {
        conversationId,
        offerTurnId,
      });

      expect(planSubmits()).toBe(1);
      const plans = await adminDb.plan.findMany();
      expect(plans).toHaveLength(1);
      expect(plans[0]!.id).toBe(started.planId);
      expect(plans[0]!.sessionId).toBe(started.sessionId);
      const session = await adminDb.planChangeSession.findUniqueOrThrow({
        where: { id: started.sessionId },
      });
      expect(session.lastJobId).toBe(started.jobId);
      expect(session.targetKeys).toEqual([target.identifier]);
    },
  );

  it(
    'two confirms in one tick: one submission, one plan, one session, one request turn',
    T,
    async () => {
      const target = await task();
      const { conversationId, offerTurnId } = await offered(target.identifier);
      const sessionsBefore = await adminDb.planChangeSession.count();

      const [a, b] = await Promise.all([
        planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId }),
        planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId }),
      ]);

      expect(b.planId).toBe(a.planId);
      expect(b.sessionId).toBe(a.sessionId);
      expect(planSubmits()).toBe(1);
      expect(await adminDb.plan.count()).toBe(1);
      expect(await adminDb.planChangeSession.count()).toBe(sessionsBefore + 1);
      expect(
        await adminDb.planChangeTurn.count({
          where: { sessionId: a.sessionId, role: 'user', body: REQUEST },
        }),
      ).toBe(1);
    },
  );

  it('Confirm plus a typed yes for one offer: one submission and one plan', T, async () => {
    const { conversationId, offerTurnId, offerSeq } = await offered();
    // The typed yes is submitted; its settle races the Confirm press.
    const yes = await aiAskService.submitTurn('Yes, go ahead.', me(), {
      sessionId: conversationId,
    });
    if (!('jobId' in yes) || !yes.jobId) throw new Error('not an ask');
    const yesJob = yes.jobId;
    jobs.set(yesJob, {
      jobId: yesJob,
      status: 'succeeded',
      result: {
        ask: answerWith({
          answer: 'Starting the plan.',
          offerReply: { seq: offerSeq, kind: 'plan', decision: 'agree' },
        }),
      },
      error: null,
    });

    const [pressed] = await Promise.all([
      planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId }),
      aiAskService.settle(yesJob, me(), { sessionId: conversationId }),
    ]);

    expect(planSubmits()).toBe(1);
    const plans = await adminDb.plan.findMany();
    expect(plans).toHaveLength(1);
    expect(plans[0]!.id).toBe(pressed.planId);
    expect(
      await adminDb.planChangeTurn.count({ where: { sessionId: conversationId, role: 'system' } }),
    ).toBe(1);
    expect(
      await adminDb.planChangeTurn.count({
        where: { sessionId: conversationId, role: 'user', body: REQUEST },
      }),
    ).toBe(1);
    expect((await rawOffer(offerTurnId))!['confirmedSessionId']).toBe(conversationId);
  });

  it(
    'a settle replayed after the confirm writes no second answer and no second submission',
    T,
    async () => {
      const { jobId, conversationId, offerTurnId } = await offered();
      await planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId });
      const answersBefore = await adminDb.planChangeTurn.count({
        where: { sessionId: conversationId, role: 'assistant' },
      });

      await aiAskService.settle(jobId, me(), { sessionId: conversationId });

      expect(
        await adminDb.planChangeTurn.count({
          where: { sessionId: conversationId, role: 'assistant' },
        }),
      ).toBe(answersBefore);
      expect(planSubmits()).toBe(1);
      expect(await adminDb.plan.count()).toBe(1);
      expect((await threadOf(conversationId)).find((t) => t.id === offerTurnId)!.offer?.state).toBe(
        'confirmed',
      );
    },
  );
});

describe('the targeted start', () => {
  it(
    '"plan this" on a browsable target starts once at settle, carrying the target, and stores no offer',
    T,
    async () => {
      const target = await task();
      const { sessionId, settled } = await turn(
        answerWith({ offer: planOffer(target.identifier, { immediate: true }) }),
        undefined,
        'Plan this card.',
      );

      expect(settled.outcome).toBe('redirected');
      expect(planSubmits()).toBe(1);
      const planCall = submitJobMock.mock.calls.find((c) => c[0] !== 'ask_project')!;
      expect(planCall[2]).toMatchObject({ targetKeys: [target.identifier] });
      expect(await adminDb.plan.count()).toBe(1);
      const stored = await adminDb.planChangeTurn.findMany({
        where: { sessionId, role: 'assistant' },
      });
      expect(stored.every((t) => t.answerOffer === null)).toBe(true);
    },
  );
});

describe('a door that finds the offer already claimed', () => {
  /** Write the offer's claim as another door's start would hold it. */
  async function claimedElsewhere(offerTurnId: string, extra: Record<string, unknown> = {}) {
    const raw = (await rawOffer(offerTurnId))!;
    await adminDb.planChangeTurn.update({
      where: { id: offerTurnId },
      data: {
        answerOffer: {
          ...raw,
          confirmedAt: new Date().toISOString(),
          confirmedById: fx.ownerId,
          ...extra,
        },
      },
    });
    return raw;
  }

  it('waits, and starts ONE plan itself when the other door gives its claim back', T, async () => {
    const { conversationId, offerTurnId } = await offered();
    const raw = await claimedElsewhere(offerTurnId);
    const giveBack = new Promise((resolve) => setTimeout(resolve, 500)).then(() =>
      adminDb.planChangeTurn.update({
        where: { id: offerTurnId },
        data: { answerOffer: raw as Prisma.InputJsonObject },
      }),
    );

    const [started] = await Promise.all([
      planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId }),
      giveBack,
    ]);

    expect(planSubmits()).toBe(1);
    expect((await adminDb.plan.findMany()).map((p) => p.id)).toEqual([started.planId]);
    expect((await rawOffer(offerTurnId))!['confirmedSessionId']).toBe(conversationId);
  });

  it(
    'a claim whose stamp never becomes readable refuses after the bounded wait, starting nothing',
    T,
    async () => {
      const { conversationId, offerTurnId } = await offered();
      // A stamp naming a session but no readable job reads as still in flight.
      await claimedElsewhere(offerTurnId, { confirmedSessionId: conversationId, start: {} });
      const realNow = Date.now.bind(Date);
      let reads = 0;
      // Each read of the clock lands 31s after the last, so the wait expires on its
      // first check instead of after thirty real seconds.
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + reads++ * 31_000);
      try {
        const err = await planOfferStartService
          .confirmPlanOffer(me(), { conversationId, offerTurnId })
          .catch((e: unknown) => e);
        expect((err as InstanceType<typeof PlanOfferStartRefusedError>).reason).toBe(
          'offer_not_open',
        );
      } finally {
        clock.mockRestore();
      }
      expect(planSubmits()).toBe(0);
      expect(await adminDb.plan.count()).toBe(0);
    },
  );
});

describe('a start that throws gives its claim back', () => {
  it('the targeted door releases the turn, and the retry starts ONE plan', T, async () => {
    const target = await task();
    const { jobId, sessionId } = await turn(answerWith(), undefined, 'Plan this card.');
    const input = { conversationId: sessionId, askJobId: jobId, anchorKey: target.identifier };
    submitJobMock.mockImplementationOnce(async () => {
      throw new Error('motir-ai is down');
    });

    await expect(planOfferStartService.startTargetedPlan(me(), input)).rejects.toThrow(
      'motir-ai is down',
    );
    const asked = await adminDb.planChangeTurn.findFirstOrThrow({
      where: { sessionId, jobId, role: 'user' },
    });
    expect(asked.planStartClaimedAt).toBeNull();
    expect(await adminDb.plan.count()).toBe(0);

    const started = await planOfferStartService.startTargetedPlan(me(), input);
    expect(started?.session.targetKeys).toEqual([target.identifier]);
    expect(await planOfferStartService.startTargetedPlan(me(), input)).toBeNull();
    expect(await adminDb.plan.count()).toBe(1);
    // One refused attempt at the boundary, then the one start.
    expect(planSubmits()).toBe(2);
  });
});

describe('mid-planning', () => {
  /** An offer on a conversation that then started a plan of its own, still running. */
  async function planningConversation() {
    const o = await offered();
    const running = await planChangeSessionsService.submit(me(), { sessionId: o.conversationId });
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: running.planId } })).status).toBe(
      'generating',
    );
    return { ...o, runningPlanId: running.planId };
  }

  it(
    'a confirm restarts: one new session holds the new plan, the original ends restarted',
    T,
    async () => {
      const { conversationId, offerTurnId, runningPlanId } = await planningConversation();
      const before = planSubmits();
      const sessionsBefore = await adminDb.planChangeSession.count();

      const started = await planOfferStartService.confirmPlanOffer(me(), {
        conversationId,
        offerTurnId,
      });

      expect(started.sessionId).not.toBe(conversationId);
      expect(planSubmits()).toBe(before + 1);
      expect(await adminDb.planChangeSession.count()).toBe(sessionsBefore + 1);
      expect(
        await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: conversationId } }),
      ).toMatchObject({
        endReason: 'restarted',
      });
      // The new submission is on the successor; the original keeps only its own plan.
      expect(await adminDb.plan.findMany({ where: { sessionId: conversationId } })).toEqual([
        expect.objectContaining({ id: runningPlanId }),
      ]);
      const successorPlans = await adminDb.plan.findMany({
        where: { sessionId: started.sessionId },
      });
      expect(successorPlans.map((p) => p.id)).toEqual([started.planId]);
    },
  );

  it(
    'the same offer confirmed twice mid-planning: one new session and one submission',
    T,
    async () => {
      const { conversationId, offerTurnId } = await planningConversation();
      const before = planSubmits();
      const sessionsBefore = await adminDb.planChangeSession.count();

      const first = await planOfferStartService.confirmPlanOffer(me(), {
        conversationId,
        offerTurnId,
      });
      const turnsAfterFirst = await adminDb.planChangeTurn.count();
      const second = await planOfferStartService.confirmPlanOffer(me(), {
        conversationId,
        offerTurnId,
      });

      expect(second.sessionId).toBe(first.sessionId);
      expect(second.planId).toBe(first.planId);
      expect(planSubmits()).toBe(before + 1);
      expect(await adminDb.planChangeSession.count()).toBe(sessionsBefore + 1);
      expect(await adminDb.planChangeTurn.count()).toBe(turnsAfterFirst);
      expect(await adminDb.plan.count({ where: { sessionId: first.sessionId } })).toBe(1);

      // The restart door itself, addressed at the ended session, owns no start.
      const door = await planChangeSessionsService.restartForPlanOffer(
        me(),
        { sessionId: conversationId },
        { requestMd: REQUEST, scope: buildScope([]), offerRef: offerTurnId },
      );
      expect(door.ownsStart).toBe(false);
      expect(await adminDb.planChangeSession.count()).toBe(sessionsBefore + 1);
      expect(await adminDb.planChangeTurn.count()).toBe(turnsAfterFirst);
    },
  );
  it(
    'a restart whose start throws resumes on its successor: one request, one plan',
    T,
    async () => {
      const { conversationId, offerTurnId } = await planningConversation();
      const before = planSubmits();
      submitJobMock.mockImplementationOnce(async () => {
        throw new Error('motir-ai is down');
      });
      await expect(
        planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId }),
      ).rejects.toThrow('motir-ai is down');
      expect((await rawOffer(offerTurnId))!['confirmedAt']).toBeNull();
      expect(
        (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: conversationId } }))
          .endReason,
      ).toBe('restarted');
      const sessionsAfterRestart = await adminDb.planChangeSession.count();

      const started = await planOfferStartService.confirmPlanOffer(me(), {
        conversationId,
        offerTurnId,
      });

      expect(started.sessionId).not.toBe(conversationId);
      expect(await adminDb.planChangeSession.count()).toBe(sessionsAfterRestart);
      expect(await adminDb.plan.count({ where: { sessionId: started.sessionId } })).toBe(1);
      const requests = await adminDb.planChangeTurn.findMany({
        where: { sessionId: started.sessionId, role: 'user' },
      });
      expect(requests.map((t) => t.body)).toEqual([REQUEST]);
      expect(planSubmits()).toBe(before + 2);
      expect((await rawOffer(offerTurnId))!['confirmedSessionId']).toBe(started.sessionId);
    },
  );
});
