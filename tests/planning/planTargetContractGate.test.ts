import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { aiGenerationService } from '@/lib/services/aiGenerationService';
import { plansService } from '@/lib/services/plansService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PlanTargetLockedError } from '@/lib/planChange/errors';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE PLAN-TARGET STATUS CONTRACT, ASSEMBLED (MOTIR-5648), bug MOTIR-5640.
//
// The four cards under this bug each have their own file, and each proves its own
// half against real Postgres:
//
//   * MOTIR-5645 → `planTargetParkDoor.test.ts`      the park, per status, and the race
//   * MOTIR-5646 → `planTargetRelease.test.ts`       approve / decline, and the resting status
//   * MOTIR-5647 → `planTargetAbandonedExit.test.ts` the lease, and the `planned` exemption
//   * MOTIR-5643 → `planning-parking-edges.test.ts`  the edges and the backfill
//
// ⚠️ WHAT THIS FILE ADDS is what NONE of those can see from inside its own card,
// and it is deliberately not a fourth copy of the matrix:
//
//   1. THE OTHER DOORS. The park lives at `plansService.addProposals`, and the
//      claim that this covers `expand_item` and generation is an inheritance
//      claim about the call graph. Asserted here through
//      `aiGenerationService.appendProposals`, the seam motir-ai's plan jobs
//      actually call.
//   2. THE CROSS-HOLDER exclusion. A SESSION and a PLAN are different holders on
//      one table, and each file only ever exercises its own kind.
//   3. THE LATE APPEND (MOTIR-5647's own acceptance criterion): an author who
//      comes back after the lease expired re-parks, and is refused if somebody
//      else took the card meanwhile.
//   4. THE WHOLE WALK, per status, in ONE table — park, decide, rest — so a
//      regression in any single step reads as a broken row here rather than as
//      four files disagreeing.

const DB_TEST_TIMEOUT_MS = 30_000;

/** Every status a card may be parked FROM (AMENDMENT 16 D2). */
const PARKABLE = [
  'todo',
  'blocked',
  'in_progress',
  'implemented',
  'in_review',
  'approved',
] as const;

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

async function identifierOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).identifier;
}

describe('1 — THE OTHER DOORS inherit the park (D1)', () => {
  it(
    'the GENERATION seam parks its targets, exactly as the MCP door does',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      // `aiGenerationService.appendProposals` is what motir-ai's plan jobs call
      // through `app/api/internal/ai/plan-proposals`, for generation, for
      // `expand_item` and for a session turn. It resolves the plan by its source
      // job and hands the batch to `plansService.addProposals` — so the park is
      // inherited rather than re-implemented, and THAT is the claim under test.
      const card = await seedCard();
      await setStatus(card, 'implemented');

      const jobId = 'job_generation_1';
      const plan = await plansService.createPlan(
        fx.projectId,
        { title: 'Generated', sourceJobId: jobId },
        fx.ctx,
      );

      await aiGenerationService.appendProposals(
        jobId,
        [{ op: 'modify', workItemId: card, patch: { descriptionMd: 'Generated body.' } }],
        fx.ctx,
      );

      expect(await statusOf(card)).toBe(PLANNING_STATUS_KEY);
      expect(await lockFor(card)).toMatchObject({
        planId: plan.id,
        sessionId: null,
        priorStatus: 'implemented',
        statusHeld: true,
      });
    },
  );

  it(
    'a generation append that names a card ANOTHER plan holds is refused',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const holder = await plansService.createPlan(fx.projectId, { title: 'Holder' }, fx.ctx);
      await plansService.addProposals(
        holder.id,
        [{ op: 'modify', workItemId: card, patch: { priority: 'high' } }],
        fx.ctx,
      );

      const jobId = 'job_generation_2';
      await plansService.createPlan(
        fx.projectId,
        { title: 'Generated', sourceJobId: jobId },
        fx.ctx,
      );

      await expect(
        aiGenerationService.appendProposals(
          jobId,
          [{ op: 'modify', workItemId: card, patch: { priority: 'low' } }],
          fx.ctx,
        ),
      ).rejects.toBeInstanceOf(PlanTargetLockedError);

      // The holder keeps it, and the loser wrote nothing.
      expect(await lockFor(card)).toMatchObject({ planId: holder.id });
    },
  );
});

describe('2 — a SESSION and a PLAN exclude each other (D4, D5)', () => {
  it(
    'a plan cannot park a card a SESSION is holding',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const identifier = await identifierOf(card);
      const session = await adminDb.planChangeSession.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          scopeKey: identifier,
          lastJobId: 'job-session-1',
        },
      });
      await planTargetLockService.acquireForScope(session.id, [identifier], {
        userId: fx.ctx.userId,
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
      });
      expect((await lockFor(card))!.sessionId).toBe(session.id);

      const plan = await plansService.createPlan(fx.projectId, { title: 'Interloper' }, fx.ctx);
      await expect(
        plansService.addProposals(
          plan.id,
          [{ op: 'modify', workItemId: card, patch: { priority: 'high' } }],
          fx.ctx,
        ),
      ).rejects.toBeInstanceOf(PlanTargetLockedError);

      // ⚠️ THE WHOLE REASON THE TWO HOLDERS SHARE ONE TABLE. The exclusion is
      // `work_item_id UNIQUE`; in two tables there would be nothing for it to be
      // unique ACROSS, and a session and a plan could each take this card.
      expect((await lockFor(card))!.sessionId).toBe(session.id);
      expect((await lockFor(card))!.planId).toBeNull();
    },
  );

  it(
    'a session cannot take a card a PLAN is holding',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const identifier = await identifierOf(card);
      const plan = await plansService.createPlan(fx.projectId, { title: 'Holder' }, fx.ctx);
      await plansService.addProposals(
        plan.id,
        [{ op: 'modify', workItemId: card, patch: { priority: 'high' } }],
        fx.ctx,
      );

      const session = await adminDb.planChangeSession.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          scopeKey: identifier,
          lastJobId: 'job-session-2',
        },
      });

      await expect(
        planTargetLockService.acquireForScope(session.id, [identifier], {
          userId: fx.ctx.userId,
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
        }),
      ).rejects.toBeInstanceOf(PlanTargetLockedError);

      expect((await lockFor(card))!.planId).toBe(plan.id);
    },
  );
});

describe('3 — THE LATE APPEND (MOTIR-5647 AC)', () => {
  it(
    'an author who comes back after the lease expired RE-PARKS the card',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await setStatus(card, 'in_progress');
      const plan = await plansService.createPlan(fx.projectId, { title: 'A long pause' }, fx.ctx);
      await plansService.addProposals(
        plan.id,
        [{ op: 'modify', workItemId: card, patch: { priority: 'high' } }],
        fx.ctx,
      );

      // The lease runs out and the sweep gives the card back.
      await adminDb.planTargetLock.update({
        where: { workItemId: card },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      await planTargetLockService.releaseExpired();
      expect(await statusOf(card)).toBe('in_progress');
      expect(await lockFor(card)).toBeNull();

      // The author returns and appends again — the plan is still `generating`.
      await plansService.addProposals(
        plan.id,
        [{ op: 'add', parentRef: card, proposedFields: { title: 'A child', kind: 'subtask' } }],
        fx.ctx,
      );

      expect(await statusOf(card)).toBe(PLANNING_STATUS_KEY);
      expect(await lockFor(card)).toMatchObject({ planId: plan.id, priorStatus: 'in_progress' });
    },
  );

  it(
    'and is REFUSED when somebody else took the card meanwhile',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const mine = await plansService.createPlan(fx.projectId, { title: 'Mine' }, fx.ctx);
      await plansService.addProposals(
        mine.id,
        [{ op: 'modify', workItemId: card, patch: { priority: 'high' } }],
        fx.ctx,
      );
      await adminDb.planTargetLock.update({
        where: { workItemId: card },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      await planTargetLockService.releaseExpired();

      // Somebody else takes it while I am away.
      const theirs = await plansService.createPlan(fx.projectId, { title: 'Theirs' }, fx.ctx);
      await plansService.addProposals(
        theirs.id,
        [{ op: 'modify', workItemId: card, patch: { priority: 'low' } }],
        fx.ctx,
      );

      await expect(
        plansService.addProposals(
          mine.id,
          [{ op: 'add', parentRef: card, proposedFields: { title: 'Too late', kind: 'subtask' } }],
          fx.ctx,
        ),
      ).rejects.toBeInstanceOf(PlanTargetLockedError);

      expect(await lockFor(card)).toMatchObject({ planId: theirs.id });
    },
  );
});

describe('4 — THE WHOLE WALK, per status', () => {
  for (const from of PARKABLE) {
    it(
      `\`${from}\` → park → APPROVE → To Do, with the lock gone`,
      { timeout: DB_TEST_TIMEOUT_MS },
      async () => {
        const card = await seedCard();
        await setStatus(card, from);

        const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
        await plansService.addProposals(
          plan.id,
          [{ op: 'modify', workItemId: card, patch: { descriptionMd: 'Re-scoped.' } }],
          fx.ctx,
        );
        expect(await statusOf(card)).toBe(PLANNING_STATUS_KEY);

        await plansService.markPlanned(plan.id, fx.ctx);
        await plansService.approvePlan(plan.id, fx.ctx);

        expect(await statusOf(card)).toBe('todo');
        expect(await lockFor(card)).toBeNull();
      },
    );

    it(
      `\`${from}\` → park → DECLINE → \`${from}\`, with the lock gone`,
      { timeout: DB_TEST_TIMEOUT_MS },
      async () => {
        const card = await seedCard();
        await setStatus(card, from);

        const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
        await plansService.addProposals(
          plan.id,
          [{ op: 'modify', workItemId: card, patch: { descriptionMd: 'Re-scoped.' } }],
          fx.ctx,
        );
        await plansService.markPlanned(plan.id, fx.ctx);
        await plansService.declinePlan(plan.id, fx.ctx);

        // Nothing about the card changed, so it goes back exactly where it was.
        expect(await statusOf(card)).toBe(from);
        expect(await lockFor(card)).toBeNull();
      },
    );
  }

  it(
    'a card with an open blocker rests at Blocked from EVERY parked status',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      for (const from of PARKABLE) {
        await truncateAuthTables();
        fx = await makeWorkItemFixture();
        const card = await seedCard();
        const blocker = await seedCard('An open blocker');
        await workItemsService.linkWorkItems(
          { fromId: card, toId: blocker, kind: 'is_blocked_by' },
          fx.ctx,
        );
        await setStatus(card, from);

        const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
        await plansService.addProposals(
          plan.id,
          [{ op: 'modify', workItemId: card, patch: { descriptionMd: 'Re-scoped.' } }],
          fx.ctx,
        );
        await plansService.markPlanned(plan.id, fx.ctx);
        await plansService.approvePlan(plan.id, fx.ctx);

        expect(await statusOf(card)).toBe('blocked');
      }
    },
  );
});
