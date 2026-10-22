import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { ProjectDTO } from '@/lib/dto/projects';
import { MotirAiOutOfCreditsError } from '@/lib/ai/errors';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { createTestProject } from '../../fixtures/projectFixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';
import { setProjectAccess } from '../../helpers/projectAccess';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from '../../helpers/workspaceRoleFixtures';

// THE PLAN OFFER'S REFUSALS (Story MOTIR-9219 · MOTIR-9295), on REAL Postgres. Every
// arm asserts BOTH halves: the reason is observable on what core stored (the offer's
// served `cannotStart`, its disposition, the absence of an offer or a turn), and the
// planner submissions counted at the boundary are zero. Each permission arm runs on a
// fixture where two actors genuinely see different things — the project is
// Members-only and each person is seated by their own project role — so a read that
// returned everyone's view could not pass as a refusal.
//
// Mocked: only the motir-ai boundary (`submitJob` captured, `getJob` from a map). The
// doors are called as services with their ProjectContext, so no cookie-only resolver
// is reached and none is mocked.
//
// ── THE STORY'S CRITERIA, WALKED ──────────────────────────────────────────────────
//   Declining keeps talking; a later confirm of a declined offer starts nothing  § decline
//   An offer never names a target the caller cannot browse ................. § targets
//   No offer, no start, without ai:plan — or with ai:plan but no edit ....... § permissions
//   Out of credits: no answer on the turn; a refused start records the reason  § credits
//   A closed target, or one another person is planning, cannot start ...... § cannot start
//   Another member's offer, another project's session ...................... § isolation
//   The seam, exactly-once, the targeted start, mid-planning ............... planOfferSeam.test.ts
//   How the refusal reads on the rail, and its copy ......................... MOTIR-9294 (rail), copy card
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
const { planTargetLockService } = await import('@/lib/services/planTargetLockService');
const { contextualPlanningService } = await import('@/lib/services/contextualPlanningService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const {
  PlanChangeTurnNotFoundError,
  PlanOfferStartRefusedError,
  PlanSessionEndedError,
  PlanSessionNotFoundError,
  PlanTargetLockedError,
} = await import('@/lib/planChange/errors');

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
  await setProjectAccess(adminDb, fx.projectId, 'members');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function ctxOf(userId: string, project: ProjectDTO = fx.project): ProjectContext {
  return { userId, workspaceId: fx.workspaceId, projectId: project.id, project };
}
const owner = () => ctxOf(fx.ownerId);

async function task(title = 'CSV export') {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);
}

/** A workspace member seated in the fixture's project; `permissions` gives them a custom role. */
async function member(label: string, permissions?: string[]): Promise<ProjectContext> {
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
  if (permissions) await restrict(u.id, permissions);
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

/** Type `body`, settle its job with `ask`, and return what settle answered. */
async function turn(
  pctx: ProjectContext,
  ask: Record<string, unknown>,
  sessionId?: string,
  body = 'Can we export custom fields?',
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

async function offered(pctx: ProjectContext, targetKey?: string) {
  const { sessionId, settled } = await turn(pctx, answerWith({ offer: planOffer(targetKey) }));
  const answer = lastAnswer(settled.session.turns);
  expect(answer.offer?.state).toBe('undecided');
  return { conversationId: sessionId, offerTurnId: answer.id };
}

async function servedOffer(pctx: ProjectContext, sessionId: string, turnId: string) {
  const turns = (await planChangeSessionsService.getById(pctx, sessionId)).turns;
  return turns.find((t) => t.id === turnId)!.offer;
}

async function rawOffer(turnId: string) {
  const row = await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: turnId } });
  return row.answerOffer as Record<string, unknown> | null;
}

/** Plan-edit submissions counted at the boundary — every submit that is not an ask. */
function planSubmits(): number {
  return submitJobMock.mock.calls.filter((c) => c[0] !== 'ask_project').length;
}

async function refusalOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e,
  );
}

/** A second project in the workspace, Members-only, holding one card. */
async function otherProject() {
  const project = await createTestProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ownerId,
    name: 'Other',
    identifier: 'OTHR',
  });
  await setProjectAccess(adminDb, project.id, 'members');
  const card = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'Foreign' },
    fx.ctx,
  );
  return { project, card };
}

describe('decline', () => {
  it(
    'stores the decline, submits nothing, and a later confirm is refused with no submission',
    T,
    async () => {
      const { conversationId, offerTurnId } = await offered(owner());
      await planOfferService.declinePlanOffer(offerTurnId, owner(), { sessionId: conversationId });
      expect((await rawOffer(offerTurnId))!['declinedById']).toBe(fx.ownerId);
      expect(planSubmits()).toBe(0);

      const err = await refusalOf(
        planOfferStartService.confirmPlanOffer(owner(), { conversationId, offerTurnId }),
      );
      expect(err).toBeInstanceOf(PlanOfferStartRefusedError);
      expect(planSubmits()).toBe(0);
      expect(await adminDb.plan.count()).toBe(0);
      expect((await servedOffer(owner(), conversationId, offerTurnId))?.state).toBe('declined');
      expect((await rawOffer(offerTurnId))!['confirmedAt']).toBeNull();
    },
  );
});

describe('targets', () => {
  it('another project’s key, or an unknown one, never yields an offer naming it', T, async () => {
    const { card: foreign } = await otherProject();
    // The owner can browse OTHR; this member cannot — the scoped read is what differs.
    const m = await member('scoped');
    for (const key of [foreign.identifier, `${fx.project.identifier}-9999`]) {
      const { sessionId, settled } = await turn(m, answerWith({ offer: planOffer(key) }));
      expect(lastAnswer(settled.session.turns).body).toBe('Here is how the export works.');
      const stored = await adminDb.planChangeTurn.findMany({
        where: { sessionId, role: 'assistant' },
      });
      for (const row of stored) {
        expect((row.answerOffer as Record<string, unknown> | null)?.['targetKey'] ?? null).not.toBe(
          key,
        );
      }
    }
    expect(planSubmits()).toBe(0);
  });

  it(
    '"plan this" on a target the caller cannot browse starts nothing and offers nothing on it',
    T,
    async () => {
      const { card: foreign } = await otherProject();
      const m = await member('scoped');
      const { sessionId, settled } = await turn(
        m,
        answerWith({ offer: planOffer(foreign.identifier, { immediate: true }) }),
        undefined,
        'Plan this card.',
      );
      expect(settled.outcome).toBe('answered');
      expect(planSubmits()).toBe(0);
      expect(await adminDb.plan.count()).toBe(0);
      const stored = await adminDb.planChangeTurn.findMany({ where: { sessionId } });
      expect(
        stored.some(
          (t) =>
            (t.answerOffer as Record<string, unknown> | null)?.['targetKey'] === foreign.identifier,
        ),
      ).toBe(false);
    },
  );
});

describe('permissions', () => {
  it(
    'without ai:plan the turn is refused before any write; a member holding it gets the offer',
    T,
    async () => {
      const target = await task();
      const allowed = await member('planner');
      const denied = await member('no-plan', ['project:browse', 'work_item:edit']);
      const turnsBefore = await adminDb.planChangeTurn.count();

      await expect(
        aiAskService.submitTurn('Can we export custom fields?', denied),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      expect(await adminDb.planChangeTurn.count()).toBe(turnsBefore);
      expect(submitJobMock).not.toHaveBeenCalled();
      // `assertCanPlan` gates the plan start itself the same way.
      const theirs = await offered(allowed, target.identifier);
      await expect(
        planChangeSessionsService.submit(denied, { sessionId: theirs.conversationId }),
      ).rejects.toBeInstanceOf(PermissionDeniedError);

      // The same fixture, the other actor: the offer is stored.
      expect((await rawOffer(theirs.offerTurnId))!['targetKey']).toBe(target.identifier);
      expect(planSubmits()).toBe(0);
      expect(await adminDb.plan.count()).toBe(0);
    },
  );

  it('an offer whose person loses ai:plan cannot be started by them', T, async () => {
    const m = await member('loses-plan');
    const { conversationId, offerTurnId } = await offered(m);
    await restrict(m.userId, ['project:browse', 'work_item:edit']);
    await expect(
      planOfferStartService.confirmPlanOffer(m, { conversationId, offerTurnId }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(planSubmits()).toBe(0);
    expect((await rawOffer(offerTurnId))!['confirmedAt']).toBeNull();
  });

  it(
    'with ai:plan but no work_item:edit the answer lands with no offer and nothing starts',
    T,
    async () => {
      const target = await task();
      const m = await member('ask-only', ['project:browse', 'ai:plan']);
      for (const immediate of [false, true]) {
        const { sessionId, settled } = await turn(
          m,
          answerWith({ offer: planOffer(target.identifier, { immediate }) }),
        );
        const answer = lastAnswer(settled.session.turns);
        expect(answer.body).toBe('Here is how the export works.');
        expect(answer.offer).toBeNull();
        const rows = await adminDb.planChangeTurn.findMany({
          where: { sessionId, role: 'assistant' },
        });
        expect(rows.every((r) => r.answerOffer === null)).toBe(true);
      }
      expect(planSubmits()).toBe(0);
      expect(await adminDb.plan.count()).toBe(0);
    },
  );
});

describe('credits', () => {
  it('a turn that cannot run for credits lands no answer and no offer', T, async () => {
    submitJobMock.mockImplementationOnce(async () => {
      throw new MotirAiOutOfCreditsError('no credits left');
    });
    await expect(
      aiAskService.submitTurn('Can we export custom fields?', owner()),
    ).rejects.toBeInstanceOf(MotirAiOutOfCreditsError);
    expect(await adminDb.planChangeTurn.count({ where: { role: 'assistant' } })).toBe(0);
    const rows = await adminDb.planChangeTurn.findMany();
    expect(rows.every((r) => r.answerOffer === null && r.jobId === null)).toBe(true);
    expect(planSubmits()).toBe(0);
  });

  it(
    'a confirm refused for credits leaves no plan row and records out_of_credits on the offer',
    T,
    async () => {
      const { conversationId, offerTurnId } = await offered(owner());
      submitJobMock.mockImplementationOnce(async () => {
        throw new MotirAiOutOfCreditsError('no credits left');
      });
      await expect(
        planOfferStartService.confirmPlanOffer(owner(), { conversationId, offerTurnId }),
      ).rejects.toBeInstanceOf(MotirAiOutOfCreditsError);
      expect(await adminDb.plan.count()).toBe(0);
      const offer = await servedOffer(owner(), conversationId, offerTurnId);
      expect(offer?.state).toBe('undecided');
      expect(offer?.cannotStart).toBe('out_of_credits');
      expect((await rawOffer(offerTurnId))!['confirmedAt']).toBeNull();
      // The one attempt reached the boundary and was refused there; nothing else did.
      expect(planSubmits()).toBe(1);
    },
  );
});

describe('cannot start', () => {
  it('a target moved to done reads target_closed, and its confirm submits nothing', T, async () => {
    const target = await task();
    const { conversationId, offerTurnId } = await offered(owner(), target.identifier);
    await adminDb.workItem.update({ where: { id: target.id }, data: { status: 'done' } });

    const offer = await servedOffer(owner(), conversationId, offerTurnId);
    expect(offer?.cannotStart).toBe('target_closed');
    // Re-read, not resolved forward: the stored target is unchanged.
    expect(offer?.targetKey).toBe(target.identifier);
    const err = await refusalOf(
      planOfferStartService.confirmPlanOffer(owner(), { conversationId, offerTurnId }),
    );
    expect((err as InstanceType<typeof PlanOfferStartRefusedError>).reason).toBe('target_closed');
    expect(planSubmits()).toBe(0);
    expect(await adminDb.plan.count()).toBe(0);
  });

  it(
    'a target another person’s session holds reads target_held, and its confirm submits nothing',
    T,
    async () => {
      const target = await task();
      const holder = await member('holder');
      await contextualPlanningService.planFromWorkItem(
        { anchorId: target.id, prompt: 'Their plan.' },
        holder,
      );
      const theirSubmits = planSubmits();
      const plansBefore = await adminDb.plan.count();
      const { conversationId, offerTurnId } = await offered(owner(), target.identifier);

      // The hold is real and foreign: the shipped preflight read names it.
      const hold = await planTargetLockService.readForeignHoldForScope(
        [target.identifier],
        owner(),
      );
      expect(hold).toBeInstanceOf(PlanTargetLockedError);
      expect((await servedOffer(owner(), conversationId, offerTurnId))?.cannotStart).toBe(
        'target_held',
      );

      await expect(
        planOfferStartService.confirmPlanOffer(owner(), { conversationId, offerTurnId }),
      ).rejects.toBeInstanceOf(PlanTargetLockedError);
      expect(planSubmits()).toBe(theirSubmits);
      expect(await adminDb.plan.count()).toBe(plansBefore);
      expect((await rawOffer(offerTurnId))!['confirmedAt']).toBeNull();
    },
  );
});

describe('isolation', () => {
  it(
    'member B confirming member A’s offer is refused and changes nothing on A’s session',
    T,
    async () => {
      const a = await member('a');
      const b = await member('b');
      const { conversationId, offerTurnId } = await offered(a);
      const sessionBefore = await adminDb.planChangeSession.findUniqueOrThrow({
        where: { id: conversationId },
      });
      const turnsBefore = await adminDb.planChangeTurn.findMany({
        where: { sessionId: conversationId },
      });

      await expect(
        planOfferStartService.confirmPlanOffer(b, { conversationId, offerTurnId }),
      ).rejects.toBeInstanceOf(PlanChangeTurnNotFoundError);

      expect(
        await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: conversationId } }),
      ).toEqual(sessionBefore);
      expect(
        await adminDb.planChangeTurn.findMany({ where: { sessionId: conversationId } }),
      ).toEqual(turnsBefore);
      expect(planSubmits()).toBe(0);
      expect(await adminDb.plan.count()).toBe(0);
    },
  );

  it(
    'a session of another project addressed by id answers PlanSessionNotFoundError',
    T,
    async () => {
      const { project } = await otherProject();
      const { conversationId, offerTurnId } = await offered(owner());
      const elsewhere = ctxOf(fx.ownerId, project);

      await expect(
        planChangeSessionsService.submit(elsewhere, { sessionId: conversationId }),
      ).rejects.toBeInstanceOf(PlanSessionNotFoundError);
      await expect(
        planChangeSessionsService.getById(elsewhere, conversationId),
      ).rejects.toBeInstanceOf(PlanSessionNotFoundError);
      await expect(
        planOfferStartService.confirmPlanOffer(elsewhere, { conversationId, offerTurnId }),
      ).rejects.toBeInstanceOf(PlanChangeTurnNotFoundError);
      expect(planSubmits()).toBe(0);
      expect(await adminDb.plan.count()).toBe(0);
      expect((await rawOffer(offerTurnId))!['confirmedAt']).toBeNull();
    },
  );
  it(
    'the targeted door refuses an ended conversation and an ask job it never submitted',
    T,
    async () => {
      const target = await task();
      const { jobId, sessionId } = await turn(owner(), answerWith(), undefined, 'Plan this card.');
      const err = await refusalOf(
        planOfferStartService.startTargetedPlan(owner(), {
          conversationId: sessionId,
          askJobId: 'job-never',
          anchorKey: target.identifier,
        }),
      );
      expect(err).toBeInstanceOf(PlanChangeTurnNotFoundError);

      await adminDb.planChangeSession.update({
        where: { id: sessionId },
        data: { endedAt: new Date() },
      });
      await expect(
        planOfferStartService.startTargetedPlan(owner(), {
          conversationId: sessionId,
          askJobId: jobId,
          anchorKey: target.identifier,
        }),
      ).rejects.toBeInstanceOf(PlanSessionEndedError);
      expect(planSubmits()).toBe(0);
      expect(await adminDb.plan.count()).toBe(0);
    },
  );

  it('a conversation that does not exist answers the same 404 as another member’s', T, async () => {
    const { offerTurnId } = await offered(owner());
    await expect(
      planOfferStartService.confirmPlanOffer(owner(), { conversationId: 'missing', offerTurnId }),
    ).rejects.toBeInstanceOf(PlanChangeTurnNotFoundError);
    expect(planSubmits()).toBe(0);
  });
  it('an answer turn that carries no offer is not an offer to confirm', T, async () => {
    const { conversationId } = await offered(owner());
    const { settled } = await turn(owner(), answerWith(), conversationId, 'And imports?');
    const plain = lastAnswer(settled.session.turns);
    expect(plain.offer).toBeNull();
    await expect(
      planOfferStartService.confirmPlanOffer(owner(), { conversationId, offerTurnId: plain.id }),
    ).rejects.toBeInstanceOf(PlanChangeTurnNotFoundError);
    expect(planSubmits()).toBe(0);
  });

  it('a restart retry refuses once its successor has moved on, starting nothing', T, async () => {
    const { conversationId, offerTurnId } = await offered(owner());
    await planChangeSessionsService.submit(owner(), { sessionId: conversationId });
    submitJobMock.mockImplementationOnce(async () => {
      throw new Error('motir-ai is down');
    });
    await expect(
      planOfferStartService.confirmPlanOffer(owner(), { conversationId, offerTurnId }),
    ).rejects.toThrow('motir-ai is down');
    const successor = await adminDb.planChangeSession.findFirstOrThrow({
      where: { id: { not: conversationId }, endedAt: null },
    });
    // The person typed into the new conversation before pressing again.
    await planChangeSessionsService.appendTurn('Actually, plan the import first.', owner(), {
      sessionId: successor.id,
    });
    const before = planSubmits();

    await expect(
      planOfferStartService.confirmPlanOffer(owner(), { conversationId, offerTurnId }),
    ).rejects.toBeInstanceOf(PlanSessionEndedError);
    expect(planSubmits()).toBe(before);
    expect(await adminDb.plan.count({ where: { sessionId: successor.id } })).toBe(0);
    expect((await rawOffer(offerTurnId))!['confirmedAt']).toBeNull();
  });
});
