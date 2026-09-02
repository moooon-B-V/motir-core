import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import {
  PlanNotEditableError,
  PlanNotGeneratingError,
  PlanRefGraphError,
  UnresolvedPlanRefError,
} from '@/lib/plans/errors';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Bug MOTIR-4153 — the APPEND reaches a `planned` plan through the door
// AMENDMENT 10 D1 built and only the job seam had used
// (`docs/decisions/agent-authored-plans.md` AMENDMENT 12).
//
// This file is the SERVICE half; `tests/mcp/append-to-planned-plan.test.ts` is
// the door. The split follows the one the correction verbs already use: what
// only the transport can answer (the schema, the permission, the grant refusal)
// lives there, and everything about what the plan substrate DOES lives here,
// asserted off the stored rows through `adminDb` rather than off a returned DTO
// — a service that refused and returned a plausible DTO would satisfy the return
// value and not the table.
//
// `revisionLease.test.ts` already covers D1's relaxation in both directions for
// the job seam. What is new here, and what has no other home, is D3: a revision
// is the only append with NO CLOSE still coming, so it runs the close's own
// gate.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A CLOSED plan (`planned`) holding two `add`s appended in separate calls, so
 *  both ids are refable by a later batch. */
async function plannedPlanWithTwoAdds(fx: WorkItemFixture) {
  const plan = await plansService.createPlan(
    fx.projectId,
    {
      title: 'A landed plan',
      authorSource: 'mcp',
      authorHarness: 'Claude Code',
      authorModel: 'claude-opus-5',
    },
    fx.ctx,
  );
  const first = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The prerequisite', kind: 'story' } }],
    fx.ctx,
  );
  const second = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'The dependent', kind: 'task' } }],
    fx.ctx,
  );
  await plansService.markPlanned(plan.id, fx.ctx);
  return { planId: plan.id, firstId: first.items[0]!.id, secondId: second.items[1]!.id };
}

const countItems = (planId: string) => adminDb.planItem.count({ where: { planId } });

describe('a DECLARED revision grows a `planned` plan; an undeclared append does not', () => {
  it('appends to a `planned` plan and leaves it `planned` — no re-open', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlanWithTwoAdds(fx);

    const after = await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'The card the correction needed', kind: 'task' } }],
      fx.ctx,
      { revision: true },
    );

    expect(after.items).toHaveLength(3);
    // The status is the half AMENDMENT 10 D1 is most explicit about: a revision
    // does not re-open a plan.
    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(row.status).toBe('planned');
    const stored = await adminDb.planItem.findMany({ where: { planId }, orderBy: { id: 'asc' } });
    expect(
      stored.map((i) => (i.proposedFields as { title?: string } | null)?.title).filter(Boolean),
    ).toContain('The card the correction needed');
  });

  it('the SAME batch without the flag is refused, and the refusal names it', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlanWithTwoAdds(fx);

    const refused = await plansService
      .addProposals(
        planId,
        [{ op: 'add', proposedFields: { title: 'Undeclared', kind: 'task' } }],
        fx.ctx,
      )
      .catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(PlanNotGeneratingError);
    // The message is the whole point of the refusal: a caller one flag away from
    // what it wanted must not be told "no more proposals can be appended", which
    // is what sends it to author a second plan.
    expect((refused as Error).message).toContain('revision: true');
    expect((refused as Error).message).toContain('planned');
    expect(await countItems(planId)).toBe(2);
  });

  it('on a `generating` plan the flag changes nothing — same gate, same result', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Open' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Declared on an open plan', kind: 'task' } }],
      fx.ctx,
      { revision: true },
    );
    expect(await countItems(plan.id)).toBe(1);
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } })).status).toBe(
      'generating',
    );
  });
});

describe('`approved` and `declined` stay FROZEN — the boundary does not move', () => {
  it('an approved plan refuses a revision, naming the status and the surface', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlanWithTwoAdds(fx);
    await plansService.approvePlan(planId, fx.ctx);

    const refused = await plansService
      .addProposals(
        planId,
        [{ op: 'add', proposedFields: { title: 'Too late', kind: 'task' } }],
        fx.ctx,
        {
          revision: true,
        },
      )
      .catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(PlanNotEditableError);
    expect((refused as Error).message).toContain('approved');
    expect((refused as Error).message).toContain('update_work_item');
  });

  it('a declined plan refuses a revision too', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlanWithTwoAdds(fx);
    await plansService.declinePlan(planId, fx.ctx);

    const refused = await plansService
      .addProposals(
        planId,
        [{ op: 'add', proposedFields: { title: 'Too late', kind: 'task' } }],
        fx.ctx,
        {
          revision: true,
        },
      )
      .catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(PlanNotEditableError);
    expect((refused as Error).message).toContain('declined');
    expect(await countItems(planId)).toBe(2);
  });
});

describe('the append’s REF CHECK runs unchanged on the revision path', () => {
  it('a `planItem:` ref to an already-persisted `add` resolves and is stored', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, firstId } = await plannedPlanWithTwoAdds(fx);

    // The resolvable set is the plan's already-persisted `add`s — which for a
    // revision simply includes everything the original authoring pass wrote, so
    // a revision can reference the tree it is revising for free (D1's own line).
    const after = await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'A child of the prerequisite', kind: 'task' },
          parentRef: `${TEMP_REF_PREFIX}${firstId}`,
        },
      ],
      fx.ctx,
      { revision: true },
    );

    const created = after.items.find(
      (i) =>
        (i.proposedFields as { title?: string } | null)?.title === 'A child of the prerequisite',
    )!;
    expect(
      (await adminDb.planItem.findUniqueOrThrow({ where: { id: created.id } })).parentRef,
    ).toBe(`${TEMP_REF_PREFIX}${firstId}`);
  });

  it('a ref naming NOTHING is refused AT THE CALL, and the plan is byte-identical', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlanWithTwoAdds(fx);
    const before = await adminDb.planItem.findMany({ where: { planId }, orderBy: { id: 'asc' } });

    const refused = await plansService
      .addProposals(
        planId,
        [
          {
            op: 'add',
            proposedFields: { title: 'Dangling', kind: 'task' },
            blockedByRefs: [`${TEMP_REF_PREFIX}PLACEHOLDER`],
          },
        ],
        fx.ctx,
        { revision: true },
      )
      .catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(UnresolvedPlanRefError);
    // MOTIR-3539's property, asserted rather than assumed on the new path: a
    // refusal leaves the plan byte-identical rather than half-appended, because
    // `add_plan_items` returns its ids POSITIONALLY.
    expect(await adminDb.planItem.findMany({ where: { planId }, orderBy: { id: 'asc' } })).toEqual(
      before,
    );
  });

  it('a ref to a proposal in the SAME batch is refused — its id does not exist yet', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlanWithTwoAdds(fx);

    const refused = await plansService
      .addProposals(
        planId,
        [
          { op: 'add', proposedFields: { title: 'Parent in this batch', kind: 'story' } },
          {
            op: 'add',
            proposedFields: { title: 'Child in this batch', kind: 'task' },
            parentRef: `${TEMP_REF_PREFIX}not-yet-persisted`,
          },
        ],
        fx.ctx,
        { revision: true },
      )
      .catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(UnresolvedPlanRefError);
    expect(await countItems(planId)).toBe(2);
  });
});

// ── ⚠️ D3 · THE CLOSE'S GATE, ON THE ONE APPEND WITH NO CLOSE COMING ─────────

describe('a revision append runs the CLOSE’s gate — the arm `markPlanned` used to own', () => {
  // ⚠️ THE SUBJECT IS A `blockedByRefs` ENTRY, NOT A `modify`'s TARGET, and the
  // difference is a finding rather than a fixture detail. `PlanItem.workItemId`
  // carries a real foreign key, so a `modify` naming a DELETED work item is
  // refused by Postgres at the insert (P2003 → `PlanPersistenceError`) on both
  // paths and was never the gate's business. `blockedByRefs` is a `String[]`
  // with no FK, so a ref naming nothing is stored happily and is caught only by
  // the `liveById` arm — which is exactly the arm the append delegates to the
  // close.
  const NAMES_NOTHING = 'wi_does_not_exist';

  it('a ref that resolves to NOTHING is REFUSED on a revision, and nothing lands', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlanWithTwoAdds(fx);

    const refused = await plansService
      .addProposals(
        planId,
        [
          {
            op: 'add',
            proposedFields: { title: 'Points at nothing', kind: 'task' },
            blockedByRefs: [NAMES_NOTHING],
          },
        ],
        fx.ctx,
        { revision: true },
      )
      .catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(PlanRefGraphError);
    expect((refused as PlanRefGraphError).reason).toBe('dangling');
    // A throw inside the transaction rolls the inserts back, so the plan is
    // exactly the plan the reviewer was already reading.
    expect(await countItems(planId)).toBe(2);
  });

  it('the SAME batch on a `generating` plan is ACCEPTED — the close still owns it there', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Still open' }, fx.ctx);

    // The append deliberately does NOT take the `liveById` arm — "a plan may
    // legitimately reference an item created between the two" — and D3 must not
    // have changed that for the path that still has a close coming. This is the
    // control that makes the case above a statement about the REVISION and not
    // about the append.
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Points at nothing, for now', kind: 'task' },
          blockedByRefs: [NAMES_NOTHING],
        },
      ],
      fx.ctx,
    );
    expect(await countItems(plan.id)).toBe(1);

    // …and `markPlanned` is what refuses it, which is the half of the split that
    // has no equivalent once a plan is `planned`.
    const closed = await plansService.markPlanned(plan.id, fx.ctx).catch((e: unknown) => e);
    expect(closed).toBeInstanceOf(PlanRefGraphError);
  });

  it('an ALREADY-unapprovable plan can still be appended to — it is the repair', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Broken then repaired' },
      fx.ctx,
    );
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Closed clean', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    // The plan closed CLEAN and was broken afterwards — MOTIR-3936's own shape,
    // and the case the BEFORE/AFTER comparison exists for: refusing the repair
    // because the plan is still broken mid-repair would lock the author out of
    // the only tool that fixes it.
    await adminDb.planItem.update({
      where: { id: appended.items[0]!.id },
      data: { blockedByRefs: [NAMES_NOTHING] },
    });

    const after = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'The replacement card', kind: 'task' } }],
      fx.ctx,
      { revision: true },
    );

    expect(after.items).toHaveLength(2);
    expect(await countItems(plan.id)).toBe(2);
  });
});

describe('the addition lands on the plan’s TIMELINE, with who made it', () => {
  it('writes an `appended` row carrying the harness and model', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await plannedPlanWithTwoAdds(fx);
    const trail = () =>
      adminDb.planRevision.findMany({ where: { planId }, orderBy: { changedAt: 'asc' } });
    const before = await trail();

    await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'Arrived after the close', kind: 'task' } }],
      fx.ctx,
      { revision: true },
    );

    const after = await trail();
    expect(after.length).toBe(before.length + 1);
    // The VISIBILITY property D1 makes the relaxation conditional on: the
    // proposal set of a `planned` plan may not change INVISIBLY, and a trail row
    // is what makes the change loud. It lands AFTER the close, which is what
    // tells a reviewer the card arrived while they were reading.
    const latest = after[after.length - 1]!;
    expect(latest.changeKind).toBe('appended');
    expect(after.map((r) => r.changeKind)).toContain('planned');
    expect(after.indexOf(latest)).toBeGreaterThan(
      after.findIndex((r) => r.changeKind === 'planned'),
    );
    expect(latest.actorHarness).toBe('Claude Code');
    expect(latest.actorModel).toBe('claude-opus-5');
  });
});
