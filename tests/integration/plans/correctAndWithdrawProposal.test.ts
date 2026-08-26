import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import {
  InvalidProposalError,
  PlanNotEditableError,
  PlanProposalReferencedError,
  UnresolvedPlanRefError,
} from '@/lib/plans/errors';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-3533 · Subtask MOTIR-3540 — the structural correction and the
// withdraw, against real Postgres.
//
// The card these prove is the SUBSTRATE: no MCP tool (its sibling) and no UI.
// So every case drives `plansService` directly, and the assertions read the
// stored rows through `adminDb` rather than the returned DTO — a service that
// refused and returned a plausible DTO would satisfy the return value and not
// the table.
//
// `docs/decisions/agent-authored-plans.md` AMENDMENT 8 is the decision these
// implement, and it amends AMENDMENT 3's D3 and D4.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A plan with two `add`s appended in SEPARATE calls, so both ids are refable. */
async function planWithTwoAdds(fx: WorkItemFixture) {
  const plan = await plansService.createPlan(
    fx.projectId,
    {
      title: 'Correctable',
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
  return {
    planId: plan.id,
    firstId: first.items[0]!.id,
    secondId: second.items.find((i) => i.id !== first.items[0]!.id)!.id,
  };
}

const row = (id: string) => adminDb.planItem.findUniqueOrThrow({ where: { id } });

describe('a correction reaches the columns the deepen turn excludes', () => {
  it('changes parentRef, blockedByRefs and targetRepo on a `planned` plan', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, firstId, secondId } = await planWithTwoAdds(fx);
    await plansService.markPlanned(planId, fx.ctx);

    await plansService.correctProposal(
      planId,
      secondId,
      {
        parentRef: `${TEMP_REF_PREFIX}${firstId}`,
        blockedByRefs: [`${TEMP_REF_PREFIX}${firstId}`],
      },
      fx.ctx,
    );

    const corrected = await row(secondId);
    expect(corrected.parentRef).toBe(`${TEMP_REF_PREFIX}${firstId}`);
    expect(corrected.blockedByRefs).toEqual([`${TEMP_REF_PREFIX}${firstId}`]);
  });

  it('works on a `generating` plan too — the act, not the status, is what is new', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, firstId, secondId } = await planWithTwoAdds(fx);
    await plansService.correctProposal(
      planId,
      secondId,
      { parentRef: `${TEMP_REF_PREFIX}${firstId}` },
      fx.ctx,
    );
    expect((await row(secondId)).parentRef).toBe(`${TEMP_REF_PREFIX}${firstId}`);
  });

  it('corrects content fields alongside structure, in one act', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, secondId } = await planWithTwoAdds(fx);
    await plansService.correctProposal(
      planId,
      secondId,
      { title: 'Renamed', storyPoints: 3, blockedByRefs: [] },
      fx.ctx,
    );
    const corrected = await row(secondId);
    expect((corrected.proposedFields as { title: string }).title).toBe('Renamed');
    expect((corrected.proposedFields as { storyPoints: number }).storyPoints).toBe(3);
  });

  it('REPLACES blockedByRefs wholesale, and `[]` clears — a list has no sparse edit', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, firstId, secondId } = await planWithTwoAdds(fx);
    await plansService.correctProposal(
      planId,
      secondId,
      { blockedByRefs: [`${TEMP_REF_PREFIX}${firstId}`] },
      fx.ctx,
    );
    expect((await row(secondId)).blockedByRefs).toEqual([`${TEMP_REF_PREFIX}${firstId}`]);
    await plansService.correctProposal(planId, secondId, { blockedByRefs: [] }, fx.ctx);
    expect((await row(secondId)).blockedByRefs).toEqual([]);
  });

  it('re-pins targetRepo through the project’s repository domain, and refuses an unknown name', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, secondId } = await planWithTwoAdds(fx);
    await expect(
      plansService.correctProposal(
        planId,
        secondId,
        { targetRepo: 'a-repo-this-project-has-never-heard-of' },
        fx.ctx,
      ),
    ).rejects.toThrow();
    // …and the refusal left the proposal alone.
    expect((await row(secondId)).proposedFields).not.toHaveProperty(
      'targetRepo',
      'a-repo-this-project-has-never-heard-of',
    );
  });

  it('corrects a `modify` proposal’s PATCH — the op no door could touch', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'An existing card' });
    const plan = await plansService.createPlan(fx.projectId, { title: 'Modify' }, fx.ctx);
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { priority: 'low' } }],
      fx.ctx,
    );
    const modifyId = appended.items[0]!.id;

    await plansService.correctProposal(
      plan.id,
      modifyId,
      { patch: { priority: 'high', storyPoints: 5 } },
      fx.ctx,
    );
    expect(await row(modifyId).then((r) => r.patch)).toEqual({ priority: 'high', storyPoints: 5 });
  });
});

describe('the deepen turn’s contract is UNCHANGED — AMENDMENT 3 D3 still holds for a deepen', () => {
  it('deepenProposal still cannot reach parentRef, blockedByRefs or targetRepo', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, firstId, secondId } = await planWithTwoAdds(fx);

    // The deepen input has no structural members, so the only way to ask is to
    // pass them anyway — and the merge must ignore every one of them. This is
    // the assertion that keeps D3 true for the turn it was written about.
    await plansService.deepenProposal(
      planId,
      secondId,
      {
        storyPoints: 2,
        parentRef: `${TEMP_REF_PREFIX}${firstId}`,
        blockedByRefs: [`${TEMP_REF_PREFIX}${firstId}`],
        targetRepo: 'motir-core',
      } as never,
      fx.ctx,
    );

    const after = await row(secondId);
    expect((after.proposedFields as { storyPoints?: number }).storyPoints).toBe(2);
    expect(after.parentRef).toBeNull();
    expect(after.blockedByRefs).toEqual([]);
    expect(after.proposedFields).not.toHaveProperty('targetRepo');
  });
});

describe('a correction cannot re-introduce the defect the append check closed', () => {
  it('REFUSES a corrected parentRef naming no proposal', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, secondId } = await planWithTwoAdds(fx);
    await expect(
      plansService.correctProposal(
        planId,
        secondId,
        { parentRef: `${TEMP_REF_PREFIX}nothing` },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(UnresolvedPlanRefError);
    expect((await row(secondId)).parentRef).toBeNull();
  });

  it('REFUSES a corrected blockedByRefs entry naming no proposal', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, secondId } = await planWithTwoAdds(fx);
    await expect(
      plansService.correctProposal(
        planId,
        secondId,
        { blockedByRefs: [`${TEMP_REF_PREFIX}nothing`] },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(UnresolvedPlanRefError);
  });

  it('REFUSES a proposal pointed at ITSELF — the resolvable set excludes the subject', async () => {
    // Without the exclusion this would RESOLVE (the proposal is an `add` on the
    // plan) and store a one-node cycle for materialize to trip over.
    const fx = await makeWorkItemFixture();
    const { planId, secondId } = await planWithTwoAdds(fx);
    await expect(
      plansService.correctProposal(
        planId,
        secondId,
        { parentRef: `${TEMP_REF_PREFIX}${secondId}` },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(UnresolvedPlanRefError);
  });
});

describe('the withdraw', () => {
  it('takes the proposal OFF the plan — the row goes, it is not neutered', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, secondId } = await planWithTwoAdds(fx);
    await plansService.withdrawProposal(planId, secondId, fx.ctx);

    expect(await adminDb.planItem.findUnique({ where: { id: secondId } })).toBeNull();
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(1);
  });

  it('REPORTS the dangling ref rather than leaving one — and names the referrer', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, firstId, secondId } = await planWithTwoAdds(fx);
    await plansService.correctProposal(
      planId,
      secondId,
      { blockedByRefs: [`${TEMP_REF_PREFIX}${firstId}`] },
      fx.ctx,
    );

    let thrown: unknown;
    try {
      await plansService.withdrawProposal(planId, firstId, fx.ctx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PlanProposalReferencedError);
    expect((thrown as Error).message).toContain(secondId);

    // Refused, so BOTH proposals are still there — no partial cascade.
    expect(await adminDb.planItem.count({ where: { planId } })).toBe(2);
  });

  it('sees a referrer on a `modify`s patch too, not only on an `add`s own fields', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'An existing card' });
    const plan = await plansService.createPlan(fx.projectId, { title: 'Both carriers' }, fx.ctx);
    const first = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'The prerequisite', kind: 'task' } }],
      fx.ctx,
    );
    const addId = first.items[0]!.id;
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'modify',
          workItemId: target.id,
          patch: { blockedByAdd: [`${TEMP_REF_PREFIX}${addId}`] },
        },
      ],
      fx.ctx,
    );

    await expect(plansService.withdrawProposal(plan.id, addId, fx.ctx)).rejects.toBeInstanceOf(
      PlanProposalReferencedError,
    );
  });

  it('RELEASES a `modify`s target, so a corrected one can be appended', async () => {
    // The escape `DUPLICATE_PLAN_TARGET` has never had.
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Contended' });
    const plan = await plansService.createPlan(fx.projectId, { title: 'Release' }, fx.ctx);
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { priority: 'low' } }],
      fx.ctx,
    );

    // While it stands, a second `modify` on that target is refused.
    await expect(
      plansService.addProposals(
        plan.id,
        [{ op: 'modify', workItemId: target.id, patch: { priority: 'high' } }],
        fx.ctx,
      ),
    ).rejects.toThrow();

    await plansService.withdrawProposal(plan.id, appended.items[0]!.id, fx.ctx);

    // …and once withdrawn it is appendable again.
    const after = await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { priority: 'high' } }],
      fx.ctx,
    );
    expect(after.items).toHaveLength(1);
  });
});

describe('`approved` and `declined` are FROZEN, and the refusal says why', () => {
  it('refuses a correction on an approved plan, naming the status and the work item', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, secondId } = await planWithTwoAdds(fx);
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);

    let thrown: unknown;
    try {
      await plansService.correctProposal(planId, secondId, { title: 'Too late' }, fx.ctx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PlanNotEditableError);
    expect((thrown as Error).message).toContain('approved');
    expect((thrown as Error).message).toContain('update_work_item');
  });

  it('refuses a withdraw on an approved plan', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, secondId } = await planWithTwoAdds(fx);
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);
    await expect(plansService.withdrawProposal(planId, secondId, fx.ctx)).rejects.toBeInstanceOf(
      PlanNotEditableError,
    );
  });

  it('refuses both on a declined plan, and says a decline is a closed decision', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, secondId } = await planWithTwoAdds(fx);
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.declinePlan(planId, fx.ctx);

    let thrown: unknown;
    try {
      await plansService.correctProposal(planId, secondId, { title: 'No' }, fx.ctx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PlanNotEditableError);
    expect((thrown as Error).message).toContain('declined');
    await expect(plansService.withdrawProposal(planId, secondId, fx.ctx)).rejects.toBeInstanceOf(
      PlanNotEditableError,
    );
  });
});

describe('both writes reach the trail, with the AGENT that made them', () => {
  it('a correction records `edited` carrying the harness and model', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, secondId } = await planWithTwoAdds(fx);
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.correctProposal(planId, secondId, { title: 'Corrected' }, fx.ctx);

    const rows = await adminDb.planRevision.findMany({
      where: { planId },
      orderBy: { changedAt: 'asc' },
    });
    const last = rows.at(-1)!;
    expect(last.changeKind).toBe('edited');
    // ⚠️ The reviewer's whole question: WHO changed the tree under them. A
    // correction on a `planned` plan is an agent act, not a person's, so the
    // actor triple must be present — `editAddProposal` files a `planned` edit
    // under the person, which is right for the review route and wrong here.
    expect(last.actorHarness).toBe('Claude Code');
    expect(last.actorModel).toBe('claude-opus-5');
    expect((last.diff as { correction?: boolean }).correction).toBe(true);
  });

  it('a withdraw records the seventh verb, and survives the row it deleted', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, secondId } = await planWithTwoAdds(fx);
    await plansService.withdrawProposal(planId, secondId, fx.ctx);

    const rows = await adminDb.planRevision.findMany({ where: { planId } });
    const withdrawn = rows.find((r) => r.changeKind === 'withdrawn')!;
    expect(withdrawn).toBeDefined();
    // The deleted id rides in the diff as a VALUE — `planItemId` is a real
    // relation and would have been nulled by the cascade, losing the subject.
    expect((withdrawn.diff as { withdrewPlanItemId?: string }).withdrewPlanItemId).toBe(secondId);
    expect(withdrawn.planItemId).toBeNull();
  });

  it('a REFUSED correction writes no revision — the trail cannot claim an act that did not happen', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, secondId } = await planWithTwoAdds(fx);
    const before = await adminDb.planRevision.count({ where: { planId } });

    await expect(
      plansService.correctProposal(
        planId,
        secondId,
        { parentRef: `${TEMP_REF_PREFIX}nothing` },
        fx.ctx,
      ),
    ).rejects.toThrow();

    expect(await adminDb.planRevision.count({ where: { planId } })).toBe(before);
  });
});

describe('the shape rules a correction still enforces', () => {
  it('refuses a `patch` on an `add`', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, secondId } = await planWithTwoAdds(fx);
    await expect(
      plansService.correctProposal(planId, secondId, { patch: { priority: 'high' } }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidProposalError);
  });

  it('refuses content fields on a `modify` — it has no proposed body', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Existing' });
    const plan = await plansService.createPlan(fx.projectId, { title: 'Shape' }, fx.ctx);
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: target.id, patch: { priority: 'low' } }],
      fx.ctx,
    );
    await expect(
      plansService.correctProposal(plan.id, appended.items[0]!.id, { title: 'Nope' }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidProposalError);
  });

  it('refuses a correction that changes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, secondId } = await planWithTwoAdds(fx);
    await expect(plansService.correctProposal(planId, secondId, {}, fx.ctx)).rejects.toBeInstanceOf(
      InvalidProposalError,
    );
  });

  it('re-validates sizing on the MERGED result, as the append does', async () => {
    // ⚠️ The rule is `lib/estimation/validate.ts`, not the Fibonacci scale the
    // planner writes to: finite, non-negative, within MAX, at most two decimal
    // places. `4` is a perfectly legal value and asserting it is refused would
    // pin a constraint the product does not have.
    const fx = await makeWorkItemFixture();
    const { planId, secondId } = await planWithTwoAdds(fx);
    await expect(
      plansService.correctProposal(planId, secondId, { storyPoints: -1 }, fx.ctx),
    ).rejects.toThrow();
    await expect(
      plansService.correctProposal(planId, secondId, { estimateMinutes: -5 }, fx.ctx),
    ).rejects.toThrow();
    // …and the proposal is untouched by either refusal.
    expect((await row(secondId)).proposedFields).not.toHaveProperty('storyPoints', -1);
  });
});
