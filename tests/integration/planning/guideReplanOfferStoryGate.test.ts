import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestWorkItem } from '../../fixtures/workItemFixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from '../../helpers/workspaceRoleFixtures';
import { projectAccessData, setProjectAccess } from '@/tests/helpers/projectAccess';
import { consentedVisitor } from '../../visitor/_consentedVisitor';

// STORY GATE — GUIDE ME THROUGH OFFERS A RE-PLAN (Story MOTIR-8684 · MOTIR-8695;
// decision MOTIR-8685). The motir-core half of the story, through its HTTP doors, on
// real Postgres. Harness lifted from the pick seam (`pickPlanSeam.test.ts`); the
// predecessors' own suites (`guideOfferSeedRead.test.ts`, `guideOfferSeedStamp.test.ts`,
// the landing's `tests/ai/guideLandingService.test.ts`, …) each prove ONE half with
// its neighbours mocked or hand-built. This file proves the output of one half is
// what the next half accepts:
//
//   the guide door → the settle (the guide's `needs_replan` LANDS) → the stored offer
//   read back → the seed read → the seed's OWN `firstTurn` sent through
//   `POST /api/work-items/{id}/ai/plan` with `seedGuideTurnId` → the stamped, held,
//   confirmed session → the return reads (the seed read, a second Confirm, Decline,
//   the Plans row).
//
// Every "nothing happened" is a before/after COUNT of `plan_change_session`,
// `plan_change_turn` and `submitJob` calls plus the card's `updatedAt` — never a
// status code alone.
//
// Stubs: the context resolvers a Vitest process cannot supply through cookies (the
// session, the active project, the request locale), `next/cache`, `sendEvent`, and
// the motir-ai boundary client — `submitJob` COUNTED, and `getJob` serving the
// settled guide turn, which is how `guideLandingService.settle` obtains it.

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
const submitJobMock = vi.fn(async (..._args: unknown[]) => ({ jobId: `job-gate-${++jobSeq}` }));
/** The settled guide turn each guide job id returns, served by `getJob`. */
const served = new Map<string, unknown>();
const getJobMock = vi.fn(async (jobId: string) =>
  served.has(jobId)
    ? { status: 'succeeded', result: { guideTurn: served.get(jobId) } }
    : { status: 'running' },
);
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...(args as [])),
  streamJob: vi.fn(),
  getJob: (jobId: string) => getJobMock(jobId),
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

const { workItemTodosService } = await import('@/lib/services/workItemTodosService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { planSessionsService } = await import('@/lib/services/planSessionsService');
const { readGuideTurnRecord } = await import('@/lib/ai/guideWorkItem');
const { replanOfferStateOf } = await import('@/lib/planning/guideReplanOffer');
const { POST: guideRoute } = await import('@/app/api/ai/guide/route');
const { POST: settleRoute } = await import('@/app/api/ai/guide/settle/route');
const { POST: declineRoute } = await import('@/app/api/ai/guide/offer/decline/route');
const { GET: seedRoute } = await import('@/app/api/ai/guide/offer/[turnId]/planning-seed/route');
const { POST: planRoute } = await import('@/app/api/work-items/[id]/ai/plan/route');

type Actor = { id: string; email: string; name: string };
type Json = Record<string, unknown>;
interface GuideSeed {
  source: 'guide';
  guideTurnId: string;
  intent: 'plan';
  anchorKey: string;
  firstTurn: string;
  offerState: 'undecided' | 'confirmed';
  seededSessionId: string | null;
  seededSessionOpen: boolean;
  guide: { guidedKey: string; guidedTitle: string; targetResolution: string };
}
interface Tree {
  epic: WorkItem;
  story: WorkItem;
  subtask: WorkItem;
  rows: string[];
}

let fx: WorkItemFixture;
let seq = 0;

beforeAll(() => {
  // The guide door's sixth gate and the planning start both read Motir AI as
  // configured; the client itself is the module stub above.
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.guide-replan-gate.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token-test');
});

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockClear();
  getJobMock.mockClear();
  served.clear();
  seq += 1;
  fx = await makeWorkItemFixture({ name: `Guide gate ${seq}`, identifier: `GRO${seq}` });
  signIn(ownerOf(fx));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── actors ────────────────────────────────────────────────────────────────────

const ownerOf = (f: WorkItemFixture): Actor => ({
  id: f.owner.id,
  email: f.owner.email,
  name: f.owner.name,
});

function signIn(actor: Actor) {
  session.current = { user: { id: actor.id, email: actor.email, name: actor.name } };
  activeCtx.current = {
    userId: actor.id,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  } as ProjectContext;
}

/** A workspace member; `inProject` also adds them to the fixture's project. */
async function member(label: string, inProject = true): Promise<Actor> {
  const user = await createTestUser({ name: `Member ${label} ${seq}` });
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
  });
  if (inProject) {
    await addToProjectAs({
      key: fx.project.identifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: user.id,
      role: 'member',
    });
  }
  return { id: user.id, email: user.email, name: user.name };
}

// ── the fixture tree: epic → story → manual subtask, four rows, step 1 ticked ──

async function setStatus(id: string, status: string) {
  await adminDb.workItem.update({ where: { id }, data: { status } });
}

async function manualSubtask(
  parent: WorkItem,
  title: string,
): Promise<{ card: WorkItem; rows: string[] }> {
  const card = await createTestWorkItem(fx, {
    kind: 'subtask',
    title,
    type: 'manual',
    executor: 'human',
    parentId: parent.id,
  });
  await setStatus(card.id, 'todo');
  const rows: string[] = [];
  for (const text of [
    'Create a SendGrid account',
    'Create an API key',
    'Verify the sending domain',
    'Add the key to the environment',
  ]) {
    rows.push((await workItemTodosService.addTodo(card.id, { text }, fx.ctx)).todo.id);
  }
  await workItemTodosService.setTodoDone(rows[0]!, true, fx.ctx);
  return { card: await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } }), rows };
}

async function tree(): Promise<Tree> {
  const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Transactional email' });
  await setStatus(epic.id, 'in_progress');
  const story = await createTestWorkItem(fx, {
    kind: 'story',
    title: 'Send receipts by email',
    parentId: epic.id,
  });
  await setStatus(story.id, 'todo');
  const { card, rows } = await manualSubtask(story, 'Set up transactional email with SendGrid');
  return {
    epic: await adminDb.workItem.findUniqueOrThrow({ where: { id: epic.id } }),
    story: await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } }),
    subtask: card,
    rows,
  };
}

// ── what motir-ai emits ───────────────────────────────────────────────────────
//
// The shape is the motir-ai handler's (MOTIR-8688), copied from its integration gate
// `motir-ai/tests/guideWorkItemReplanOffer.integration.test.ts` (MOTIR-8690, case 2:
// `{ type: 'needs_replan', reason, requestMd, targetKey }`). The guide ALWAYS fills
// both `requestMd` and `targetKey` on an offer.

/** Markdown, a newline and non-ASCII text — the seed must carry it byte for byte. */
const REQUEST_MD = [
  '**Re-plan the story:** the vendor named on this card was dropped last week.',
  '',
  '- Ticked so far: _Create a SendGrid account_',
  '- The person found: the team moved to Postmark — 不再使用 SendGrid. Café ✓',
].join('\n');

function offerTurn(targetKey: string, requestMd = REQUEST_MD, reason = 'the vendor was dropped') {
  return {
    messageMd: `This work item is wrong, and I can't guide you any further. A re-plan is offered on ${targetKey}.`,
    actions: [{ type: 'needs_replan', reason, requestMd, targetKey }],
  };
}

const plainTurn = (messageMd = 'Next: create an API key.') => ({ messageMd, actions: [] });

// ── the wire ─────────────────────────────────────────────────────────────────

const BASE = 'http://localhost:3000';
const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

interface Door {
  status: number;
  json: Json & {
    jobId?: string | null;
    session?: PlanChangeSessionDto;
    planning?: { canPlan: boolean; reason: string | null };
  };
}

async function door(body: Json): Promise<Door> {
  const res = await guideRoute(post('/api/ai/guide', body));
  return { status: res.status, json: (await res.json()) as Door['json'] };
}

/** Press Guide me through on `card` (must open a conversation and start a job). */
async function openGuide(card: WorkItem) {
  const res = await door({ itemKey: card.identifier });
  expect(res.status).toBe(200);
  return { jobId: res.json.jobId!, sessionId: res.json.session!.id, planning: res.json.planning! };
}

/** The person's next turn in the guide conversation. */
async function say(sessionId: string, text: string) {
  const res = await door({ sessionId, text });
  expect(res.status).toBe(200);
  return { jobId: res.json.jobId!, sessionId };
}

async function settle(jobId: string, sessionId: string) {
  const res = await settleRoute(post('/api/ai/guide/settle', { jobId, sessionId }));
  return { status: res.status, json: (await res.json()) as Json };
}

/** Serve the guide's turn for `jobId`, settle it, and return the reply turn's id. */
async function land(t: { jobId: string; sessionId: string }, guideTurn: unknown): Promise<string> {
  served.set(t.jobId, guideTurn);
  const res = await settle(t.jobId, t.sessionId);
  expect(res.status).toBe(200);
  expect(res.json.outcome).toBe('guided');
  const reply = await adminDb.planChangeTurn.findFirstOrThrow({
    where: { sessionId: t.sessionId, role: 'assistant', jobId: t.jobId },
  });
  return reply.id;
}

async function readSeed(turnId: string): Promise<{ status: number; text: string }> {
  const res = await seedRoute(new Request(`${BASE}/api/ai/guide/offer/${turnId}/planning-seed`), {
    params: Promise.resolve({ turnId }),
  });
  return { status: res.status, text: await res.text() };
}

async function seedOf(turnId: string): Promise<GuideSeed> {
  const res = await readSeed(turnId);
  expect(res.status, res.text).toBe(200);
  return (JSON.parse(res.text) as { seed: GuideSeed }).seed;
}

async function send(anchor: WorkItem, body: Json) {
  const res = await planRoute(post(`/api/work-items/${anchor.id}/ai/plan`, body), {
    params: Promise.resolve({ id: anchor.id }),
  });
  return { status: res.status, json: (await res.json()) as Json };
}

async function decline(sessionId: string, turnId: string) {
  const res = await declineRoute(post('/api/ai/guide/offer/decline', { sessionId, turnId }));
  return { status: res.status, text: await res.text() };
}

async function counts() {
  return {
    sessions: await adminDb.planChangeSession.count(),
    turns: await adminDb.planChangeTurn.count(),
    submits: submitJobMock.mock.calls.length,
  };
}

const card = (id: string) => adminDb.workItem.findUniqueOrThrow({ where: { id } });

/** The card's own fields as they stand, for an "unchanged" comparison. */
async function cardState(id: string) {
  const w = await card(id);
  return {
    status: w.status,
    title: w.title,
    descriptionMd: w.descriptionMd,
    updatedAt: w.updatedAt.toISOString(),
  };
}

/** The offer and its derived state, from a FRESH read of the guide session. */
async function offerOn(sessionId: string, turnId: string) {
  const fresh = await planChangeSessionsService.getById(activeCtx.current!, sessionId);
  const turn = fresh.turns.find((t) => t.id === turnId);
  return {
    offer: turn?.guide?.replanOffer ?? null,
    state: replanOfferStateOf(fresh.turns, turnId),
  };
}

const commentsOn = (workItemId: string) =>
  adminDb.comment.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });
const rawGuideTurn = async (turnId: string) =>
  (await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: turnId } })).guideTurn;
const locksOf = (sessionId: string) =>
  adminDb.planTargetLock.findMany({ where: { sessionId }, include: { workItem: true } });

/** Land an offer on `t.subtask` for whoever is signed in. */
async function landedOffer(subtask: WorkItem, targetKey: string, requestMd = REQUEST_MD) {
  const opened = await openGuide(subtask);
  const turnId = await land(opened, offerTurn(targetKey, requestMd));
  return { sessionId: opened.sessionId, turnId, planning: opened.planning };
}

/** B: a second member with their own guide conversation and a CONFIRMED offer in the
 *  same project, on their own story — so every read below has a row A must not get. */
async function memberBWithConfirmedOffer() {
  const b = await member('B');
  const owner = ownerOf(fx);
  const storyB = await createTestWorkItem(fx, { kind: 'story', title: 'Send invoices' });
  await setStatus(storyB.id, 'todo');
  const { card: subB } = await manualSubtask(storyB, 'Rotate the invoice signing key');
  signIn(b);
  const offer = await landedOffer(subB, storyB.identifier, 'B’s private re-plan request');
  const seed = await seedOf(offer.turnId);
  const sent = await send(storyB, {
    prompt: seed.firstTurn,
    targetKeys: [storyB.identifier, subB.identifier],
    seedGuideTurnId: offer.turnId,
  });
  expect(sent.status).toBe(200);
  signIn(owner);
  return { b, storyB, subB, ...offer, planSessionId: sent.json.sessionId as string };
}

// ── 1–4 · THE SEAM ───────────────────────────────────────────────────────────

describe('1–4 · land → stored → seed → Confirm → return', () => {
  it('the landed target is the seed’s anchor, the seed’s turn is what the session stores, and the session is the one every return names', async () => {
    const t = await tree();
    const b = await memberBWithConfirmedOffer();

    // 1 · LAND. The guide names the story — key-shaped, as motir-ai's gate asserts
    // (`/^[A-Z][A-Z0-9]*-\d+$/`). The lower-cased spelling is its own case below.
    const before1 = await cardState(t.subtask.id);
    const opened = await openGuide(t.subtask);
    expect(opened.planning).toEqual({ canPlan: true, reason: null });
    const turnId = await land(opened, offerTurn(t.story.identifier));

    const comments = await commentsOn(t.subtask.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.bodyMd).toContain('Reason: the vendor was dropped');
    expect(comments[0]!.bodyMd).toContain(`Re-plan offered on: ${t.story.identifier}`);

    const stored = await offerOn(opened.sessionId, turnId);
    expect(stored.offer).toMatchObject({
      requestMd: REQUEST_MD,
      requestedTargetKey: t.story.identifier,
      targetKey: t.story.identifier,
      targetResolution: 'as_asked',
      declinedAt: null,
      confirmedSessionId: null,
    });
    expect(stored.state).toBe('undecided');
    expect(await cardState(t.subtask.id)).toEqual(before1);

    // Replaying the settle writes no second comment and no second offer.
    const replayBefore = await counts();
    const replay = await settle(opened.jobId, opened.sessionId);
    expect(replay.status).toBe(200);
    expect(await commentsOn(t.subtask.id)).toHaveLength(1);
    expect(await counts()).toEqual(replayBefore);
    const offers = (
      await adminDb.planChangeTurn.findMany({ where: { sessionId: opened.sessionId } })
    ).filter((row) => readGuideTurnRecord(row.guideTurn)?.replanOffer);
    expect(offers.map((row) => row.id)).toEqual([turnId]);

    // 2 · THE SEED READ, on the landed offer: the anchor IS the stored target.
    const json2 = await rawGuideTurn(turnId);
    const before2 = await counts();
    const seed = await seedOf(turnId);
    expect(seed.anchorKey).toBe(stored.offer!.targetKey);
    expect(seed.firstTurn).toBe(stored.offer!.requestMd);
    expect(seed.firstTurn).toBe(REQUEST_MD);
    expect(seed).toMatchObject({
      intent: 'plan',
      seededSessionId: null,
      offerState: 'undecided',
      guide: { guidedKey: t.subtask.identifier },
    });
    expect(await counts()).toEqual(before2);
    expect(await rawGuideTurn(turnId)).toEqual(json2);

    // 3 · CONFIRM: the seed's own first turn, on the target plus the guided card.
    const before3 = await counts();
    const sent = await send(t.story, {
      prompt: seed.firstTurn,
      targetKeys: [t.story.identifier, t.subtask.identifier],
      seedGuideTurnId: turnId,
    });
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    const planSessionId = sent.json.sessionId as string;
    const after3 = await counts();
    expect(after3.sessions).toBe(before3.sessions + 1);
    expect(after3.submits).toBe(before3.submits + 1);
    expect(submitJobMock.mock.calls.at(-1)![0]).not.toBe('guide_work_item');

    const stamped = await adminDb.planChangeSession.findMany({
      where: { seedGuideTurnId: turnId },
    });
    expect(stamped.map((s) => s.id)).toEqual([planSessionId]);
    expect(stamped[0]!.seedGateId).toBeNull();
    const userTurns = await adminDb.planChangeTurn.findMany({
      where: { sessionId: planSessionId, role: 'user' },
    });
    expect(userTurns.map((u) => u.body)).toEqual([seed.firstTurn]);

    const confirmed = await offerOn(opened.sessionId, turnId);
    expect(confirmed.state).toBe('confirmed');
    expect(confirmed.offer!.confirmedSessionId).toBe(planSessionId);

    // The plan's card hold: both targets at Planning, both locks naming the session.
    expect((await card(t.story.id)).status).toBe('planning');
    expect((await card(t.subtask.id)).status).toBe('planning');
    const locks = await locksOf(planSessionId);
    expect(locks.map((l) => l.workItem.identifier).sort()).toEqual(
      [t.story.identifier, t.subtask.identifier].sort(),
    );

    // 4 · RETURN, without sending twice.
    const back = await seedOf(turnId);
    expect(back).toMatchObject({
      offerState: 'confirmed',
      seededSessionId: planSessionId,
      seededSessionOpen: true,
      anchorKey: t.story.identifier,
    });

    const before4 = await counts();
    const again = await send(t.story, {
      prompt: seed.firstTurn,
      targetKeys: [t.story.identifier, t.subtask.identifier],
      seedGuideTurnId: turnId,
    });
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({
      code: 'GUIDE_REPLAN_OFFER_CONFIRMED',
      sessionId: planSessionId,
    });
    expect(await counts()).toEqual(before4);

    // The Plans row: A's guide-seeded session listed ONCE, naming the guided card —
    // beside B's, which A's project view also lists, naming B's card.
    const page = await planSessionsService.listSessions(fx.projectId, fx.ctx, { limit: 100 });
    const mine = page.sessions.filter((s) => s.id === planSessionId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.seed).toMatchObject({ origin: 'guide', cardKey: t.subtask.identifier });
    const theirs = page.sessions.find((s) => s.id === b.planSessionId);
    expect(theirs?.seed).toMatchObject({ origin: 'guide', cardKey: b.subB.identifier });

    // Decline on the confirmed offer: refused, and nothing is written.
    const json4 = await rawGuideTurn(turnId);
    const before4b = await counts();
    const declined = await decline(opened.sessionId, turnId);
    expect(declined.status).toBe(409);
    expect(JSON.parse(declined.text)).toMatchObject({ code: 'GUIDE_REPLAN_OFFER_NOT_OPEN' });
    expect(await counts()).toEqual(before4b);
    expect(await rawGuideTurn(turnId)).toEqual(json4);
  });
});

describe('1b · a lower-cased target key', () => {
  // Keys are case-insensitive everywhere else in the API (the guide door folds
  // `itemKey` with `toUpperCase()`), and `resolveReplanTarget` folds the guide's
  // `targetKey` the same way, so `gro1-2` resolves to the story as asked. The
  // stored `requestedTargetKey` stays what the guide sent, verbatim.
  it('resolves to the story, as asked', async () => {
    const t = await tree();
    const offer = await landedOffer(t.subtask, t.story.identifier.toLowerCase());
    const { offer: stored } = await offerOn(offer.sessionId, offer.turnId);
    expect(stored).toMatchObject({
      requestedTargetKey: t.story.identifier.toLowerCase(),
      targetKey: t.story.identifier,
      targetResolution: 'as_asked',
    });
    expect((await seedOf(offer.turnId)).anchorKey).toBe(t.story.identifier);
  });
});

// ── 5 · DECLINE SPENDS NOTHING ───────────────────────────────────────────────

describe('5 · Decline spends nothing', () => {
  it('a declined offer plans nothing, holds nothing, moves nothing, and the door resumes the same guide', async () => {
    const t = await tree();
    // A second subtask under the same story: the one this case declines on.
    const { card: second } = await manualSubtask(t.story, 'Add the DNS records for sending');
    const offer = await landedOffer(second, t.story.identifier);
    const commentIds = (await commentsOn(second.id)).map((c) => c.id);
    expect(commentIds).toHaveLength(1);

    const before = await counts();
    const cardBefore = await cardState(second.id);
    const storyBefore = await cardState(t.story.id);
    const res = await decline(offer.sessionId, offer.turnId);
    expect(res.status).toBe(200);

    const after = await offerOn(offer.sessionId, offer.turnId);
    expect(after.state).toBe('declined');
    expect(after.offer!.declinedAt).toEqual(expect.any(String));
    expect(after.offer!.declinedById).toBe(fx.ownerId);

    expect(await counts()).toEqual(before);
    expect((await adminDb.planChangeSession.findMany()).map((s) => s.id)).toEqual([
      offer.sessionId,
    ]);
    expect(await adminDb.planTargetLock.count()).toBe(0);
    expect(await cardState(second.id)).toEqual(cardBefore);
    expect(await cardState(t.story.id)).toEqual(storyBefore);
    expect((await commentsOn(second.id)).map((c) => c.id)).toEqual(commentIds);

    // Then: no seed, no send, and the door resumes THE SAME guide conversation.
    const seed = await readSeed(offer.turnId);
    expect(seed.status).toBe(404);
    expect(JSON.parse(seed.text)).toEqual({ code: 'NOT_FOUND' });

    const beforeSend = await counts();
    const sent = await send(t.story, {
      prompt: REQUEST_MD,
      targetKeys: [t.story.identifier, second.identifier],
      seedGuideTurnId: offer.turnId,
    });
    expect(sent.status).toBe(409);
    expect(sent.json.code).toBe('GUIDE_REPLAN_OFFER_NOT_OPEN');
    expect(await counts()).toEqual(beforeSend);
    expect(await adminDb.planTargetLock.count()).toBe(0);

    const resumed = await door({ itemKey: second.identifier });
    expect(resumed.status).toBe(200);
    expect(resumed.json.jobId).toBeNull();
    expect(resumed.json.session!.id).toBe(offer.sessionId);
    expect(await adminDb.planChangeSession.count({ where: { origin: 'guide' } })).toBe(1);
  });
});

// ── 6 · A REVISED OFFER SUPERSEDES THE OLD ───────────────────────────────────

describe('6 · a revised offer supersedes the old', () => {
  it('the earlier offer is refused at every door; the later one seeds on the epic and sends', async () => {
    const t = await tree();
    const first = await landedOffer(t.subtask, t.story.identifier);
    const next = await say(
      first.sessionId,
      'It is not the story — the whole epic assumed SendGrid.',
    );
    const laterId = await land(
      next,
      offerTurn(t.epic.identifier, 'Re-plan the epic: no SendGrid.'),
    );

    expect((await offerOn(first.sessionId, first.turnId)).state).toBe('superseded');
    const before = await counts();
    const json = await rawGuideTurn(first.turnId);

    expect((await readSeed(first.turnId)).status).toBe(404);
    const d = await decline(first.sessionId, first.turnId);
    expect(d.status).toBe(409);
    expect(JSON.parse(d.text)).toMatchObject({ code: 'GUIDE_REPLAN_OFFER_NOT_OPEN' });
    const s = await send(t.story, {
      prompt: REQUEST_MD,
      targetKeys: [t.story.identifier, t.subtask.identifier],
      seedGuideTurnId: first.turnId,
    });
    expect(s.status).toBe(409);
    expect(s.json.code).toBe('GUIDE_REPLAN_OFFER_NOT_OPEN');
    expect(await counts()).toEqual(before);
    expect(await rawGuideTurn(first.turnId)).toEqual(json);

    const later = await seedOf(laterId);
    expect(later.anchorKey).toBe(t.epic.identifier);
    expect(later.firstTurn).toBe('Re-plan the epic: no SendGrid.');
    const sent = await send(t.epic, {
      prompt: later.firstTurn,
      targetKeys: [t.epic.identifier, t.subtask.identifier],
      seedGuideTurnId: laterId,
    });
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    const stamped = await adminDb.planChangeSession.findMany({
      where: { seedGuideTurnId: laterId },
    });
    expect(stamped.map((x) => x.id)).toEqual([sent.json.sessionId]);
    expect((await offerOn(first.sessionId, laterId)).state).toBe('confirmed');
  });
});

// ── 7 · A DONE TARGET IS RESOLVED FORWARD ────────────────────────────────────

describe('7 · a done target is resolved forward', () => {
  it('a Done story resolves to its epic; with the epic Done too there is no target and no seed', async () => {
    const t = await tree();
    await setStatus(t.story.id, 'done');

    const first = await landedOffer(t.subtask, t.story.identifier);
    expect((await offerOn(first.sessionId, first.turnId)).offer).toMatchObject({
      requestedTargetKey: t.story.identifier,
      targetKey: t.epic.identifier,
      targetResolution: 'nearest_open_ancestor',
    });
    expect((await seedOf(first.turnId)).anchorKey).toBe(t.epic.identifier);

    await setStatus(t.epic.id, 'done');
    const next = await say(first.sessionId, 'Still wrong.');
    const noneId = await land(next, offerTurn(t.story.identifier));
    expect((await offerOn(first.sessionId, noneId)).offer).toMatchObject({
      targetKey: null,
      targetResolution: 'none',
    });
    const comments = await commentsOn(t.subtask.id);
    expect(comments.at(-1)!.bodyMd).toContain('No open work item to re-plan on.');

    expect((await readSeed(noneId)).status).toBe(404);
    const before = await counts();
    const s = await send(t.story, {
      prompt: REQUEST_MD,
      targetKeys: [t.story.identifier, t.subtask.identifier],
      seedGuideTurnId: noneId,
    });
    expect(s.status).toBe(422);
    expect(s.json).toEqual({ code: 'SEED_NOT_APPLICABLE' });
    expect(await counts()).toEqual(before);

    const d = await decline(first.sessionId, noneId);
    expect(d.status).toBe(200);
    expect((await offerOn(first.sessionId, noneId)).state).toBe('declined');
  });
});

// ── 8 · NO LEAK ──────────────────────────────────────────────────────────────

describe('8 · no leak — every refusal returns one body', () => {
  it('another member’s offer, an unknown id, a user turn, a plain reply and an unbrowsable card all read the same 404', async () => {
    const t = await tree();
    const b = await memberBWithConfirmedOffer();

    // A's own guide conversation: a plain reply first, so there is an assistant
    // turn with NO offer.
    const opened = await openGuide(t.subtask);
    const plainId = await land(opened, plainTurn());
    const userTurn = await adminDb.planChangeTurn.findFirstOrThrow({
      where: { sessionId: opened.sessionId, role: 'user' },
    });

    // D: a workspace member outside the project, who lands an offer while the
    // project is open to the workspace — and then loses browse when it is not.
    const d = await member('D', false);
    signIn(d);
    const { card: dCard } = await manualSubtask(t.story, 'Rotate the DKIM key');
    const dOffer = await landedOffer(dCard, t.story.identifier, 'D’s re-plan request');
    expect((await readSeed(dOffer.turnId)).status).toBe(200);
    await setProjectAccess(adminDb, fx.projectId, 'members');
    activeCtx.current = {
      ...activeCtx.current!,
      project: { ...fx.project, ...projectAccessData('members') },
    } as ProjectContext;
    const unbrowsable = await readSeed(dOffer.turnId);
    await setProjectAccess(adminDb, fx.projectId, 'workspace');

    signIn(ownerOf(fx));
    const before = await counts();
    const bodies = [
      await readSeed(b.turnId),
      await readSeed('cmunknownguideturn0000000'),
      await readSeed(userTurn.id),
      await readSeed(plainId),
      unbrowsable,
    ];
    for (const r of bodies) {
      expect(r.status).toBe(404);
      expect(r.text).toBe(bodies[0]!.text);
    }
    expect(JSON.parse(bodies[0]!.text)).toEqual({ code: 'NOT_FOUND' });

    // A's decline of B's offer, and A's send with B's turn: refused, nothing written.
    const bJson = await rawGuideTurn(b.turnId);
    const dec = await decline(b.sessionId, b.turnId);
    expect(dec.status).toBe(404);
    const sent = await send(t.story, {
      prompt: 'anything',
      targetKeys: [t.story.identifier, t.subtask.identifier],
      seedGuideTurnId: b.turnId,
    });
    expect(sent.status).toBe(422);
    expect(sent.json).toEqual({ code: 'SEED_NOT_APPLICABLE' });
    expect(await counts()).toEqual(before);
    expect(await rawGuideTurn(b.turnId)).toEqual(bJson);
    expect(await adminDb.planTargetLock.count({ where: { workItemId: t.story.id } })).toBe(0);

    const titles = [t.epic, t.story, t.subtask, b.storyB, b.subB, dCard].map((w) => w.title);
    for (const text of [...bodies.map((r) => r.text), dec.text, JSON.stringify(sent.json)]) {
      expect(text).not.toContain('B’s private re-plan request');
      expect(text).not.toContain('D’s re-plan request');
      for (const title of titles) expect(text).not.toContain(title);
    }
  });

  describe('a Visitor', () => {
    let previousCloud: string | undefined;
    beforeEach(() => {
      previousCloud = process.env['MOTIR_CLOUD'];
      process.env['MOTIR_CLOUD'] = 'true';
    });
    afterEach(() => {
      if (previousCloud === undefined) delete process.env['MOTIR_CLOUD'];
      else process.env['MOTIR_CLOUD'] = previousCloud;
    });

    it('whose hidden set holds the guided card is not shown A’s guide-seeded session, but is shown an unseeded one', async () => {
      const t = await tree();
      const offer = await landedOffer(t.subtask, t.story.identifier);
      const seed = await seedOf(offer.turnId);
      const sent = await send(t.story, {
        prompt: seed.firstTurn,
        targetKeys: [t.story.identifier, t.subtask.identifier],
        seedGuideTurnId: offer.turnId,
      });
      expect(sent.status).toBe(200);
      const unseeded = await adminDb.planChangeSession.create({
        data: { workspaceId: fx.workspaceId, projectId: fx.projectId, targetKeys: [] },
      });
      // Both reached planning, so the list could show either (MOTIR-9300): only the
      // guide seed withholds the one.
      for (const sessionId of [unseeded.id, sent.json.sessionId as string]) {
        await adminDb.plan.create({
          data: {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            sessionId,
            status: 'generating',
            createdById: fx.ownerId,
          },
        });
      }

      await setProjectAccess(adminDb, fx.projectId, 'public');
      await adminDb.workItem.update({
        where: { id: t.epic.id },
        data: { publicChildrenHidden: true },
      });
      const visitor = await consentedVisitor(fx.projectIdentifier);
      const page = await planSessionsService.listSessions(fx.projectId, visitor, { limit: 100 });
      const ids = page.sessions.map((s) => s.id);
      expect(ids).toContain(unseeded.id);
      expect(ids).not.toContain(sent.json.sessionId);
      // A member's project view lists both.
      const memberPage = await planSessionsService.listSessions(fx.projectId, fx.ctx, {
        limit: 100,
      });
      expect(memberPage.sessions.map((s) => s.id)).toEqual(
        expect.arrayContaining([unseeded.id, sent.json.sessionId]),
      );
    });
  });
});

// ── 9 · CANNOT PLAN AGREES WITH THE DOOR ─────────────────────────────────────

describe('9 · cannot plan agrees with the door', () => {
  it('a member without ai:plan is refused by the guide door AND by the plan route alike; the owner may plan', async () => {
    const t = await tree();
    const owner = ownerOf(fx);
    const c = await member('C');
    signIn(c);
    // C lands an offer while still holding the default member role…
    const offer = await landedOffer(t.subtask, t.story.identifier);
    expect(offer.planning).toEqual({ canPlan: true, reason: null });

    // …and then loses `ai:plan`.
    const role = await createCustomRoleAs({
      projectId: fx.projectId,
      ctx: fx.ctx,
      name: 'No planning',
      permissions: ['project:browse', 'work_item:edit'],
    });
    await setProjectRoleAs({
      key: fx.project.identifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: c.id,
      role: role.id,
    });

    const before = await counts();
    const storyBefore = await cardState(t.story.id);
    const doorRes = await door({ itemKey: t.subtask.identifier });
    const sent = await send(t.story, {
      prompt: REQUEST_MD,
      targetKeys: [t.story.identifier, t.subtask.identifier],
      seedGuideTurnId: offer.turnId,
    });
    // The rail draws no Confirm for C because the door does not answer C at all; the
    // start refuses C for the same missing key, with the same status.
    //
    // ⚠️ The card's case 9 asks for the door's response to carry `planning: {
    // canPlan: false, reason: 'no_permission' }` for C. The shipped door cannot: it
    // asserts `ai:plan` before it builds any result (`requireGuidableCard`, gate 2),
    // and `planningAccess()` only ever withholds with `ai_not_configured`
    // (`lib/dto/planChange.ts` says so). So the predicate and the refusal agree by
    // BOTH refusing — which is what is asserted.
    expect(doorRes.status).toBe(403);
    expect(sent.status).toBe(doorRes.status);
    expect(await counts()).toEqual(before);
    expect(await cardState(t.story.id)).toEqual(storyBefore);
    expect((await offerOn(offer.sessionId, offer.turnId)).state).toBe('undecided');

    signIn(owner);
    const { card: mine } = await manualSubtask(t.story, 'Owner’s card');
    const opened = await openGuide(mine);
    expect(opened.planning).toEqual({ canPlan: true, reason: null });
  });
});

// ── 10 · CONFIRM AGAINST DECLINE, RACING ─────────────────────────────────────

describe('10 · Confirm against Decline, racing on the real locks', () => {
  it('ends in exactly one outcome, and the loser answers 409 GUIDE_REPLAN_OFFER_NOT_OPEN', async () => {
    const t = await tree();
    const offer = await landedOffer(t.subtask, t.story.identifier);
    const seed = await seedOf(offer.turnId);
    const before = await counts();

    const [c, d] = await Promise.all([
      send(t.story, {
        prompt: seed.firstTurn,
        targetKeys: [t.story.identifier, t.subtask.identifier],
        seedGuideTurnId: offer.turnId,
      }),
      decline(offer.sessionId, offer.turnId),
    ]);
    const after = await counts();
    const { state, offer: stored } = await offerOn(offer.sessionId, offer.turnId);
    const stamped = await adminDb.planChangeSession.count({
      where: { seedGuideTurnId: offer.turnId },
    });

    if (c.status === 200) {
      expect(state).toBe('confirmed');
      expect(stored!.declinedAt).toBeNull();
      expect(d.status).toBe(409);
      expect(JSON.parse(d.text)).toMatchObject({ code: 'GUIDE_REPLAN_OFFER_NOT_OPEN' });
      expect(stamped).toBe(1);
      expect(after.sessions).toBe(before.sessions + 1);
      expect(after.submits).toBe(before.submits + 1);
    } else {
      expect(d.status).toBe(200);
      expect(state).toBe('declined');
      expect(stored!.confirmedSessionId).toBeNull();
      expect(c.status).toBe(409);
      expect(c.json.code).toBe('GUIDE_REPLAN_OFFER_NOT_OPEN');
      expect(stamped).toBe(0);
      expect(after).toEqual(before);
      expect(await adminDb.planTargetLock.count()).toBe(0);
    }
  });
});

// ── 11 · UNCHANGED PATHS STAY UNCHANGED ──────────────────────────────────────

describe('11 · unchanged paths stay unchanged', () => {
  it('a reason-only needs_replan comments as it always has, stores no offer and has no seed', async () => {
    const t = await tree();
    const opened = await openGuide(t.subtask);
    const replyId = await land(opened, {
      messageMd: 'This card needs a re-plan.',
      actions: [{ type: 'needs_replan', reason: 'the vendor was dropped' }],
    });
    const comments = await commentsOn(t.subtask.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.bodyMd).toContain('Reason: the vendor was dropped');
    expect(comments[0]!.bodyMd).not.toContain('Re-plan offered on');
    expect(readGuideTurnRecord(await rawGuideTurn(replyId))?.replanOffer ?? null).toBeNull();
    expect((await offerOn(opened.sessionId, replyId)).state).toBeNull();
    expect((await readSeed(replyId)).status).toBe(404);
  });

  it('a revise_step on a stale step is applied in place, with no offer and no re-plan comment', async () => {
    const t = await tree();
    const opened = await openGuide(t.subtask);
    const replyId = await land(opened, {
      messageMd: 'That step is out of date; I corrected it.',
      actions: [
        {
          type: 'revise_step',
          rowId: t.rows[2]!,
          text: 'Verify the sending domain in Postmark',
          reason: 'the provider moved',
        },
      ],
    });
    const row = await adminDb.workItemTodo.findUniqueOrThrow({ where: { id: t.rows[2]! } });
    expect(row.text).toBe('Verify the sending domain in Postmark');
    expect(await adminDb.workItemTodo.count({ where: { workItemId: t.subtask.id } })).toBe(4);
    expect(readGuideTurnRecord(await rawGuideTurn(replyId))?.replanOffer ?? null).toBeNull();
    expect(await commentsOn(t.subtask.id)).toHaveLength(0);
    expect((await readSeed(replyId)).status).toBe(404);
  });
});

// ── the Decline door's own refusals ──────────────────────────────────────────

describe('the Decline door refuses a malformed request before it reads anything', () => {
  it('no session, no active project, a body that is not JSON, and a missing id', async () => {
    const before = await counts();

    session.current = null;
    expect((await decline('s', 't')).status).toBe(401);
    signIn(ownerOf(fx));

    activeCtx.current = null;
    const noProject = await decline('s', 't');
    expect(noProject.status).toBe(404);
    expect(JSON.parse(noProject.text)).toMatchObject({ code: 'NO_ACTIVE_PROJECT' });
    signIn(ownerOf(fx));

    const notJson = await declineRoute(
      new Request(`${BASE}/api/ai/guide/offer/decline`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }),
    );
    expect(notJson.status).toBe(400);
    const nullBody = await declineRoute(
      new Request(`${BASE}/api/ai/guide/offer/decline`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'null',
      }),
    );
    expect(nullBody.status).toBe(400);
    for (const body of [{ sessionId: 's' }, { turnId: 't' }, { sessionId: 's', turnId: '' }]) {
      const res = await declineRoute(post('/api/ai/guide/offer/decline', body));
      expect(res.status).toBe(400);
      expect(((await res.json()) as Json).code).toBe('BAD_REQUEST');
    }
    // An unknown conversation is the shared not-found, and nothing is written.
    expect((await decline('cmunknownguidesession0000', 't')).status).toBe(404);
    expect(await counts()).toEqual(before);
  });
});
