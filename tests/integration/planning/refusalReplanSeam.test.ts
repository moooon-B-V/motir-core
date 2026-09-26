import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalGateKind, WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { computeGateStamp } from '@/lib/approvalGates/stamp';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestWorkItem } from '../../fixtures/workItemFixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// STORY GATE — A REFUSED DECISION OPENS THE PLANNER (Story MOTIR-6068 · Subtask
// MOTIR-6212; ADR `approval-gates.md` §10f, `agent-authored-plans.md` AMENDMENT 17 §9).
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
const { GET: gateReadRoute } = await import('@/app/api/work-items/approval-gate/route');
const { POST: planRoute } = await import('@/app/api/work-items/[id]/ai/plan/route');

type Actor = { id: string; email: string; name: string };
type Seed = {
  gateId: string;
  gateKind: ApprovalGateKind;
  intent: 'plan' | 'replan';
  anchorKey: string;
  firstTurn: string;
  seededSessionId: string | null;
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

// ── the three refusals, pressed through the real door ────────────────────────

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

const DECISION_BODY = [
  '## Decision',
  'Exports move to managed object storage.',
  '## What changed',
  '**Change:** less requirement',
  'The approved plan kept exports in Postgres.',
  '## Supersedes',
  'PROD-41 and PROD-42',
  '## Resulting direction',
  'Every export is written to the bucket.',
].join('\n');

/** Multi-line, with characters a template would mangle — it must arrive verbatim. */
const REASONS: Record<Refusal, string> = {
  decision_approval:
    'The doc skips the backfill.\n\n  Say how the {old} rows move — it’s the risk.',
  decision_confirmation: 'We agreed to keep Postgres.\nAdd a cache in front of it instead.',
  decision_choice: 'Neither: the law differs per region.\nAsk per-region.',
};

type Refusal = 'decision_approval' | 'decision_confirmation' | 'decision_choice';
const REFUSALS: readonly [Refusal, 'changes_requested' | 'overturned', string][] = [
  ['decision_approval', 'changes_requested', 'Changes were requested on this decision.'],
  ['decision_confirmation', 'overturned', 'This decision was overturned.'],
  ['decision_choice', 'changes_requested', 'None of the options on this choice was picked.'],
];

/** An AWAITING gate of `kind` on a fresh card, and the stamp its reader was shown. */
async function awaitingGate(kind: Refusal) {
  seq += 1;
  if (kind === 'decision_approval') {
    // A bare awaiting gate, as `refusalReasonSeam.test.ts` raises it: the decision
    // document lives on a pull request this suite does not need to stand up.
    const card = await createTestWorkItem(fx, { kind: 'story', title: `Decision ${seq}` });
    const gate = await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: card.id,
        kind,
        subjectId: `subject-${seq}`,
        subjectVersion: 'v1',
        state: 'awaiting',
      },
    });
    const stamp = computeGateStamp({
      subjectVersion: 'v1',
      companionSubjectVersion: null,
      descriptionMd: card.descriptionMd ?? null,
    });
    return { card, gateId: gate.id, stamp };
  }
  // The choice and the confirmation are raised by the product itself, from the body.
  const created = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title: kind === 'decision_choice' ? `Choice ${seq}` : `Confirmation ${seq}`,
      type: kind === 'decision_choice' ? 'choice' : 'decision',
      executor: 'human',
      descriptionMd: kind === 'decision_choice' ? CHOICE_BODY : DECISION_BODY,
    },
    fx.ctx,
  );
  const read = await approvalGatesService.getForWorkItem({ workItemId: created.id, kind }, fx.ctx);
  expect(read.gate?.state).toBe('awaiting');
  const card = await adminDb.workItem.findUniqueOrThrow({ where: { id: created.id } });
  return { card, gateId: read.gate!.id, stamp: read.stamp! };
}

/** Refuse it exactly as the press does: the door, a reason, the reader's stamp. */
async function refuse(kind: Refusal): Promise<{ card: WorkItem; gateId: string }> {
  const { card, gateId, stamp } = await awaitingGate(kind);
  await approvalGatesService.decide(
    {
      gateId,
      decision: kind === 'decision_confirmation' ? 'overturn' : 'request_changes',
      noteMd: REASONS[kind],
      source: 'ui',
      stamp,
    },
    fx.ctx,
  );
  return { card, gateId };
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

async function send(
  card: WorkItem,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
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

async function overlayRead(card: WorkItem, kind: Refusal) {
  const res = await gateReadRoute(
    new Request(
      `http://localhost:3000/api/work-items/approval-gate?key=${card.identifier}&kind=${kind}`,
    ),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    gate: { id: string; state: string; noteMd: string | null };
    canReplan: boolean;
  };
}

async function counts() {
  return {
    sessions: await adminDb.planChangeSession.count(),
    turns: await adminDb.planChangeTurn.count(),
    jobRuns: await adminDb.jobRun.count(),
    submits: submitJobMock.mock.calls.length,
  };
}

const sessionRow = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });

// ── 1 · THE SEAM, once per kind ──────────────────────────────────────────────

describe('the seam — refuse → door → seed read → seeded send → session → door returns → Plans row', () => {
  for (const [kind, state, verb] of REFUSALS) {
    it(`${kind} (${state})`, async () => {
      const { card, gateId } = await refuse(kind);

      // THE PRESS landed: refused, with the reason stored verbatim.
      const gateRow = await adminDb.approvalGate.findUniqueOrThrow({ where: { id: gateId } });
      expect(gateRow).toMatchObject({ state, noteMd: REASONS[kind], decisionSource: 'ui' });

      // THE DOOR's condition, from the overlay's own read of the decided gate.
      const overlay = await overlayRead(card, kind);
      expect(overlay.gate).toMatchObject({ id: gateId, state, noteMd: REASONS[kind] });
      expect(overlay.canReplan).toBe(true);

      // THE SEED READ — composed from the row the press wrote.
      const before = await counts();
      const seed = await seedOf(gateId);
      expect(seed).toEqual({
        gateId,
        gateKind: kind,
        intent: 'replan',
        anchorKey: card.identifier,
        firstTurn: expect.any(String),
        seededSessionId: null,
      });
      expect(seed.firstTurn.startsWith(`${card.identifier} · ${card.title}`)).toBe(true);
      expect(seed.firstTurn).toContain(verb);
      expect(seed.firstTurn).toContain(REASONS[kind]); // verbatim, line breaks and braces kept
      if (kind === 'decision_confirmation') {
        expect(seed.firstTurn).toContain('The work items it superseded: PROD-41, PROD-42');
      } else {
        expect(seed.firstTurn).not.toContain('superseded');
      }
      expect(await counts()).toEqual(before);

      // THE SEND — the seed's own first turn, carrying the gate once.
      const sent = await send(card, {
        prompt: seed.firstTurn,
        isAnswer: false,
        seedGateId: gateId,
      });
      expect(sent.status).toBe(200);
      const sessionId = sent.json['sessionId'] as string;
      expect(await sessionRow(sessionId)).toMatchObject({
        seedGateId: gateId,
        createdById: fx.ownerId,
        projectId: fx.projectId,
      });
      const turns = await adminDb.planChangeTurn.findMany({
        where: { sessionId, role: 'user' },
      });
      expect(turns.map((t) => t.body)).toEqual([seed.firstTurn]);
      expect(submitJobMock).toHaveBeenCalledTimes(1);

      // THE DOOR RETURNS to that session.
      expect((await seedOf(gateId)).seededSessionId).toBe(sessionId);

      // THE PLANS ROW names the refused card and the kind.
      const page = await planSessionsService.listSessions(fx.projectId, fx.ctx);
      const row = page.sessions.find((s) => s.id === sessionId);
      expect(row?.seed).toEqual({ cardKey: card.identifier, gateKind: kind });
    });
  }
});

// ── 2 · NO LEAK ──────────────────────────────────────────────────────────────

describe('no leak — two viewers who cannot see the card get the identical 404, and no reason', () => {
  it('a member outside the private project and an owner in another workspace', async () => {
    const { gateId } = await refuse('decision_approval');
    const reasonFragments = ['backfill', '{old}', REASONS.decision_approval];

    // The owner sees the refusal and its reason…
    const seen = await readSeed(gateId);
    expect(seen.status).toBe(200);
    expect(seen.text).toContain('backfill');

    // …a workspace member outside the (now private) project sees nothing…
    const outsider = await member(false);
    await adminDb.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'private' } });
    signIn(outsider, fx, 'private');
    const hidden = await readSeed(gateId);

    // …and neither does the owner of another workspace.
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    signIn(ownerOf(rival), rival);
    const foreign = await readSeed(gateId);

    // And an id that never existed, for the body the other two must match.
    const absent = await readSeed('cmg-no-such-gate');

    for (const res of [hidden, foreign, absent]) {
      expect(res.status).toBe(404);
      expect(JSON.parse(res.text)).toEqual({ code: 'NOT_FOUND' });
      for (const fragment of reasonFragments) expect(res.text).not.toContain(fragment);
    }
    expect(hidden.text).toBe(absent.text);
    expect(foreign.text).toBe(absent.text);
  });

  it('neither of them can seed a session from it either: 422 SEED_NOT_APPLICABLE, nothing written', async () => {
    const { gateId } = await refuse('decision_choice');
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const theirCard = await createTestWorkItem(rival, { kind: 'story', title: 'Theirs' });
    signIn(ownerOf(rival), rival);
    const before = await counts();

    const res = await send(theirCard, { prompt: 'Re-plan it', seedGateId: gateId });

    expect(res.status).toBe(422);
    expect(res.json).toEqual({ code: 'SEED_NOT_APPLICABLE' });
    expect(await counts()).toEqual(before);
  });
});

// ── 3 · ONCE-ONLY ────────────────────────────────────────────────────────────

describe('once-only — the seed is stamped on the first sent turn and never again', () => {
  it('a second turn — even one carrying a DIFFERENT refused gate — leaves seedGateId as it was', async () => {
    const first = await refuse('decision_confirmation');
    const seed = await seedOf(first.gateId);
    const sent = await send(first.card, { prompt: seed.firstTurn, seedGateId: first.gateId });
    const sessionId = sent.json['sessionId'] as string;
    const stamped = await sessionRow(sessionId);

    // Another refusal the same viewer may seed from — the stray value on a continuing turn.
    const other = await refuse('decision_approval');
    const second = await send(first.card, {
      prompt: 'Also keep the audit log.',
      sessionId,
      seedGateId: other.gateId,
    });
    expect(second.status).toBe(200);
    expect(second.json['sessionId']).toBe(sessionId);

    const after = await sessionRow(sessionId);
    expect(after.seedGateId).toBe(first.gateId);
    expect(after.createdAt).toEqual(stamped.createdAt);
    expect(await adminDb.planChangeSession.count()).toBe(1);
    expect(await adminDb.planChangeTurn.count({ where: { sessionId, role: 'user' } })).toBe(2);
    // The other gate seeded nothing, so its door still offers a fresh start.
    expect((await seedOf(other.gateId)).seededSessionId).toBeNull();
  });
});

// ── 4 · ISOLATION ────────────────────────────────────────────────────────────

describe('isolation — the door returns each member to their OWN seeded session', () => {
  it('B pressing the door on A’s refused gate starts fresh, and B’s send makes B’s own session', async () => {
    // A (the owner) refuses and re-plans.
    const { card, gateId } = await refuse('decision_approval');
    const seedA = await seedOf(gateId);
    const sentA = await send(card, { prompt: seedA.firstTurn, seedGateId: gateId });
    expect(sentA.status).toBe(200);
    const sessionA = sentA.json['sessionId'] as string;
    expect((await seedOf(gateId)).seededSessionId).toBe(sessionA);

    // B — a member of the same project — reads the same refusal, with no session of theirs.
    const b = await member(true);
    signIn(b);
    const seedB = await seedOf(gateId);
    expect(seedB.seededSessionId).toBeNull();
    expect(seedB.firstTurn).toBe(seedA.firstTurn);

    // While A's session still holds the card, B's seeded send is the ordinary
    // target-lock refusal (MOTIR-2787) — it never lands B on A's session.
    const whileHeld = await send(card, { prompt: seedB.firstTurn, seedGateId: gateId });
    expect(whileHeld.status).toBe(409);
    expect(whileHeld.json['code']).toBe('PLAN_TARGET_LOCKED');
    expect(await adminDb.planChangeSession.count()).toBe(1);

    // Once A's lease has run out, B's send reclaims the card in a session of B's own.
    await adminDb.planTargetLock.updateMany({
      where: { workItemId: card.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const sentB = await send(card, { prompt: seedB.firstTurn, seedGateId: gateId });
    expect(sentB.status).toBe(200);
    const sessionB = sentB.json['sessionId'] as string;
    expect(sessionB).not.toBe(sessionA);
    expect(await sessionRow(sessionB)).toMatchObject({ seedGateId: gateId, createdById: b.id });
    expect((await seedOf(gateId)).seededSessionId).toBe(sessionB);

    // A's door still points at A's session — B's send took nothing from it.
    signIn(ownerOf(fx));
    expect((await seedOf(gateId)).seededSessionId).toBe(sessionA);
    expect(await sessionRow(sessionA)).toMatchObject({
      seedGateId: gateId,
      createdById: fx.ownerId,
    });
  });
});

// ── 5 · NOTHING ON READ ──────────────────────────────────────────────────────

describe('nothing on read — opening the seed creates no session, turn or job', () => {
  it('for the owner (200), repeatedly, and for a viewer refused with the 404', async () => {
    const { gateId } = await refuse('decision_choice');
    const before = await counts();

    for (let i = 0; i < 3; i += 1) expect((await readSeed(gateId)).status).toBe(200);
    const outsider = await member(false);
    await adminDb.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'private' } });
    signIn(outsider, fx, 'private');
    expect((await readSeed(gateId)).status).toBe(404);

    expect(await counts()).toEqual(before);
    expect(before).toMatchObject({ sessions: 0, turns: 0, submits: 0 });
  });
});
