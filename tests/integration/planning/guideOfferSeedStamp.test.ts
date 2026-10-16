import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope } from '@/lib/planChange/scope';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestWorkItem } from '../../fixtures/workItemFixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';

// A PLANNING SESSION REMEMBERS THE GUIDE OFFER THAT SEEDED IT (Story MOTIR-8684 ·
// MOTIR-8691; decision MOTIR-8685), on real Postgres: the guide-seeded first turn
// through `POST /api/work-items/{id}/ai/plan` with `seedGuideTurnId`, the stamp, the
// confirmation written beside it, the lookup Confirm returns to, and the races. A
// guide conversation is built directly (a session and its assistant turns), so this
// file holds the seam this card owns and none of the landing's.
//
// Stubs: the context resolvers a Vitest process cannot supply through cookies, and
// the motir-ai boundary client — exactly as the neighbouring seam tests do.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => session.current,
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: async () => activeCtx.current,
}));
vi.mock('next-intl/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl/server')>()),
  getLocale: async () => 'en',
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));

let jobSeq = 0;
const submitJobMock = vi.fn(async (..._args: unknown[]) => ({ jobId: `job-offer-${++jobSeq}` }));
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
const { POST: planRoute } = await import('@/app/api/work-items/[id]/ai/plan/route');
const { POST: declineRoute } = await import('@/app/api/ai/guide/offer/decline/route');
const { replanOfferStateOf } = await import('@/lib/planning/guideReplanOffer');
const { readGuideTurnRecord } = await import('@/lib/ai/guideWorkItem');

type Actor = { id: string; email: string; name: string };

let fx: WorkItemFixture;
let seq = 0;
let target: WorkItem;
let guided: WorkItem;

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockClear();
  fx = await makeWorkItemFixture();
  signIn({ id: fx.owner.id, email: fx.owner.email, name: fx.owner.name });
  target = await createTestWorkItem(fx, { kind: 'story', title: 'Sending' });
  guided = await createTestWorkItem(fx, {
    kind: 'task',
    title: 'Rotate the signing key',
    type: 'manual',
    executor: 'human',
    parentId: target.id,
  });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function signIn(actor: Actor) {
  session.current = { user: actor };
  activeCtx.current = {
    userId: actor.id,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  } as ProjectContext;
}

async function member(): Promise<Actor> {
  seq += 1;
  const user = await createTestUser({ name: `Member ${seq}` });
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
  });
  await addToProjectAs({
    key: fx.project.identifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: 'member',
  });
  return { id: user.id, email: user.email, name: user.name };
}

const OFFER = {
  reason: 'The story is wrong',
  requestMd: 'Re-plan the story: the provider is being retired.',
  requestedTargetKey: null as string | null,
  targetKey: null as string | null,
  targetResolution: 'as_asked',
  declinedAt: null,
  declinedById: null,
  confirmedAt: null,
  confirmedById: null,
  confirmedSessionId: null,
};

/** A guide conversation on `guided` for `userId`, holding one offer on its latest
 *  assistant turn. Returns the session id and that turn's id. */
async function guideOffer(userId = fx.ownerId, targetKey: string | null = target.identifier) {
  const guide = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: userId,
      scopeKey: buildScope([guided.identifier]).scopeKey,
      targetKeys: [guided.identifier],
      origin: 'guide',
      turnCount: 2,
    },
  });
  await adminDb.planChangeTurn.create({
    data: {
      workspaceId: fx.workspaceId,
      sessionId: guide.id,
      seq: 0,
      role: 'user',
      body: 'Guide me through this.',
      intent: 'guide',
    },
  });
  const turn = await adminDb.planChangeTurn.create({
    data: {
      workspaceId: fx.workspaceId,
      sessionId: guide.id,
      seq: 1,
      role: 'assistant',
      body: 'This work item is wrong.',
      guideTurn: {
        actions: [{ type: 'needs_replan', reason: OFFER.reason, requestMd: OFFER.requestMd }],
        outcomes: [{ outcome: 'landed' }],
        temporary: false,
        replanOffer: { ...OFFER, requestedTargetKey: targetKey, targetKey },
      },
    },
  });
  return { guideSessionId: guide.id, turnId: turn.id };
}

/** A LATER assistant turn holding an offer, so every earlier one is superseded. */
async function reviseOffer(guideSessionId: string, seqNo: number) {
  return adminDb.planChangeTurn.create({
    data: {
      workspaceId: fx.workspaceId,
      sessionId: guideSessionId,
      seq: seqNo,
      role: 'assistant',
      body: 'A revised offer.',
      guideTurn: {
        actions: [{ type: 'needs_replan', reason: 'r', requestMd: 'q' }],
        outcomes: [{ outcome: 'landed' }],
        temporary: false,
        replanOffer: { ...OFFER, targetKey: target.identifier, requestedTargetKey: null },
      },
    },
  });
}

async function confirm(
  card: WorkItem,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await planRoute(
    new Request(`http://localhost:3000/api/work-items/${card.id}/ai/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: OFFER.requestMd, targetKeys: [], ...body }),
    }),
    { params: Promise.resolve({ id: card.id }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function decline(sessionId: string, turnId: string) {
  const res = await declineRoute(
    new Request('http://localhost:3000/api/ai/guide/offer/decline', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, turnId }),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function counts() {
  return {
    sessions: await adminDb.planChangeSession.count(),
    turns: await adminDb.planChangeTurn.count(),
    submits: submitJobMock.mock.calls.length,
  };
}

async function storedOffer(turnId: string) {
  const row = await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: turnId } });
  return readGuideTurnRecord(row.guideTurn)?.replanOffer ?? null;
}

describe('Confirm — the guide-seeded first turn', () => {
  it('creates ONE stamped session, appends ONE user turn, submits ONE job, and marks the offer confirmed', async () => {
    const { turnId } = await guideOffer();
    const before = await counts();

    const res = await confirm(target, {
      targetKeys: [target.identifier],
      seedGuideTurnId: turnId,
    });
    expect(res.status).toBe(200);
    const planSessionId = res.json.sessionId as string;

    const after = await counts();
    expect(after.sessions).toBe(before.sessions + 1);
    expect(after.submits).toBe(before.submits + 1);

    const row = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: planSessionId } });
    expect(row).toMatchObject({
      origin: 'conversation',
      seedGuideTurnId: turnId,
      seedGateId: null,
    });
    const userTurns = await adminDb.planChangeTurn.findMany({
      where: { sessionId: planSessionId, role: 'user' },
    });
    expect(userTurns.map((t) => t.body)).toEqual([OFFER.requestMd]);

    const offer = await storedOffer(turnId);
    expect(offer).toMatchObject({ confirmedSessionId: planSessionId, confirmedById: fx.ownerId });
    expect(offer?.confirmedAt).toEqual(expect.any(String));

    // The new session HOLDS the target, as the gate-seeded start does.
    const locks = await adminDb.planTargetLock.findMany({
      where: { sessionId: planSessionId },
      include: { workItem: true },
    });
    expect(locks.map((l) => l.workItem.identifier)).toContain(target.identifier);
  });

  it('refuses a second Confirm with 409 GUIDE_REPLAN_OFFER_CONFIRMED naming the session, and writes nothing', async () => {
    const { turnId } = await guideOffer();
    const first = await confirm(target, {
      targetKeys: [target.identifier],
      seedGuideTurnId: turnId,
    });
    const before = await counts();

    const again = await confirm(target, {
      targetKeys: [target.identifier],
      seedGuideTurnId: turnId,
    });
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({
      code: 'GUIDE_REPLAN_OFFER_CONFIRMED',
      sessionId: first.json.sessionId,
    });
    expect(await counts()).toEqual(before);
  });

  it('two Confirms started together end with ONE session, ONE user turn and ONE job', async () => {
    const { turnId } = await guideOffer();
    const body = { targetKeys: [target.identifier], seedGuideTurnId: turnId };
    const [a, b] = await Promise.all([confirm(target, body), confirm(target, body)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.json.code).toBe('GUIDE_REPLAN_OFFER_CONFIRMED');
    expect(await adminDb.planChangeSession.count({ where: { seedGuideTurnId: turnId } })).toBe(1);
    expect(submitJobMock).toHaveBeenCalledTimes(1);
  });

  it('a Confirm and a Decline started together end in exactly one outcome', async () => {
    const { guideSessionId, turnId } = await guideOffer();
    const [c, d] = await Promise.all([
      confirm(target, { targetKeys: [target.identifier], seedGuideTurnId: turnId }),
      decline(guideSessionId, turnId),
    ]);
    const offer = await storedOffer(turnId);
    const planSessions = await adminDb.planChangeSession.count({
      where: { seedGuideTurnId: turnId },
    });
    if (c.status === 200) {
      expect(offer?.confirmedSessionId).toBeTruthy();
      expect(offer?.declinedAt).toBeNull();
      expect(d.status).toBe(409);
      expect(d.json.code).toBe('GUIDE_REPLAN_OFFER_NOT_OPEN');
      expect(planSessions).toBe(1);
    } else {
      expect(d.status).toBe(200);
      expect(offer?.declinedAt).toEqual(expect.any(String));
      expect(offer?.confirmedSessionId).toBeNull();
      expect(c.status).toBe(409);
      expect(c.json.code).toBe('GUIDE_REPLAN_OFFER_NOT_OPEN');
      expect(planSessions).toBe(0);
    }
  });

  it('lands the request ONCE in the caller’s own open conversation that already holds the target', async () => {
    const { turnId } = await guideOffer();
    // The member already has an open planning conversation holding the target.
    const opened = await planChangeSessionsService.startWithFirstTurn(
      activeCtx.current!,
      buildScope([target.identifier]),
      'Plan the sending story',
    );
    const before = await counts();

    const res = await confirm(target, { targetKeys: [target.identifier], seedGuideTurnId: turnId });
    expect(res.status).toBe(200);
    expect(res.json.sessionId).toBe(opened.id);
    const after = await counts();
    expect(after.sessions).toBe(before.sessions);
    expect(after.turns).toBe(before.turns + 2); // the user turn and the submit marker
    expect(
      (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: opened.id } }))
        .seedGuideTurnId,
    ).toBeNull();
    expect((await storedOffer(turnId))?.confirmedSessionId).toBe(opened.id);
  });

  it('refuses a superseded offer and a declined one with 409 GUIDE_REPLAN_OFFER_NOT_OPEN, writing nothing', async () => {
    const { guideSessionId, turnId } = await guideOffer();
    await reviseOffer(guideSessionId, 2);
    const before = await counts();
    const superseded = await confirm(target, {
      targetKeys: [target.identifier],
      seedGuideTurnId: turnId,
    });
    expect(superseded.status).toBe(409);
    expect(superseded.json.code).toBe('GUIDE_REPLAN_OFFER_NOT_OPEN');
    expect((await counts()).sessions).toBe(before.sessions);
    expect((await counts()).submits).toBe(before.submits);

    // A second guide conversation is a session of its own: count after it exists.
    const other = await guideOffer();
    expect((await decline(other.guideSessionId, other.turnId)).status).toBe(200);
    const beforeDeclined = await counts();
    const declined = await confirm(target, {
      targetKeys: [target.identifier],
      seedGuideTurnId: other.turnId,
    });
    expect(declined.status).toBe(409);
    expect(declined.json.code).toBe('GUIDE_REPLAN_OFFER_NOT_OPEN');
    expect((await counts()).sessions).toBe(beforeDeclined.sessions);
    expect((await counts()).submits).toBe(beforeDeclined.submits);
  });

  it('answers 422 SEED_NOT_APPLICABLE, alike, for every way the seed is not the caller’s to use', async () => {
    const { turnId } = await guideOffer();
    const noTarget = await guideOffer(fx.ownerId, null);
    const noOffer = await adminDb.planChangeTurn.findFirstOrThrow({
      where: { role: 'user', session: { origin: 'guide' } },
    });
    const planning = await planChangeSessionsService.startWithFirstTurn(
      activeCtx.current!,
      buildScope([guided.identifier]),
      'A planning turn',
    );
    const planningTurn = await adminDb.planChangeTurn.findFirstOrThrow({
      where: { sessionId: planning.id },
    });
    const stranger = await member();
    const theirs = await guideOffer(stranger.id);

    const cases: Array<[string, Record<string, unknown>]> = [
      // Anchored on the guided card, whose scope does not include the offer's target.
      ['a scope without the offer’s target', { seedGuideTurnId: turnId }],
      [
        'an offer with no target',
        { targetKeys: [target.identifier], seedGuideTurnId: noTarget.turnId },
      ],
      ['a turn with no offer', { targetKeys: [target.identifier], seedGuideTurnId: noOffer.id }],
      [
        'a planning session’s turn',
        { targetKeys: [target.identifier], seedGuideTurnId: planningTurn.id },
      ],
      [
        'another member’s offer',
        { targetKeys: [target.identifier], seedGuideTurnId: theirs.turnId },
      ],
      ['an unknown turn', { targetKeys: [target.identifier], seedGuideTurnId: 'no-such-turn' }],
    ];
    const before = await counts();
    const bodies = new Set<string>();
    for (const [label, body] of cases) {
      const res = await confirm(label.startsWith('a scope') ? guided : target, body);
      expect(res.status, label).toBe(422);
      bodies.add(JSON.stringify(res.json));
    }
    expect(bodies.size).toBe(1);
    expect(await counts()).toEqual(before);
  });

  it('answers 400 for both seeds together, and ignores the seed when a sessionId is sent', async () => {
    const { turnId } = await guideOffer();
    const both = await confirm(target, {
      targetKeys: [target.identifier],
      seedGateId: 'gate-1',
      seedGuideTurnId: turnId,
    });
    expect(both.status).toBe(400);

    const opened = await planChangeSessionsService.startWithFirstTurn(
      activeCtx.current!,
      buildScope([target.identifier]),
      'First',
    );
    const withSession = await confirm(target, {
      targetKeys: [target.identifier],
      sessionId: opened.id,
      seedGuideTurnId: turnId,
    });
    expect(withSession.status).toBe(200);
    expect((await storedOffer(turnId))?.confirmedSessionId).toBeNull();
  });

  it('the one_seed CHECK rejects a session carrying both seeds', async () => {
    const { turnId } = await guideOffer();
    const gate = await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: target.id,
        kind: 'decision_approval',
        subjectId: 's',
        subjectVersion: 'v1',
        state: 'awaiting',
      },
    });
    await expect(
      adminDb.planChangeSession.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          createdById: fx.ownerId,
          scopeKey: '',
          targetKeys: [],
          seedGateId: gate.id,
          seedGuideTurnId: turnId,
        },
      }),
    ).rejects.toThrow();
  });
});

describe('Decline refuses a confirmed offer', () => {
  it('409 GUIDE_REPLAN_OFFER_NOT_OPEN, and the offer is untouched', async () => {
    const { guideSessionId, turnId } = await guideOffer();
    await confirm(target, { targetKeys: [target.identifier], seedGuideTurnId: turnId });
    const res = await decline(guideSessionId, turnId);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('GUIDE_REPLAN_OFFER_NOT_OPEN');
    expect((await storedOffer(turnId))?.declinedAt).toBeNull();
  });
});

describe('findGuideSeededSession', () => {
  it('returns the confirmed session for the owner, and null for everyone and everything else', async () => {
    const { turnId } = await guideOffer();
    const undecided = await planChangeSessionsService.findGuideSeededSession(
      activeCtx.current!,
      turnId,
    );
    expect(undecided).toBeNull();

    const res = await confirm(target, { targetKeys: [target.identifier], seedGuideTurnId: turnId });
    expect(
      await planChangeSessionsService.findGuideSeededSession(activeCtx.current!, turnId),
    ).toEqual({ sessionId: res.json.sessionId, open: true });

    // A second member in the project, with their own offer and their own confirmed
    // session: the owner's view and the project's sessions differ.
    // The owner's session holds `target`'s planning lock, so the member's offer aims at
    // a story of its own; on the held target their Confirm is refused, and nothing is
    // seeded for them.
    const other = await member();
    const elsewhere = await createTestWorkItem(fx, { kind: 'story', title: 'Billing' });
    const held = await guideOffer(other.id);
    const theirs = await guideOffer(other.id, elsewhere.identifier);
    signIn(other);
    expect(
      await planChangeSessionsService.findGuideSeededSession(activeCtx.current!, turnId),
    ).toBeNull();
    const locked = await confirm(target, {
      targetKeys: [target.identifier],
      seedGuideTurnId: held.turnId,
    });
    expect(locked.status).toBe(409);
    expect(locked.json.code).toBe('PLAN_TARGET_LOCKED');
    expect(
      await planChangeSessionsService.findGuideSeededSession(activeCtx.current!, held.turnId),
    ).toBeNull();
    const mine = await confirm(elsewhere, {
      targetKeys: [elsewhere.identifier],
      seedGuideTurnId: theirs.turnId,
    });
    expect(mine.status).toBe(200);
    expect(
      await planChangeSessionsService.findGuideSeededSession(activeCtx.current!, theirs.turnId),
    ).toEqual({ sessionId: mine.json.sessionId, open: true });
    expect(
      await planChangeSessionsService.findGuideSeededSession(activeCtx.current!, turnId),
    ).toBeNull();
    expect(
      await planChangeSessionsService.findGuideSeededSession(activeCtx.current!, 'no-such-turn'),
    ).toBeNull();
  });

  it('the state of a confirmed offer stays confirmed after a later offer arrives', async () => {
    const { guideSessionId, turnId } = await guideOffer();
    await confirm(target, { targetKeys: [target.identifier], seedGuideTurnId: turnId });
    await reviseOffer(guideSessionId, 2);
    const rows = await adminDb.planChangeTurn.findMany({
      where: { sessionId: guideSessionId },
      orderBy: { seq: 'asc' },
    });
    const turns = rows.map((t) => ({
      id: t.id,
      role: t.role,
      guide: readGuideTurnRecord(t.guideTurn),
    }));
    expect(replanOfferStateOf(turns, turnId)).toBe('confirmed');
  });
});
