import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalGateKind, ApprovalGateState, WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { buildScope, PROJECT_SCOPE } from '@/lib/planChange/scope';
import { EmptyPlanChangeTurnError, PlanSeedNotApplicableError } from '@/lib/planChange/errors';
import { usersService } from '@/lib/services/usersService';
import { createTestProject } from '../fixtures/projectFixtures';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// MOTIR-6207 — a planning SESSION REMEMBERS the gate that seeded it (story
// MOTIR-6068; `agent-authored-plans.md` AMENDMENT 17 §9), against a REAL
// Postgres. Only the motir-ai boundary client is mocked, as in every AI service
// test: the scope advisory lock, the gate row lock, the seeded read and the
// target lock all run for real.

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
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

const MINUTE = 60 * 1000;

let fx: WorkItemFixture;
let card: WorkItem;
let seq = 0;

function pctxFor(userId: string, f: WorkItemFixture = fx): ProjectContext {
  return { userId, workspaceId: f.workspaceId, projectId: f.projectId, project: f.project };
}

const scopeOf = (item: { identifier: string }) => buildScope([item.identifier]);

/** A gate row, created in its final state (the decided-immutable trigger fires
 *  on UPDATE, so a decided fixture is written in one INSERT). */
async function gate(
  item: { id: string; workspaceId: string; projectId: string } | null,
  kind: ApprovalGateKind,
  state: ApprovalGateState,
  where: { workspaceId: string; projectId: string } = fx,
): Promise<string> {
  seq += 1;
  const decided = state !== 'awaiting' && state !== 'superseded';
  const row = await adminDb.approvalGate.create({
    data: {
      workspaceId: item?.workspaceId ?? where.workspaceId,
      projectId: item?.projectId ?? where.projectId,
      workItemId: item?.id ?? null,
      kind,
      subjectId: `subject-${seq}`,
      state,
      ...(decided
        ? {
            decidedById: fx.ownerId,
            decidedAt: new Date(),
            decidedByLabel: 'Owner',
            noteMd: 'Not this direction.\nTry the other one.',
          }
        : {}),
    },
  });
  return row.id;
}

/** A second member of the project holding `ai:plan`. */
async function teammate(): Promise<ProjectContext> {
  seq += 1;
  const u = await usersService.createUser({
    email: `seed-teammate-${seq}@example.com`,
    password: 'correct-horse-battery-staple-9',
    name: `Teammate ${seq}`,
  });
  await adminDb.workspaceMembership.create({
    data: { userId: u.id, workspaceId: fx.workspaceId, role: 'member' },
  });
  await addToProjectAs({
    key: fx.project.identifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: u.id,
    role: 'member',
  });
  return pctxFor(u.id);
}

async function setActivity(sessionId: string, at: Date) {
  await adminDb.planChangeSession.update({
    where: { id: sessionId },
    data: { lastActivityAt: at },
  });
}

async function seedOf(sessionId: string): Promise<string | null> {
  return (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } }))
    .seedGateId;
}

async function counts() {
  return {
    sessions: await adminDb.planChangeSession.count(),
    turns: await adminDb.planChangeTurn.count(),
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  card = await createTestWorkItem(fx, { kind: 'story', title: 'The refused card' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('startSeededWithFirstTurn — a refused gate seeds a NEW session', () => {
  it.each([
    ['decision_approval', 'changes_requested'],
    ['decision_choice', 'changes_requested'],
    ['decision_confirmation', 'overturned'],
  ] as const)(
    '%s in %s: one conversation session stamped with the gate, holding one user turn',
    async (kind, state) => {
      const gateId = await gate(card, kind, state);
      const s = await planChangeSessionsService.startSeededWithFirstTurn(
        pctxFor(fx.ownerId),
        scopeOf(card),
        '  Re-plan from the reason  ',
        gateId,
      );

      expect(s.origin).toBe('conversation');
      expect(s.turns.map((t) => [t.role, t.body])).toEqual([['user', 'Re-plan from the reason']]);
      expect(s.targetKeys).toEqual([card.identifier]);
      expect(await seedOf(s.id)).toBe(gateId);
      expect(await counts()).toEqual({ sessions: 1, turns: 1 });
    },
  );

  it('a second call for the same gate within the window APPENDS to that session', async () => {
    const gateId = await gate(card, 'decision_approval', 'changes_requested');
    const me = pctxFor(fx.ownerId);
    const first = await planChangeSessionsService.startSeededWithFirstTurn(
      me,
      scopeOf(card),
      'one',
      gateId,
    );
    const second = await planChangeSessionsService.startSeededWithFirstTurn(
      me,
      scopeOf(card),
      'two',
      gateId,
      { isAnswer: true },
    );

    expect(second.id).toBe(first.id);
    expect(second.turns.map((t) => t.body)).toEqual(['one', 'two']);
    expect(second.turns[1]?.isAnswer).toBe(true);
    expect(await adminDb.planChangeSession.count()).toBe(1);
  });

  it('a call after the window starts a NEW seeded session and hands the target lock over', async () => {
    const gateId = await gate(card, 'decision_approval', 'changes_requested');
    const me = pctxFor(fx.ownerId);
    const old = await planChangeSessionsService.startSeededWithFirstTurn(
      me,
      scopeOf(card),
      'old',
      gateId,
    );
    await setActivity(old.id, new Date(Date.now() - 3 * 60 * MINUTE));

    const fresh = await planChangeSessionsService.startSeededWithFirstTurn(
      me,
      scopeOf(card),
      'new',
      gateId,
    );

    expect(fresh.id).not.toBe(old.id);
    expect(fresh.turns.map((t) => t.body)).toEqual(['new']);
    expect(await seedOf(fresh.id)).toBe(gateId);
    const lock = await adminDb.planTargetLock.findFirst({ where: { workItemId: card.id } });
    expect(lock?.sessionId).toBe(fresh.id);
  });

  it('never lands on the caller’s recent UNSEEDED session in the same scope, and leaves it unseeded', async () => {
    const gateId = await gate(card, 'decision_approval', 'changes_requested');
    const me = pctxFor(fx.ownerId);
    const plain = await planChangeSessionsService.startWithFirstTurn(me, scopeOf(card), 'plain');

    const seeded = await planChangeSessionsService.startSeededWithFirstTurn(
      me,
      scopeOf(card),
      'seeded',
      gateId,
    );

    expect(seeded.id).not.toBe(plain.id);
    expect(seeded.turns.map((t) => t.body)).toEqual(['seeded']);
    expect(await seedOf(plain.id)).toBeNull();
    expect(await seedOf(seeded.id)).toBe(gateId);
  });

  it('never lands on a session seeded by a DIFFERENT gate on the same card', async () => {
    const gateA = await gate(card, 'decision_approval', 'changes_requested');
    const gateB = await gate(card, 'decision_confirmation', 'overturned');
    const me = pctxFor(fx.ownerId);
    const a = await planChangeSessionsService.startSeededWithFirstTurn(
      me,
      scopeOf(card),
      'a',
      gateA,
    );
    const b = await planChangeSessionsService.startSeededWithFirstTurn(
      me,
      scopeOf(card),
      'b',
      gateB,
    );

    expect(b.id).not.toBe(a.id);
    expect(await seedOf(a.id)).toBe(gateA);
    expect(await seedOf(b.id)).toBe(gateB);
  });

  it('never resumes ANOTHER member’s session seeded by the same gate', async () => {
    const gateId = await gate(card, 'decision_approval', 'changes_requested');
    const other = await teammate();
    const theirs = await planChangeSessionsService.startSeededWithFirstTurn(
      other,
      scopeOf(card),
      'theirs',
      gateId,
    );
    await adminDb.planTargetLock.deleteMany({});

    const mine = await planChangeSessionsService.startSeededWithFirstTurn(
      pctxFor(fx.ownerId),
      scopeOf(card),
      'mine',
      gateId,
    );

    expect(mine.id).not.toBe(theirs.id);
    expect(mine.turns.map((t) => t.body)).toEqual(['mine']);
  });

  it('accepts the gate’s card among SEVERAL anchors of the scope', async () => {
    const other = await createTestWorkItem(fx, { kind: 'story', title: 'Another' });
    const gateId = await gate(card, 'decision_choice', 'changes_requested');
    const s = await planChangeSessionsService.startSeededWithFirstTurn(
      pctxFor(fx.ownerId),
      buildScope([other.identifier, card.identifier.toLowerCase()]),
      'both',
      gateId,
    );
    expect(await seedOf(s.id)).toBe(gateId);
  });

  it('TWO first turns racing for one gate, truly in parallel, end in ONE seeded session holding both', async () => {
    const gateId = await gate(card, 'decision_approval', 'changes_requested');
    const me = pctxFor(fx.ownerId);
    const [a, b] = await Promise.all([
      planChangeSessionsService.startSeededWithFirstTurn(me, scopeOf(card), 'tab A', gateId),
      planChangeSessionsService.startSeededWithFirstTurn(me, scopeOf(card), 'tab B', gateId),
    ]);

    expect(a.id).toBe(b.id);
    expect(await adminDb.planChangeSession.count()).toBe(1);
    const turns = await adminDb.planChangeTurn.findMany({
      where: { sessionId: a.id },
      orderBy: { seq: 'asc' },
    });
    expect(turns.map((t) => t.seq)).toEqual([0, 1]);
    expect(turns.map((t) => t.body).sort()).toEqual(['tab A', 'tab B']);
    expect(await seedOf(a.id)).toBe(gateId);
  });

  it('a gate row that goes leaves the session intact and UNSEEDED (ON DELETE SET NULL)', async () => {
    const gateId = await gate(card, 'decision_approval', 'changes_requested');
    const s = await planChangeSessionsService.startSeededWithFirstTurn(
      pctxFor(fx.ownerId),
      scopeOf(card),
      'x',
      gateId,
    );
    await adminDb.approvalGate.delete({ where: { id: gateId } });

    expect(await seedOf(s.id)).toBeNull();
    expect(await adminDb.planChangeTurn.count({ where: { sessionId: s.id } })).toBe(1);
  });

  it('an empty body is refused before anything is read or written', async () => {
    const gateId = await gate(card, 'decision_approval', 'changes_requested');
    await expect(
      planChangeSessionsService.startSeededWithFirstTurn(
        pctxFor(fx.ownerId),
        scopeOf(card),
        '   ',
        gateId,
      ),
    ).rejects.toBeInstanceOf(EmptyPlanChangeTurnError);
    expect(await counts()).toEqual({ sessions: 0, turns: 0 });
  });
});

describe('startSeededWithFirstTurn — the seed guard refuses, and writes nothing', () => {
  async function expectRefused(gateId: string, scope = scopeOf(card), pctx = pctxFor(fx.ownerId)) {
    await expect(
      planChangeSessionsService.startSeededWithFirstTurn(pctx, scope, 'seed me', gateId),
    ).rejects.toBeInstanceOf(PlanSeedNotApplicableError);
    expect(await counts()).toEqual({ sessions: 0, turns: 0 });
    expect(await adminDb.planTargetLock.count()).toBe(0);
  }

  it.each([
    ['decision_approval', 'awaiting'],
    ['decision_approval', 'approved'],
    ['decision_approval', 'superseded'],
    ['decision_choice', 'approved'],
    ['decision_confirmation', 'approved'],
    ['decision_confirmation', 'changes_requested'],
  ] as const)('a %s gate in %s', async (kind, state) => {
    await expectRefused(await gate(card, kind, state));
  });

  it.each([
    ['design_result', 'changes_requested'],
    ['pull_request_approval', 'changes_requested'],
    ['acceptance_result', 'changes_requested'],
  ] as const)('a refused gate of another kind (%s in %s)', async (kind, state) => {
    await expectRefused(await gate(card, kind, state));
  });

  it('a card-less plan_approval gate', async () => {
    await expectRefused(await gate(null, 'plan_approval', 'declined'));
  });

  it('a refused gate on a DIFFERENT work item than the scope anchors on', async () => {
    const elsewhere = await createTestWorkItem(fx, { kind: 'story', title: 'Elsewhere' });
    await expectRefused(await gate(elsewhere, 'decision_approval', 'changes_requested'));
  });

  it('the project-wide scope, which anchors on no card', async () => {
    await expectRefused(await gate(card, 'decision_approval', 'changes_requested'), PROJECT_SCOPE);
  });

  it('a refused gate from ANOTHER PROJECT of the same workspace', async () => {
    const project = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'ELSE',
    });
    const otherFx: WorkItemFixture = {
      ...fx,
      project,
      projectId: project.id,
      projectIdentifier: project.identifier,
    };
    const theirs = await createTestWorkItem(otherFx, { kind: 'story', title: 'Theirs' });
    const gateId = await gate(theirs, 'decision_approval', 'changes_requested');
    // Even a scope naming that card's identifier cannot adopt it here.
    await expectRefused(gateId, scopeOf(theirs));
  });

  it('a refused gate from ANOTHER WORKSPACE (hidden by RLS — indistinguishable from absent)', async () => {
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const theirs = await createTestWorkItem(rival, { kind: 'story', title: 'Theirs' });
    const gateId = await gate(theirs, 'decision_approval', 'changes_requested');
    await expectRefused(gateId, scopeOf(theirs));
  });

  it('an unknown gate id', async () => {
    await expectRefused('no-such-gate');
  });
});

describe('findSeededSession — the caller’s own recent seeded session, or null', () => {
  it('returns the caller’s recent session seeded by the gate, and writes nothing', async () => {
    const gateId = await gate(card, 'decision_approval', 'changes_requested');
    const me = pctxFor(fx.ownerId);
    const s = await planChangeSessionsService.startSeededWithFirstTurn(
      me,
      scopeOf(card),
      'x',
      gateId,
    );
    const before = await counts();

    expect(await planChangeSessionsService.findSeededSession(me, gateId)).toBe(s.id);
    expect(await counts()).toEqual(before);
  });

  it('is null once the session has gone quiet past the window', async () => {
    const gateId = await gate(card, 'decision_approval', 'changes_requested');
    const me = pctxFor(fx.ownerId);
    const s = await planChangeSessionsService.startSeededWithFirstTurn(
      me,
      scopeOf(card),
      'x',
      gateId,
    );
    const now = new Date();
    await setActivity(s.id, new Date(now.getTime() - 119 * MINUTE));
    expect(await planChangeSessionsService.findSeededSession(me, gateId, now)).toBe(s.id);
    await setActivity(s.id, new Date(now.getTime() - 121 * MINUTE));
    expect(await planChangeSessionsService.findSeededSession(me, gateId, now)).toBeNull();
  });

  it('is null for ANOTHER member’s seeded session, an unseeded one, or another gate’s', async () => {
    const gateId = await gate(card, 'decision_approval', 'changes_requested');
    const otherGate = await gate(card, 'decision_confirmation', 'overturned');
    const other = await teammate();
    await planChangeSessionsService.startSeededWithFirstTurn(
      other,
      scopeOf(card),
      'theirs',
      gateId,
    );
    const me = pctxFor(fx.ownerId);
    await adminDb.planTargetLock.deleteMany({});
    await planChangeSessionsService.startWithFirstTurn(me, scopeOf(card), 'unseeded');
    await adminDb.planTargetLock.deleteMany({});
    await planChangeSessionsService.startSeededWithFirstTurn(
      me,
      scopeOf(card),
      'other gate',
      otherGate,
    );

    expect(await planChangeSessionsService.findSeededSession(me, gateId)).toBeNull();
    expect(await planChangeSessionsService.findSeededSession(other, gateId)).not.toBeNull();
  });

  it('refuses a viewer who cannot browse the project (the browse verdict → 404 at the route)', async () => {
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const theirs = await createTestWorkItem(rival, { kind: 'story', title: 'Theirs' });
    const gateId = await gate(theirs, 'decision_approval', 'changes_requested');
    await planChangeSessionsService.startSeededWithFirstTurn(
      pctxFor(rival.ownerId, rival),
      scopeOf(theirs),
      'theirs',
      gateId,
    );

    // A stranger inside the RIGHT tenant: the project does not resolve for them.
    await expect(
      planChangeSessionsService.findSeededSession(pctxFor(fx.ownerId, rival), gateId),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
  });
});
