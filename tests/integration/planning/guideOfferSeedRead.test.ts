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

// THE GUIDE-OFFER SEED READ (Story MOTIR-8684 · MOTIR-8692; decision MOTIR-8685), on
// real Postgres: `GET /api/ai/guide/offer/{turnId}/planning-seed` through the real
// service. A guide conversation is built directly (a session and its assistant
// turns); the Confirm that makes an offer `confirmed` goes through the real per-card
// plan route.
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
const { GET: seedRoute } = await import('@/app/api/ai/guide/offer/[turnId]/planning-seed/route');

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

async function readSeed(turnId: string) {
  const res = await seedRoute(
    new Request(`http://localhost:3000/api/ai/guide/offer/${turnId}/planning-seed`),
    { params: Promise.resolve({ turnId }) },
  );
  return { status: res.status, cache: res.headers.get('Cache-Control'), text: await res.text() };
}

const seedOf = (text: string) => (JSON.parse(text) as { seed: Record<string, unknown> }).seed;

describe('the guide-offer seed read', () => {
  it('serves the owner the target, the request verbatim and the guided card, no-store', async () => {
    const { turnId } = await guideOffer();
    const res = await readSeed(turnId);
    expect(res.status).toBe(200);
    expect(res.cache).toBe('no-store');
    expect(seedOf(res.text)).toEqual({
      source: 'guide',
      guideTurnId: turnId,
      intent: 'plan',
      anchorKey: target.identifier,
      firstTurn: OFFER.requestMd,
      offerState: 'undecided',
      seededSessionId: null,
      seededSessionOpen: false,
      guide: {
        guidedKey: guided.identifier,
        guidedTitle: guided.title,
        targetResolution: 'as_asked',
        confirmedAt: null,
      },
    });
  });

  it('carries the request byte for byte, Markdown, newlines and non-ASCII included', async () => {
    const { guideSessionId } = await guideOffer();
    const request = '## Re-plan\n\n- «déjà vu» 日本語\n\n  indented';
    const turn = await adminDb.planChangeTurn.create({
      data: {
        workspaceId: fx.workspaceId,
        sessionId: guideSessionId,
        seq: 2,
        role: 'assistant',
        body: 'Revised.',
        guideTurn: {
          actions: [{ type: 'needs_replan', reason: 'r', requestMd: request }],
          outcomes: [{ outcome: 'landed' }],
          temporary: false,
          replanOffer: {
            ...OFFER,
            requestMd: `  ${request}\n`,
            requestedTargetKey: target.identifier,
            targetKey: target.identifier,
          },
        },
      },
    });
    expect(seedOf((await readSeed(turn.id)).text).firstTurn).toBe(request);
  });

  it('after Confirm reads confirmed with the started session; an ended session reads closed', async () => {
    const { turnId } = await guideOffer();
    const confirmedRes = await confirm(target, {
      targetKeys: [target.identifier],
      seedGuideTurnId: turnId,
    });
    const sessionId = confirmedRes.json.sessionId as string;
    const open = seedOf((await readSeed(turnId)).text);
    expect(open).toMatchObject({
      offerState: 'confirmed',
      seededSessionId: sessionId,
      seededSessionOpen: true,
    });
    expect((open.guide as { confirmedAt: string | null }).confirmedAt).toEqual(expect.any(String));

    await adminDb.planChangeSession.update({
      where: { id: sessionId },
      data: { endedAt: new Date(), endReason: 'restarted' },
    });
    expect(seedOf((await readSeed(turnId)).text)).toMatchObject({
      seededSessionId: sessionId,
      seededSessionOpen: false,
    });
  });

  it('answers the identical 404 for every "nothing here for you", and reads and writes nothing', async () => {
    const live = await guideOffer();
    const noTarget = await guideOffer(fx.ownerId, null);
    const declined = await guideOffer();
    await decline(declined.guideSessionId, declined.turnId);
    const superseded = await guideOffer();
    await reviseOffer(superseded.guideSessionId, 2);
    const userTurn = await adminDb.planChangeTurn.findFirstOrThrow({
      where: { sessionId: live.guideSessionId, role: 'user' },
    });
    const noOffer = await adminDb.planChangeTurn.create({
      data: {
        workspaceId: fx.workspaceId,
        sessionId: live.guideSessionId,
        seq: 5,
        role: 'assistant',
        body: 'Plain reply.',
        guideTurn: { actions: [], outcomes: [], temporary: false },
      },
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
    // The stranger's OWN confirmed offer exists in the same project too.
    signIn(stranger);
    await confirm(target, { targetKeys: [target.identifier], seedGuideTurnId: theirs.turnId });
    signIn({ id: fx.owner.id, email: fx.owner.email, name: fx.owner.name });

    // A target that became Done, and a guided card / target the viewer cannot see.
    const finished = await createTestWorkItem(fx, { kind: 'story', title: 'Finished' });
    await adminDb.workItem.update({ where: { id: finished.id }, data: { status: 'done' } });
    const doneTarget = await guideOffer(fx.ownerId, finished.identifier);

    const ids = [
      '',
      'no-such-turn',
      userTurn.id,
      noOffer.id,
      noTarget.turnId,
      declined.turnId,
      superseded.turnId,
      planningTurn.id,
      theirs.turnId,
      doneTarget.turnId,
    ];
    const before = await counts();
    const jsonBefore = await adminDb.planChangeTurn.findUniqueOrThrow({
      where: { id: live.turnId },
    });
    const bodies = new Set<string>();
    for (const id of ids) {
      const res = await readSeed(id);
      expect(res.status, id).toBe(404);
      expect(res.cache).toBe('no-store');
      bodies.add(res.text);
    }
    expect(bodies).toEqual(new Set([JSON.stringify({ code: 'NOT_FOUND' })]));
    expect(await counts()).toEqual(before);
    const jsonAfter = await adminDb.planChangeTurn.findUniqueOrThrow({
      where: { id: live.turnId },
    });
    expect(jsonAfter.guideTurn).toEqual(jsonBefore.guideTurn);
  });

  it('answers 404 for an offer whose guided card or target the viewer cannot browse, or an archived target', async () => {
    const hidden = await member();
    const { turnId } = await guideOffer();
    // The target is archived since the offer landed.
    await adminDb.workItem.update({ where: { id: target.id }, data: { archivedAt: new Date() } });
    expect((await readSeed(turnId)).status).toBe(404);
    await adminDb.workItem.update({ where: { id: target.id }, data: { archivedAt: null } });
    expect((await readSeed(turnId)).status).toBe(200);
    // Another member, who is not the owner, cannot read it however visible the cards are.
    signIn(hidden);
    expect((await readSeed(turnId)).status).toBe(404);
  });

  it('leaves the cards’ updatedAt unchanged', async () => {
    const { turnId } = await guideOffer();
    const before = await adminDb.workItem.findMany({ select: { id: true, updatedAt: true } });
    await readSeed(turnId);
    expect(await adminDb.workItem.findMany({ select: { id: true, updatedAt: true } })).toEqual(
      before,
    );
  });
});
