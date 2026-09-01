import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `buildPlanRowViews` is a SERVER module: it reaches `next-intl/server` for the
// request-shared formatter, which has no request context in a test. Stubbing
// just the formatter keeps everything else real — real Postgres, the real
// service, the real repository — so what is asserted below is the builder's own
// behaviour and not a re-statement of a mock.
vi.mock('next-intl/server', () => ({
  getFormatter: async () => ({ relativeTime: (d: Date) => `at ${d.toISOString()}` }),
}));

import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { userRepository } from '@/lib/repositories/userRepository';
import { planStalenessService } from '@/lib/services/planStalenessService';
import { createTestUser, makeWorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

const { buildPlanRowViews } = await import('@/app/(authed)/plans/planRowView');

// The Plans-list view-model builder (Story MOTIR-2982 · Subtask MOTIR-2992,
// closing the coverage gap on `planRowView.ts`, which this story rewrote).
//
// The load-bearing property is the one a passing render would never reveal:
// the requester NAME is resolved in ONE query for the whole page. The list is
// paginated, so a per-row lookup makes the page's cost grow with the page size
// for a field one join away — and it would look completely correct on screen.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/**
 * Append one proposal to a `generating` plan.
 *
 * ⚠️ IT IS WHAT MAKES THE NEXT CLOSE A CLOSE (MOTIR-4124). `markPlanned` over a
 * plan holding NOTHING discards it — `declined` / `discarded` — so a row-view
 * case that wants a plan sitting in the review queue has to put something in it
 * first. None of these cases is about what the plan proposes; they are about
 * the row's when-label, its attribution and its staleness.
 */
async function proposeOne(
  fx: Awaited<ReturnType<typeof makeWorkItemFixture>>,
  planId: string,
): Promise<void> {
  await plansService.addProposals(
    planId,
    [{ op: 'add', proposedFields: { title: 'A proposed card', kind: 'task' } }],
    fx.ctx,
  );
}

describe('buildPlanRowViews — the row view-model', () => {
  it('resolves every requester NAME in ONE query, whatever the page size', async () => {
    const fx = await makeWorkItemFixture();
    const mara = await createTestUser({ email: 'mara@example.com', name: 'Mara' });
    const jonas = await createTestUser({ email: 'jonas@example.com', name: 'Jonas' });

    const plans = [];
    // Six rows over three distinct requesters (two repeats, one unattributed) —
    // enough that a per-row implementation and a batched one give visibly
    // different query counts.
    for (const requester of [mara.id, jonas.id, mara.id, jonas.id, mara.id, null]) {
      plans.push(
        await plansService.createPlan(
          fx.projectId,
          { title: `plan ${plans.length}`, createdById: requester },
          fx.ctx,
        ),
      );
    }

    // ⚠️ SPY THE REPOSITORY, not the query log. `db.$on('query')` is silent
    // unless the client was built with query logging, so a count taken from it
    // is zero for a BATCHED and a PER-ROW implementation alike — i.e. the
    // assertion would pass for exactly the regression it exists to catch. (That
    // is not hypothetical: this test was first written that way and a control
    // assertion caught it.) The call counts below are the property itself.
    const batched = vi.spyOn(userRepository, 'findByIds');
    const perRow = vi.spyOn(userRepository, 'findById');

    const views = await buildPlanRowViews(plans, fx.ctx);

    expect(views.map((v) => v.createdByName)).toEqual([
      'Mara',
      'Jonas',
      'Mara',
      'Jonas',
      'Mara',
      null,
    ]);

    // ONE read for six rows and three distinct ids, and NO per-row lookup — the
    // assertion a per-row regression fails and a screenshot does not.
    expect(batched).toHaveBeenCalledTimes(1);
    expect(batched.mock.calls[0]![0]).toHaveLength(2); // distinct ids, deduped
    expect(perRow).not.toHaveBeenCalled();
    batched.mockRestore();
    perRow.mockRestore();
  });

  it('resolves the DECIDER in the SAME one query, over the UNION of both parties', async () => {
    // MOTIR-3238 widened `requesterNames` into `partyNames`. The property is not
    // "the decider resolves" — it is that adding a second role added no second
    // read, which is exactly what a screenshot cannot show and what a
    // well-meaning second `findByIds` would break silently.
    const fx = await makeWorkItemFixture();
    const mara = await createTestUser({ email: 'mara@example.com', name: 'Mara' });
    const jonas = await createTestUser({ email: 'jonas@example.com', name: 'Jonas' });

    // Three decided plans. Two share a decider, and one of them was requested by
    // the person who decided the others — so the union is SMALLER than the sum,
    // which is what pins the de-duplication rather than merely the batching.
    const plans: string[] = [];
    for (const [requester, decider] of [
      [mara.id, jonas.id],
      [jonas.id, jonas.id],
      [mara.id, null],
    ] as const) {
      const plan = await plansService.createPlan(
        fx.projectId,
        { title: `plan ${plans.length}`, createdById: requester },
        fx.ctx,
      );
      await adminDb.plan.update({
        where: { id: plan.id },
        data: { status: 'approved', decidedAt: new Date(), decidedById: decider },
      });
      plans.push(plan.id);
    }

    // Re-read through the service so the DTOs carry the decided state written
    // above (`createPlan`'s return predates it).
    const page = await plansService.listPlans(fx.projectId, fx.ctx);
    const byId = new Map(page.plans.map((p) => [p.id, p]));
    const dtos = plans.map((id) => byId.get(id)!);

    const batched = vi.spyOn(userRepository, 'findByIds');
    const perRow = vi.spyOn(userRepository, 'findById');

    const views = await buildPlanRowViews(dtos, fx.ctx);

    expect(views.map((v) => v.createdByName)).toEqual(['Mara', 'Jonas', 'Mara']);
    expect(views.map((v) => v.decidedByName)).toEqual(['Jonas', 'Jonas', null]);

    // ONE read for three rows and two roles, over the DEDUPED union — two ids,
    // not the five id slots the rows occupy.
    expect(batched).toHaveBeenCalledTimes(1);
    expect(batched.mock.calls[0]![0]).toHaveLength(2);
    expect(perRow).not.toHaveBeenCalled();
    batched.mockRestore();
    perRow.mockRestore();
  });

  it('leaves the decider null when NOBODY decided it — the abandoned case', async () => {
    // `decisionReason: 'abandoned'` with a NULL `decidedById` is what the
    // abandoned-plan sweep writes (MOTIR-3189 / MOTIR-3236). The view-model must
    // carry that absence through rather than inventing a decider from the actor
    // that happened to be in context.
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'a plan nobody came back to', createdById: fx.ownerId },
      fx.ctx,
    );
    await adminDb.plan.update({
      where: { id: plan.id },
      data: {
        status: 'declined',
        decidedAt: new Date(),
        decidedById: null,
        decisionReason: 'abandoned',
      },
    });

    const page = await plansService.listPlans(fx.projectId, fx.ctx);
    const [view] = await buildPlanRowViews(
      page.plans.filter((p) => p.id === plan.id),
      fx.ctx,
    );

    expect(view!.createdByName).toBe(fx.owner.name);
    expect(view!.decidedByName).toBeNull();
  });

  it('carries the attribution fields through from the DTO, and derives nothing itself', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      {
        title: 'An agent-authored plan',
        sourceJobId: 'job_1',
        createdById: fx.ownerId,
        authorSource: 'mcp',
        authorHarness: 'Claude Code',
        authorModel: 'claude-opus-5',
      },
      fx.ctx,
    );

    const [view] = await buildPlanRowViews([plan], fx.ctx);

    // The row component stays presentational: every state it switches on arrives
    // already decided here, exactly as the relative time and staleness count do.
    expect(view!.createdByName).toBe(fx.owner.name);
    expect(view!.authorSource).toBe('mcp');
    expect(view!.authorHarness).toBe('Claude Code');
    expect(view!.origin).toBe('user');
    // …and NOT the job. `sourceJobId` left the view-model with MOTIR-2996: its
    // only reader was the row's *Motir generated this* inference, which now
    // reads `authorSource === 'native'` instead.
    expect(view!).not.toHaveProperty('sourceJobId');
  });

  it('makes NO user query at all when no plan on the page has a requester', async () => {
    const fx = await makeWorkItemFixture();
    const plans = [
      await plansService.createPlan(fx.projectId, { title: 'a' }, fx.ctx),
      await plansService.createPlan(fx.projectId, { title: 'b', origin: 'cadence' }, fx.ctx),
    ];

    const batched = vi.spyOn(userRepository, 'findByIds');
    const perRow = vi.spyOn(userRepository, 'findById');

    const views = await buildPlanRowViews(plans, fx.ctx);

    expect(views.every((v) => v.createdByName === null)).toBe(true);
    // Not merely "one query" — NO query. An empty id set must short-circuit
    // rather than issue an `IN ()` nobody needs.
    expect(batched).not.toHaveBeenCalled();
    expect(perRow).not.toHaveBeenCalled();
    batched.mockRestore();
    perRow.mockRestore();
    // …and the cadence row still carries the origin the surface reads to say
    // "nobody asked" rather than "unattributed".
    expect(views[1]!.origin).toBe('cadence');
  });

  it('leaves the name null when the requester has been deleted', async () => {
    const fx = await makeWorkItemFixture();
    const gone = await createTestUser({ email: 'gone@example.com', name: 'Gone' });
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'asked before leaving', createdById: gone.id },
      fx.ctx,
    );
    await adminDb.user.delete({ where: { id: gone.id } });

    // `ON DELETE SET NULL` empties the column, so this degrades to the
    // unattributed treatment rather than rendering a dangling id.
    const [view] = await buildPlanRowViews([{ ...plan, createdById: gone.id }], fx.ctx);
    expect(view!.createdByName).toBeNull();
  });

  it('still builds the pre-existing row fields — title fallback, count, when-label', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'A title' }, fx.ctx);
    await proposeOne(fx, plan.id);
    const planned = await plansService.markPlanned(plan.id, fx.ctx);

    const [view] = await buildPlanRowViews([planned], fx.ctx);

    expect(view!.title).toBe('A title');
    expect(view!.itemCount).toBe(1);
    expect(view!.whenKey).toBe('plannedAt');
    expect(view!.whenLabel).toContain('at ');
    expect(view!.staleCount).toBe(0);
  });
});

// ── The pre-existing row fields, to the ≥90% per-file floor (MOTIR-2992) ────
// `planRowView.ts` entered the coverage report with this story, and the floor
// applies to the WHOLE file, not only to the lines this story wrote. These are
// the branches the attribution tests above do not reach: the lifecycle
// timestamp each status labels itself with, its fallback when that timestamp is
// null, and the staleness read's graceful degradation.
describe('buildPlanRowViews — the lifecycle when-label, over every status', () => {
  it('labels each status with its own verb and timestamp', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);

    // generating → the creation time
    let [view] = await buildPlanRowViews([plan], fx.ctx);
    expect(view!.whenKey).toBe('createdAt');

    // planned → plannedAt
    await proposeOne(fx, plan.id);
    const planned = await plansService.markPlanned(plan.id, fx.ctx);
    [view] = await buildPlanRowViews([planned], fx.ctx);
    expect(view!.whenKey).toBe('plannedAt');

    // approved → approvedAt (the decided timestamp)
    const approved = await plansService.approvePlan(plan.id, fx.ctx);
    [view] = await buildPlanRowViews([approved], fx.ctx);
    expect(view!.whenKey).toBe('approvedAt');
  });

  it('labels a DECLINED plan with its own verb', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
    await proposeOne(fx, plan.id);
    await plansService.markPlanned(plan.id, fx.ctx);
    const declined = await plansService.declinePlan(plan.id, fx.ctx);

    const [view] = await buildPlanRowViews([declined], fx.ctx);
    expect(view!.whenKey).toBe('declinedAt');
  });

  it('falls back to the creation time when the lifecycle timestamp is null', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);

    // A row whose status says `approved` while `decidedAt` is null cannot arise
    // through the service — but the fallback exists because a row read is not a
    // proof, and a null here would otherwise throw inside `new Date(...)` and
    // take down the whole list for one malformed row.
    const [view] = await buildPlanRowViews(
      [{ ...plan, status: 'approved', decidedAt: null }],
      fx.ctx,
    );
    expect(view!.whenKey).toBe('approvedAt');
    expect(view!.whenLabel).toContain(plan.createdAt.slice(0, 10));
  });

  it('falls back for a PLANNED plan with no plannedAt', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
    const [view] = await buildPlanRowViews(
      [{ ...plan, status: 'planned', plannedAt: null }],
      fx.ctx,
    );
    expect(view!.whenKey).toBe('plannedAt');
    expect(view!.whenLabel).toContain(plan.createdAt.slice(0, 10));
  });

  it('falls back for a DECLINED plan with no decidedAt, and resolves the title fallbacks', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'The title', summary: '  ' },
      fx.ctx,
    );

    const [declined] = await buildPlanRowViews(
      [{ ...plan, status: 'declined', decidedAt: null }],
      fx.ctx,
    );
    expect(declined!.whenKey).toBe('declinedAt');
    expect(declined!.whenLabel).toContain(plan.createdAt.slice(0, 10));
    // The row prefers the SUMMARY, falls through a whitespace-only one to the
    // title, and ends at the empty placeholder the component turns into
    // "Untitled plan".
    expect(declined!.title).toBe('The title');

    const [untitled] = await buildPlanRowViews([{ ...plan, title: null, summary: null }], fx.ctx);
    expect(untitled!.title).toBe('');

    const [summarised] = await buildPlanRowViews([{ ...plan, summary: 'The summary' }], fx.ctx);
    expect(summarised!.title).toBe('The summary');
  });

  it('degrades to a zero stale count when the staleness read fails', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
    await proposeOne(fx, plan.id);
    const planned = await plansService.markPlanned(plan.id, fx.ctx);

    const boom = vi
      .spyOn(planStalenessService, 'computePlanStaleness')
      .mockRejectedValue(new Error('staleness unavailable'));

    // The row omits the flag rather than failing the whole list — one unreadable
    // verdict must not blank the Plans page.
    const [view] = await buildPlanRowViews([planned], fx.ctx);
    expect(view!.staleCount).toBe(0);
    expect(boom).toHaveBeenCalled();
    boom.mockRestore();
  });

  it('counts the stale items of a planned plan', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'p' }, fx.ctx);
    await proposeOne(fx, plan.id);
    const planned = await plansService.markPlanned(plan.id, fx.ctx);

    const stale = vi.spyOn(planStalenessService, 'computePlanStaleness').mockResolvedValue({
      planId: plan.id,
      stale: true,
      items: [
        { planItemId: 'a', workItemId: null, stale: true, reasons: [], targetMissing: false },
        { planItemId: 'b', workItemId: null, stale: false, reasons: [], targetMissing: false },
      ],
    } as never);

    const [view] = await buildPlanRowViews([planned], fx.ctx);
    expect(view!.staleCount).toBe(1);
    stale.mockRestore();
  });
});
