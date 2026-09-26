import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalGateKind, ApprovalGateState, WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope, PROJECT_SCOPE } from '@/lib/planChange/scope';
import { usersService } from '@/lib/services/usersService';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { createTestProject } from '../../fixtures/projectFixtures';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';

// MOTIR-6209 — a Plans row NAMES the refused work item its session was seeded
// from (story MOTIR-6068; design MOTIR-6206 `plans-sessions--seeded.mock.html`).
// Real Postgres, the real service, repository and mapper; only the motir-ai
// boundary is mocked, as in every planning service test.

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(async () => ({ jobId: 'job-seed' })),
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
const { planSessionsService } = await import('@/lib/services/planSessionsService');

let fx: WorkItemFixture;
let seq = 0;

function pctx(userId = fx.ownerId): ProjectContext {
  return { userId, workspaceId: fx.workspaceId, projectId: fx.projectId, project: fx.project };
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

/** A decided gate, written in its final state in one INSERT (the
 *  decided-immutable trigger fires on UPDATE). */
async function refusedGate(
  item: WorkItem,
  kind: ApprovalGateKind,
  state: ApprovalGateState,
): Promise<string> {
  seq += 1;
  const row = await adminDb.approvalGate.create({
    data: {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      workItemId: item.id,
      kind,
      subjectId: `subject-${seq}`,
      state,
      decidedById: fx.ownerId,
      decidedAt: new Date(),
      decidedByLabel: 'Owner',
      noteMd: 'Not this direction.',
    },
  });
  return row.id;
}

/** A session SEEDED by a refusal of `kind` on a fresh card, aged to `minutes`. */
async function seededSession(
  kind: ApprovalGateKind,
  state: ApprovalGateState,
  minutes: number,
): Promise<{ sessionId: string; gateId: string; card: WorkItem }> {
  const card = await createTestWorkItem(fx, { kind: 'story', title: `Refused card ${kind}` });
  const gateId = await refusedGate(card, kind, state);
  const s = await planChangeSessionsService.startSeededWithFirstTurn(
    pctx(),
    buildScope([card.identifier]),
    `${card.identifier} · ${card.title}\nRe-plan this work item from that reason.`,
    gateId,
  );
  await adminDb.planChangeSession.update({
    where: { id: s.id },
    data: { lastActivityAt: minutesAgo(minutes) },
  });
  return { sessionId: s.id, gateId, card };
}

/** An UNSEEDED project-wide conversation, aged past the resume window (plus
 *  `minutes`) so the next first turn in the scope starts a new session. */
async function plainSession(body: string, minutes: number): Promise<string> {
  const s = await planChangeSessionsService.startWithFirstTurn(pctx(), PROJECT_SCOPE, body);
  await adminDb.planChangeSession.update({
    where: { id: s.id },
    data: { lastActivityAt: minutesAgo(180 + minutes) },
  });
  return s.id;
}

/** A plain workspace MEMBER who is a member of this project only. */
async function teammate(): Promise<ProjectContext> {
  seq += 1;
  const u = await usersService.createUser({
    email: `seed-row-teammate-${seq}@example.com`,
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
  return pctx(u.id);
}

/** Move the card to a PRIVATE project the teammate is not a member of. */
async function moveOutOfReach(card: WorkItem): Promise<void> {
  const elsewhere = await createTestProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ownerId,
    identifier: 'HIDN',
  });
  await adminDb.project.update({ where: { id: elsewhere.id }, data: { accessLevel: 'private' } });
  await adminDb.workItem.update({ where: { id: card.id }, data: { projectId: elsewhere.id } });
}

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a seeded session’s row carries its seed', () => {
  it('each of the three refusals resolves to the refused card’s key and the gate kind', async () => {
    const approval = await seededSession('decision_approval', 'changes_requested', 1);
    const confirmation = await seededSession('decision_confirmation', 'overturned', 2);
    const choice = await seededSession('decision_choice', 'changes_requested', 3);

    const page = await planSessionsService.listSessions(fx.projectId, fx.ctx);

    expect(page.sessions.map((s) => [s.id, s.seed])).toEqual([
      [approval.sessionId, { cardKey: approval.card.identifier, gateKind: 'decision_approval' }],
      [
        confirmation.sessionId,
        { cardKey: confirmation.card.identifier, gateKind: 'decision_confirmation' },
      ],
      [choice.sessionId, { cardKey: choice.card.identifier, gateKind: 'decision_choice' }],
    ]);
    // A browsable seed leaves the title alone.
    expect(page.sessions[0]!.firstTurn).toBe(
      `${approval.card.identifier} · ${approval.card.title}\nRe-plan this work item from that reason.`,
    );
  });

  it('an unseeded session’s seed is null and its row is otherwise unchanged', async () => {
    const id = await plainSession('Split invoicing out of billing', 1);

    const [row] = (await planSessionsService.listSessions(fx.projectId, fx.ctx)).sessions;

    expect(row).toMatchObject({ id, firstTurn: 'Split invoicing out of billing', seed: null });
  });

  it('the `?session=` landing row carries the seed too', async () => {
    const { sessionId, card } = await seededSession('decision_approval', 'changes_requested', 1);

    const row = await planSessionsService.getSessionRow(fx.projectId, sessionId, fx.ctx);

    expect(row!.seed).toEqual({ cardKey: card.identifier, gateKind: 'decision_approval' });
  });

  it('another member of the project sees the same seed (the list is project-wide)', async () => {
    const { card } = await seededSession('decision_choice', 'changes_requested', 1);
    const mate = await teammate();

    const [row] = (
      await planSessionsService.listSessions(fx.projectId, {
        userId: mate.userId,
        workspaceId: mate.workspaceId,
      })
    ).sessions;

    expect(row!.seed).toEqual({ cardKey: card.identifier, gateKind: 'decision_choice' });
  });
});

describe('an unresolvable seed resolves to null', () => {
  it('the gate row deleted (SetNull): no seed, the session and its turn intact', async () => {
    const { sessionId, gateId } = await seededSession('decision_approval', 'changes_requested', 1);
    await adminDb.approvalGate.delete({ where: { id: gateId } });

    const [row] = (await planSessionsService.listSessions(fx.projectId, fx.ctx)).sessions;

    expect(row!.id).toBe(sessionId);
    expect(row!.seed).toBeNull();
    expect(row!.firstTurn).toContain('Re-plan this work item');
  });

  it('the card out of the viewer’s reach: no seed, and the first turn — which names the card — is withheld', async () => {
    const { sessionId, card } = await seededSession('decision_confirmation', 'overturned', 1);
    const mate = await teammate();
    await moveOutOfReach(card);

    const [row] = (
      await planSessionsService.listSessions(fx.projectId, {
        userId: mate.userId,
        workspaceId: mate.workspaceId,
      })
    ).sessions;

    expect(row!.id).toBe(sessionId);
    expect(row!.seed).toBeNull();
    expect(row!.firstTurn).toBeNull();
    expect(JSON.stringify(row)).not.toContain(card.title);
  });

  it('a gate kind outside the allowlist: no seed, the title untouched', async () => {
    const { sessionId, card } = await seededSession('decision_approval', 'changes_requested', 1);
    // A seed the stamp never writes today — the union is the three decision refusals
    // and the design Re-plan, and widening it further is MOTIR-6071's. The mapper
    // still answers null.
    const other = await refusedGate(card, 'acceptance_result', 'changes_requested');
    await adminDb.planChangeSession.update({
      where: { id: sessionId },
      data: { seedGateId: other },
    });

    const row = await planSessionsService.getSessionRow(fx.projectId, sessionId, fx.ctx);

    expect(row!.seed).toBeNull();
    expect(row!.firstTurn).toContain('Re-plan this work item');
  });
});

describe('the seed costs no query of its own', () => {
  it('a page of mixed seeded and unseeded rows is ONE statement', async () => {
    await seededSession('decision_approval', 'changes_requested', 1);
    await plainSession('plain one', 2);
    await seededSession('decision_choice', 'changes_requested', 3);
    await plainSession('plain two', 4);
    await seededSession('decision_confirmation', 'overturned', 5);

    const calls: string[] = [];
    const rows = await adminDb.$transaction(async (tx) => {
      const counted = new Proxy(tx, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (
            typeof prop === 'string' &&
            !prop.startsWith('_') &&
            prop !== 'then' &&
            !prop.endsWith('Internal')
          ) {
            calls.push(prop);
          }
          return value;
        },
      });
      return planChangeSessionRepository.listPageByProject(
        {
          projectId: fx.projectId,
          workspaceId: fx.workspaceId,
          limit: 10,
          after: null,
          state: null,
        },
        counted,
      );
    });

    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r.seedCardKey !== null)).toHaveLength(3);
    expect(calls).toEqual(['$queryRaw']);
  });
});

// MOTIR-6424 — a session seeded by a design Re-plan is anchored on the design card's
// PARENT, and its Plans row names the refused DESIGN card through the allowlist.
describe('a design Re-plan seed', () => {
  it('stamps the session anchored on the parent, and the row names the design card', async () => {
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Exports' });
    const design = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'Empty state design',
      parentId: story.id,
    });
    seq += 1;
    const gate = await adminDb.approvalGate.create({
      data: {
        workspaceId: design.workspaceId,
        projectId: design.projectId,
        workItemId: design.id,
        kind: 'design_result',
        subjectId: `subject-${seq}`,
        state: 'changes_requested',
        decidedById: fx.ownerId,
        decidedAt: new Date(),
        decidedByLabel: 'Owner',
        noteMd: 'The toolbar changes.',
        refusalVerdict: 're_plan',
        decisionSource: 'ui',
      },
    });
    const s = await planChangeSessionsService.startSeededWithFirstTurn(
      pctx(),
      buildScope([story.identifier]),
      `${design.identifier} · ${design.title}`,
      gate.id,
    );
    const stored = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(stored.seedGateId).toBe(gate.id);

    const row = await planSessionsService.getSessionRow(fx.projectId, s.id, fx.ctx);
    expect(row!.seed).toEqual({ cardKey: design.identifier, gateKind: 'design_result' });
  });
});
