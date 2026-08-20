import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { scopeClaimService } from '@/lib/services/scopeClaimService';
import { sprintsService } from '@/lib/services/sprintsService';
import { backlogService } from '@/lib/services/backlogService';
import { SPRINT_ACTIVE } from '@/lib/workItems/readyFilter';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The STORY-LEVEL integration seams (Story MOTIR-3001 · MOTIR-3200) — the
// writer→consumer pairs the per-subtask unit tests each mock, driven end to end
// against real Postgres.
//
// ⚠️ WHAT MAKES THESE WORTH THEIR RUNTIME. Every assertion here is about TWO
// halves agreeing, and each half is already green on its own:
//
//   • the ancestor facet ↔ the parent-ready cascade — the facet's own units
//     assert the narrowing; this asserts it over a REAL traversal of REAL rows,
//     which is where a re-seeded walk would actually show;
//   • the facet ↔ the scope claim — two independent computations of the phrase
//     "the scope", which nothing has ever compared;
//   • the claim ↔ the workflow — that only the two legal edges are ever
//     written, and that a refused claim leaves every row byte-identical.
//
// A seam is exactly where two green halves disagree, and no unit test of either
// half can see it.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function make(
  fx: WorkItemFixture,
  opts: {
    title?: string;
    kind?: 'epic' | 'story' | 'task' | 'bug' | 'subtask';
    parentId?: string;
  } = {},
) {
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: opts.kind ?? 'subtask',
      title: opts.title ?? 'Item',
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
    },
    fx.ctx,
  );
}

async function block(fx: WorkItemFixture, fromId: string, toId: string) {
  await workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, fx.ctx);
}

async function rowsOf(ids: string[]) {
  const rows = await adminDb.workItem.findMany({ where: { id: { in: ids } } });
  return new Map(rows.map((r) => [r.id, r]));
}

describe('SEAM — the ancestor facet ↔ the parent-ready cascade', () => {
  it('a leaf under a NOT-ready intermediate ancestor is absent from the real traversal', async () => {
    // ⚠️ THE ASSERTION THAT FAILS IF THE WALK WAS RE-SEEDED at the named
    // container. It belongs here as well as in the facet's own units because it
    // is a property of the WHOLE top-down traversal against real rows: the
    // cascade is what `collectReadyLeaves` computes by starting at the project
    // roots, and a re-seed is invisible in any test that starts from the
    // container too.
    //
    //   epic ─┬─ gatedStory (blocked by an unfinished card)
    //         │     └── buried   ← its OWN blockers are all satisfied
    //         └── openStory
    //               └── reachable
    const fx = await makeWorkItemFixture();
    const epic = await make(fx, { title: 'Epic', kind: 'epic' });
    const gate = await make(fx, { title: 'Unfinished', kind: 'task' });
    const gatedStory = await make(fx, { title: 'Gated', kind: 'story', parentId: epic.id });
    await block(fx, gatedStory.id, gate.id);
    const buried = await make(fx, { title: 'Buried', parentId: gatedStory.id });
    const openStory = await make(fx, { title: 'Open', kind: 'story', parentId: epic.id });
    const reachable = await make(fx, { title: 'Reachable', parentId: openStory.id });

    const scoped = await workItemsService.listReady(
      fx.projectId,
      { ancestorKeys: [epic.identifier] },
      fx.ctx,
    );
    const keys = scoped.items.map((i) => i.key);

    expect(keys).toContain(reachable.identifier);
    expect(keys).not.toContain(buried.identifier);
    // And it is genuinely a NARROWING of the same answer, not a different one.
    const unfaceted = (await workItemsService.listReady(fx.projectId, {}, fx.ctx)).items.map(
      (i) => i.key,
    );
    expect(unfaceted).toEqual(expect.arrayContaining(keys));
    expect(unfaceted).not.toContain(buried.identifier);
  });
});

describe('SEAM — the facet ↔ the scope claim', () => {
  it('the set the facet returns is the set the claim locks, both directions', async () => {
    // ⚠️ TWO INDEPENDENT COMPUTATIONS OF ONE PHRASE. The facet walks top-down
    // through `collectReadyLeaves`; the claim collects the container's subtree
    // inside a locked transaction. Nothing has ever compared them, and a scoped
    // run is exactly the caller that would be broken by a difference — it reads
    // one and claims the other.
    const fx = await makeWorkItemFixture();
    const story = await make(fx, { title: 'The story', kind: 'story' });
    const children = [];
    for (const t of ['a', 'b', 'c']) {
      children.push(await make(fx, { title: t, parentId: story.id }));
    }

    const facet = await workItemsService.listReady(
      fx.projectId,
      { ancestorKeys: [story.identifier] },
      fx.ctx,
    );
    const claim = await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: story.identifier },
      fx.ctx,
    );

    expect(claim.outcome).toBe('claimed');
    const claimedLeaves = claim.members
      .map((m) => m.key)
      .filter((k) => k !== story.identifier)
      .sort();
    expect(facet.items.map((i) => i.key).sort()).toEqual(claimedLeaves);
    expect(claimedLeaves).toEqual(children.map((c) => c.identifier).sort());
  });

  it('a leaf whose blocker is a SIBLING is claimed but NOT ready — the two answers differ, correctly', async () => {
    // The one place the two sets are legitimately different, stated so that the
    // difference is a decision rather than a surprise: the claim takes every
    // member in the TO-DO category, `blocked` included, because it is taking
    // OWNERSHIP; the facet returns only what can START. A scoped run consumes
    // both — it owns the wider set and works the narrower one first.
    const fx = await makeWorkItemFixture();
    const story = await make(fx, { title: 'The story', kind: 'story' });
    const first = await make(fx, { title: 'first', parentId: story.id });
    const second = await make(fx, { title: 'second', parentId: story.id });
    await block(fx, second.id, first.id);

    const facet = await workItemsService.listReady(
      fx.projectId,
      { ancestorKeys: [story.identifier] },
      fx.ctx,
    );
    const claim = await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: story.identifier },
      fx.ctx,
    );

    expect(facet.items.map((i) => i.key)).toEqual([first.identifier]);
    expect(claim.members.map((m) => m.key).sort()).toEqual(
      [story.identifier, first.identifier, second.identifier].sort(),
    );
  });
});

describe('SEAM — the claim ↔ the workflow', () => {
  it('writes ONLY the two legal edges into in_progress, and nothing else moves', async () => {
    const fx = await makeWorkItemFixture();
    const story = await make(fx, { title: 'The story', kind: 'story' });
    const ready = await make(fx, { title: 'ready', parentId: story.id });
    const gated = await make(fx, { title: 'gated', parentId: story.id });
    await block(fx, gated.id, ready.id);

    // ⚠️ `blocked` is a STATUS, not a derivation. A card with an open blocker is
    // not automatically moved there — readiness is COMPUTED from the edges and
    // the status is written by somebody. So the fixture writes it, which is what
    // makes this the second legal SOURCE edge rather than a hypothetical one.
    await workItemsService.updateStatus(gated.id, 'blocked', fx.ctx);

    const before = await rowsOf([story.id, ready.id, gated.id]);
    expect(before.get(gated.id)?.status).toBe('blocked');
    expect(before.get(ready.id)?.status).toBe('todo');

    await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: story.identifier },
      fx.ctx,
    );

    const after = await rowsOf([story.id, ready.id, gated.id]);
    for (const id of [story.id, ready.id, gated.id]) {
      expect(after.get(id)?.status).toBe('in_progress');
      expect(after.get(id)?.assigneeId).toBe(fx.ownerId);
    }
  });

  it('a REFUSED claim leaves every row byte-identical — all or nothing, for real', async () => {
    // ⚠️ THE PROPERTY WITH NO GOOD PARTIAL. A half-claimed scope can neither be
    // finished nor cleanly abandoned, because the run is already holding cards
    // somebody else is now blocked on. Asserted at the ROW level rather than
    // through the service's own answer: the point is what is in the database.
    const fx = await makeWorkItemFixture();
    const story = await make(fx, { title: 'The story', kind: 'story' });
    const ok = await make(fx, { title: 'fine', parentId: story.id });
    const finished = await make(fx, { title: 'already done', parentId: story.id });
    await workItemsService.updateStatus(finished.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(finished.id, 'in_review', fx.ctx);

    const before = await rowsOf([story.id, ok.id, finished.id]);
    const claim = await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: story.identifier },
      fx.ctx,
    );

    expect(claim.outcome).toBe('not_claimable');
    expect(claim.members).toEqual([]);
    const after = await rowsOf([story.id, ok.id, finished.id]);
    for (const id of [story.id, ok.id, finished.id]) {
      expect(after.get(id)?.status).toBe(before.get(id)?.status);
      expect(after.get(id)?.assigneeId).toBe(before.get(id)?.assigneeId ?? null);
      expect(after.get(id)?.updatedAt).toEqual(before.get(id)?.updatedAt);
    }
  });
});

describe('SEAM — the sprint facet at real depth', () => {
  it('a sprint of MIXED kinds and depths resolves to exactly the rows whose OWN sprintId matches', async () => {
    // Sprint 44 held 79 items of mixed kinds, and that is legitimate — which is
    // why a sprint scope has no shape rule. What it does have is a membership
    // that is DIRECT and never inherited, and this is that claim against a real
    // three-level tree.
    const fx = await makeWorkItemFixture();
    const story = await make(fx, { title: 'A story', kind: 'story' });
    const midTask = await make(fx, { title: 'A task', kind: 'task', parentId: story.id });
    const deep = await make(fx, { title: 'Deep', parentId: midTask.id });
    const shallow = await make(fx, { title: 'Shallow', parentId: story.id });
    // A `task` rather than a subtask: the kind-parent matrix requires a subtask
    // to have a parent, and the point of this row is that it has none.
    const loose = await make(fx, { title: 'Loose', kind: 'task' });

    // The story and the mid task are containers, so they are not ready leaves
    // anyway; the interesting exclusion is `shallow`, a ready leaf under an
    // in-sprint parent that is NOT itself in the sprint.
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Mixed' }, fx.ctx);
    await backlogService.bulkAssignToSprint(
      [story.id, midTask.id, deep.id, loose.id],
      sprint.id,
      fx.ctx,
    );
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);

    const byId = await workItemsService.listReady(fx.projectId, { sprintRef: sprint.id }, fx.ctx);
    const byLiteral = await workItemsService.listReady(
      fx.projectId,
      { sprintRef: SPRINT_ACTIVE },
      fx.ctx,
    );

    const keys = byId.items.map((i) => i.key).sort();
    expect(keys).toEqual([deep.identifier, loose.identifier].sort());
    expect(keys).not.toContain(shallow.identifier);
    // The reserved literal resolves to the same sprint, not to a wider set.
    expect(byLiteral.items.map((i) => i.key).sort()).toEqual(keys);
  });
});
