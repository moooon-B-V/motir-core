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
import { projectAccessData, setProjectAccess } from '@/tests/helpers/projectAccess';
import { consentedVisitor } from '../../visitor/_consentedVisitor';

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

/** An UNSEEDED, OPEN project-wide conversation, `180 + minutes` quiet. Written
 *  directly: a member's open session is resumed at any age (AMENDMENT 23 §3), so
 *  a second first turn would land on the first. */
async function plainSession(body: string, minutes: number): Promise<string> {
  const s = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ownerId,
      scopeKey: PROJECT_SCOPE.scopeKey,
      targetKeys: [],
      turnCount: 1,
      lastActivityAt: minutesAgo(180 + minutes),
    },
  });
  await adminDb.planChangeTurn.create({
    data: {
      workspaceId: fx.workspaceId,
      sessionId: s.id,
      seq: 0,
      role: 'user',
      body,
      authorId: fx.ownerId,
    },
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
    data: { userId: u.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
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
  await setProjectAccess(adminDb, elsewhere.id, 'members');
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
      [
        approval.sessionId,
        {
          cardKey: approval.card.identifier,
          gateKind: 'decision_approval',
          origin: 'refusal',
          chosenLabel: null,
        },
      ],
      [
        confirmation.sessionId,
        {
          cardKey: confirmation.card.identifier,
          gateKind: 'decision_confirmation',
          origin: 'refusal',
          chosenLabel: null,
        },
      ],
      [
        choice.sessionId,
        {
          cardKey: choice.card.identifier,
          gateKind: 'decision_choice',
          origin: 'refusal',
          chosenLabel: null,
        },
      ],
    ]);
    // A browsable seed leaves the title alone.
    expect(page.sessions[0]!.firstTurn).toBe(
      `${approval.card.identifier} · ${approval.card.title}\nRe-plan this work item from that reason.`,
    );
  });

  it('an ACCEPTANCE refusal stamps its session and names its kind (MOTIR-6504)', async () => {
    const accepted = await seededSession('acceptance_result', 'changes_requested', 1);

    const row = await planSessionsService.getSessionRow(fx.projectId, accepted.sessionId, fx.ctx);

    expect(row!.seed).toEqual({
      cardKey: accepted.card.identifier,
      gateKind: 'acceptance_result',
      // A refusal seed, never a pick (MOTIR-6069's two origins) — so no option was chosen.
      origin: 'refusal',
      chosenLabel: null,
    });
  });

  it('an unseeded session’s seed is null and its row is otherwise unchanged', async () => {
    const id = await plainSession('Split invoicing out of billing', 1);

    const [row] = (await planSessionsService.listSessions(fx.projectId, fx.ctx)).sessions;

    expect(row).toMatchObject({ id, firstTurn: 'Split invoicing out of billing', seed: null });
  });

  it('the `?session=` landing row carries the seed too', async () => {
    const { sessionId, card } = await seededSession('decision_approval', 'changes_requested', 1);

    const row = await planSessionsService.getSessionRow(fx.projectId, sessionId, fx.ctx);

    expect(row!.seed).toEqual({
      cardKey: card.identifier,
      gateKind: 'decision_approval',
      origin: 'refusal',
      chosenLabel: null,
    });
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

    expect(row!.seed).toEqual({
      cardKey: card.identifier,
      gateKind: 'decision_choice',
      origin: 'refusal',
      chosenLabel: null,
    });
  });
});

describe('a PICK-seeded session is named as the follow-up to its choice (MOTIR-6434)', () => {
  it('carries origin pick and the stamped label, linked to the CHOICE card; None of these stays a refusal', async () => {
    const parent = await createTestWorkItem(fx, { kind: 'story', title: 'Reporting' });
    const choice = await createTestWorkItem(fx, {
      kind: 'subtask',
      type: 'choice',
      title: 'Choose where exports live',
      parentId: parent.id,
    });
    seq += 1;
    const gate = await adminDb.approvalGate.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: choice.id,
        kind: 'decision_choice',
        subjectId: `subject-pick-${seq}`,
        state: 'approved',
        decidedById: fx.ownerId,
        decidedAt: new Date(),
        decidedByLabel: 'Owner',
        chosenOption: {
          optionId: 'managed-object-storage',
          label: 'Managed object storage',
          bestFor: 'less to operate',
          followUp: 'Report exports.',
          situation: 'better_than_your_decision',
        },
      },
    });
    const s = await planChangeSessionsService.startSeededWithFirstTurn(
      pctx(),
      buildScope([parent.identifier]),
      `${choice.identifier} · ${choice.title}`,
      gate.id,
    );
    const row = (await planSessionsService.listSessions(fx.projectId, fx.ctx)).sessions.find(
      (r) => r.id === s.id,
    );
    expect(row!.seed).toEqual({
      cardKey: choice.identifier,
      gateKind: 'decision_choice',
      origin: 'pick',
      chosenLabel: 'Managed object storage',
    });
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
    // A seed the stamp never writes — the union is the three decision refusals, the
    // design Re-plan and the acceptance refusal (MOTIR-6504). The mapper still answers
    // null for any other kind.
    const other = await refusedGate(card, 'pull_request_approval', 'changes_requested');
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
    expect(row!.seed).toEqual({
      cardKey: design.identifier,
      gateKind: 'design_result',
      origin: 'refusal',
      chosenLabel: null,
    });
  });
});

// MOTIR-8697 — a session started by Confirm on a GUIDE's re-plan offer
// (MOTIR-8691's `seed_guide_turn_id`) is named by the GUIDED card on its Plans
// row, and is withheld exactly as a gate seed is.

/** A guide conversation on `guided` (the shape `openGuideWithFirstTurn` writes:
 *  `origin: 'guide'`, `targetKeys` = that ONE card) holding one assistant reply,
 *  and a PLANNING session anchored on `anchorKey` stamped with that reply as its
 *  guide seed. Written directly: the stamp's own write path is MOTIR-8691's. */
async function guideSeededSession(
  f: WorkItemFixture,
  guided: WorkItem,
  anchorKey: string,
  minutes: number,
): Promise<{ sessionId: string; guideSessionId: string; turnId: string }> {
  const base = { workspaceId: f.workspaceId, projectId: f.projectId, createdById: f.ownerId };
  const guide = await adminDb.planChangeSession.create({
    data: {
      ...base,
      origin: 'guide',
      scopeKey: buildScope([guided.identifier]).scopeKey,
      targetKeys: [guided.identifier],
      turnCount: 1,
    },
  });
  const reply = await adminDb.planChangeTurn.create({
    data: {
      workspaceId: f.workspaceId,
      sessionId: guide.id,
      seq: 0,
      role: 'assistant',
      body: 'I cannot guide you further: this work item is wrong.',
    },
  });
  const s = await adminDb.planChangeSession.create({
    data: {
      ...base,
      scopeKey: buildScope([anchorKey]).scopeKey,
      targetKeys: [anchorKey],
      turnCount: 1,
      seedGuideTurnId: reply.id,
      lastActivityAt: minutesAgo(minutes),
    },
  });
  await adminDb.planChangeTurn.create({
    data: {
      workspaceId: f.workspaceId,
      sessionId: s.id,
      seq: 0,
      role: 'user',
      body: `${guided.identifier} · ${guided.title}\nRe-plan this: the guide could not go further.`,
      authorId: f.ownerId,
    },
  });
  return { sessionId: s.id, guideSessionId: guide.id, turnId: reply.id };
}

describe('a GUIDE-seeded session is named by the guided card (MOTIR-8697)', () => {
  it('lists with origin guide and the guided card’s key, beside a gate-seeded and an unseeded row read as before, in one statement', async () => {
    const parent = await createTestWorkItem(fx, { kind: 'story', title: 'Key rotation' });
    const guided = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'Rotate the signing key',
      parentId: parent.id,
    });
    const g = await guideSeededSession(fx, guided, parent.identifier, 1);
    const gate = await seededSession('decision_approval', 'changes_requested', 2);
    const plainId = await plainSession('plain one', 3);

    const page = await planSessionsService.listSessions(fx.projectId, fx.ctx);
    const byId = new Map(page.sessions.map((r) => [r.id, r]));

    // The guide conversation itself is never a Plans row.
    expect(byId.has(g.guideSessionId)).toBe(false);
    expect(byId.get(g.sessionId)!.seed).toEqual({
      cardKey: guided.identifier,
      gateKind: null,
      origin: 'guide',
      chosenLabel: null,
    });
    expect(byId.get(g.sessionId)!.targetKeys).toEqual([parent.identifier]);
    expect(byId.get(g.sessionId)!.firstTurn).toContain('the guide could not go further');
    expect(byId.get(gate.sessionId)!.seed).toEqual({
      cardKey: gate.card.identifier,
      gateKind: 'decision_approval',
      origin: 'refusal',
      chosenLabel: null,
    });
    expect(byId.get(plainId)!.seed).toBeNull();
    expect(byId.get(plainId)!.firstTurn).toBe('plain one');

    // The `?session=` landing carries it too.
    expect(
      (await planSessionsService.getSessionRow(fx.projectId, g.sessionId, fx.ctx))!.seed,
    ).toMatchObject({ origin: 'guide', cardKey: guided.identifier });

    // The raw row, and still ONE statement for the page.
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
    expect(calls).toEqual(['$queryRaw']);
    const raw = rows.find((r) => r.id === g.sessionId)!;
    expect(raw).toMatchObject({
      seedGuideTurnId: g.turnId,
      seedGuideCardKey: guided.identifier,
      seedGuideCardInProject: true,
      seedGateId: null,
    });
    const rawGate = rows.find((r) => r.id === gate.sessionId)!;
    expect(rawGate).toMatchObject({ seedGuideTurnId: null, seedGuideCardKey: null });
    expect(rawGate.seedGuideCardInProject).toBe(false);
  });

  it('the guided card moved to another project: no seed, and the first turn is withheld', async () => {
    const guided = await createTestWorkItem(fx, { kind: 'story', title: 'Rotate the key' });
    const anchor = await createTestWorkItem(fx, { kind: 'story', title: 'Anchor' });
    const g = await guideSeededSession(fx, guided, anchor.identifier, 1);
    await moveOutOfReach(guided);

    const row = await planSessionsService.getSessionRow(fx.projectId, g.sessionId, fx.ctx);
    expect(row!.seed).toBeNull();
    expect(row!.firstTurn).toBeNull();
    expect(JSON.stringify(row)).not.toContain('Rotate the key');
  });

  it('the guided card deleted: no seed, and the first turn is withheld', async () => {
    const guided = await createTestWorkItem(fx, { kind: 'story', title: 'Rotate the key' });
    const anchor = await createTestWorkItem(fx, { kind: 'story', title: 'Anchor' });
    const g = await guideSeededSession(fx, guided, anchor.identifier, 1);
    await adminDb.workItem.delete({ where: { id: guided.id } });

    const row = await planSessionsService.getSessionRow(fx.projectId, g.sessionId, fx.ctx);
    expect(row!.seed).toBeNull();
    expect(row!.firstTurn).toBeNull();
  });

  it('a Visitor whose hidden set holds the guided card does not see the session — in the list, the counts, or by id — and still sees an unseeded one', async () => {
    const previousCloud = process.env['MOTIR_CLOUD'];
    process.env['MOTIR_CLOUD'] = 'true';
    try {
      const identifier = `GS${seq++}`;
      const pub = await makeWorkItemFixture({ name: `GS ${identifier}`, identifier });
      await adminDb.project.update({
        where: { id: pub.projectId },
        data: projectAccessData('public'),
      });
      const epic = await createTestWorkItem(pub, { kind: 'epic', title: 'Private epic' });
      const guided = await createTestWorkItem(pub, {
        kind: 'story',
        title: 'Hidden guided card',
        parentId: epic.id,
      });
      await adminDb.workItem.update({
        where: { id: epic.id },
        data: { publicChildrenHidden: true },
      });
      const anchor = await createTestWorkItem(pub, { kind: 'story', title: 'Visible anchor' });
      // The anchor is visible, so only the GUIDE seed can withhold this session.
      const g = await guideSeededSession(pub, guided, anchor.identifier, 1);
      const plain = await adminDb.planChangeSession.create({
        data: {
          workspaceId: pub.workspaceId,
          projectId: pub.projectId,
          createdById: pub.ownerId,
          targetKeys: [],
        },
      });

      const visitor = await consentedVisitor(identifier);
      const page = await planSessionsService.listSessions(pub.projectId, visitor);
      expect(page.sessions.map((r) => r.id)).toEqual([plain.id]);
      const counts = await planSessionsService.countSessionsByPlanState(pub.projectId, visitor);
      expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(1);
      expect(
        await planSessionsService.getSessionRow(pub.projectId, g.sessionId, visitor),
      ).toBeNull();

      // A member of the project still sees both.
      const member = await planSessionsService.listSessions(pub.projectId, pub.ctx);
      expect(member.sessions.map((r) => r.id).sort()).toEqual([g.sessionId, plain.id].sort());
    } finally {
      if (previousCloud === undefined) delete process.env['MOTIR_CLOUD'];
      else process.env['MOTIR_CLOUD'] = previousCloud;
    }
  });
});
