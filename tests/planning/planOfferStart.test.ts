import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { PlanChangeTurnDto } from '@/lib/dto/planChange';
import { readAskOutcome } from '@/lib/planning/askResult';
import { MotirAiOutOfCreditsError } from '@/lib/ai/errors';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from '../helpers/workspaceRoleFixtures';

// ONE START PER OFFER (Story MOTIR-9219 · MOTIR-9291), on REAL Postgres. The three
// doors — Confirm, a typed yes, and a targeted "plan this" turn — each start exactly one
// plan through the shipped submit. Mocked: only the motir-ai boundary (`submitJob` /
// `getJob`), so every plan row and turn below is the real one.

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
const { planOfferStartService } = await import('@/lib/services/planOfferStartService');
const { contextualPlanningService } = await import('@/lib/services/contextualPlanningService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const {
  PlanChangeTurnNotFoundError,
  PlanOfferStartRefusedError,
  PlanSessionEndedError,
  PlanTargetLockedError,
} = await import('@/lib/planChange/errors');

const T = { timeout: 120_000 };

let fx: WorkItemFixture;
let jobSeq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  jobs.clear();
  jobSeq = 0;
  submitJobMock.mockReset();
  submitJobMock.mockImplementation(async () => ({ jobId: `job-${++jobSeq}` }));
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'token');
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function ctxOf(userId: string): ProjectContext {
  return { userId, workspaceId: fx.workspaceId, projectId: fx.projectId, project: fx.project };
}
const owner = () => ctxOf(fx.ownerId);

async function task(title = 'CSV export') {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);
}

async function member(label: string): Promise<ProjectContext> {
  const u = await createTestUser({ name: `Member ${label}` });
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
  return ctxOf(u.id);
}

async function restrict(userId: string, permissions: string[]) {
  const role = await createCustomRoleAs({
    projectId: fx.projectId,
    ctx: fx.ctx,
    name: `Role ${userId}`,
    permissions,
  });
  await setProjectRoleAs({
    key: fx.project.identifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: userId,
    role: role.id,
  });
}

const REQUEST = 'Plan custom fields in the CSV export.';

/** Type `body`, settle its job with `ask`, and return the thread after the settle. */
async function turn(
  pctx: ProjectContext,
  body: string,
  ask: Record<string, unknown>,
  sessionId?: string,
) {
  const submitted = await aiAskService.submitTurn(body, pctx, sessionId ? { sessionId } : {});
  if (!('jobId' in submitted) || !submitted.jobId) throw new Error('not an ask');
  const jobId = submitted.jobId;
  jobs.set(jobId, { jobId, status: 'succeeded', result: { ask }, error: null });
  const settled = await aiAskService.settle(jobId, pctx, { sessionId: submitted.session.id });
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

/** An answered turn carrying an offer: the conversation and the offer's turn. */
async function offered(pctx: ProjectContext, targetKey?: string, sessionId?: string) {
  const { sessionId: conversationId, settled } = await turn(
    pctx,
    'Can we export custom fields?',
    answerWith({ offer: planOffer(targetKey) }),
    sessionId,
  );
  const offer = lastAnswer(settled.session.turns);
  expect(offer.offer?.state).toBe('undecided');
  return { conversationId, offerTurnId: offer.id, offerSeq: offer.seq };
}

async function rawOffer(turnId: string) {
  const row = await adminDb.planChangeTurn.findFirstOrThrow({ where: { id: turnId } });
  return row.answerOffer as Record<string, unknown>;
}

async function plansOf(sessionId: string) {
  return adminDb.plan.findMany({ where: { sessionId } });
}

async function turnsOf(sessionId: string) {
  return adminDb.planChangeTurn.findMany({ where: { sessionId }, orderBy: { seq: 'asc' } });
}

/** How many plan-edit jobs were submitted (every submit that is not an ask). */
function planSubmits(): number {
  return submitJobMock.mock.calls.filter((c) => c[0] !== 'ask_project').length;
}

describe('readAskOutcome — the typed reply', () => {
  const read = (offerReply: unknown) =>
    readAskOutcome({ ask: { intent: 'ask', answer: 'A.', citations: [], offerReply } });

  it('reads agree and decline verbatim', () => {
    expect(read({ seq: 3, kind: 'plan', decision: 'agree' })?.offerReply).toEqual({
      seq: 3,
      kind: 'plan',
      decision: 'agree',
    });
    expect(read({ seq: 0, kind: 'plan', decision: 'decline' })?.offerReply?.decision).toBe(
      'decline',
    );
  });

  it('reads anything else as NO reply, never as agreement', () => {
    for (const reply of [
      { kind: 'plan', decision: 'agree' },
      { seq: 1.5, kind: 'plan', decision: 'agree' },
      { seq: '1', kind: 'plan', decision: 'agree' },
      { seq: 1, kind: 'plan', decision: 'yes' },
      { seq: 1, kind: '', decision: 'agree' },
      'agree',
      undefined,
    ]) {
      const out = read(reply);
      expect(out?.answer).toBe('A.');
      expect(out && 'offerReply' in out).toBe(false);
    }
  });
});

describe('confirmPlanOffer — the Confirm door', () => {
  it(
    'with no target: appends the request once on its own conversation and submits there once',
    T,
    async () => {
      const { conversationId, offerTurnId } = await offered(owner());
      const before = planSubmits();
      const started = await planOfferStartService.confirmPlanOffer(owner(), {
        conversationId,
        offerTurnId,
      });
      expect(started.sessionId).toBe(conversationId);
      expect(planSubmits()).toBe(before + 1);
      const plans = await plansOf(conversationId);
      expect(plans).toHaveLength(1);
      expect(started.planId).toBe(plans[0]!.id);
      const turns = await turnsOf(conversationId);
      expect(turns.filter((t) => t.role === 'user' && t.body === REQUEST)).toHaveLength(1);
      expect(turns.filter((t) => t.role === 'system')).toHaveLength(1);
      const offer = await rawOffer(offerTurnId);
      expect(offer['confirmedSessionId']).toBe(conversationId);
      expect(offer['confirmedById']).toBe(fx.ownerId);
      const thread = await planChangeSessionsService.getById(owner(), conversationId);
      expect(thread.turns.find((t) => t.id === offerTurnId)?.offer?.state).toBe('confirmed');
    },
  );

  it('with a target: lands through the scoped door, on the session for that card', T, async () => {
    const target = await task();
    const { conversationId, offerTurnId } = await offered(owner(), target.identifier);
    const ownTurnsBefore = (await turnsOf(conversationId)).length;
    const started = await planOfferStartService.confirmPlanOffer(owner(), {
      conversationId,
      offerTurnId,
    });
    expect(started.sessionId).not.toBe(conversationId);
    expect(started.session.targetKeys).toEqual([target.identifier]);
    expect(await turnsOf(conversationId)).toHaveLength(ownTurnsBefore);
    const landed = await turnsOf(started.sessionId);
    expect(landed.filter((t) => t.role === 'user' && t.body === REQUEST)).toHaveLength(1);
    expect(await plansOf(started.sessionId)).toHaveLength(1);
    expect((await rawOffer(offerTurnId))['confirmedSessionId']).toBe(started.sessionId);
  });

  it('two doors at once start ONE plan, and the loser answers the same session', T, async () => {
    const { conversationId, offerTurnId } = await offered(owner());
    const before = planSubmits();
    const [a, b] = await Promise.all([
      planOfferStartService.confirmPlanOffer(owner(), { conversationId, offerTurnId }),
      planOfferStartService.confirmPlanOffer(owner(), { conversationId, offerTurnId }),
    ]);
    expect(a.sessionId).toBe(conversationId);
    expect(b.sessionId).toBe(conversationId);
    expect(b.jobId).toBe(a.jobId);
    expect(b.planId).toBe(a.planId);
    expect(planSubmits()).toBe(before + 1);
    expect(await plansOf(conversationId)).toHaveLength(1);
    const turns = await turnsOf(conversationId);
    expect(turns.filter((t) => t.role === 'system')).toHaveLength(1);
    expect(turns.filter((t) => t.role === 'user' && t.body === REQUEST)).toHaveLength(1);
    // A press after the start answers the same, again with no second run.
    const later = await planOfferStartService.confirmPlanOffer(owner(), {
      conversationId,
      offerTurnId,
    });
    expect(later.jobId).toBe(a.jobId);
    expect(planSubmits()).toBe(before + 1);
  });

  it('refuses target_not_available before any claim, leaving the offer pending', T, async () => {
    const target = await task();
    const { conversationId, offerTurnId } = await offered(owner(), target.identifier);
    await workItemsService.deleteWorkItem(target.id, fx.ctx);
    const turnsBefore = (await turnsOf(conversationId)).length;
    const before = planSubmits();
    const err = await planOfferStartService
      .confirmPlanOffer(owner(), { conversationId, offerTurnId })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanOfferStartRefusedError);
    expect((err as InstanceType<typeof PlanOfferStartRefusedError>).reason).toBe(
      'target_not_available',
    );
    expect(planSubmits()).toBe(before);
    expect(await turnsOf(conversationId)).toHaveLength(turnsBefore);
    expect((await rawOffer(offerTurnId))['confirmedAt']).toBeNull();
  });

  it(
    'a targeted turn refuses already_planning on a conversation that holds an undecided plan',
    T,
    async () => {
      // A confirmed OFFER there restarts instead (MOTIR-9293, planOfferRestart.test.ts).
      const target = await task();
      const { conversationId } = await offered(owner());
      await planChangeSessionsService.submit(owner(), { sessionId: conversationId });
      const askTurn = (await turnsOf(conversationId)).find((t) => t.role === 'user' && t.jobId)!;
      const turnsBefore = (await turnsOf(conversationId)).length;
      const before = planSubmits();
      const err = await planOfferStartService
        .startTargetedPlan(owner(), {
          conversationId,
          askJobId: askTurn.jobId!,
          anchorKey: target.identifier,
        })
        .catch((e: unknown) => e);
      expect((err as InstanceType<typeof PlanOfferStartRefusedError>).reason).toBe(
        'already_planning',
      );
      expect(planSubmits()).toBe(before);
      expect(await turnsOf(conversationId)).toHaveLength(turnsBefore);
      expect(await plansOf(conversationId)).toHaveLength(1);
    },
  );

  it(
    'refuses an ended conversation with PlanSessionEndedError, submitting nothing',
    T,
    async () => {
      const { conversationId, offerTurnId } = await offered(owner());
      await adminDb.planChangeSession.update({
        where: { id: conversationId },
        data: { endedAt: new Date() },
      });
      const before = planSubmits();
      await expect(
        planOfferStartService.confirmPlanOffer(owner(), { conversationId, offerTurnId }),
      ).rejects.toBeInstanceOf(PlanSessionEndedError);
      expect(planSubmits()).toBe(before);
      expect((await rawOffer(offerTurnId))['confirmedAt']).toBeNull();
    },
  );

  it('refuses a target another member holds, then starts once the hold frees', T, async () => {
    const target = await task();
    const other = await member('holder');
    await contextualPlanningService.planFromWorkItem(
      { anchorId: target.id, prompt: 'Their plan.' },
      other,
    );
    const { conversationId, offerTurnId } = await offered(owner(), target.identifier);
    await expect(
      planOfferStartService.confirmPlanOffer(owner(), { conversationId, offerTurnId }),
    ).rejects.toBeInstanceOf(PlanTargetLockedError);
    expect((await rawOffer(offerTurnId))['confirmedAt']).toBeNull();

    await adminDb.planTargetLock.deleteMany({});
    const started = await planOfferStartService.confirmPlanOffer(owner(), {
      conversationId,
      offerTurnId,
    });
    expect(await plansOf(started.sessionId)).toHaveLength(1);
  });

  it(
    'releases the claim when the submit throws, and a retry starts one plan with one request',
    T,
    async () => {
      for (const targeted of [false, true]) {
        const target = targeted ? await task(`Target ${jobSeq}`) : null;
        const { conversationId, offerTurnId } = await offered(owner(), target?.identifier);
        submitJobMock.mockImplementationOnce(async () => {
          throw new Error('motir-ai is down');
        });
        await expect(
          planOfferStartService.confirmPlanOffer(owner(), { conversationId, offerTurnId }),
        ).rejects.toThrow('motir-ai is down');
        expect((await rawOffer(offerTurnId))['confirmedAt']).toBeNull();

        const started = await planOfferStartService.confirmPlanOffer(owner(), {
          conversationId,
          offerTurnId,
        });
        expect(await plansOf(started.sessionId)).toHaveLength(1);
        const landed = await turnsOf(started.sessionId);
        expect(landed.filter((t) => t.role === 'user' && t.body === REQUEST)).toHaveLength(1);
        await adminDb.plan.updateMany({ data: { status: 'declined' } });
      }
    },
  );

  it('records out_of_credits on the offer when the submit is refused for credits', T, async () => {
    const { conversationId, offerTurnId } = await offered(owner());
    submitJobMock.mockImplementationOnce(async () => {
      throw new MotirAiOutOfCreditsError('no credits left');
    });
    await expect(
      planOfferStartService.confirmPlanOffer(owner(), { conversationId, offerTurnId }),
    ).rejects.toBeInstanceOf(MotirAiOutOfCreditsError);
    expect(await plansOf(conversationId)).toHaveLength(0);
    const thread = await planChangeSessionsService.getById(owner(), conversationId);
    const offer = thread.turns.find((t) => t.id === offerTurnId)?.offer;
    expect(offer?.state).toBe('undecided');
    expect(offer?.cannotStart).toBe('out_of_credits');
  });

  it('re-asserts ai:plan and work_item:edit at start time', T, async () => {
    const m = await member('revoked');
    const { conversationId, offerTurnId } = await offered(m);
    await restrict(m.userId, ['project:browse', 'ai:plan']);
    const before = planSubmits();
    await expect(
      planOfferStartService.confirmPlanOffer(m, { conversationId, offerTurnId }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(planSubmits()).toBe(before);
    expect((await rawOffer(offerTurnId))['confirmedAt']).toBeNull();
  });

  it('answers an absent, another member’s or a non-offer turn with the same 404', T, async () => {
    const { conversationId, offerTurnId } = await offered(owner());
    const m = await member('stranger');
    const theirs = await offered(m);
    for (const [pctx, input] of [
      [owner(), { conversationId, offerTurnId: 'missing' }],
      [owner(), { conversationId, offerTurnId: theirs.offerTurnId }],
      [m, { conversationId, offerTurnId }],
    ] as const) {
      await expect(planOfferStartService.confirmPlanOffer(pctx, input)).rejects.toBeInstanceOf(
        PlanChangeTurnNotFoundError,
      );
    }
  });
});

describe('settle — the typed reply and the targeted turn', () => {
  it('an agreeing reply naming the pending offer starts exactly one plan', T, async () => {
    const { conversationId, offerTurnId, offerSeq } = await offered(owner());
    const before = planSubmits();
    const { settled } = await turn(
      owner(),
      'Yes, go ahead.',
      answerWith({
        answer: 'Starting the plan.',
        offerReply: { seq: offerSeq, kind: 'plan', decision: 'agree' },
      }),
      conversationId,
    );
    expect(settled.outcome).toBe('redirected');
    expect(planSubmits()).toBe(before + 1);
    expect(await plansOf(conversationId)).toHaveLength(1);
    expect((await rawOffer(offerTurnId))['confirmedSessionId']).toBe(conversationId);
  });

  it('a reply naming another seq, or no reply at all, starts nothing', T, async () => {
    const { conversationId, offerTurnId, offerSeq } = await offered(owner());
    const before = planSubmits();
    const wrong = await turn(
      owner(),
      'Yes.',
      answerWith({ offerReply: { seq: offerSeq - 1, kind: 'plan', decision: 'agree' } }),
      conversationId,
    );
    expect(wrong.settled.outcome).toBe('answered');
    expect(planSubmits()).toBe(before);
    // The reply's own answer superseded the offer: it can no longer be confirmed.
    const thread = await planChangeSessionsService.getById(owner(), conversationId);
    expect(thread.turns.find((t) => t.id === offerTurnId)?.offer?.state).toBe('superseded');
    const err = await planOfferStartService
      .confirmPlanOffer(owner(), { conversationId, offerTurnId })
      .catch((e: unknown) => e);
    expect((err as InstanceType<typeof PlanOfferStartRefusedError>).reason).toBe('offer_not_open');
    expect(await plansOf(conversationId)).toHaveLength(0);
  });

  it('a declining reply leaves the offer declined and starts nothing', T, async () => {
    const { conversationId, offerTurnId, offerSeq } = await offered(owner());
    const before = planSubmits();
    const { settled } = await turn(
      owner(),
      'No, not now.',
      answerWith({ offerReply: { seq: offerSeq, kind: 'plan', decision: 'decline' } }),
      conversationId,
    );
    expect(settled.outcome).toBe('answered');
    expect(planSubmits()).toBe(before);
    expect((await rawOffer(offerTurnId))['declinedAt']).toEqual(expect.any(String));
  });

  it(
    'an immediate offer stores nothing and starts at once; a replay starts nothing more',
    T,
    async () => {
      const target = await task();
      const ask = answerWith({ offer: planOffer(target.identifier, { immediate: true }) });
      const before = planSubmits();
      const { jobId, sessionId, settled } = await turn(owner(), 'Plan this card.', ask);
      expect(settled.outcome).toBe('redirected');
      expect(planSubmits()).toBe(before + 1);
      if (settled.outcome !== 'redirected') throw new Error('not redirected');
      expect(settled.session.targetKeys).toEqual([target.identifier]);
      const userTurn = await adminDb.planChangeTurn.findFirstOrThrow({
        where: { sessionId, jobId, role: 'user' },
      });
      expect(userTurn.planStartClaimedAt).toBeInstanceOf(Date);
      const answer = lastAnswer(
        (await planChangeSessionsService.getById(owner(), sessionId)).turns,
      );
      expect(answer.offer).toBeNull();

      const replay = await aiAskService.settle(jobId, owner(), { sessionId });
      expect(replay.outcome).toBe('answered');
      expect(planSubmits()).toBe(before + 1);
    },
  );

  it('an immediate offer whose anchor does not resolve refuses and starts nothing', T, async () => {
    const before = planSubmits();
    const { sessionId } = await turn(
      owner(),
      'Plan this card.',
      answerWith({ offer: planOffer(`${fx.project.identifier}-9999`, { immediate: true }) }),
    );
    expect(planSubmits()).toBe(before);
    const err = await planOfferStartService
      .startTargetedPlan(owner(), {
        conversationId: sessionId,
        askJobId: 'job-1',
        anchorKey: `${fx.project.identifier}-9999`,
      })
      .catch((e: unknown) => e);
    expect((err as InstanceType<typeof PlanOfferStartRefusedError>).reason).toBe(
      'target_not_available',
    );
  });
});

describe('the confirm door over HTTP', () => {
  it('answers a start refusal 409 with its reason, and a missing offer turn 404', async () => {
    const { mapPlanChangeError } = await import('@/app/api/ai/plan-change/_errors');
    const refused = mapPlanChangeError(new PlanOfferStartRefusedError('already_planning'))!;
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: 'PLAN_OFFER_START_REFUSED',
      reason: 'already_planning',
    });
    const missing = mapPlanChangeError(new PlanChangeTurnNotFoundError('t1'))!;
    expect(missing.status).toBe(404);
  });
});
