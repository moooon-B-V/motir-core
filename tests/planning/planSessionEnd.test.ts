import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE ONE END OPERATION (story MOTIR-7630 · MOTIR-7637) — against a REAL
// Postgres. `docs/decisions/agent-authored-plans.md` AMENDMENT 23 §2: one
// idempotent operation stamps a session's end, discards its `generating` plan and
// gives its cards back; approving or declining a plan ends its session.

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

async function seedCard(status = 'in_progress'): Promise<{ id: string; key: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'The card' },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: dto.id }, data: { status } });
  return { id: dto.id, key: dto.identifier };
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

/** A conversation session on `card` that holds the card at Planning. */
async function openSessionOn(card: { key: string }): Promise<string> {
  const session = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ctx.userId,
      scopeKey: card.key,
      targetKeys: [card.key],
    },
  });
  await planTargetLockService.acquireForScope(session.id, [card.key], {
    ...fx.ctx,
    projectId: fx.projectId,
  });
  return session.id;
}

async function planInSession(sessionId: string, status: 'generating' | 'planned') {
  return adminDb.plan.create({
    data: { workspaceId: fx.workspaceId, projectId: fx.projectId, sessionId, status },
  });
}

/** A `planned` plan with one `modify` of `cardId`, produced by `sessionId`. */
async function plannedPlanIn(sessionId: string, cardId: string): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
  await adminDb.plan.update({ where: { id: plan.id }, data: { sessionId } });
  await plansService.addProposals(
    plan.id,
    [{ op: 'modify', workItemId: cardId, patch: { descriptionMd: 'Re-scoped.' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

async function sessionRow(id: string) {
  return adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });
}

describe('endSession — Motir ends a session', () => {
  it(
    'stamps the end, discards the generating plan with no decider and gives the card back',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard('in_progress');
      const sessionId = await openSessionOn(card);
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
      const plan = await planInSession(sessionId, 'generating');

      const out = await planChangeSessionsService.endSession(sessionId, 'failed', {
        workspaceId: fx.workspaceId,
      });

      expect(out.ended).toBe(true);
      const row = await sessionRow(sessionId);
      expect(row.endReason).toBe('failed');
      expect(row.endedById).toBeNull();
      expect(row.endedAt).not.toBeNull();
      const decided = await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } });
      expect(decided).toMatchObject({
        status: 'declined',
        decisionReason: 'abandoned',
        decidedById: null,
      });
      expect(await statusOf(card.id)).toBe('in_progress');
      expect(await adminDb.planTargetLock.count({ where: { sessionId } })).toBe(0);
    },
  );

  it(
    'is idempotent — ending it again returns the first end',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const sessionId = await openSessionOn(card);
      const first = await planChangeSessionsService.endSession(sessionId, 'idle', {
        workspaceId: fx.workspaceId,
      });

      const again = await planChangeSessionsService.endSession(sessionId, 'failed', {
        workspaceId: fx.workspaceId,
      });

      expect(again.ended).toBe(false);
      expect(again.session.endReason).toBe('idle');
      expect(again.session.endedAt).toEqual(first.session.endedAt);
    },
  );

  it(
    'two concurrent ends of one session write ONE end',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const sessionId = await openSessionOn(card);

      const results = await Promise.all([
        planChangeSessionsService.endSession(sessionId, 'failed', { workspaceId: fx.workspaceId }),
        planChangeSessionsService.endSession(sessionId, 'idle', { workspaceId: fx.workspaceId }),
      ]);

      expect(results.filter((r) => r.ended)).toHaveLength(1);
      const winner = results.find((r) => r.ended)!;
      expect((await sessionRow(sessionId)).endReason).toBe(winner.session.endReason);
      expect(await statusOf(card.id)).toBe('in_progress');
    },
  );

  it('leaves a `planned` plan for its reviewer', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const card = await seedCard();
    const sessionId = await openSessionOn(card);
    const plan = await planInSession(sessionId, 'planned');

    await planChangeSessionsService.endSession(sessionId, 'idle', {
      workspaceId: fx.workspaceId,
    });

    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } })).status).toBe(
      'planned',
    );
  });

  it(
    'a person restarting discards the generating plan in their name',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const sessionId = await openSessionOn(card);
      const plan = await planInSession(sessionId, 'generating');

      await planChangeSessionsService.endSession(sessionId, 'restarted', {
        workspaceId: fx.workspaceId,
        endedById: fx.ctx.userId,
        actorId: fx.ctx.userId,
      });

      expect((await sessionRow(sessionId)).endedById).toBe(fx.ctx.userId);
      expect(await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } })).toMatchObject({
        status: 'declined',
        decisionReason: 'discarded',
        decidedById: fx.ctx.userId,
      });
    },
  );
});

describe('a decision ends the session its plan came from', () => {
  it('approving ends it `approved`, by the approver', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const card = await seedCard();
    const sessionId = await openSessionOn(card);
    const other = await adminDb.planChangeSession.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        createdById: fx.ctx.userId,
        scopeKey: card.key,
      },
    });
    const planId = await plannedPlanIn(sessionId, card.id);

    await plansService.approvePlan(planId, fx.ctx);

    const row = await sessionRow(sessionId);
    expect(row.endReason).toBe('approved');
    expect(row.endedById).toBe(fx.ctx.userId);
    // Another session of the same scope is not touched.
    expect((await sessionRow(other.id)).endedAt).toBeNull();
  });

  it('declining ends it `declined`, by the decider', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const card = await seedCard();
    const sessionId = await openSessionOn(card);
    const planId = await plannedPlanIn(sessionId, card.id);

    await plansService.declinePlan(planId, fx.ctx);

    const row = await sessionRow(sessionId);
    expect(row.endReason).toBe('declined');
    expect(row.endedById).toBe(fx.ctx.userId);
    expect(await statusOf(card.id)).toBe('in_progress');
  });

  it(
    'deciding an EARLIER plan of the session leaves the session open',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const sessionId = await openSessionOn(card);
      const earlier = await plannedPlanIn(sessionId, card.id);
      await adminDb.plan.update({
        where: { id: earlier },
        data: { createdAt: new Date(Date.now() - 60_000) },
      });
      await planInSession(sessionId, 'generating');

      await plansService.declinePlan(earlier, fx.ctx);

      expect((await sessionRow(sessionId)).endedAt).toBeNull();
    },
  );
});
