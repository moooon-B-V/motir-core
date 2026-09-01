import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { planRevisionRepository } from '@/lib/repositories/planRevisionRepository';
import { makeWorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// The plan timeline's READ half (Story MOTIR-3532 · Subtask MOTIR-3536): the
// stored content events merged into the four derived lifecycle ones, on the
// surface that already renders them. `design/ai-planning/design-notes.md` Part X
// is the design of record.
//
// Every case drives the REAL mutations against real Postgres and reads the result
// back through `getPlanReview` — the path the rail actually consumes. Building a
// revision row by hand and asserting the merge over it would test the merge and
// not the seam, and the seam is where the two cards meet.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const AGENT = {
  authorSource: 'mcp' as const,
  authorHarness: 'Claude Code',
  authorModel: 'claude-opus-5',
};

async function timeline(planId: string, ctx: { userId: string; workspaceId: string }) {
  return (await planReviewService.getPlanReview(planId, ctx)).history;
}

describe('the merged sequence', () => {
  it('interleaves content events BETWEEN the lifecycle ones, not after them', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'P', ...AGENT }, fx.ctx);
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'One', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    // …and an edit AFTER the plan was closed for review. This is the row the
    // whole story exists for: a naive concatenation would append it at the end,
    // and a same-day plan would never reveal the difference.
    const items = appended.items;
    await plansService.updateProposal(plan.id, items[0]!.id, { title: 'Renamed' }, fx.ctx);
    await plansService.declinePlan(plan.id, fx.ctx);

    const history = await timeline(plan.id, fx.ctx);
    expect(history.map((e) => e.kind)).toEqual([
      'created',
      'appended',
      'planned',
      'edited',
      'declined',
    ]);
    // The sequence is monotonic in time — the property, not just the order.
    const times = history.map((e) => Date.parse(e.at!));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('does NOT render the four stored kinds the derived events already say', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'P' }, fx.ctx);
    // The proposal is what makes the close a CLOSE (MOTIR-4124): a plan holding
    // nothing is discarded instead of queued, and this case is about the
    // lifecycle trail of a plan that reached a reviewer.
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'One', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    // The TRAIL holds all of them — it is the audit record and must be complete…
    const stored = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRevisionRepository.listByPlan(plan.id, tx),
    );
    expect(stored.map((r) => r.changeKind)).toEqual(['created', 'appended', 'planned']);
    // …and the TIMELINE says each of them exactly once, from the derived side.
    const history = await timeline(plan.id, fx.ctx);
    expect(history.map((e) => e.kind)).toEqual(['created', 'appended', 'planned']);
  });

  it('gives every event a distinct id, so a repeated kind is still a distinct row', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'P' }, fx.ctx);
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'One', kind: 'task' } }],
      fx.ctx,
    );
    const items = appended.items;
    await plansService.deepenProposal(plan.id, items[0]!.id, { storyPoints: 2 }, fx.ctx);

    const history = await timeline(plan.id, fx.ctx);
    const ids = history.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the collapse rule — kind + actor + adjacency', () => {
  it('folds a RUN of same-kind, same-actor edits into one row with a span', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'P', ...AGENT }, fx.ctx);
    const appended = await plansService.addProposals(
      plan.id,
      [
        { op: 'add', proposedFields: { title: 'One', kind: 'task' } },
        { op: 'add', proposedFields: { title: 'Two', kind: 'task' } },
        { op: 'add', proposedFields: { title: 'Three', kind: 'task' } },
      ],
      fx.ctx,
    );
    const items = appended.items;
    for (const item of items) {
      await plansService.deepenProposal(plan.id, item.id, { storyPoints: 2 }, fx.ctx);
    }

    const history = await timeline(plan.id, fx.ctx);
    expect(history.map((e) => e.kind)).toEqual(['created', 'appended', 'edited']);
    // THREE separate `update_plan_item` calls, ONE row — which is the shape a
    // titles-first pass actually produces, and the reason the rule is not tidying.
    const run = history[2]!;
    expect(run.count).toBe(3);
    expect(run.until).toBeTruthy();
    expect(Date.parse(run.until!)).toBeGreaterThanOrEqual(Date.parse(run.at!));
  });

  it('does NOT fold across a different ACTOR', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'P', ...AGENT }, fx.ctx);
    const appended = await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'One', kind: 'task' } }],
      fx.ctx,
    );
    const items = appended.items;
    await plansService.deepenProposal(plan.id, items[0]!.id, { storyPoints: 2 }, fx.ctx);
    await plansService.markPlanned(plan.id, fx.ctx);
    // The review edit is a PERSON acting, with no agent — a different actor from
    // the agent above it, even though the kind is the same.
    await plansService.updateProposal(plan.id, items[0]!.id, { title: 'Mine' }, fx.ctx);

    const history = await timeline(plan.id, fx.ctx);
    expect(history.map((e) => e.kind)).toEqual([
      'created',
      'appended',
      'edited',
      'planned',
      'edited',
    ]);
    expect(history[2]!.actorHarness).toBe('Claude Code');
    expect(history[4]!.actorHarness).toBeNull();
  });

  it('does NOT let a run swallow a lifecycle event between two of its members', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'P' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'One', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'Two', kind: 'task' } }],
      fx.ctx,
    );

    const history = await timeline(plan.id, fx.ctx);
    // Two appends by one actor with nothing between them DO fold…
    expect(history.map((e) => e.kind)).toEqual(['created', 'appended']);
    expect(history[1]!.count).toBe(2);
    // …and `created` is still its own row above them, never absorbed.
    expect(history[0]!.count).toBeUndefined();
  });
});

describe('the actor, read back through the surface', () => {
  it('carries the agent triple on a generation event and none on a decision', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'P', ...AGENT }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'One', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.declinePlan(plan.id, fx.ctx);

    const history = await timeline(plan.id, fx.ctx);
    const append = history.find((e) => e.kind === 'appended')!;
    expect(append.actorSource).toBe('mcp');
    expect(append.actorHarness).toBe('Claude Code');
    expect(append.actorModel).toBe('claude-opus-5');
    expect(append.byName).toBe(fx.owner.name);

    const decision = history[history.length - 1]!;
    expect(decision.kind).toBe('declined');
    expect(decision.byName).toBe(fx.owner.name);
    expect(decision.actorSource).toBeUndefined();
  });

  it('names NOBODY on a cadence-originated append', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'P', origin: 'cadence', ...AGENT },
      fx.ctx,
    );
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'One', kind: 'task' } }],
      fx.ctx,
    );

    const history = await timeline(plan.id, fx.ctx);
    const append = history.find((e) => e.kind === 'appended')!;
    expect(append.byName).toBeNull();
    // …and the agent is still named, so the row is not silently unattributed.
    expect(append.actorHarness).toBe('Claude Code');
  });
});

describe('a plan with NO content rows renders its lifecycle timeline unchanged', () => {
  it('produces exactly the four derived events — the state every pre-existing plan is in', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'Legacy' }, fx.ctx);
    // One proposal, so the close QUEUES the plan rather than discarding it
    // (MOTIR-4124) — this case is about a plan that reached a reviewer and was
    // then declined, which is the history the three derived events describe.
    await plansService.addProposals(
      plan.id,
      [{ op: 'add', proposedFields: { title: 'One', kind: 'task' } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);
    await plansService.declinePlan(plan.id, fx.ctx);
    // Wipe the trail: this is exactly a plan created before MOTIR-3535 shipped.
    await adminDb.planRevision.deleteMany({ where: { planId: plan.id } });

    const history = await timeline(plan.id, fx.ctx);
    expect(history.map((e) => e.kind)).toEqual(['created', 'planned', 'declined']);
    for (const ev of history) {
      expect(ev.count).toBeUndefined();
      expect(ev.until).toBeUndefined();
      expect(ev.actorSource).toBeUndefined();
    }
    expect(history[2]!.byName).toBe(fx.owner.name);
  });
});

describe('cost', () => {
  it('loads the whole trail in ONE query, however many rows it has', async () => {
    const fx = await makeWorkItemFixture();
    const plan = await plansService.createPlan(fx.projectId, { title: 'P' }, fx.ctx);
    const appended = await plansService.addProposals(
      plan.id,
      Array.from({ length: 8 }, (_, i) => ({
        op: 'add' as const,
        proposedFields: { title: `Item ${i}`, kind: 'task' as const },
      })),
      fx.ctx,
    );
    const items = appended.items;
    for (const item of items) {
      await plansService.deepenProposal(plan.id, item.id, { storyPoints: 2 }, fx.ctx);
    }
    expect(await adminDb.planRevision.count({ where: { planId: plan.id } })).toBe(10);

    // Count the reads the trail costs, by the only method that cannot be fooled
    // by a batching layer: call the repository's own read and assert the SHAPE of
    // what it does. One `findMany`, no per-row lookup — the N+1 this surface
    // cannot afford, since it is re-read on every poll of a `generating` plan.
    let calls = 0;
    const spy = { findMany: planRevisionRepository.listByPlan };
    const original = planRevisionRepository.listByPlan;
    planRevisionRepository.listByPlan = async (...args: Parameters<typeof original>) => {
      calls += 1;
      return original(...args);
    };
    try {
      const history = await timeline(plan.id, fx.ctx);
      expect(calls).toBe(1);
      // …and ten rows still collapse to two readable ones.
      expect(history.map((e) => e.kind)).toEqual(['created', 'appended', 'edited']);
      expect(history[2]!.count).toBe(8);
    } finally {
      planRevisionRepository.listByPlan = spy.findMany;
    }
  });
});
