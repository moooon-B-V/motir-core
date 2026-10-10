import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { PlanNotFoundError } from '@/lib/plans/errors';
import type { PlanReviewDto, PlanReviewUnchangedDto } from '@/lib/dto/planReview';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { abandonedPlanService } from '@/lib/services/abandonedPlanService';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { planReviewService } from '@/lib/services/planReviewService';
import { plansService } from '@/lib/services/plansService';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Bug MOTIR-8127 — the generating-plan poll's conditional read, and THE AUDIT that makes it safe.
//
// `GET /api/plans/[id]?since=<reviewVersion>` answers `{ unchanged: true }` instead of re-reading
// and re-sending the whole review when nothing the review shows has moved. The danger the card
// names is a write that moves what the review shows WITHOUT moving the token: the client keeps its
// snapshot, so it would stay stale with nothing to correct it. `lastActivityAt` is NOT that token —
// `markPlanned`, a decline and an abandon change the plan without stamping it — so the token is
// read from the tables the review reads (`planRepository.readReviewFingerprint`).
//
// The audit is ONE assertion applied to EVERY write door that can act on a `generating` plan:
//
//     take the token → run the door → ask "changed since that token?" → the answer is the REVIEW.
//
// The property is the user-visible one (a poll holding the old token is not told "unchanged"), not
// an implementation detail of which column moved. A new door that is not in the table below fails
// `planReviewVersionDoors.test.ts`, which is the source scan that keeps this list closed.

const DB_TEST_TIMEOUT_MS = 60_000;
const HOUR = 3_600_000;

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function isUnchanged(
  answer: PlanReviewDto | PlanReviewUnchangedDto,
): answer is PlanReviewUnchangedDto {
  return 'unchanged' in answer;
}

async function generatingPlan(fx: WorkItemFixture, titles = ['A', 'B']) {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Being written' }, fx.ctx);
  const appended = await plansService.addProposals(
    plan.id,
    titles.map((title) => ({
      op: 'add' as const,
      proposedFields: { title, kind: 'task' as const, descriptionMd: `Body of ${title}` },
    })),
    fx.ctx,
  );
  return { planId: plan.id, itemIds: appended.items.map((i) => i.id) };
}

/** The token a poll would hold after its last full read. */
async function tokenOf(planId: string, fx: WorkItemFixture): Promise<string> {
  const review = await planReviewService.getPlanReview(planId, fx.ctx);
  expect(review.status, 'a token is only minted for a generating plan').toBe('generating');
  expect(review.reviewVersion).toBeTruthy();
  return review.reviewVersion!;
}

const sinceToken = (planId: string, fx: WorkItemFixture, since: string) =>
  planReviewService.getPlanReviewIfChanged(planId, fx.ctx, since);

describe('the conditional read (MOTIR-8127)', () => {
  it(
    'answers `unchanged` for an untouched generating plan, WITHOUT reading its items',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const fx = await makeWorkItemFixture({ identifier: 'RVA' });
      const { planId } = await generatingPlan(fx);
      const token = await tokenOf(planId, fx);

      const itemReads = vi.spyOn(planItemRepository, 'findByPlan');
      const full = vi.spyOn(planReviewService, 'getPlanReview');
      const answer = await sinceToken(planId, fx, token);

      expect(isUnchanged(answer)).toBe(true);
      expect((answer as PlanReviewUnchangedDto).reviewVersion).toBe(token);
      // The whole point: no item read, no review assembly.
      expect(itemReads).not.toHaveBeenCalled();
      expect(full).not.toHaveBeenCalled();
    },
  );

  it(
    'reads the review in full when no token, or a token nobody minted, is sent',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const fx = await makeWorkItemFixture({ identifier: 'RVB' });
      const { planId } = await generatingPlan(fx);

      const none = await planReviewService.getPlanReviewIfChanged(planId, fx.ctx, null);
      expect(isUnchanged(none)).toBe(false);
      const garbage = await sinceToken(planId, fx, 'rv1.not-a-real-token');
      expect(isUnchanged(garbage)).toBe(false);
      expect((garbage as PlanReviewDto).items).toHaveLength(2);
    },
  );

  it('hands a token to a generating plan only, and the token is stable across reads', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'RVC' });
    const { planId } = await generatingPlan(fx);

    const first = await tokenOf(planId, fx);
    const second = await tokenOf(planId, fx);
    expect(second).toBe(first);

    await plansService.markPlanned(planId, fx.ctx);
    const planned = await planReviewService.getPlanReview(planId, fx.ctx);
    expect(planned.status).toBe('planned');
    expect(
      planned.reviewVersion,
      'a settled plan is not polled, so it is not versioned',
    ).toBeUndefined();
  });

  it(
    'never answers `unchanged` to a reader who may not see the plan',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const fx = await makeWorkItemFixture({ identifier: 'RVD' });
      const stranger = await makeWorkItemFixture({ identifier: 'RVE' });
      const { planId } = await generatingPlan(fx);
      const token = await tokenOf(planId, fx);

      // The same refusal an unknown id gets — the token comparison is never reached.
      await expect(sinceToken(planId, stranger, token)).rejects.toThrow(PlanNotFoundError);
    },
  );
});

// ── THE AUDIT — one row per write door that can act on a `generating` plan ──────────────────────
//
// Each row: set the plan up, take the token, run the door. The assertion is shared (below).

interface Door {
  name: string;
  /** Runs the door against a `generating` plan; returns nothing the assertion needs. */
  run: (args: { fx: WorkItemFixture; planId: string; itemIds: string[] }) => Promise<unknown>;
  /** Setup that must happen BEFORE the token is taken (e.g. a step a narration needs). */
  before?: (args: { fx: WorkItemFixture; planId: string; itemIds: string[] }) => Promise<unknown>;
}

const SESSION = 'session-a';

const DOORS: Door[] = [
  {
    name: 'plansService.addProposals',
    run: ({ fx, planId }) =>
      plansService.addProposals(
        planId,
        [
          {
            op: 'add',
            proposedFields: { title: 'C', kind: 'task', descriptionMd: 'Body of C' },
          },
        ],
        fx.ctx,
      ),
  },
  {
    name: 'plansService.deepenProposal',
    run: ({ fx, planId, itemIds }) =>
      plansService.deepenProposal(planId, itemIds[0]!, { descriptionMd: 'Deepened.' }, fx.ctx),
  },
  {
    name: 'plansService.correctPlanBrief',
    run: ({ fx, planId }) =>
      plansService.correctPlanBrief(planId, { title: 'Renamed while writing' }, fx.ctx),
  },
  {
    name: 'plansService.correctProposal',
    run: ({ fx, planId, itemIds }) =>
      plansService.correctProposal(planId, itemIds[0]!, { descriptionMd: 'Corrected.' }, fx.ctx),
  },
  {
    name: 'plansService.withdrawProposal',
    run: ({ fx, planId, itemIds }) => plansService.withdrawProposal(planId, itemIds[1]!, fx.ctx),
  },
  {
    name: 'plansService.recordPlanStep',
    run: ({ fx, planId }) =>
      plansService.recordPlanStep(
        planId,
        { sessionKey: SESSION, kind: 'settle', targetRef: null },
        fx.ctx,
      ),
  },
  {
    name: 'plansService.recordPlanNarration',
    before: ({ fx, planId }) =>
      plansService.recordPlanStep(
        planId,
        { sessionKey: SESSION, kind: 'settle', targetRef: null },
        fx.ctx,
      ),
    run: ({ fx, planId }) =>
      plansService.recordPlanNarration(
        planId,
        { sessionKey: SESSION, narration: ['I am reading the brief.'] },
        fx.ctx,
      ),
  },
  {
    name: 'plansService.endPlanStep',
    before: ({ fx, planId }) =>
      plansService.recordPlanStep(
        planId,
        { sessionKey: SESSION, kind: 'settle', targetRef: null },
        fx.ctx,
      ),
    run: ({ fx, planId }) => plansService.endPlanStep(planId, SESSION, fx.ctx),
  },
  {
    // The plan LEAVES `generating`: a poll that is told "unchanged" here never learns it finished.
    name: 'plansService.markPlanned',
    run: ({ fx, planId }) => plansService.markPlanned(planId, fx.ctx),
  },
  {
    name: 'plansService.declinePlan (a generating plan’s discard)',
    run: ({ fx, planId }) => plansService.declinePlan(planId, fx.ctx),
  },
  {
    // A person restarting the conversation ends the session AND discards the plan it was writing.
    name: 'planSessionEndService.endSession (restarted)',
    before: async ({ fx, planId }) => {
      const session = await adminDb.planChangeSession.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          createdById: fx.ctx.userId,
          scopeKey: '',
          targetKeys: [],
        },
      });
      await adminDb.plan.update({ where: { id: planId }, data: { sessionId: session.id } });
    },
    run: async ({ fx, planId }) => {
      const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
      return planSessionEndService.endSession(plan.sessionId!, 'restarted', {
        workspaceId: fx.workspaceId,
        endedById: fx.ctx.userId,
      });
    },
  },
  {
    name: 'abandonedPlanService.reconcileAbandoned',
    run: async ({ planId }) => {
      await adminDb.plan.update({
        where: { id: planId },
        data: { createdAt: new Date(Date.now() - 72 * HOUR) },
      });
      const out = await abandonedPlanService.reconcileAbandoned();
      return out;
    },
  },
];

describe('THE AUDIT: a poll holding the token from before a write door is never told `unchanged`', () => {
  it.each(DOORS.map((d) => [d.name, d] as const))(
    '%s',
    { timeout: DB_TEST_TIMEOUT_MS },
    async (_name, door) => {
      const fx = await makeWorkItemFixture();
      const { planId, itemIds } = await generatingPlan(fx);
      await door.before?.({ fx, planId, itemIds });
      const token = await tokenOf(planId, fx);

      // Sanity: with no write, the very same token IS unchanged — so the next assertion is about
      // the door, not about a token that never matched.
      expect(isUnchanged(await sinceToken(planId, fx, token))).toBe(true);

      await door.run({ fx, planId, itemIds });

      const answer = await sinceToken(planId, fx, token);
      expect(
        isUnchanged(answer),
        `${door.name} changed what the review shows but the poll was told "unchanged"`,
      ).toBe(false);
    },
  );
});
