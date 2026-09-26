import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalGateKind, WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestWorkItem } from '../../fixtures/workItemFixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// STORY GATE — A PICKED OPTION IS PLANNED (Story MOTIR-6069 · Subtask MOTIR-6437;
// `picked-option-planning.md`, `picked-option-planning-starts.md`). Harness lifted
// from the refusal seam (MOTIR-6212, `refusalReplanSeam.test.ts`); its prose below
// describes that suite's seam, and this file holds the PICK's: choose → seed read →
// the stamped send on the RESOLVED ANCHOR → resume → Plans row, for all three anchor
// cases, with the read and the guard agreeing on each.
//
// Each builder card tests its own half and mocks its neighbours: the session stamp
// (`tests/ai/planChangeSeededSession.test.ts`), the seed read
// (`tests/api/approval-gate-planning-seed-route.test.ts`), the Plans row
// (`tests/integration/plans/planSessionsSeed.test.ts`), the seeded first turn on the
// wire (`tests/ai/refusalSeededFirstTurn.test.ts`) and the ask/door
// (`tests/components/refusal-replan.test.tsx`). This file holds the SEAM between them
// on real Postgres, once per refusal kind: the person's press through
// `approvalGatesService.decide` → the overlay's gate read (the door's `canReplan`) →
// the seed read → the seed's OWN first turn sent through `POST
// /api/work-items/{id}/ai/plan` with `seedGateId` → the stamped session → the seed
// read pointing the door back at it → the Plans row naming the card. Then the guards a
// percentage cannot see: no leak, once-only, isolation and nothing-on-read — each on a
// fixture where the two actors genuinely see different things.
//
// Stubs: only the context resolvers a Vitest process cannot supply through cookies
// (the session, the active project, the request locale) and the motir-ai boundary
// client, exactly as the planning integration tests stub it.

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
const submitJobMock = vi.fn(async (..._args: unknown[]) => ({ jobId: `job-seam-${++jobSeq}` }));
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

const { workItemsService } = await import('@/lib/services/workItemsService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { planSessionsService } = await import('@/lib/services/planSessionsService');
const { GET: seedRoute } = await import('@/app/api/approval-gates/[id]/planning-seed/route');
const { POST: planRoute } = await import('@/app/api/work-items/[id]/ai/plan/route');
const { POST: askRoute } = await import('@/app/api/ai/ask/route');

type Actor = { id: string; email: string; name: string };
type Seed = {
  gateId: string;
  gateKind: ApprovalGateKind;
  intent: 'plan' | 'replan';
  anchorKey: string | null;
  firstTurn: string;
  seededSessionId: string | null;
  pick?: { choiceKey: string; label: string; bestFor: string };
};

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  submitJobMock.mockClear();
  fx = await makeWorkItemFixture();
  signIn(ownerOf(fx));
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── actors ────────────────────────────────────────────────────────────────────

const ownerOf = (f: WorkItemFixture): Actor => ({
  id: f.owner.id,
  email: f.owner.email,
  name: f.owner.name,
});

function signIn(actor: Actor, on: WorkItemFixture = fx, accessLevel?: 'private') {
  session.current = { user: { id: actor.id, email: actor.email, name: actor.name } };
  activeCtx.current = {
    userId: actor.id,
    workspaceId: on.workspaceId,
    projectId: on.projectId,
    project: { ...on.project, ...(accessLevel ? { accessLevel } : {}) },
  } as ProjectContext;
}

/** A plain workspace member; `inProject` also adds them to the fixture's project. */
async function member(inProject: boolean): Promise<Actor> {
  seq += 1;
  const user = await createTestUser({ name: `Member ${seq}` });
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: fx.workspaceId, role: 'member' },
  });
  if (inProject) {
    await projectMembersService.addMember({
      key: fx.project.identifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: user.id,
      role: 'member',
    });
  }
  return { id: user.id, email: user.email, name: user.name };
}

// ── a choice, raised by the product and CHOSEN through the real door ─────────

const CHOICE_BODY = [
  '## Question',
  'Where do exported reports live?',
  '## Why this is a choice',
  '**Situation:** contradicts your decision',
  '**You said:** "Keep every export forever."',
  'Research found the retention law caps it at seven years.',
  '## Options',
  '### Seven years, then delete',
  '**Best if you want:** less to operate',
  'The law’s own ceiling.',
  '### Keep, but anonymise after seven',
  '**Best if you want:** more customisable later',
  'The data stays useful.',
  '## What this choice gates',
  'The retention story.',
].join('\n');

/** An awaiting choice under `parentId` (or at the root), raised from its body. */
async function awaitingChoice(parentId: string | null) {
  seq += 1;
  const created = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: parentId ? 'subtask' : 'task',
      title: `Choice ${seq}`,
      type: 'choice',
      executor: 'human',
      descriptionMd: CHOICE_BODY,
      ...(parentId ? { parentId } : {}),
    },
    fx.ctx,
  );
  const read = await approvalGatesService.getForWorkItem(
    { workItemId: created.id, kind: 'decision_choice' },
    fx.ctx,
  );
  expect(read.gate?.state).toBe('awaiting');
  const card = await adminDb.workItem.findUniqueOrThrow({ where: { id: created.id } });
  return { card, gateId: read.gate!.id, stamp: read.stamp! };
}

/** CHOOSE it exactly as the press does: the option, the reader's stamp. */
async function choose(parentId: string | null): Promise<{ card: WorkItem; gateId: string }> {
  const { card, gateId, stamp } = await awaitingChoice(parentId);
  await approvalGatesService.decide(
    {
      gateId,
      decision: 'choose',
      optionId: 'seven-years-then-delete',
      source: 'ui',
      stamp,
    },
    fx.ctx,
  );
  return { card, gateId };
}

async function setStatus(id: string, status: string) {
  await adminDb.workItem.update({ where: { id }, data: { status } });
}

// ── the wire ─────────────────────────────────────────────────────────────────

async function readSeed(gateId: string): Promise<{ status: number; text: string }> {
  const res = await seedRoute(
    new Request(`http://localhost:3000/api/approval-gates/${gateId}/planning-seed`),
    { params: Promise.resolve({ id: gateId }) },
  );
  return { status: res.status, text: await res.text() };
}

async function seedOf(gateId: string): Promise<Seed> {
  const res = await readSeed(gateId);
  expect(res.status).toBe(200);
  return (JSON.parse(res.text) as { seed: Seed }).seed;
}

/** A first turn on a CARD scope — the anchored plan route. */
async function sendOn(card: WorkItem, body: Record<string, unknown>) {
  const res = await planRoute(
    new Request(`http://localhost:3000/api/work-items/${card.id}/ai/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: card.id }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** A first turn on the PROJECT scope — the one door, `POST /api/ai/ask`. */
async function sendOnProject(body: Record<string, unknown>) {
  const res = await askRoute(
    new Request('http://localhost:3000/api/ai/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function counts() {
  return {
    sessions: await adminDb.planChangeSession.count(),
    turns: await adminDb.planChangeTurn.count(),
  };
}

const seededSessions = (gateId: string) =>
  adminDb.planChangeSession.findMany({ where: { seedGateId: gateId } });

// ── 1 · THE SEAM, for all three anchor cases ─────────────────────────────────

describe('the seam — choose → seed read → stamped send on the ANCHOR → resume → Plans row', () => {
  it('under an open STORY: the anchor is the story, and only the story’s scope is stamped', async () => {
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Retention' });
    await setStatus(story.id, 'todo');
    const { card, gateId } = await choose(story.id);

    // The body edited AFTER the pick: the seed still quotes the STAMP.
    await adminDb.workItem.update({
      where: { id: card.id },
      data: { descriptionMd: '## Options\n- Something else entirely' },
    });
    const seed = await seedOf(gateId);
    expect(seed).toMatchObject({
      intent: 'plan',
      anchorKey: story.identifier,
      seededSessionId: null,
    });
    expect(seed.firstTurn).toContain('The option chosen: Seven years, then delete');
    expect(seed.firstTurn).toContain('Best if you want: less to operate');
    expect(seed.firstTurn).toContain('The retention story.');
    expect(seed.firstTurn).not.toContain('Something else entirely');
    expect(seed.pick).toMatchObject({
      choiceKey: card.identifier,
      label: 'Seven years, then delete',
    });

    // The WRONG scope — the choice card itself — is refused and writes nothing.
    const before = await counts();
    const wrong = await sendOn(card, { prompt: seed.firstTurn, seedGateId: gateId });
    expect(wrong.status).toBe(422);
    expect(wrong.json).toEqual({ code: 'SEED_NOT_APPLICABLE' });
    expect(await counts()).toEqual(before);

    // The ANCHOR's scope — the story — is stamped: the read and the guard agree.
    const sent = await sendOn(story, { prompt: seed.firstTurn, seedGateId: gateId });
    expect(sent.status).toBe(200);
    const [stamped] = await seededSessions(gateId);
    expect(stamped!.targetKeys).toEqual([story.identifier]);

    // THE DOOR RETURNS to it — for this viewer only.
    expect((await seedOf(gateId)).seededSessionId).toBe(stamped!.id);
    const mate = await member(true);
    signIn(mate);
    expect((await seedOf(gateId)).seededSessionId).toBeNull();
  });

  it('under a DONE story in an open EPIC: the anchor is the epic', async () => {
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Exports' });
    await setStatus(epic.id, 'in_progress');
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Done', parentId: epic.id });
    await setStatus(story.id, 'done');
    const { gateId } = await choose(story.id);

    const seed = await seedOf(gateId);
    expect(seed.anchorKey).toBe(epic.identifier);
    const before = await counts();
    expect((await sendOn(story, { prompt: seed.firstTurn, seedGateId: gateId })).status).toBe(422);
    expect(await counts()).toEqual(before);
    expect((await sendOn(epic, { prompt: seed.firstTurn, seedGateId: gateId })).status).toBe(200);
    const [stamped] = await seededSessions(gateId);
    expect(stamped!.targetKeys).toEqual([epic.identifier]);
  });

  it('a ROOT choice: the anchor is the PROJECT, stamped through the one door', async () => {
    const other = await createTestWorkItem(fx, { kind: 'story', title: 'Unrelated' });
    const { gateId } = await choose(null);

    const seed = await seedOf(gateId);
    expect(seed.anchorKey).toBeNull();
    expect(seed.firstTurn).toContain('This choice has no open container');
    const before = await counts();
    expect((await sendOn(other, { prompt: seed.firstTurn, seedGateId: gateId })).status).toBe(422);
    expect(await counts()).toEqual(before);

    const sent = await sendOnProject({ body: seed.firstTurn, seedGateId: gateId });
    expect(sent.status).toBe(200);
    const [stamped] = await seededSessions(gateId);
    expect(stamped!.targetKeys).toEqual([]);
    expect((await seedOf(gateId)).seededSessionId).toBe(stamped!.id);
  });
});

// ── 2 · THE PLANS ROW — a pick beside a refusal ──────────────────────────────

describe('the Plans row names a pick as a pick, and a refusal as a refusal', () => {
  it('origin pick with the chosen label, and origin refusal for None of these, side by side', async () => {
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Retention' });
    const picked = await choose(story.id);
    const pickSeed = await seedOf(picked.gateId);
    await sendOn(story, { prompt: pickSeed.firstTurn, seedGateId: picked.gateId });

    const none = await awaitingChoice(null);
    await approvalGatesService.decide(
      {
        gateId: none.gateId,
        decision: 'request_changes',
        noteMd: 'Neither: the law differs per region.',
        source: 'ui',
        stamp: none.stamp,
      },
      fx.ctx,
    );
    const noneSeed = await seedOf(none.gateId);
    expect(noneSeed.intent).toBe('replan');
    await sendOn(none.card, { prompt: noneSeed.firstTurn, seedGateId: none.gateId });

    const page = await planSessionsService.listSessions(fx.projectId, fx.ctx);
    const seeds = page.sessions.map((s) => s.seed).filter(Boolean);
    expect(seeds).toEqual(
      expect.arrayContaining([
        {
          cardKey: picked.card.identifier,
          gateKind: 'decision_choice',
          origin: 'pick',
          chosenLabel: 'Seven years, then delete',
        },
        {
          cardKey: none.card.identifier,
          gateKind: 'decision_choice',
          origin: 'refusal',
          chosenLabel: null,
        },
      ]),
    );
  });
});

// ── 3 · GUARDS ───────────────────────────────────────────────────────────────

describe('guards — no leak, not-a-pick, refusals unchanged, tenancy', () => {
  it('a viewer who cannot browse the choice gets the SAME 404 as an unknown id', async () => {
    const { gateId } = await choose(null);
    const outsider = await member(false);
    await adminDb.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'private' } });
    signIn(outsider, fx, 'private');
    const hidden = await readSeed(gateId);
    const unknown = await readSeed('cmunknowngate000000000000');
    expect(hidden.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(hidden.text).toBe(unknown.text);
  });

  it('an AWAITING choice is no seed at all', async () => {
    const { gateId } = await awaitingChoice(null);
    expect((await readSeed(gateId)).status).toBe(404);
  });

  it('None of these still seeds a REPLAN on its own card, with its shipped turn', async () => {
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Retention' });
    const none = await awaitingChoice(story.id);
    await approvalGatesService.decide(
      {
        gateId: none.gateId,
        decision: 'request_changes',
        noteMd: 'Neither.',
        source: 'ui',
        stamp: none.stamp,
      },
      fx.ctx,
    );
    const seed = await seedOf(none.gateId);
    expect(seed).toMatchObject({ intent: 'replan', anchorKey: none.card.identifier });
    expect(seed.firstTurn).toContain('None of the options on this choice was picked.');
    expect(seed.pick).toBeUndefined();
  });

  it('a pick gate in ANOTHER PROJECT of the workspace is a 404 here', async () => {
    const { gateId } = await choose(null);
    const elsewhere = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSW' });
    signIn(ownerOf(elsewhere), elsewhere);
    expect((await readSeed(gateId)).status).toBe(404);
  });
});
