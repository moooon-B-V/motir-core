import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  PLAN_STATUS_DTO_VALUES,
  WORK_ITEM_PENDING_PLAN_SILENT_STATUSES,
  WORK_ITEM_PENDING_PLAN_STATUSES,
} from '@/lib/dto/plans';
import { AI_PENDING_PLAN_STATUSES } from '@/lib/dto/ai';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The work-item page's PENDING-PLAN read (bug MOTIR-4197 · design MOTIR-4256
// §3 / §5) over real Postgres — `plansService.listPendingProposalsForWorkItem`.
//
// ⚠️ THE ARMS THAT MATTER ARE THE SILENT ONES. A read that returns the
// `planned` plan naming a card is easy to get right and easy to over-return:
// every positive case below passes on a read that lists every proposal that
// ever named the card. Only the `generating` / `approved` / `declined` arms —
// and the sibling card that shares the plan — can fail on it. MOTIR-4197 AC 5
// names those two negatives outright, beside the empty one.

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seed(fx: WorkItemFixture, title: string): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return dto.id;
}

type Status = (typeof PLAN_STATUS_DTO_VALUES)[number];

/** A plan in `status` carrying ONE proposal of `op` naming `target`, driven
 *  through the real service as far as the service goes. `stale` has no service
 *  path of its own — it is written by the drift guard — so it is set directly,
 *  exactly as `planDrift.test.ts` and `pendingPlansRoute.test.ts` set it. */
async function planNaming(
  fx: WorkItemFixture,
  target: string,
  op: 'modify' | 'remove',
  status: Status,
  title: string | null = 'Rework',
): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, title === null ? {} : { title }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [
      op === 'modify'
        ? { op, workItemId: target, patch: { title: 'New' } }
        : { op, workItemId: target },
    ],
    fx.ctx,
  );
  if (status === 'generating') return plan.id;
  await plansService.markPlanned(plan.id, fx.ctx);
  if (status === 'planned') return plan.id;
  if (status === 'stale') {
    await adminDb.plan.update({ where: { id: plan.id }, data: { status: 'stale' } });
    return plan.id;
  }
  if (status === 'approved') await plansService.approvePlan(plan.id, fx.ctx);
  else await plansService.declinePlan(plan.id, fx.ctx);
  return plan.id;
}

const read = (fx: WorkItemFixture, target: string) =>
  plansService.listPendingProposalsForWorkItem(fx.projectId, target, fx.ctx);

describe('the status set is TOTAL over PlanStatus, and is NOT the boundary’s', () => {
  it('announced ∪ silent is exactly PlanStatus, and the two are disjoint', () => {
    const announced = new Set<string>(WORK_ITEM_PENDING_PLAN_STATUSES);
    const silent = new Set<string>(WORK_ITEM_PENDING_PLAN_SILENT_STATUSES);
    expect([...announced].filter((s) => silent.has(s))).toEqual([]);
    expect([...PLAN_STATUS_DTO_VALUES].sort()).toEqual([...announced, ...silent].sort());
  });

  it('differs from AI_PENDING_PLAN_STATUSES on exactly `generating`', () => {
    // The boundary asks "is a run in flight for this PROJECT?" and admits
    // `generating`; the item page asks "is a decision pending about THIS card?"
    // and does not. Reusing the one for the other is the mistake the constant
    // exists to prevent, and this pins the difference so a future edit that
    // makes them equal is a red test rather than a silent widening.
    const boundary = new Set<string>(AI_PENDING_PLAN_STATUSES);
    const page = new Set<string>(WORK_ITEM_PENDING_PLAN_STATUSES);
    expect([...boundary].filter((s) => !page.has(s))).toEqual(['generating']);
    expect([...page].filter((s) => !boundary.has(s))).toEqual([]);
  });
});

describe('plansService.listPendingProposalsForWorkItem', () => {
  it('the EMPTY case — a card no plan names reads []', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'nobody proposes anything');
    expect(await read(fx, target)).toEqual([]);
  });

  it('a `planned` plan proposing a MODIFY is announced, with its id, title and op', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'about to be renamed');
    const planId = await planNaming(fx, target, 'modify', 'planned', 'Epic 8 sweep');

    expect(await read(fx, target)).toEqual([
      { planId, planTitle: 'Epic 8 sweep', planStatus: 'planned', op: 'modify' },
    ]);
  });

  it('a `planned` plan proposing a REMOVE is announced as a remove — a different sentence', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'about to be archived');
    const planId = await planNaming(fx, target, 'remove', 'planned');

    const rows = await read(fx, target);
    expect(rows.map((r) => [r.planId, r.op])).toEqual([[planId, 'remove']]);
  });

  it('a `stale` plan is announced too, for both ops — it is undecided by construction', async () => {
    const fx = await makeWorkItemFixture();
    const modified = await seed(fx, 'stale modify');
    const removed = await seed(fx, 'stale remove');
    const a = await planNaming(fx, modified, 'modify', 'stale');
    const b = await planNaming(fx, removed, 'remove', 'stale');

    expect((await read(fx, modified)).map((r) => [r.planId, r.planStatus, r.op])).toEqual([
      [a, 'stale', 'modify'],
    ]);
    expect((await read(fx, removed)).map((r) => [r.planId, r.planStatus, r.op])).toEqual([
      [b, 'stale', 'remove'],
    ]);
  });

  it('a `generating` plan is SILENT — the claim is not finished being made', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'still being written about');
    await planNaming(fx, target, 'modify', 'generating');
    expect(await read(fx, target)).toEqual([]);
  });

  it('a DECIDED plan is silent — `declined` (history) and `approved` (the tree now)', async () => {
    const fx = await makeWorkItemFixture();
    const declinedTarget = await seed(fx, 'a plan was declined about me');
    await planNaming(fx, declinedTarget, 'modify', 'declined');
    expect(await read(fx, declinedTarget)).toEqual([]);

    // Approving a `modify` writes the patch onto the SAME id (the card survives),
    // so the read is asked of the very card the plan changed — and still says
    // nothing, because there is no future left to announce.
    const approvedTarget = await seed(fx, 'a plan was approved about me');
    await planNaming(fx, approvedTarget, 'modify', 'approved');
    expect(await read(fx, approvedTarget)).toEqual([]);
  });

  it('returns ONE row per plan, in plan-creation order, and a null title as null', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'named by three plans');
    const first = await planNaming(fx, target, 'modify', 'planned', 'First');
    const second = await planNaming(fx, target, 'remove', 'stale', 'Second');
    const third = await planNaming(fx, target, 'modify', 'planned', null);
    // A decided sibling in the middle of the same set is not a row.
    await planNaming(fx, target, 'modify', 'declined', 'Declined');

    expect(await read(fx, target)).toEqual([
      { planId: first, planTitle: 'First', planStatus: 'planned', op: 'modify' },
      { planId: second, planTitle: 'Second', planStatus: 'stale', op: 'remove' },
      { planId: third, planTitle: null, planStatus: 'planned', op: 'modify' },
    ]);
  });

  it('a proposal naming a SIBLING card is not this card’s', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'me');
    const sibling = await seed(fx, 'my sibling');
    await planNaming(fx, sibling, 'modify', 'planned');

    expect(await read(fx, target)).toEqual([]);
    expect((await read(fx, sibling)).map((r) => r.op)).toEqual(['modify']);
  });

  it('is browse-gated — a stranger to the project is refused, not handed []', async () => {
    const fx = await makeWorkItemFixture();
    const target = await seed(fx, 'private');
    await planNaming(fx, target, 'modify', 'planned');
    const other = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });

    // A stranger from ANOTHER workspace meets the no-existence-leak shape: the
    // project is `NotFound` to them, not `AccessDenied` — the same refusal every
    // browse-gated plan read gives, and the one the item page turns into a 404.
    // Either way the read never reaches the repository and never hands back
    // an empty list a caller could mistake for "no pending plan".
    await expect(
      plansService.listPendingProposalsForWorkItem(fx.projectId, target, other.ctx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
