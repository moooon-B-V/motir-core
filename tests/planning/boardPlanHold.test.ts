import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE BOARD'S PLAN HOLD, up front (Story MOTIR-6017 · Subtask MOTIR-6268;
// `design/boards/design-notes.md` § _⭐ The board refuses ON THE CARD while a PLAN
// holds it_ → _THE DATA_) — against a REAL Postgres, through the shipped board
// read. The fixtures are `planHoldGuard.test.ts`'s: an MCP-authored plan whose
// `modify` proposals PARK their cards at `planning` under a plan-held lock.
//
// What it pins:
//   · each card's `planHold` is exactly `planTargetLockService.readPlanHold`'s
//     answer for the same card — the board and the funnel share `planHoldFor`;
//   · an unheld card, a SESSION-held lock and an expired `generating` lease → null;
//   · each holding plan's label fields and its server-side held count, two plans;
//   · `moveCard`'s returned card keeps its hold on a rank change inside Planning.
const { session, activeCtx } = vi.hoisted(() => ({
  session: { current: null as unknown },
  activeCtx: { current: null as unknown },
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { boardsService } from '@/lib/services/boardsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';
import type { BoardCardDto, BoardProjectionDto } from '@/lib/dto/boards';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';

const DB_TEST_TIMEOUT_MS = 30_000;

let fx: WorkItemFixture;

beforeEach(async () => {
  spyOnJobDispatch();
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: fx.owner.email, name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedCard(title: string): Promise<{ id: string; identifier: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, descriptionMd: 'The old body.' },
    fx.ctx,
  );
  return { id: dto.id, identifier: dto.identifier };
}

/** A plan with one `modify` per card — still `generating`; the append parks
 *  every card at `planning` under a plan-held lock. */
async function generatingModify(workItemIds: string[], title: string): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    workItemIds.map((workItemId) => ({
      op: 'modify' as const,
      workItemId,
      patch: { descriptionMd: 'Re-scoped.' },
    })),
    fx.ctx,
  );
  return plan.id;
}

async function plannedModify(workItemIds: string[], title: string): Promise<string> {
  const planId = await generatingModify(workItemIds, title);
  await plansService.markPlanned(planId, fx.ctx);
  return planId;
}

function cardsById(board: BoardProjectionDto): Map<string, BoardCardDto> {
  return new Map(board.columns.flatMap((c) => c.cards).map((c) => [c.id, c]));
}

describe('the board projection carries each card’s plan hold', () => {
  it(
    'per card, exactly readPlanHold’s answer; per plan, its label and held count — two plans',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const a1 = await seedCard('A one');
      const a2 = await seedCard('A two');
      const b1 = await seedCard('B one');
      const free = await seedCard('Free');
      const planA = await plannedModify([a1.id, a2.id], 'Plan A');
      const planB = await generatingModify([b1.id], 'Plan B');
      // Plan A's session anchors at a1 — the `{name}` rule's first choice.
      const planARow = await adminDb.plan.findUniqueOrThrow({ where: { id: planA } });
      expect(planARow.sessionId).not.toBeNull();
      await adminDb.planChangeSession.update({
        where: { id: planARow.sessionId! },
        data: { targetKeys: [a1.identifier] },
      });

      const board = await boardsService.getBoard(fx.projectId, fx.ctx);
      const byId = cardsById(board);

      for (const card of [a1, a2, b1]) {
        const onBoard = byId.get(card.id);
        expect(onBoard?.status).toBe(PLANNING_STATUS_KEY);
        const expected = await planTargetLockService.readPlanHold(card.id, fx.ctx);
        expect(expected).not.toBeNull();
        expect(onBoard?.planHold).toEqual(expected);
      }
      expect(byId.get(a1.id)?.planHold?.planId).toBe(planA);
      expect(byId.get(b1.id)?.planHold?.planStatus).toBe('generating');
      expect(byId.get(free.id)?.planHold).toBeNull();

      expect(Object.keys(board.planHolds).sort()).toEqual([planA, planB].sort());
      expect(board.planHolds[planA]).toEqual({
        planId: planA,
        anchorKey: a1.identifier,
        title: 'Plan A',
        heldCount: 2,
      });
      expect(board.planHolds[planB]).toMatchObject({
        planId: planB,
        title: 'Plan B',
        heldCount: 1,
      });
    },
  );

  it(
    'a board no plan holds reads nothing and carries an empty map',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const free = await seedCard('Free');
      const board = await boardsService.getBoard(fx.projectId, fx.ctx);
      expect(cardsById(board).get(free.id)?.planHold).toBeNull();
      expect(board.planHolds).toEqual({});
    },
  );

  it(
    'a SESSION-held lock (no plan) is not a hold — null, and no plan named',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard('Session parked');
      const planId = await plannedModify([card.id], 'Plan');
      const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
      await adminDb.planTargetLock.update({
        where: { workItemId: card.id },
        data: { planId: null, sessionId: plan.sessionId },
      });

      const board = await boardsService.getBoard(fx.projectId, fx.ctx);
      const onBoard = cardsById(board).get(card.id);
      expect(onBoard?.status).toBe(PLANNING_STATUS_KEY);
      expect(onBoard?.planHold).toBeNull();
      expect(await planTargetLockService.readPlanHold(card.id, fx.ctx)).toBeNull();
      expect(board.planHolds).toEqual({});
    },
  );

  it(
    'an EXPIRED lease on a `generating` plan is not a hold, and is not counted',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const expired = await seedCard('Expired');
      const live = await seedCard('Live');
      const planId = await generatingModify([expired.id, live.id], 'Plan');
      await adminDb.planTargetLock.update({
        where: { workItemId: expired.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const board = await boardsService.getBoard(fx.projectId, fx.ctx);
      const byId = cardsById(board);
      expect(byId.get(expired.id)?.planHold).toBeNull();
      expect(await planTargetLockService.readPlanHold(expired.id, fx.ctx)).toBeNull();
      expect(byId.get(live.id)?.planHold).toEqual(
        await planTargetLockService.readPlanHold(live.id, fx.ctx),
      );
      expect(board.planHolds[planId]?.heldCount).toBe(1);
    },
  );

  it(
    'a `planned` plan’s lock never expires — an old lease still holds and counts',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard('Old lease');
      const planId = await plannedModify([card.id], 'Plan');
      await adminDb.planTargetLock.update({
        where: { workItemId: card.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const board = await boardsService.getBoard(fx.projectId, fx.ctx);
      expect(cardsById(board).get(card.id)?.planHold?.planId).toBe(planId);
      expect(board.planHolds[planId]?.heldCount).toBe(1);
    },
  );

  it(
    '`moveCard`’s returned card keeps its hold on a rank change inside Planning',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard('Held');
      await plannedModify([card.id], 'Plan');
      const board = await boardsService.getBoard(fx.projectId, fx.ctx);
      const column = board.columns.find((c) => c.cards.some((x) => x.id === card.id))!;

      const moved = await boardsService.moveCard(
        board.boardId,
        card.id,
        { toColumnId: column.id },
        fx.ctx,
      );
      expect(moved.appliedStatus).toBe(PLANNING_STATUS_KEY);
      expect(moved.card.planHold).toEqual(
        await planTargetLockService.readPlanHold(card.id, fx.ctx),
      );
    },
  );
});
