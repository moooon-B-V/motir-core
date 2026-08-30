import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { PlanRefGraphError } from '@/lib/plans/errors';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-3936 — `planned` MEANS APPROVABLE, over the EDGES the plan writes and
// through EVERY door that can write to a plan.
//
// Two occurrences produced this card, and each is a fixture below.
//
//   2026-08-29 · a correction on a `planned` plan wrote `patch.blockedByRemove:
//     ["MOTIR-3884"]` — a KEY, not an id — which resolves to nothing. The close
//     had already passed; nothing re-checked; the reviewer met
//     `INVALID_PLAN_REF_GRAPH` by pressing Approve.
//   2026-08-30 · two `modify` patches in ONE batch wrote both directions of one
//     edge between two COMMITTED work items. `final: true` accepted it,
//     `validate_plan` answered VALID twice, and approve returned a bare 500
//     three times from a BEFORE ROW trigger.
//
// The unit half is `tests/plans/validateProposals.test.ts`. What only a real
// database proves — and what this file proves — is that the three doors actually
// RUN the gate: the close leaves the plan `generating`, the correction rolls its
// own write back, and `checkApprovability` (the verdict `validate_plan` returns)
// agrees with both.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A `generating` plan carrying the two `modify` patches that close a cycle. */
async function planWithReciprocalEdges(fx: WorkItemFixture) {
  const a = await createTestWorkItem(fx, { kind: 'task', title: 'The run modal' });
  const b = await createTestWorkItem(fx, { kind: 'task', title: 'The runs index' });
  const plan = await plansService.createPlan(fx.projectId, { title: 'Reciprocal' }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [
      { op: 'modify', workItemId: a.id, patch: { blockedByAdd: [b.id] } },
      { op: 'modify', workItemId: b.id, patch: { blockedByAdd: [a.id] } },
    ],
    fx.ctx,
  );
  return { planId: plan.id, a, b };
}

describe('the CLOSE refuses a cycle across two `modify` patches (2026-08-30)', () => {
  it('refuses `final: true` and leaves the plan `generating`, where the author can fix it', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await planWithReciprocalEdges(fx);

    await expect(plansService.markPlanned(planId, fx.ctx)).rejects.toBeInstanceOf(
      PlanRefGraphError,
    );

    // The whole point of refusing HERE: the plan is still editable.
    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(row.status).toBe('generating');
    expect(row.plannedAt).toBeNull();
  });

  it('names BOTH cards by key and title, so the message says what to drop', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, a, b } = await planWithReciprocalEdges(fx);

    const err = await plansService.markPlanned(planId, fx.ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanRefGraphError);
    const message = (err as Error).message;
    expect(message).toContain(a.identifier);
    expect(message).toContain('The run modal');
    expect(message).toContain(b.identifier);
    expect(message).toContain('The runs index');
  });

  it('`checkApprovability` — the verdict `validate_plan` returns — refuses the SAME plan', async () => {
    // The second occurrence's sharpest fact: this call answered VALID twice on a
    // plan approve refused three times. It shares one implementation with the
    // close and with approve, so it cannot disagree with either.
    const fx = await makeWorkItemFixture();
    const { planId } = await planWithReciprocalEdges(fx);

    const rejections = await plansService.checkApprovability(planId, fx.ctx);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.code).toBe('INVALID_PLAN_REF_GRAPH');
    expect(rejections[0]!.reason).toBe('cycle');
  });

  it('accepts the plan once the reverse edge is dropped', async () => {
    const fx = await makeWorkItemFixture();
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'The run modal' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'The runs index' });
    const plan = await plansService.createPlan(fx.projectId, { title: 'One way' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: a.id, patch: { blockedByAdd: [b.id] } }],
      fx.ctx,
    );

    await expect(plansService.checkApprovability(plan.id, fx.ctx)).resolves.toEqual([]);
    const closed = await plansService.markPlanned(plan.id, fx.ctx);
    expect(closed.status).toBe('planned');
  });

  it('refuses one proposed edge that closes a ring through COMMITTED edges', async () => {
    // Nothing in the plan mentions the chain. Only a walk over the committed
    // graph — the one the trigger does — can see it.
    const fx = await makeWorkItemFixture();
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'Alpha' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'Beta' });
    const c = await createTestWorkItem(fx, { kind: 'task', title: 'Gamma' });
    // b blocked_by c, c blocked_by a — COMMITTED edges, written the way the
    // product writes them, so the trigger has already had its say about them.
    await adminDb.workItemLink.createMany({
      data: [
        {
          workspaceId: fx.workspaceId,
          fromId: b.id,
          toId: c.id,
          kind: 'is_blocked_by',
          createdById: fx.ctx.userId,
        },
        {
          workspaceId: fx.workspaceId,
          fromId: c.id,
          toId: a.id,
          kind: 'is_blocked_by',
          createdById: fx.ctx.userId,
        },
      ],
    });

    const plan = await plansService.createPlan(fx.projectId, { title: 'Ring closer' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: a.id, patch: { blockedByAdd: [b.id] } }],
      fx.ctx,
    );

    await expect(plansService.markPlanned(plan.id, fx.ctx)).rejects.toBeInstanceOf(
      PlanRefGraphError,
    );
  });
});

describe('a CORRECTION cannot move a `planned` plan out of approvable (2026-08-29)', () => {
  /** A `planned` plan holding one `modify` on a real card. */
  async function plannedPlanWithModify(fx: WorkItemFixture) {
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'The redirect sweep' });
    const other = await createTestWorkItem(fx, { kind: 'task', title: 'The other card' });
    const plan = await plansService.createPlan(fx.projectId, { title: 'Correctable' }, fx.ctx);
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { blockedByAdd: [other.id] } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    return { planId: plan.id, itemId: appended.items[0]!.id, target, other };
  }

  it('refuses a correction that writes a `MOTIR-<n>` KEY where a ref belongs — the fixture', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId, target } = await plannedPlanWithModify(fx);

    const err = await plansService
      .correctProposal(planId, itemId, { patch: { blockedByRemove: [target.identifier] } }, fx.ctx)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PlanRefGraphError);
    expect((err as PlanRefGraphError).reason).toBe('dangling');
    // The message a reviewer used to meet named a cuid and nothing else.
    expect((err as Error).message).toContain(target.identifier);
    expect((err as Error).message).toContain('never a `<PREFIX>-<n>` key');
  });

  it('ROLLS THE WRITE BACK — the stored proposal is byte-identical', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId, target, other } = await plannedPlanWithModify(fx);
    const before = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });

    await plansService
      .correctProposal(planId, itemId, { patch: { blockedByRemove: [target.identifier] } }, fx.ctx)
      .catch(() => undefined);

    const after = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(after.patch).toEqual(before.patch);
    expect(after.blockedByRefs).toEqual(before.blockedByRefs);
    // And no trail row was written for a correction that did not happen.
    expect(await adminDb.planRevision.count({ where: { planId, changeKind: 'edited' } })).toBe(0);
    expect(other.id).toBeTruthy();
  });

  it('still allows a VALID correction on a `planned` plan', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId, other } = await plannedPlanWithModify(fx);

    const corrected = await plansService.correctProposal(
      planId,
      itemId,
      { patch: { blockedByRemove: [other.id] } },
      fx.ctx,
    );
    expect(corrected.items[0]!.patch).toMatchObject({ blockedByRemove: [other.id] });
  });

  it('refuses a correction that closes a CYCLE, and permits the one that undoes it', async () => {
    const fx = await makeWorkItemFixture();
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'Alpha' });
    const b = await createTestWorkItem(fx, { kind: 'task', title: 'Beta' });
    const plan = await plansService.createPlan(fx.projectId, { title: 'Two edges' }, fx.ctx);
    const appended = await plansService.addProposals(
      plan.id,
      [
        { op: 'modify', workItemId: a.id, patch: { blockedByAdd: [b.id] } },
        { op: 'modify', workItemId: b.id, patch: {} },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    const second = appended.items[1]!.id;

    await expect(
      plansService.correctProposal(plan.id, second, { patch: { blockedByAdd: [a.id] } }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanRefGraphError);
  });

  it('DOES NOT LOCK THE AUTHOR OUT of repairing a plan that is ALREADY unapprovable', async () => {
    // The gate compares BEFORE with AFTER. A plan broken by something else — a
    // pre-gate close, or the tree moving — is precisely the plan somebody is
    // correcting, and refusing the repair because the plan is still broken
    // mid-repair would leave nobody able to make one.
    const fx = await makeWorkItemFixture();
    const { planId, itemId, target } = await plannedPlanWithModify(fx);
    // Break it the way a pre-MOTIR-3936 correction did: straight into the row.
    await adminDb.planItem.update({
      where: { id: itemId },
      data: { patch: { blockedByRemove: ['MOTIR-9999'] } },
    });
    expect(await plansService.checkApprovability(planId, fx.ctx)).toHaveLength(1);

    // A correction that leaves it broken is still ALLOWED — it is a step of the
    // repair, not a new defect.
    const corrected = await plansService.correctProposal(
      planId,
      itemId,
      { patch: { blockedByRemove: ['MOTIR-9999'], blockedByAdd: [target.id] } },
      fx.ctx,
    );
    expect(corrected.items[0]!.patch).toMatchObject({ blockedByRemove: ['MOTIR-9999'] });

    // And the repair that finishes the job leaves it approvable.
    await plansService.correctProposal(
      planId,
      itemId,
      { patch: { blockedByAdd: [target.id] } },
      fx.ctx,
    );
    expect(await plansService.checkApprovability(planId, fx.ctx)).toEqual([]);
  });
});

describe('a WITHDRAW runs the same gate', () => {
  it('leaves a valid plan valid and records the withdrawal', async () => {
    const fx = await makeWorkItemFixture();
    const a = await createTestWorkItem(fx, { kind: 'task', title: 'Alpha' });
    const plan = await plansService.createPlan(fx.projectId, { title: 'Withdrawable' }, fx.ctx);
    const appended = await plansService.addProposals(
      plan.id,
      [
        { op: 'add', proposedFields: { title: 'A new card', kind: 'task' } },
        { op: 'modify', workItemId: a.id, patch: { storyPoints: 3 } },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const after = await plansService.withdrawProposal(plan.id, appended.items[0]!.id, fx.ctx);
    expect(after.items).toHaveLength(1);
    expect(await plansService.checkApprovability(plan.id, fx.ctx)).toEqual([]);
  });
});
