import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planRevisionRepository } from '@/lib/repositories/planRevisionRepository';
import { makeWorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The plan CONTENT trail (Story MOTIR-3532 · Subtask MOTIR-3535) — proven end to
// end against real Postgres.
//
// What is worth asserting here, and what is not. The trail's VALUE is entirely a
// property of two things: that a row exists for every plan mutation, and that it
// commits with the mutation it describes rather than beside it. Neither survives
// a mocked repository — a mock is exactly where the answer would come from — so
// every case below drives the real service against the real database.
//
// The atomicity cases follow `tests/integration/work-items/revisions.test.ts`'s
// shape: inject a failure into the revision INSERT and assert the MUTATION rolled
// back with it. That is the direction that matters. A revision written outside
// the mutation's transaction would leave the mutation standing here — and the
// test would go green while the trail started lying.
//
// The READ path, its DTO and the surface are the sibling card's, so the
// assertions read the rows through `adminDb` rather than through a repository
// this card deliberately did not add.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Every revision on one plan, oldest first — the order the timeline reads in. */
async function trail(planId: string) {
  return adminDb.planRevision.findMany({ where: { planId }, orderBy: { changedAt: 'asc' } });
}

const AGENT = {
  authorSource: 'mcp' as const,
  authorHarness: 'Claude Code',
  authorModel: 'claude-opus-5',
};

/** A `generating` plan carrying two `add` proposals, and the ids to drive them. */
async function seedPlanWithProposals(
  fx: Awaited<ReturnType<typeof makeWorkItemFixture>>,
  opts: { origin?: 'user' | 'cadence' } = {},
) {
  const plan = await plansService.createPlan(
    fx.projectId,
    {
      title: 'A plan',
      ...AGENT,
      ...(opts.origin === 'cadence' ? { origin: 'cadence' as const } : {}),
    },
    fx.ctx,
  );
  const appended = await plansService.addProposals(
    plan.id,
    [
      { op: 'add', proposedFields: { title: 'One', kind: 'task' } },
      { op: 'add', proposedFields: { title: 'Two', kind: 'task' } },
    ],
    fx.ctx,
  );
  return { plan, items: appended.items };
}

// ── one row per mutation, in the mutation's own transaction ──────────────────

describe('every plan mutation writes exactly one revision row', () => {
  it('createPlan writes a `created` row naming the plan it opened', async () => {
    const fx = await makeWorkItemFixture();

    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Timeline story', summary: 'a summary', ...AGENT },
      fx.ctx,
    );

    const rows = await trail(plan.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.changeKind).toBe('created');
    expect(rows[0]!.planItemId).toBeNull();
    expect(rows[0]!.diff).toEqual({
      title: 'Timeline story',
      summary: 'a summary',
      origin: 'user',
    });
  });

  it('addProposals writes ONE `appended` row for the whole batch, counting the ops', async () => {
    const fx = await makeWorkItemFixture();
    const { plan } = await seedPlanWithProposals(fx);

    const rows = await trail(plan.id);
    expect(rows.map((r) => r.changeKind)).toEqual(['created', 'appended']);
    // ONE row, TWO proposals — an append is one act however many it carries.
    expect(rows[1]!.diff).toEqual({ proposalCount: 2, ops: { add: 2, modify: 0, remove: 0 } });
  });

  it('an EMPTY append writes NO row — the MCP close is not a content mutation', async () => {
    const fx = await makeWorkItemFixture();
    const { plan } = await seedPlanWithProposals(fx);

    // `add_plan_items { final: true }` with no proposals: it goes through
    // `addProposals`, inserts nothing, and hands off to `markPlanned`. A row here
    // would read *"0 proposals appended"* on every plan authored over the MCP.
    await plansService.addProposals(plan.id, [], fx.ctx);

    expect((await trail(plan.id)).map((r) => r.changeKind)).toEqual(['created', 'appended']);
  });

  it('a deepen writes an `edited` row naming the proposal and the fields it supplied', async () => {
    const fx = await makeWorkItemFixture();
    const { plan, items } = await seedPlanWithProposals(fx);

    await plansService.deepenProposal(
      plan.id,
      items[0]!.id,
      { descriptionMd: 'deepened', storyPoints: 3 },
      fx.ctx,
    );

    const rows = await trail(plan.id);
    expect(rows.map((r) => r.changeKind)).toEqual(['created', 'appended', 'edited']);
    expect(rows[2]!.planItemId).toBe(items[0]!.id);
    expect(rows[2]!.diff).toEqual({ fields: ['descriptionMd', 'storyPoints'], proposalCount: 1 });
  });

  it('markPlanned writes a `planned` row carrying the count a reader is asked to approve', async () => {
    const fx = await makeWorkItemFixture();
    const { plan } = await seedPlanWithProposals(fx);

    await plansService.markPlanned(plan.id, fx.ctx);

    const rows = await trail(plan.id);
    expect(rows.map((r) => r.changeKind)).toEqual(['created', 'appended', 'planned']);
    expect(rows[2]!.diff).toEqual({ itemCount: 2 });
  });

  it('a review edit on a `planned` plan writes its own `edited` row', async () => {
    const fx = await makeWorkItemFixture();
    const { plan, items } = await seedPlanWithProposals(fx);
    await plansService.markPlanned(plan.id, fx.ctx);

    await plansService.updateProposal(plan.id, items[1]!.id, { title: 'Renamed' }, fx.ctx);

    const rows = await trail(plan.id);
    expect(rows.map((r) => r.changeKind)).toEqual(['created', 'appended', 'planned', 'edited']);
    // AND IT LANDS AFTER `planned` — the row this whole story exists for. A plan
    // whose contents moved between being closed for review and being decided is
    // exactly what a reviewer cannot see today.
    expect(rows[3]!.diff).toEqual({ fields: ['title'], proposalCount: 1 });
  });

  it('declinePlan writes a `declined` row carrying the reason the row stores', async () => {
    const fx = await makeWorkItemFixture();
    const { plan } = await seedPlanWithProposals(fx);
    await plansService.markPlanned(plan.id, fx.ctx);

    await plansService.declinePlan(plan.id, fx.ctx);

    const rows = await trail(plan.id);
    expect(rows.map((r) => r.changeKind)).toEqual(['created', 'appended', 'planned', 'declined']);
    expect(rows[3]!.diff).toEqual({ itemCount: 2, decisionReason: 'reviewed' });
  });

  it('a DISCARD (declining a still-`generating` plan) records that reason instead', async () => {
    const fx = await makeWorkItemFixture();
    const { plan } = await seedPlanWithProposals(fx);

    await plansService.declinePlan(plan.id, fx.ctx);

    const rows = await trail(plan.id);
    expect(rows[rows.length - 1]!.diff).toEqual({ itemCount: 2, decisionReason: 'discarded' });
  });

  it('approvePlan writes an `approved` row counting the proposals AND what they touched', async () => {
    const fx = await makeWorkItemFixture();
    const { plan } = await seedPlanWithProposals(fx);
    await plansService.markPlanned(plan.id, fx.ctx);

    await plansService.approvePlan(plan.id, fx.ctx);

    const rows = await trail(plan.id);
    expect(rows.map((r) => r.changeKind)).toEqual(['created', 'appended', 'planned', 'approved']);
    expect(rows[3]!.diff).toEqual({ itemCount: 2, touchedWorkItemCount: 2 });
  });
});

// ── WHO acted, in both senses ────────────────────────────────────────────────

describe('the actor — the acting user AND the agent triple', () => {
  it('records the agent triple on a generation-time write, beside the acting user', async () => {
    const fx = await makeWorkItemFixture();
    const { plan } = await seedPlanWithProposals(fx);

    const rows = await trail(plan.id);
    for (const row of rows) {
      expect(row.changedById).toBe(fx.ownerId);
      expect(row.actorSource).toBe('mcp');
      expect(row.actorHarness).toBe('Claude Code');
      expect(row.actorModel).toBe('claude-opus-5');
    }
  });

  it('records NO agent on a decision, however the plan was written', async () => {
    const fx = await makeWorkItemFixture();
    const { plan } = await seedPlanWithProposals(fx);
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.declinePlan(plan.id, fx.ctx);

    const rows = await trail(plan.id);
    const decision = rows[rows.length - 1]!;
    // The plan IS agent-written — the rows above it say so — and the decision is
    // still a person's. A row that read the plan's `authorSource` at render time
    // could not tell these two apart.
    expect(rows[0]!.actorSource).toBe('mcp');
    expect(decision.changedById).toBe(fx.ownerId);
    expect(decision.actorSource).toBeNull();
    expect(decision.actorHarness).toBeNull();
    expect(decision.actorModel).toBeNull();
  });

  it('records NO agent on a REVIEW edit, which is a person acting on an agent-written plan', async () => {
    const fx = await makeWorkItemFixture();
    const { plan, items } = await seedPlanWithProposals(fx);
    await plansService.markPlanned(plan.id, fx.ctx);

    await plansService.updateProposal(plan.id, items[0]!.id, { title: 'Mine now' }, fx.ctx);

    const rows = await trail(plan.id);
    const edit = rows[rows.length - 1]!;
    expect(edit.changeKind).toBe('edited');
    expect(edit.changedById).toBe(fx.ownerId);
    expect(edit.actorSource).toBeNull();
  });

  it('records NO acting user for a cadence-originated generation write — never the project owner', async () => {
    const fx = await makeWorkItemFixture();
    const { plan } = await seedPlanWithProposals(fx, { origin: 'cadence' });
    await plansService.markPlanned(plan.id, fx.ctx);

    const rows = await trail(plan.id);
    expect(rows.map((r) => r.changeKind)).toEqual(['created', 'appended', 'planned']);
    for (const row of rows) expect(row.changedById).toBeNull();
    // …and the acting user was NOT null, so this is a real abstention rather
    // than a fixture that had nobody to record — the same guarantee
    // `Plan.createdById` makes for itself.
    expect(fx.ctx.userId).toBe(fx.ownerId);
  });

  it('still records the DECIDER on a cadence-originated plan — a decision is always a person', async () => {
    const fx = await makeWorkItemFixture();
    const { plan } = await seedPlanWithProposals(fx, { origin: 'cadence' });
    await plansService.markPlanned(plan.id, fx.ctx);

    await plansService.declinePlan(plan.id, fx.ctx);

    const rows = await trail(plan.id);
    expect(rows[rows.length - 1]!.changedById).toBe(fx.ownerId);
  });
});

// ── atomicity: the row commits WITH its mutation, or neither does ────────────

describe('atomicity — the revision is written inside the mutation transaction', () => {
  it('createPlan: an injected revision failure leaves NO plan and NO revision', async () => {
    const fx = await makeWorkItemFixture();

    const spy = vi
      .spyOn(planRevisionRepository, 'create')
      .mockRejectedValue(new Error('injected revision failure'));

    await expect(
      plansService.createPlan(fx.projectId, { title: 'Doomed' }, fx.ctx),
    ).rejects.toThrow('injected revision failure');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(await adminDb.plan.count()).toBe(0);
    expect(await adminDb.planRevision.count()).toBe(0);

    spy.mockRestore();
  });

  it('addProposals: an injected revision failure leaves NO proposals', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'A plan' }, fx.ctx);

    const spy = vi
      .spyOn(planRevisionRepository, 'create')
      .mockRejectedValueOnce(new Error('injected revision failure'));

    await expect(
      plansService.addProposals(
        plan.id,
        [{ op: 'add', proposedFields: { title: 'One', kind: 'task' } }],
        fx.ctx,
      ),
    ).rejects.toThrow();

    expect(await adminDb.planItem.count()).toBe(0);
    // Only the `created` row from the open survives — no orphan `appended`.
    expect((await trail(plan.id)).map((r) => r.changeKind)).toEqual(['created']);

    spy.mockRestore();
  });

  it('markPlanned: an injected revision failure leaves the plan `generating`', async () => {
    const fx = await makeWorkItemFixture();
    const { plan } = await seedPlanWithProposals(fx);

    const spy = vi
      .spyOn(planRevisionRepository, 'create')
      .mockRejectedValueOnce(new Error('injected revision failure'));

    await expect(plansService.markPlanned(plan.id, fx.ctx)).rejects.toThrow(
      'injected revision failure',
    );

    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(row.status).toBe('generating');
    expect(row.plannedAt).toBeNull();
    expect((await trail(plan.id)).map((r) => r.changeKind)).toEqual(['created', 'appended']);

    spy.mockRestore();
  });

  it('a deepen: an injected revision failure rolls back the merge into proposedFields', async () => {
    const fx = await makeWorkItemFixture();
    const { plan, items } = await seedPlanWithProposals(fx);

    const spy = vi
      .spyOn(planRevisionRepository, 'create')
      .mockRejectedValueOnce(new Error('injected revision failure'));

    await expect(
      plansService.deepenProposal(plan.id, items[0]!.id, { descriptionMd: 'never lands' }, fx.ctx),
    ).rejects.toThrow('injected revision failure');

    const item = await adminDb.planItem.findUniqueOrThrow({
      where: { id: items[0]!.id },
    });
    expect((item.proposedFields as { descriptionMd?: string }).descriptionMd).toBeUndefined();
    expect((await trail(plan.id)).map((r) => r.changeKind)).toEqual(['created', 'appended']);

    spy.mockRestore();
  });

  it('declinePlan: an injected revision failure leaves the plan undecided', async () => {
    const fx = await makeWorkItemFixture();
    const { plan } = await seedPlanWithProposals(fx);
    await plansService.markPlanned(plan.id, fx.ctx);

    const spy = vi
      .spyOn(planRevisionRepository, 'create')
      .mockRejectedValueOnce(new Error('injected revision failure'));

    await expect(plansService.declinePlan(plan.id, fx.ctx)).rejects.toThrow(
      'injected revision failure',
    );

    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(row.status).toBe('planned');
    expect(row.decidedAt).toBeNull();

    spy.mockRestore();
  });

  it('approvePlan: an injected revision failure materializes NOTHING', async () => {
    const fx = await makeWorkItemFixture();
    const { plan } = await seedPlanWithProposals(fx);
    await plansService.markPlanned(plan.id, fx.ctx);

    const spy = vi
      .spyOn(planRevisionRepository, 'create')
      .mockRejectedValueOnce(new Error('injected revision failure'));

    await expect(plansService.approvePlan(plan.id, fx.ctx)).rejects.toThrow();

    // The whole materialize rolled back: no work items, plan still `planned`.
    expect(await adminDb.workItem.count()).toBe(0);
    const row = await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(row.status).toBe('planned');
    expect((await trail(plan.id)).map((r) => r.changeKind)).toEqual([
      'created',
      'appended',
      'planned',
    ]);

    spy.mockRestore();
  });
});

// ── the trail belongs to its plan ────────────────────────────────────────────

describe('lifetime', () => {
  it('cascades with the plan — a deleted plan takes its whole trail with it', async () => {
    const fx = await makeWorkItemFixture();
    const { plan } = await seedPlanWithProposals(fx);
    expect(await adminDb.planRevision.count({ where: { planId: plan.id } })).toBe(2);

    await adminDb.plan.delete({ where: { id: plan.id } });

    expect(await adminDb.planRevision.count({ where: { planId: plan.id } })).toBe(0);
  });
});
