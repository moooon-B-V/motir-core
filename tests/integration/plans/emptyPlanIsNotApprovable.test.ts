import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { PlanHasNoProposalsError } from '@/lib/plans/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-4146 — A PLAN HOLDING NOTHING IS NOT APPROVABLE, AT EITHER DOOR.
//
// MOTIR-4124 established the rule where a plan is WRITTEN: `markPlanned` over an
// empty proposal set discards rather than queues, because `planned` means *a
// person is being asked to decide this* and there is nothing there to decide.
// It established it at that one door, and an invariant enforced at one door is
// not an invariant — it is a habit that holds until somebody uses another one.
//
// Two other doors reach the same state and neither re-asks the question:
//
//   * `approvePlan` — its only status gate is `status === 'planned'`, so a plan
//     holding zero proposals APPROVES: it materializes nothing and writes a
//     decision saying a plan was accepted into a backlog it never touched. The
//     rows that can still do this are the LEGACY ones MOTIR-4124 deliberately
//     left unmigrated ("no data migration, deliberately"), which is exactly the
//     shape each case here builds.
//   * `withdrawProposal` — `assertPlanProposalsEditable` admits `planned`, so a
//     `planned` plan's proposals can be taken off one at a time, and the last
//     one leaves an empty `planned` plan MINTED TODAY. `plansService.ts`'s own
//     comment already names this class for a different invariant (the ref graph,
//     MOTIR-3936): "AMENDMENT 8 then opened two doors onto a `planned` plan …
//     and neither re-asks the question the close answered."
//
// Against real Postgres, and the assertions read the stored `plan` row through
// `adminDb` rather than the returned DTO — a service that answered plausibly and
// wrote the other thing would satisfy a DTO assertion and not the table.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/**
 * A `planned` plan holding ZERO proposals — the LEGACY row, built the only way
 * it can still be built.
 *
 * It is closed with a proposal (the close refuses to queue an empty plan since
 * MOTIR-4124) and the row is then deleted underneath it, which is precisely the
 * state PR #2502 left behind for every plan that had already reached `planned`
 * empty. Deleting through `adminDb` rather than through `withdrawProposal` keeps
 * this fixture independent of the withdraw fix asserted below — otherwise the
 * approve cases would silently stop testing approve the moment the withdraw
 * started declining.
 */
async function legacyEmptyPlannedPlan(fx: WorkItemFixture): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Proposes nothing' }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'A story', kind: 'story' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  await adminDb.planItem.deleteMany({ where: { planId: plan.id } });
  // The premise, asserted rather than assumed: this IS the reported shape.
  const row = await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } });
  expect(row.status).toBe('planned');
  expect(await adminDb.planItem.count({ where: { planId: plan.id } })).toBe(0);
  return plan.id;
}

describe('approvePlan refuses a plan holding zero proposals (MOTIR-4146)', () => {
  it('throws, and leaves the plan `planned` rather than writing `approved`', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await legacyEmptyPlannedPlan(fx);

    await expect(plansService.approvePlan(planId, fx.ctx)).rejects.toBeInstanceOf(
      PlanHasNoProposalsError,
    );

    // The row is the assertion. Before this guard the approve SUCCEEDED: it
    // stamped `approved`, `decidedAt` and `decidedById`, and recorded an
    // `approved` revision carrying `itemCount: 0` — a decision saying a plan was
    // accepted into a backlog it had put nothing in.
    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(row.status).toBe('planned');
    expect(row.decidedAt).toBeNull();
    expect(row.decidedById).toBeNull();

    const revisions = await adminDb.planRevision.findMany({ where: { planId } });
    expect(revisions.some((r) => r.changeKind === 'approved')).toBe(false);
  });

  it('leaves a plan holding ONE proposal untouched — it still approves and materializes', async () => {
    // The counterfactual. Without it, "approve refuses" is satisfied by an
    // approve that refuses everything.
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Proposes one' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A real story', kind: 'story' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    await plansService.approvePlan(plan.id, fx.ctx);

    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(row.status).toBe('approved');
    expect(
      await adminDb.workItem.count({ where: { projectId: fx.projectId, title: 'A real story' } }),
    ).toBe(1);
  });
});

describe('withdrawing the LAST proposal of a `planned` plan ENDS it (MOTIR-4146)', () => {
  /** A `planned` plan holding exactly two `add`s, each appended separately. */
  async function plannedWithTwoAdds(fx: WorkItemFixture) {
    const plan = await plansService.createPlan(fx.projectId, { title: 'Withdrawable' }, fx.ctx);
    const first = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'The first', kind: 'story' } }],
      fx.ctx,
    );
    const second = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'The second', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    return {
      planId: plan.id,
      firstId: first.items[0]!.id,
      secondId: second.items.find((i) => i.id !== first.items[0]!.id)!.id,
    };
  }

  it('lands it `declined` + `discarded` — MOTIR-4124’s vocabulary, at the other door', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, firstId, secondId } = await plannedWithTwoAdds(fx);

    await plansService.withdrawProposal(planId, firstId, fx.ctx);
    const afterFirst = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    // Not the last one: nothing about the plan's status changes.
    expect(afterFirst.status).toBe('planned');
    expect(afterFirst.decisionReason).toBeNull();

    const returned = await plansService.withdrawProposal(planId, secondId, fx.ctx);

    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(row.status).toBe('declined');
    expect(row.decisionReason).toBe('discarded');
    // Nobody DECIDED this — the last proposal was taken off, exactly as the
    // empty close records it (`decidedById: null`).
    expect(row.decidedById).toBeNull();
    expect(row.decidedAt).not.toBeNull();
    // …and the caller is told, rather than being handed the pre-write row.
    expect(returned.status).toBe('declined');
  });

  it('records the ending on the trail, so the timeline says what happened', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, firstId, secondId } = await plannedWithTwoAdds(fx);
    await plansService.withdrawProposal(planId, firstId, fx.ctx);
    await plansService.withdrawProposal(planId, secondId, fx.ctx);

    const revisions = await adminDb.planRevision.findMany({ where: { planId } });
    const declined = revisions.find((r) => r.changeKind === 'declined');
    expect(declined).toBeDefined();
    expect(declined!.diff).toMatchObject({ itemCount: 0, decisionReason: 'discarded' });
    // The withdrawal itself is still recorded — the ending is an ADDITIONAL
    // verb, not a replacement for the one that caused it.
    expect(revisions.filter((r) => r.changeKind === 'withdrawn')).toHaveLength(2);
  });

  it('leaves a `generating` plan generating — the producer has not finished writing', async () => {
    // ⚠️ THE BOUNDARY, and it is the whole reason this fix is scoped to
    // `planned`. A `generating` plan holding nothing is a pass that has not
    // finished, which is the state MOTIR-3193 relaxed the empty final batch to
    // ESCAPE; ending it here would decide a plan whose author is still typing.
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Still writing' }, fx.ctx);
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'A draft', kind: 'story' } }],
      fx.ctx,
    );

    await plansService.withdrawProposal(plan.id, appended.items[0]!.id, fx.ctx);

    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(row.status).toBe('generating');
    expect(row.decisionReason).toBeNull();
  });
});
