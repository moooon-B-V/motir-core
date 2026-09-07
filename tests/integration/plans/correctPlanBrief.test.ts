import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { InvalidProposalError, PlanNotEditableError } from '@/lib/plans/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-4637 — the plan's OWN `title` / `summary` are correctable, against real
// Postgres.
//
// `docs/decisions/agent-authored-plans.md` AMENDMENT 13 is the decision this
// implements. Every case drives `plansService` directly and reads the stored
// rows through `adminDb` rather than the returned DTO — a service that refused
// and returned a plausible DTO would satisfy the return value and not the table,
// which is `correctAndWithdrawProposal.test.ts`'s discipline and the reason it
// caught what it caught.
//
// ⚠️ THE ASSERTIONS THAT MATTER ARE THE NEGATIVE ONES. A brief edit is a small
// write and the risk is not that it fails — it is that it also moves something
// nobody asked it to move. So the proposal set, the status, `plannedAt` and the
// item ids are each asserted UNCHANGED, directly, rather than left implied.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A plan carrying THREE proposals and a wrong summary — the incident's shape. */
async function planWithThreeAdds(fx: WorkItemFixture) {
  const plan = await plansService.createPlan(
    fx.projectId,
    {
      title: 'Close the BYOK code-index loop',
      summary: 'The org is the billing unit for code indexing.',
      authorSource: 'mcp',
      authorHarness: 'Claude Code',
      authorModel: 'claude-opus-5',
    },
    fx.ctx,
  );
  const ids: string[] = [];
  for (const title of ['The prerequisite', 'The dependent', 'The verification']) {
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title, kind: 'task' } }],
      fx.ctx,
    );
    ids.push(appended.items.find((i) => !ids.includes(i.id))!.id);
  }
  return { planId: plan.id, itemIds: ids };
}

const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });

describe('a plan’s own title and summary can be corrected after creation', () => {
  it('corrects the summary on a `planned` plan — the case the card exists for', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await planWithThreeAdds(fx);
    await plansService.markPlanned(planId, fx.ctx);

    await plansService.correctPlanBrief(
      planId,
      { summary: 'The org is the ATTRIBUTION unit; indexing is absorbed.' },
      fx.ctx,
    );

    const row = await planRow(planId);
    expect(row.summary).toBe('The org is the ATTRIBUTION unit; indexing is absorbed.');
    // SPARSE: the title was not sent, so it is exactly as it was.
    expect(row.title).toBe('Close the BYOK code-index loop');
  });

  it('works on a `generating` plan too — the act, not the status, is what is new', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await planWithThreeAdds(fx);

    await plansService.correctPlanBrief(planId, { title: 'Renamed while writing' }, fx.ctx);

    const row = await planRow(planId);
    expect(row.title).toBe('Renamed while writing');
    expect(row.status).toBe('generating');
  });

  it('corrects BOTH fields in one act — `title` travels with `summary` (D4)', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await planWithThreeAdds(fx);
    await plansService.markPlanned(planId, fx.ctx);

    await plansService.correctPlanBrief(planId, { title: 'Both', summary: 'At once.' }, fx.ctx);

    const row = await planRow(planId);
    expect(row.title).toBe('Both');
    expect(row.summary).toBe('At once.');
  });

  it('an explicit `null` CLEARS a field, and an omitted one is left alone', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await planWithThreeAdds(fx);
    await plansService.markPlanned(planId, fx.ctx);

    await plansService.correctPlanBrief(planId, { summary: null }, fx.ctx);

    const row = await planRow(planId);
    expect(row.summary).toBeNull();
    expect(row.title).toBe('Close the BYOK code-index loop');
  });

  it('refuses a call that sends neither field — a correction must change something', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await planWithThreeAdds(fx);
    await expect(plansService.correctPlanBrief(planId, {}, fx.ctx)).rejects.toBeInstanceOf(
      InvalidProposalError,
    );
  });
});

// ── ⚠️ THE ASSERTION THIS CARD EXISTS FOR ───────────────────────────────────

describe('the incident reproduces, and now costs one call instead of the plan', () => {
  it('a `planned` plan with proposals gets a corrected summary and keeps EVERY one, same id', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemIds } = await planWithThreeAdds(fx);
    await plansService.markPlanned(planId, fx.ctx);

    const before = await plansService.getPlan(planId, fx.ctx);
    expect(before.items).toHaveLength(3);

    const corrected = await plansService.correctPlanBrief(
      planId,
      { summary: 'Motir does not charge for code indexing.' },
      fx.ctx,
    );

    // THE SAME PLAN. The remedy this replaces produced a second plan id and left
    // the first `declined` / `discarded` with nothing on it.
    expect(corrected.id).toBe(planId);
    expect(corrected.itemCount).toBe(3);
    expect(corrected.items.map((i) => i.id).sort()).toEqual([...itemIds].sort());

    const stored = await adminDb.planItem.findMany({ where: { planId }, select: { id: true } });
    expect(stored.map((i) => i.id).sort()).toEqual([...itemIds].sort());

    const row = await planRow(planId);
    expect(row.status).toBe('planned');
    expect(row.summary).toBe('Motir does not charge for code indexing.');
  });

  it('touches NOTHING else — status, `plannedAt` and the proposals are byte-identical', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await planWithThreeAdds(fx);
    await plansService.markPlanned(planId, fx.ctx);

    const before = await planRow(planId);
    const itemsBefore = await adminDb.planItem.findMany({
      where: { planId },
      orderBy: { id: 'asc' },
    });

    await plansService.correctPlanBrief(planId, { summary: 'Corrected.' }, fx.ctx);

    const after = await planRow(planId);
    expect(after.status).toBe(before.status);
    // `plannedAt` is what every staleness read is derived from, so re-dating it
    // would silently un-stale a plan a reviewer has already been warned about.
    expect(after.plannedAt?.toISOString()).toBe(before.plannedAt?.toISOString());
    expect(after.decidedAt).toBe(before.decidedAt);
    expect(after.decisionReason).toBe(before.decisionReason);
    expect(after.sourceJobId).toBe(before.sourceJobId);

    const itemsAfter = await adminDb.planItem.findMany({
      where: { planId },
      orderBy: { id: 'asc' },
    });
    expect(itemsAfter).toEqual(itemsBefore);
  });
});

describe('`approved` and `declined` are FROZEN, in both directions', () => {
  it('refuses a brief edit on an APPROVED plan, naming the status', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await planWithThreeAdds(fx);
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);

    let thrown: unknown;
    try {
      await plansService.correctPlanBrief(planId, { summary: 'Too late' }, fx.ctx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PlanNotEditableError);
    expect((thrown as Error).message).toContain('approved');
    expect((thrown as Error).message).toContain('title and summary');

    // And the refusal WROTE NOTHING — the other direction of the same assertion.
    expect((await planRow(planId)).summary).toBe('The org is the billing unit for code indexing.');
  });

  it('refuses a brief edit on a DECLINED plan, and says a decline is a closed decision', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await planWithThreeAdds(fx);
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.declinePlan(planId, fx.ctx);

    let thrown: unknown;
    try {
      await plansService.correctPlanBrief(planId, { title: 'No' }, fx.ctx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PlanNotEditableError);
    expect((thrown as Error).message).toContain('declined');
    expect((thrown as Error).message).toContain('closed decision');

    expect((await planRow(planId)).title).toBe('Close the BYOK code-index loop');
  });
});

describe('the edit is on the plan’s trail, under its OWN verb (D2)', () => {
  it('records `brief_edited` with the agent that made it and the fields it sent', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await planWithThreeAdds(fx);
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.correctPlanBrief(planId, { summary: 'Corrected.' }, fx.ctx);

    const rows = await adminDb.planRevision.findMany({
      where: { planId, changeKind: 'brief_edited' },
    });
    expect(rows).toHaveLength(1);
    const [revision] = rows;
    expect(revision!.actorHarness).toBe('Claude Code');
    expect(revision!.actorModel).toBe('claude-opus-5');
    expect(revision!.changedById).toBe(fx.ctx.userId);
    // No proposal moved, so no proposal is named.
    expect(revision!.planItemId).toBeNull();
    expect(revision!.diff).toMatchObject({ fields: ['summary'], correction: true });
  });

  it('is NOT `edited` — that verb means a PROPOSAL changed, and the timeline counts it as one', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await planWithThreeAdds(fx);
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.correctPlanBrief(planId, { title: 'Renamed' }, fx.ctx);

    const edited = await adminDb.planRevision.findMany({ where: { planId, changeKind: 'edited' } });
    expect(edited).toHaveLength(0);
  });

  it('a REFUSED edit writes no trail row either — the throw rolls the whole thing back', async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await planWithThreeAdds(fx);
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);

    await expect(
      plansService.correctPlanBrief(planId, { title: 'No' }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanNotEditableError);

    const rows = await adminDb.planRevision.findMany({
      where: { planId, changeKind: 'brief_edited' },
    });
    expect(rows).toHaveLength(0);
  });
});
