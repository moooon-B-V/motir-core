import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { parentStatusRollupService } from '@/lib/services/parentStatusRollupService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE PLAN HOLD meets the parent rollup (Story MOTIR-6017 · MOTIR-6265;
// `docs/decisions/agent-authored-plans.md` AMENDMENT 21 §5(b)) — against a REAL
// Postgres. A parent an UNDECIDED plan is rewriting is not the derivation's to
// move, on EITHER arm: the forward walk would be refused by the funnel, and the
// backward arm is a `{ system: true }` set the funnel exempts, which is why the
// service asks the hold ahead of both. Lives beside the rollup's own suites so the
// approved-status coverage lane (`vitest.coverage.approved-status.config.ts`),
// which measures `parentStatusRollupService.ts`, sees it.

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

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

async function lockFor(workItemId: string) {
  return adminDb.planTargetLock.findUnique({ where: { workItemId } });
}

/** An MCP-authored plan with one `modify` naming the card, closed to `planned`.
 *  The append PARKS the card at `planning` under a plan-held lock. */
async function plannedModify(workItemId: string): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'modify', workItemId, patch: { descriptionMd: 'Re-scoped.' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

describe('a background mover records an outcome (§5(b))', () => {
  async function heldStoryWithChild() {
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story' },
      fx.ctx,
    );
    const child = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', parentId: story.id, title: 'Child' },
      fx.ctx,
    );
    await plannedModify(story.id);
    expect(await statusOf(story.id)).toBe(PLANNING_STATUS_KEY);
    return { story, child };
  }

  it.each([
    // FORWARD: every child built would walk the parent up the ladder.
    ['forward', 'implemented'],
    // BACKWARD: every child unstarted would SYSTEM-set the parent to To Do — the
    // arm the funnel's refusal cannot see.
    ['backward', 'todo'],
  ])(
    'the parent rollup answers `plan_held` on its %s arm and moves nothing',
    { timeout: DB_TEST_TIMEOUT_MS },
    async (_arm, childStatus) => {
      const { story, child } = await heldStoryWithChild();
      await adminDb.workItem.update({ where: { id: child.id }, data: { status: childStatus } });

      const out = await parentStatusRollupService.recomputeParent(story.id, fx.workspaceId);

      expect(out).toMatchObject({ outcome: 'plan_held', parentId: story.id });
      expect(await statusOf(story.id)).toBe(PLANNING_STATUS_KEY);
      expect(await lockFor(story.id)).not.toBeNull();
    },
  );
});
