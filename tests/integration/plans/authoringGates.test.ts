import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import {
  PlanGrammarError,
  PlanNotInExpectedStatusError,
  PlanRefGraphError,
  PlanTargetImmutableError,
} from '@/lib/plans/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-3573 — the AUTHORING-time gates, against real Postgres (no mocks, per
// CLAUDE.md).
//
// `planned` is the status that puts a plan in front of a person and hands them a
// button, so it must not be reachable by a plan that cannot survive being
// approved. Every rejection `validatePlanProposals` raises is now taken at the
// earliest stage that can AFFORD it:
//
//   • the APPEND runs the PURE half — no blocker listed twice, no
//     self-reference, no `parentRef` cycle — because none of those needs a read;
//   • the CLOSE (`markPlanned`) runs the whole gate, including the arms that
//     cost one batched workspace-scoped read: a dangling real ref, and the
//     kind-parent grammar.
//
// `approvePersistGate.test.ts` keeps the third stage, which this file does NOT
// replace: whether the world moved WHILE the plan waited. No check taken here
// can foresee that.
//
// ⚠️ WHAT THE APPEND CAN AND CANNOT SEE, measured rather than assumed.
// `PlanItem.id` is `@default(cuid())` and `ProposalInput` carries no id field,
// so an INCOMING proposal has no id until it is written — nothing can reference
// it, and a rejection can only name it by its position in the batch. Two
// consequences the tests below pin rather than gloss:
//   • a `parentRef` cycle and a self-reference are UNREACHABLE through
//     `addProposals` (an earlier proposal cannot name an id that did not exist
//     when it was appended), so the only pure violation a caller can actually
//     produce at the append is the DUPLICATE;
//   • the whole-plan read is therefore defence in depth — it catches a set
//     broken by a direct edit, which is exactly the case the approve gate's own
//     header says a proposal set must never be trusted against.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedItem(
  fx: WorkItemFixture,
  title: string,
  kind: 'epic' | 'story' | 'task' | 'bug' | 'subtask' = 'task',
  parentId?: string,
): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
  return dto.id;
}

async function markDone(fx: WorkItemFixture, id: string): Promise<void> {
  await workItemsService.updateStatus(id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(id, 'in_review', fx.ctx);
  await workItemsService.updateStatus(id, 'done', fx.ctx);
}

/** A `generating` plan with nothing in it. */
async function openPlan(fx: WorkItemFixture): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Proposed' }, fx.ctx);
  return plan.id;
}

/** How many proposals a plan holds, read past the service. */
async function proposalCount(planId: string): Promise<number> {
  return adminDb.planItem.count({ where: { planId } });
}

async function statusOf(planId: string): Promise<{ status: string; plannedAt: Date | null }> {
  const row = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
  return { status: row.status, plannedAt: row.plannedAt };
}

/** Run `fn`, return what it threw (and fail if it threw nothing). */
async function rejection(fn: () => Promise<unknown>): Promise<Error> {
  let thrown: Error | undefined;
  try {
    await fn();
  } catch (err) {
    thrown = err as Error;
  }
  expect(thrown, 'the call must be rejected').toBeInstanceOf(Error);
  return thrown!;
}

describe('the APPEND gate — the pure half, before the first insert', () => {
  it('refuses a blocker listed twice, and appends NOTHING', async () => {
    const fx = await makeWorkItemFixture();
    const blockerId = await seedItem(fx, 'The blocker');
    const planId = await openPlan(fx);

    const err = await rejection(() =>
      plansService.addProposals(
        planId,
        [
          {
            op: 'add',
            proposedFields: { title: 'Blocked twice', kind: 'task' },
            blockedByRefs: [blockerId, blockerId],
          },
        ],
        fx.ctx,
      ),
    );

    expect(err).toBeInstanceOf(PlanRefGraphError);
    expect((err as PlanRefGraphError).reason).toBe('duplicate');
    // The rejection names the offending proposal by its POSITION, which is the
    // only handle it has: the row was never written, so it has no id.
    expect((err as PlanRefGraphError).planItemId).toBe('incoming#0');

    expect(await proposalCount(planId)).toBe(0);
    expect((await statusOf(planId)).status).toBe('generating');
  });

  it('names the RIGHT proposal when an earlier one in the batch is fine', async () => {
    const fx = await makeWorkItemFixture();
    const blockerId = await seedItem(fx, 'The blocker');
    const planId = await openPlan(fx);

    const err = await rejection(() =>
      plansService.addProposals(
        planId,
        [
          { op: 'add', proposedFields: { title: 'Fine', kind: 'task' } },
          {
            op: 'add',
            proposedFields: { title: 'Not fine', kind: 'task' },
            blockedByRefs: [blockerId, blockerId],
          },
        ],
        fx.ctx,
      ),
    );

    expect((err as PlanRefGraphError).planItemId).toBe('incoming#1');
    // ⚠️ The whole batch is refused — the good proposal is NOT half-written.
    expect(await proposalCount(planId)).toBe(0);
  });

  it('refuses a duplicate on either side of a `modify` patch', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seedItem(fx, 'The target');
    const blockerId = await seedItem(fx, 'The blocker');

    for (const side of ['blockedByAdd', 'blockedByRemove'] as const) {
      const planId = await openPlan(fx);
      const err = await rejection(() =>
        plansService.addProposals(
          planId,
          [{ op: 'modify', workItemId: targetId, patch: { [side]: [blockerId, blockerId] } }],
          fx.ctx,
        ),
      );
      expect((err as PlanRefGraphError).reason).toBe('duplicate');
      expect(await proposalCount(planId)).toBe(0);
    }
  });

  it('⚠️ reaches the caller AS ITSELF — never wrapped as a persistence failure', async () => {
    // `addProposals` wraps its transaction in `containPrismaFailure`, whose
    // message tells the author their proposals are NOT at fault and that the
    // plan is unchanged. That is the opposite of true for a ref-graph refusal,
    // so the pass-through is asserted rather than assumed.
    const fx = await makeWorkItemFixture();
    const blockerId = await seedItem(fx, 'The blocker');
    const planId = await openPlan(fx);

    const err = await rejection(() =>
      plansService.addProposals(
        planId,
        [
          {
            op: 'add',
            proposedFields: { title: 'Blocked twice', kind: 'task' },
            blockedByRefs: [blockerId, blockerId],
          },
        ],
        fx.ctx,
      ),
    );

    expect((err as PlanRefGraphError).code).toBe('INVALID_PLAN_REF_GRAPH');
    expect(err.message).not.toContain('The database refused');
  });

  it('⚠️ ACCEPTS a real ref that resolves to nothing — that arm costs a read, so it is the CLOSE’s', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx);

    await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'Hangs off nothing', kind: 'task' },
          parentRef: 'wi_does_not_exist',
        },
      ],
      fx.ctx,
    );

    // Appended, deliberately: the pure gate never asks a question whose answer
    // lives in the workspace. `markPlanned` is where this one is answered.
    expect(await proposalCount(planId)).toBe(1);
  });

  it('accepts the ordinary layered append — parents, then children by temp-ref', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx);

    const first = await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'The story', kind: 'story' } }],
      fx.ctx,
    );
    await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'Its subtask', kind: 'subtask' },
          parentRef: `${TEMP_REF_PREFIX}${first.items[0]!.id}`,
        },
      ],
      fx.ctx,
    );

    expect(await proposalCount(planId)).toBe(2);
  });

  it('judges the WHOLE plan, not just the batch — a set broken by a direct edit is refused on the next append', async () => {
    // The cross-batch arms cannot be reached by a caller (an incoming proposal
    // has no id, so nothing can point at it). They CAN be reached by an edit
    // that writes a ref directly, which is the case the approve gate's own
    // header says a proposal set must never be trusted against — and the reason
    // the append reads the plan rather than only the batch.
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx);

    const first = await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'A', kind: 'story' } }],
      fx.ctx,
    );
    const aId = first.items[0]!.id;
    await adminDb.planItem.update({
      where: { id: aId },
      data: { parentRef: `${TEMP_REF_PREFIX}${aId}` },
    });

    const err = await rejection(() =>
      plansService.addProposals(
        planId,
        [{ op: 'add', proposedFields: { title: 'B', kind: 'story' } }],
        fx.ctx,
      ),
    );

    expect((err as PlanRefGraphError).reason).toBe('cycle');
    expect((err as PlanRefGraphError).planItemId).toBe(aId);
    // Still one proposal: the batch was refused whole.
    expect(await proposalCount(planId)).toBe(1);
  });
});

describe('the CLOSE gate — `markPlanned` runs the whole verdict before `planned`', () => {
  it('refuses a dangling real `parentRef`, leaving the plan GENERATING', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx);
    await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'Hangs off nothing', kind: 'task' },
          parentRef: 'wi_does_not_exist',
        },
      ],
      fx.ctx,
    );

    const err = await rejection(() => plansService.markPlanned(planId, fx.ctx));
    expect(err).toBeInstanceOf(PlanRefGraphError);
    expect((err as PlanRefGraphError).reason).toBe('dangling');

    // The transaction rolled back: the plan never became `planned`, and it is
    // still open to appends — which is the whole difference between a rejection
    // here and one at the approve button.
    const after = await statusOf(planId);
    expect(after.status).toBe('generating');
    expect(after.plannedAt).toBeNull();
  });

  it('refuses a `parentRef` naming a work item in ANOTHER workspace', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const foreignId = await seedItem(other, 'Foreign parent', 'story');
    const planId = await openPlan(fx);
    await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'Cross-tenant', kind: 'task' },
          parentRef: foreignId,
        },
      ],
      fx.ctx,
    );

    const err = await rejection(() => plansService.markPlanned(planId, fx.ctx));
    expect((err as PlanRefGraphError).reason).toBe('dangling');
    expect((await statusOf(planId)).status).toBe('generating');
  });

  it('refuses a kind-parent GRAMMAR violation', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx);
    // A subtask requires a parent — a top-level one is not a legal placement.
    await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'Orphan', kind: 'subtask' } }],
      fx.ctx,
    );

    const err = await rejection(() => plansService.markPlanned(planId, fx.ctx));
    expect(err).toBeInstanceOf(PlanGrammarError);
    expect((await statusOf(planId)).status).toBe('generating');
  });

  it('refuses a `modify` whose target is ALREADY terminal at the close', async () => {
    const fx = await makeWorkItemFixture();
    const targetId = await seedItem(fx, 'Shipped work');
    await markDone(fx, targetId);
    const planId = await openPlan(fx);
    await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: targetId, patch: { title: 'Rewritten' } }],
      fx.ctx,
    );

    const err = await rejection(() => plansService.markPlanned(planId, fx.ctx));
    expect(err).toBeInstanceOf(PlanTargetImmutableError);
    expect((await statusOf(planId)).status).toBe('generating');
  });

  it('⚠️ A REFUSED CLOSE IS REPAIRABLE — the author fixes the proposal and re-closes', async () => {
    // The point of moving the gate to the close rather than leaving it at
    // approve: the plan is still `generating`, so it is still the author's to
    // edit. Here the grammar violation is repaired through the deepen turn.
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx);
    const appended = await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'Orphan', kind: 'subtask' } }],
      fx.ctx,
    );

    await rejection(() => plansService.markPlanned(planId, fx.ctx));

    // ⚠️ `deepenProposal`, not `updateProposal`. The two are the SAME edit gated
    // on opposite statuses (`editAddProposal`'s `expectedStatus`): `deepenProposal`
    // is the AUTHOR's turn and requires `generating`, `updateProposal` is the
    // REVIEWER's and requires `planned`. A repair happens while the plan is still
    // the author's, so only the first one is reachable here.
    await plansService.deepenProposal(planId, appended.items[0]!.id, { kind: 'task' }, fx.ctx);
    const closed = await plansService.markPlanned(planId, fx.ctx);
    expect(closed.status).toBe('planned');

    // And the repaired plan approves, which is the property the whole card is
    // about: reaching `planned` is now a promise that the button will work.
    const approved = await plansService.approvePlan(planId, fx.ctx);
    expect(approved.status).toBe('approved');
    expect(await adminDb.workItem.count({ where: { title: 'Orphan' } })).toBe(1);
  });

  it('⚠️ A REF defect is NOT repairable — refs are settled at the append, so the plan can only be DISCARDED', async () => {
    // Measured, not assumed. `update_plan_item` cannot re-parent a proposal or
    // rewire its edges (`agent-authored-plans.md` AMENDMENT 3 D3), there is no
    // withdraw, and `addProposals` only appends. So a plan refused for a bad ref
    // stays `generating` for good — which is still strictly better than the
    // `planned`-and-dead plan it replaces, because `declinePlan` accepts
    // `generating` and records it as `discarded`, and nothing is in the queue
    // asking a reviewer to press a button that cannot work.
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx);
    await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'Bad ref', kind: 'task' }, parentRef: 'wi_gone' }],
      fx.ctx,
    );
    await rejection(() => plansService.markPlanned(planId, fx.ctx));

    const declined = await plansService.declinePlan(planId, fx.ctx);
    expect(declined.status).toBe('declined');
    expect(declined.decisionReason).toBe('discarded');
  });

  it('a VALID plan still closes exactly as before, and the close is still one-shot', async () => {
    const fx = await makeWorkItemFixture();
    const storyId = await seedItem(fx, 'The story', 'story');
    const planId = await openPlan(fx);
    await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'Its subtask', kind: 'subtask' },
          parentRef: storyId,
        },
      ],
      fx.ctx,
    );

    const closed = await plansService.markPlanned(planId, fx.ctx);
    expect(closed.status).toBe('planned');
    expect((await statusOf(planId)).plannedAt).not.toBeNull();

    // Closing twice is still refused by the status guard, not by the new gate.
    const err = await rejection(() => plansService.markPlanned(planId, fx.ctx));
    expect(err).toBeInstanceOf(PlanNotInExpectedStatusError);
    expect((err as PlanNotInExpectedStatusError).actual).toBe('planned');
  });

  it('an EMPTY plan is still a valid close — the gate passes a no-op', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await openPlan(fx);
    const closed = await plansService.markPlanned(planId, fx.ctx);
    expect(closed.status).toBe('planned');
  });
});
