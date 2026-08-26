import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { UnresolvedPlanRefError } from '@/lib/plans/errors';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { makeWorkItemFixture, createTestWorkItem } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-3533 · Subtask MOTIR-3539 — an unresolvable `planItem:` ref is
// REFUSED AT APPEND, against real Postgres.
//
// The verdict itself is pinned as pure logic in `tests/plans/appendRefCheck`.
// What only the database can answer is the half that matters here: that a
// refused batch leaves the plan BYTE-IDENTICAL rather than half-appended. The
// append inserts proposals one at a time, so "the whole batch is refused" is a
// claim about a transaction, and a mock is precisely where that claim would come
// from for free.
//
// Every count below is taken through `adminDb`, not through the DTO the service
// returns — a service that refused and returned a stale-but-plausible DTO would
// satisfy the return value and not the table.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const proposals = (planId: string) => adminDb.planItem.count({ where: { planId } });

describe('an unresolvable temp-ref is refused where it is written', () => {
  it('REFUSES the whole batch, and nothing from it persists', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Batch' }, fx.ctx);

    // A first call establishes a real, resolvable proposal — so the refusal
    // below cannot be explained by the plan being empty.
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'One', kind: 'task' } }],
      fx.ctx,
    );
    const before = await proposals(plan.id);
    expect(before).toBe(1);

    await expect(
      plansService.addProposals(
        plan.id,
        [
          { op: 'add', proposedFields: { title: 'Good', kind: 'task' } },
          {
            op: 'add',
            proposedFields: { title: 'Bad', kind: 'task' },
            blockedByRefs: [`${TEMP_REF_PREFIX}nope`],
          },
          { op: 'add', proposedFields: { title: 'Also good', kind: 'task' } },
        ],
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(UnresolvedPlanRefError);

    // Not "one fewer" — none. The two well-formed proposals in the batch are
    // refused with the malformed one, because `add_plan_items` returns ids
    // POSITIONALLY and a partial append desynchronises the caller's id map.
    expect(await proposals(plan.id)).toBe(before);
  });

  it('is the EXACT shape of the plan this card was written from', async () => {
    // The live artifact: two proposals in ONE batch, the second referencing the
    // first through a temp-ref that cannot exist yet — carried on a `modify`s
    // `patch.blockedByAdd`, which is the field the mistake actually rode.
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'An existing card the plan re-scopes',
    });
    const plan = await plansService.createPlan(fx.projectId, { title: 'The artifact' }, fx.ctx);

    await expect(
      plansService.addProposals(
        plan.id,
        [
          { op: 'add', proposedFields: { title: 'The prerequisite', kind: 'task' } },
          {
            op: 'modify',
            workItemId: target.id,
            patch: { blockedByAdd: [`${TEMP_REF_PREFIX}PLACEHOLDER`] },
          },
        ],
        fx.ctx,
      ),
    ).rejects.toThrow(/PLACEHOLDER/);

    // The plan never reaches the review queue carrying it.
    expect(await proposals(plan.id)).toBe(0);
  });

  it('ACCEPTS a ref to a proposal appended in an EARLIER call, exactly as before', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Two calls' }, fx.ctx);

    const first = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Parent', kind: 'story' } }],
      fx.ctx,
    );
    const parentId = first.items[0]!.id;

    const second = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Child', kind: 'task' },
          parentRef: `${TEMP_REF_PREFIX}${parentId}`,
          blockedByRefs: [`${TEMP_REF_PREFIX}${parentId}`],
        },
      ],
      fx.ctx,
    );
    expect(second.items).toHaveLength(2);
    expect(await proposals(plan.id)).toBe(2);
  });

  it('leaves a REAL work-item id unaffected in both fields', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'A real parent',
    });
    const plan = await plansService.createPlan(fx.projectId, { title: 'Real ids' }, fx.ctx);

    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Under a real parent', kind: 'task' },
          parentRef: parent.id,
          blockedByRefs: [parent.id],
        },
      ],
      fx.ctx,
    );
    expect(await proposals(plan.id)).toBe(1);
  });

  it('a batch carrying no temp-ref at all is untouched by the check', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Plain skeleton' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        { op: 'add', proposedFields: { title: 'A', kind: 'task' } },
        { op: 'add', proposedFields: { title: 'B', kind: 'task' } },
      ],
      fx.ctx,
    );
    expect(await proposals(plan.id)).toBe(2);
  });
});

describe('the approve path is unchanged — the late check is still the backstop', () => {
  it('a plan appended BEFORE this shipped still fails at approve, not silently', async () => {
    // ⚠️ THE PLAN IS CLOSED VALID AND BROKEN AFTERWARDS (MOTIR-3573). This case
    // used to seed the dangling ref underneath the service and then call
    // `markPlanned`, which was the only way to reproduce a pre-MOTIR-3539 plan
    // while the close validated nothing. `markPlanned` now runs the
    // confirmation gate, so that shape is refused AT THE CLOSE and never
    // reaches approve — which is MOTIR-3573's whole point, asserted in
    // `tests/integration/plans/authoringGates.test.ts`.
    //
    // The property THIS case owns is unchanged and still needs asserting: a
    // plan sitting at `planned` with an unresolvable ref — every plan appended
    // before MOTIR-3539 shipped is in exactly that state — is still REFUSED by
    // approve rather than materialized silently. So the plan reaches `planned`
    // legitimately and the ref is broken after, which reproduces the same
    // stored state by the only route the close now leaves open.
    //
    // ⚠️ WHICH error, measured rather than assumed. `resolveRef` is NOT what
    // such a plan meets first: `validatePlanProposals` — the confirmation gate
    // that re-validates independently BEFORE materialize writes anything — runs
    // its own dangling-ref check and refuses with `PlanRefGraphError`.
    // `resolveRef` sits behind it as the in-transaction backstop. The property
    // AC5 asks for is that approve still REFUSES such a plan and that this card
    // changed nothing on that path; naming a specific class here would pin an
    // ordering this card does not own.
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Legacy' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Orphaned edge', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    const [item] = await adminDb.planItem.findMany({ where: { planId: plan.id } });
    await adminDb.planItem.update({
      where: { id: item!.id },
      data: { blockedByRefs: [`${TEMP_REF_PREFIX}never-existed`] },
    });

    await expect(plansService.approvePlan(plan.id, fx.ctx)).rejects.toThrow(/never-existed/);

    // …and it refused BEFORE writing anything, which is the guarantee that
    // matters to the reviewer holding it.
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
  });
});
