import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';
import { RESTING_BLOCKED_KEY, RESTING_TODO_KEY } from '@/lib/plans/restingStatus';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// A HAND-PARKED TARGET IS RESTED BY EVERY RELEASE OF ITS PLAN (bug MOTIR-6066) —
// against a REAL Postgres, through the shipped decline / withdraw / discard /
// sweep paths.
//
// `docs/decisions/agent-authored-plans.md` AMENDMENT 16 D8, as amended
// 2026-09-22. A card parked at `planning` BY HAND before any plan named it is
// ADOPTED by the plan with `priorStatus: 'planning'` and `statusHeld: false`.
// Approve always rested it (D6). Every other ending used to read that lock as
// "nothing to restore" and leave the card at Planning — and because the release
// deletes the lock row, nothing ever moved it again. The first case below is that
// exact reproduction.

const DB_TEST_TIMEOUT_MS = 30_000;

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedCard(title = 'The card'): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, descriptionMd: 'The old body.' },
    fx.ctx,
  );
  return dto.id;
}

async function setStatus(id: string, status: string): Promise<void> {
  await adminDb.workItem.update({ where: { id }, data: { status } });
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

async function lockFor(workItemId: string) {
  return adminDb.planTargetLock.findUnique({ where: { workItemId } });
}

/** Park a `todo` card at `planning` the way the runbook does — a person's
 *  `transition_status`, with no plan and no lock row. */
async function handPark(id: string): Promise<void> {
  await workItemsService.updateStatus(id, PLANNING_STATUS_KEY, fx.ctx);
  expect(await lockFor(id)).toBeNull();
}

async function linkOpenBlocker(card: string): Promise<string> {
  const blocker = await seedCard('An open blocker');
  await workItemsService.linkWorkItems(
    { fromId: card, toId: blocker, kind: 'is_blocked_by' },
    fx.ctx,
  );
  return blocker;
}

/** An MCP-authored plan (no source job, so the plan itself holds its targets)
 *  with one `modify` — still `generating`. */
async function generatingModify(workItemId: string): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'modify', workItemId, patch: { descriptionMd: 'Re-scoped.' } }],
    fx.ctx,
  );
  return plan.id;
}

async function plannedModify(workItemId: string): Promise<string> {
  const planId = await generatingModify(workItemId);
  await plansService.markPlanned(planId, fx.ctx);
  return planId;
}

describe('DECLINE rests an adopted target (D8 as amended)', () => {
  it(
    'a hand-parked card goes to To Do on decline, by a system write on its history',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await handPark(card);
      const planId = await plannedModify(card);
      // Adopted: nothing recorded where it came from.
      expect(await lockFor(card)).toMatchObject({
        planId,
        priorStatus: PLANNING_STATUS_KEY,
        statusHeld: false,
      });

      await plansService.declinePlan(planId, fx.ctx);

      expect(await statusOf(card)).toBe(RESTING_TODO_KEY);
      expect(await lockFor(card)).toBeNull();
      const latest = await adminDb.workItemRevision.findFirstOrThrow({
        where: { workItemId: card },
        orderBy: { changedAt: 'desc' },
      });
      expect(latest.diff).toMatchObject({
        status: { from: PLANNING_STATUS_KEY, to: RESTING_TODO_KEY },
      });
    },
  );

  it(
    'the same card with an OPEN blocker rests at Blocked',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await linkOpenBlocker(card);
      await handPark(card);
      const planId = await plannedModify(card);

      await plansService.declinePlan(planId, fx.ctx);

      expect(await statusOf(card)).toBe(RESTING_BLOCKED_KEY);
      expect(await lockFor(card)).toBeNull();
    },
  );

  it(
    'a card the PLAN parked (an observed prior status) is still RESTORED, not rested',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await setStatus(card, 'in_progress');
      const planId = await plannedModify(card);
      expect(await lockFor(card)).toMatchObject({ priorStatus: 'in_progress', statusHeld: true });

      await plansService.declinePlan(planId, fx.ctx);

      expect(await statusOf(card)).toBe('in_progress');
    },
  );

  it(
    'an adopted card a person already moved OUT of Planning is left alone',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await handPark(card);
      const planId = await plannedModify(card);
      await setStatus(card, 'in_progress');

      await plansService.declinePlan(planId, fx.ctx);

      expect(await statusOf(card)).toBe('in_progress');
      expect(await lockFor(card)).toBeNull();
    },
  );
});

describe('the other releases of an adopted plan-held lock rest it the same way', () => {
  it(
    'a withdraw that empties the plan, then its close',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await handPark(card);
      const planId = await generatingModify(card);

      await plansService.withdrawProposal(
        planId,
        (await adminDb.planItem.findFirstOrThrow({ where: { planId } })).id,
        fx.ctx,
      );
      await plansService.markPlanned(planId, fx.ctx);

      expect(await statusOf(card)).toBe(RESTING_TODO_KEY);
      expect(await lockFor(card)).toBeNull();
    },
  );

  it('a DISCARDED generating plan', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const card = await seedCard();
    await linkOpenBlocker(card);
    await handPark(card);
    const planId = await generatingModify(card);

    // AMENDMENT 6: a decline of a `generating` plan is the discard.
    await plansService.declinePlan(planId, fx.ctx);

    expect(await statusOf(card)).toBe(RESTING_BLOCKED_KEY);
    expect(await lockFor(card)).toBeNull();
  });

  it(
    'the ABANDONED-plan sweep reports it as `rested`',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await handPark(card);
      await generatingModify(card);
      await adminDb.planTargetLock.update({
        where: { workItemId: card },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const out = await planTargetLockService.releaseExpired();

      expect(out.entries).toEqual([{ workItemId: card, outcome: 'rested' }]);
      expect(await statusOf(card)).toBe(RESTING_TODO_KEY);
      expect(await lockFor(card)).toBeNull();
    },
  );
});

describe('where an adopted target is NOT rested', () => {
  it(
    'an archived target keeps its status — an archived row is claimed by nothing',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await handPark(card);
      const planId = await plannedModify(card);
      await adminDb.workItem.update({ where: { id: card }, data: { archivedAt: new Date() } });

      await plansService.declinePlan(planId, fx.ctx);

      expect(await statusOf(card)).toBe(PLANNING_STATUS_KEY);
      expect(await lockFor(card)).toBeNull();
    },
  );

  it(
    'a workflow with no `blocked` status keeps the card rather than write one it does not offer',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await linkOpenBlocker(card);
      await handPark(card);
      const planId = await plannedModify(card);

      const blocked = await adminDb.workflowStatus.findMany({
        where: { projectId: fx.projectId, key: RESTING_BLOCKED_KEY },
      });
      const ids = blocked.map((s) => s.id);
      expect(ids).toHaveLength(1);
      await adminDb.workflowTransition.deleteMany({
        where: { OR: [{ fromStatusId: { in: ids } }, { toStatusId: { in: ids } }] },
      });
      await adminDb.workflowStatus.deleteMany({ where: { id: { in: ids } } });

      await plansService.declinePlan(planId, fx.ctx);

      expect(await statusOf(card)).toBe(PLANNING_STATUS_KEY);
      expect(await lockFor(card)).toBeNull();
    },
  );
});
