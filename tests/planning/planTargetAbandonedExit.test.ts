import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PLANNING_STATUS_KEY, PLAN_TARGET_PLAN_LEASE_MS } from '@/lib/planChange/targetLock';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE ABANDONED-PLAN EXIT (MOTIR-5647), bug MOTIR-5640 — against a REAL
// Postgres, through the shipped sweep.
//
// `docs/decisions/agent-authored-plans.md` AMENDMENT 16 D9. The lease is a
// DEAD-AUTHOR detector: a planner that crashes leaves a plan `generating` with
// no terminal event, so the passage of time is the only signal left. Two halves:
//
//   * a `generating` plan's lock EXPIRES after the window, and the sweep
//     restores each target's prior status — so a crashed author never strands a
//     card at Planning;
//   * a `planned` plan's lock NEVER expires, because it is waiting for a PERSON
//     and a review queue has no deadline.
//
// The second is the one this card adds. Without it, a plan sitting in review for
// longer than the window would have its targets swept out from under it and go
// claimable while a reviewer was still deciding — which is the exact failure the
// park exists to prevent, arriving by the clock instead of by a race.

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
    { projectId: fx.projectId, kind: 'task', title },
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

/** Age a lock's lease so the sweep's `expires_at <= now` read selects it — the
 *  same fixture move the session sweep's own cases make. */
async function expireLease(workItemId: string): Promise<void> {
  await adminDb.planTargetLock.update({
    where: { workItemId },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
}

describe('the lease a PLAN gets', () => {
  it('is the 24-hour window, not the session lease', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const card = await seedCard();
    await setStatus(card, 'in_progress');
    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
    const before = Date.now();
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: card, patch: { descriptionMd: 'Re-scoped.' } }],
      fx.ctx,
    );

    const lock = await lockFor(card);
    const window = lock!.expiresAt.getTime() - before;
    // Generous bounds: the point is that it is the DAY window and not the
    // half-hour one, which a runbook walk can outlast without a submit.
    expect(window).toBeGreaterThan(PLAN_TARGET_PLAN_LEASE_MS - 60_000);
    expect(window).toBeLessThanOrEqual(PLAN_TARGET_PLAN_LEASE_MS + 60_000);
  });

  it(
    'is REFRESHED by each append, so an honest pass keeps its own window open',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const plan = await plansService.createPlan(fx.projectId, { title: 'A long walk' }, fx.ctx);
      await plansService.addProposals(
        plan.id,
        [{ op: 'modify', workItemId: card, patch: { priority: 'high' } }],
        fx.ctx,
      );
      // Age it most of the way, as a pass that has been working for hours would.
      await adminDb.planTargetLock.update({
        where: { workItemId: card },
        data: { expiresAt: new Date(Date.now() + 60_000) },
      });
      const nearlyExpired = (await lockFor(card))!.expiresAt;

      // A second append — the walk laying its next layer.
      await plansService.addProposals(
        plan.id,
        [{ op: 'add', parentRef: card, proposedFields: { title: 'A child', kind: 'subtask' } }],
        fx.ctx,
      );

      expect((await lockFor(card))!.expiresAt.getTime()).toBeGreaterThan(nearlyExpired.getTime());
    },
  );
});

describe('a GENERATING plan whose author died', () => {
  it(
    'has its lock swept and the prior status RESTORED',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await setStatus(card, 'implemented');
      const plan = await plansService.createPlan(fx.projectId, { title: 'Crashed' }, fx.ctx);
      await plansService.addProposals(
        plan.id,
        [{ op: 'modify', workItemId: card, patch: { descriptionMd: 'Half-written.' } }],
        fx.ctx,
      );
      // The author vanishes: the plan never closes, and the lease runs out.
      expect(await statusOf(card)).toBe(PLANNING_STATUS_KEY);
      expect((await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } })).status).toBe(
        'generating',
      );
      await expireLease(card);

      const out = await planTargetLockService.releaseExpired();

      expect(out.entries).toEqual([{ workItemId: card, outcome: 'restored' }]);
      // Back where it was — nothing about the card changed, so nothing about its
      // status should have.
      expect(await statusOf(card)).toBe('implemented');
      expect(await lockFor(card)).toBeNull();
    },
  );

  it(
    'leaves a card a person moved out by hand exactly where they put it',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await setStatus(card, 'implemented');
      const plan = await plansService.createPlan(fx.projectId, { title: 'Crashed' }, fx.ctx);
      await plansService.addProposals(
        plan.id,
        [{ op: 'modify', workItemId: card, patch: { priority: 'high' } }],
        fx.ctx,
      );
      // A MANUAL release — the escape hatch that stops a stuck lock being a lock
      // nobody can get out of.
      await setStatus(card, 'in_progress');
      await expireLease(card);

      const out = await planTargetLockService.releaseExpired();

      expect(out.entries).toEqual([{ workItemId: card, outcome: 'left_as_is' }]);
      expect(await statusOf(card)).toBe('in_progress');
      expect(await lockFor(card)).toBeNull();
    },
  );
});

describe('a PLANNED plan waiting for a person (D9)', () => {
  it(
    'is NEVER expired, however old the lease is — the card stays parked',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await setStatus(card, 'implemented');
      const plan = await plansService.createPlan(fx.projectId, { title: 'In review' }, fx.ctx);
      await plansService.addProposals(
        plan.id,
        [{ op: 'modify', workItemId: card, patch: { descriptionMd: 'Re-scoped.' } }],
        fx.ctx,
      );
      await plansService.markPlanned(plan.id, fx.ctx);
      // A reviewer who has not got to it in two days. The lease is a dead-AUTHOR
      // detector, and this author is not dead — they have finished.
      await expireLease(card);

      const out = await planTargetLockService.releaseExpired();

      expect(out.entries).toEqual([{ workItemId: card, outcome: 'plan_awaiting_review' }]);
      // Still parked, still held: a reviewer is deciding, and the card must not
      // become claimable underneath them.
      expect(await statusOf(card)).toBe(PLANNING_STATUS_KEY);
      expect(await lockFor(card)).not.toBeNull();
    },
  );

  it(
    'and its DECISION still releases it — the exit is the decision, not the clock',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await setStatus(card, 'implemented');
      const plan = await plansService.createPlan(fx.projectId, { title: 'In review' }, fx.ctx);
      await plansService.addProposals(
        plan.id,
        [{ op: 'modify', workItemId: card, patch: { descriptionMd: 'Re-scoped.' } }],
        fx.ctx,
      );
      await plansService.markPlanned(plan.id, fx.ctx);
      await expireLease(card);
      await planTargetLockService.releaseExpired();
      expect(await statusOf(card)).toBe(PLANNING_STATUS_KEY);

      await plansService.approvePlan(plan.id, fx.ctx);

      expect(await statusOf(card)).toBe('todo');
      expect(await lockFor(card)).toBeNull();
    },
  );
});

describe('a SESSION lock is unaffected', () => {
  it(
    'still expires on its own 30-minute lease — the plan check does not reach it',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await setStatus(card, 'in_progress');
      const item = await adminDb.workItem.findUniqueOrThrow({ where: { id: card } });
      const session = await adminDb.planChangeSession.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          scopeKey: item.identifier,
          lastJobId: 'job-1',
        },
      });
      await planTargetLockService.acquireForScope(session.id, [item.identifier], {
        userId: fx.ctx.userId,
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
      });
      expect(await statusOf(card)).toBe(PLANNING_STATUS_KEY);
      // A session-held lock carries no `planId`, so the new check is skipped and
      // the sweep behaves exactly as it did before MOTIR-5647.
      expect((await lockFor(card))!.planId).toBeNull();
      await expireLease(card);

      const out = await planTargetLockService.releaseExpired();

      expect(out.entries).toEqual([{ workItemId: card, outcome: 'restored' }]);
      expect(await statusOf(card)).toBe('in_progress');
    },
  );
});
