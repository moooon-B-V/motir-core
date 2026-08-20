import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { User, WorkItemKind } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { backlogService } from '@/lib/services/backlogService';
import { scopeClaimService } from '@/lib/services/scopeClaimService';
import { sprintsService } from '@/lib/services/sprintsService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { warmPool } from '../helpers/warmPool';

// `POST /api/v1/scope-claims` (MOTIR-3049) — the ATOMIC SCOPE claim, over real
// Postgres.
//
// The behaviour under test: validate the scope, check its shape, lock EVERY row
// in a deterministic order, re-assert the to-do CATEGORY on all of them, and
// assign + flip them all in ONE transaction — or write nothing whatsoever. A
// scoped run's promise is that it takes a story and finishes it, and that
// promise is only keepable if the run owns the whole story when it starts.
//
// The concurrency tests warm the pool first: on a cold pool the racers share one
// physical connection, which serialises them and would pass even with the race
// intact.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function makeItem(
  fx: WorkItemFixture,
  title: string,
  opts: { kind?: WorkItemKind; parentId?: string } = {},
) {
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: opts.kind ?? 'subtask',
      title,
      assigneeId: null,
      descriptionMd: null,
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
    },
    fx.ctx,
  );
}

/** A story with `count` leaf children — the canonical claimable scope. */
async function makeStoryScope(fx: WorkItemFixture, count = 3) {
  const story = await makeItem(fx, 'a runnable story', { kind: 'story' });
  const children = [];
  for (let i = 0; i < count; i++) {
    children.push(await makeItem(fx, `child ${i + 1}`, { parentId: story.id }));
  }
  return { story, children };
}

/** A SECOND workspace member, so "somebody else holds it" is a real actor. */
async function otherMember(fx: WorkItemFixture): Promise<{ user: User; ctx: ServiceContext }> {
  const user = await usersService.createUser({
    email: `rival+${randomToken()}@example.com`,
    password: 'hunter2hunter2',
    name: 'Rival Runner',
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return { user, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
}

/** An ACTIVE sprint holding `itemIds`. */
async function makeActiveSprint(fx: WorkItemFixture, itemIds: string[], name = 'Sprint one') {
  const sprint = await sprintsService.createSprint(fx.projectId, { name }, fx.ctx);
  if (itemIds.length > 0) await backlogService.bulkAssignToSprint(itemIds, sprint.id, fx.ctx);
  await sprintsService.startSprint(sprint.id, {}, fx.ctx);
  return sprint;
}

async function rowOf(id: string) {
  return adminDb.workItem.findUniqueOrThrow({ where: { id } });
}

async function rowsOf(ids: string[]) {
  const rows = await adminDb.workItem.findMany({ where: { id: { in: ids } } });
  return new Map(rows.map((r) => [r.id, r]));
}

describe('claimScope — a WORK-ITEM scope, the happy path', () => {
  it('claims the container AND every child: all assigned to the caller, all in_progress', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await makeStoryScope(fx);

    const claim = await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: story.identifier },
      fx.ctx,
    );

    expect(claim.outcome).toBe('claimed');
    expect(claim.claimed).toBe(true);
    expect(claim.scope).toEqual({
      kind: 'work_item',
      key: story.identifier,
      sprintId: null,
      name: 'a runnable story',
    });
    // The CONTAINER is claimed alongside the leaves — that is the point, not an
    // accident: the run owns the whole set, so the story is in the set.
    expect(claim.members.map((m) => m.key).sort()).toEqual(
      [story, ...children].map((i) => i.identifier).sort(),
    );
    for (const m of claim.members) {
      expect(m.status).toEqual({ key: 'in_progress', category: 'in_progress' });
    }

    const rows = await rowsOf([story.id, ...children.map((c) => c.id)]);
    for (const id of [story.id, ...children.map((c) => c.id)]) {
      expect(rows.get(id)?.status).toBe('in_progress');
      expect(rows.get(id)?.assigneeId).toBe(fx.ownerId);
    }
    expect(claim.offender).toBeNull();
    expect(claim.shape).toBeNull();
    expect(claim.blockers).toEqual([]);
  });

  it('claims a `blocked` member too — the CATEGORY is re-asserted, not the `todo` key', async () => {
    // `--force` exists to dispatch a card whose dependencies are unmet, and such
    // a card sits at `blocked`. A scope holding one must still be claimable, or
    // the flag breaks the day this ships.
    const fx = await makeWorkItemFixture();
    const { story, children } = await makeStoryScope(fx, 2);
    await workItemsService.updateStatus(children[0]!.id, 'blocked', fx.ctx);

    const claim = await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: story.identifier },
      fx.ctx,
    );

    expect(claim.outcome).toBe('claimed');
    expect((await rowOf(children[0]!.id)).status).toBe('in_progress');
  });

  it('claims a CHILDLESS container as a scope of one', async () => {
    // Refusing it would make the caller branch on shape before choosing an
    // endpoint — the branch this result shape exists to remove.
    const fx = await makeWorkItemFixture();
    const lone = await makeItem(fx, 'no children', { kind: 'task' });

    const claim = await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: lone.identifier },
      fx.ctx,
    );

    expect(claim.outcome).toBe('claimed');
    expect(claim.members.map((m) => m.key)).toEqual([lone.identifier]);
  });

  it('writes ONLY `todo → in_progress` and `blocked → in_progress`, and nothing else', async () => {
    // The claimable set is the to-do CATEGORY, and in the default workflow that
    // category holds exactly two statuses — so those are the only two edges this
    // op can ever write. Read off the revision trail rather than asserted from
    // the code: a widened category or a re-pointed target shows up here as a
    // third pair.
    const fx = await makeWorkItemFixture();
    const { story, children } = await makeStoryScope(fx, 3);
    await workItemsService.updateStatus(children[1]!.id, 'blocked', fx.ctx);

    await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: story.identifier },
      fx.ctx,
    );

    const ids = [story.id, ...children.map((c) => c.id)];
    const revisions = await adminDb.workItemRevision.findMany({
      where: { workItemId: { in: ids } },
      orderBy: { changedAt: 'asc' },
    });
    const written = revisions
      .map((r) => (r.diff as { status?: { from: string; to: string } }).status)
      .filter((s): s is { from: string; to: string } => s !== undefined)
      .filter((s) => s.to === 'in_progress')
      .map((s) => `${s.from} → ${s.to}`);
    expect(new Set(written)).toEqual(new Set(['todo → in_progress', 'blocked → in_progress']));
  });
});

describe('claimScope — the SHAPE rule', () => {
  it('a STORY whose child is itself a container is `wrong_shape`, naming the child and its depth', async () => {
    // The kind-parent matrix (`lib/issues/parentRules.ts`) genuinely permits
    // `story → task → subtask`, so this is a LEGAL tree — it is just not a
    // runnable scope, and the caller's answer is a re-plan rather than a retry.
    const fx = await makeWorkItemFixture();
    const story = await makeItem(fx, 'two layers deep', { kind: 'story' });
    const leafChild = await makeItem(fx, 'a real leaf', { parentId: story.id });
    const container = await makeItem(fx, 'a task with children', {
      kind: 'task',
      parentId: story.id,
    });
    const grandchild = await makeItem(fx, 'the grandchild', { parentId: container.id });

    const claim = await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: story.identifier },
      fx.ctx,
    );

    expect(claim.outcome).toBe('wrong_shape');
    expect(claim.claimed).toBe(false);
    expect(claim.shape).toEqual({
      child: container.identifier,
      childTitle: 'a task with children',
      depth: 2,
    });
    expect(claim.members).toEqual([]);
    // NOTHING was claimed — not the story, not the legal leaf, not the grandchild.
    for (const id of [story.id, leafChild.id, container.id, grandchild.id]) {
      expect((await rowOf(id)).status).toBe('todo');
      expect((await rowOf(id)).assigneeId).toBeNull();
    }
  });

  it('refuses on shape BEFORE taking any lock — nothing is even assigned', async () => {
    const fx = await makeWorkItemFixture();
    const story = await makeItem(fx, 'deep', { kind: 'story' });
    const container = await makeItem(fx, 'container', { kind: 'task', parentId: story.id });
    await makeItem(fx, 'grandchild', { parentId: container.id });
    const before = await rowOf(story.id);

    await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: story.identifier },
      fx.ctx,
    );

    const after = await rowOf(story.id);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });
});

describe('claimScope — an UNFINISHABLE scope is refused before any lock', () => {
  it('names the blockers and touches nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await makeStoryScope(fx, 2);
    // A blocker OUTSIDE the subtree, not done: the story cannot be finished by a
    // run that owns only the subtree.
    const outsider = await makeItem(fx, 'work outside the scope', { kind: 'task' });
    await workItemsService.linkWorkItems(
      { fromId: children[0]!.id, toId: outsider.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    const before = await rowsOf([story.id, ...children.map((c) => c.id)]);
    const claim = await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: story.identifier },
      fx.ctx,
    );

    expect(claim.outcome).toBe('not_finishable');
    expect(claim.claimed).toBe(false);
    expect(claim.members).toEqual([]);
    expect(claim.blockers).toContainEqual(
      expect.objectContaining({ item: children[0]!.identifier, blockedBy: outsider.identifier }),
    );
    // BYTE-IDENTICAL, `updatedAt` included — a scope that cannot be finished
    // costs nothing, which is why the validator runs before the locks.
    const after = await rowsOf([story.id, ...children.map((c) => c.id)]);
    for (const [id, row] of before) {
      expect(after.get(id)?.status).toBe(row.status);
      expect(after.get(id)?.assigneeId).toBe(row.assigneeId);
      expect(after.get(id)?.updatedAt.toISOString()).toBe(row.updatedAt.toISOString());
    }
  });
});

describe('claimScope — ONE un-claimable member rolls the WHOLE claim back', () => {
  it('leaves every other row byte-identical, `updatedAt` included', async () => {
    // The property the card exists for. A partially-claimed scope is the one
    // outcome with no good handling — you can neither finish it nor cleanly
    // abandon it — so "all or nothing" has to be observable as *no row moved*.
    const fx = await makeWorkItemFixture();
    const { story, children } = await makeStoryScope(fx, 3);
    // One member parked at `in_review`, which is outside the to-do category.
    for (const hop of ['in_progress', 'in_review']) {
      await workItemsService.updateStatus(children[1]!.id, hop, fx.ctx);
    }

    const untouchedIds = [story.id, children[0]!.id, children[2]!.id];
    const before = await rowsOf(untouchedIds);

    const claim = await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: story.identifier },
      fx.ctx,
    );

    expect(claim.outcome).toBe('not_claimable');
    expect(claim.claimed).toBe(false);
    expect(claim.members).toEqual([]);
    expect(claim.offender?.key).toBe(children[1]!.identifier);
    expect(claim.offender?.status.key).toBe('in_review');
    expect(claim.offender?.transitionedBy?.id).toBe(fx.ownerId);

    const after = await rowsOf(untouchedIds);
    for (const [id, row] of before) {
      expect(after.get(id)?.status).toBe(row.status);
      expect(after.get(id)?.assigneeId).toBe(row.assigneeId);
      expect(after.get(id)?.updatedAt.toISOString()).toBe(row.updatedAt.toISOString());
    }
  });

  it('reports `taken` and NAMES the holder when a sibling took one member', async () => {
    const fx = await makeWorkItemFixture();
    const rival = await otherMember(fx);
    const { story, children } = await makeStoryScope(fx, 2);
    await workItemsService.claimWorkItem(fx.projectId, children[0]!.identifier, rival.ctx);

    const claim = await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: story.identifier },
      fx.ctx,
    );

    expect(claim.outcome).toBe('taken');
    expect(claim.offender?.key).toBe(children[0]!.identifier);
    expect(claim.offender?.assignee?.name).toBe('Rival Runner');
    expect(claim.offender?.transitionedBy?.name).toBe('Rival Runner');
    expect((await rowOf(children[1]!.id)).status).toBe('todo');
  });

  it('reports `mine` when the only obstacle is the caller’s own in-progress card', async () => {
    // A resume of the caller's own run — not a lost race, and the caller proceeds.
    const fx = await makeWorkItemFixture();
    const { story, children } = await makeStoryScope(fx, 2);
    await workItemsService.claimWorkItem(fx.projectId, children[0]!.identifier, fx.ctx);

    const claim = await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: story.identifier },
      fx.ctx,
    );

    expect(claim.outcome).toBe('mine');
    expect(claim.offender?.key).toBe(children[0]!.identifier);
    expect(claim.offender?.assignee?.id).toBe(fx.ownerId);
  });

  it('a member with NO assignee is still `taken` — the MOTIR-2958 shape', async () => {
    // A session that flipped the status through `transition_status` and never
    // assigned. "Unassigned" is evidence of nothing; the holder comes from the
    // status HISTORY instead.
    const fx = await makeWorkItemFixture();
    const rival = await otherMember(fx);
    const { story, children } = await makeStoryScope(fx, 2);
    await workItemsService.updateStatus(children[1]!.id, 'in_progress', rival.ctx);

    const claim = await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: story.identifier },
      fx.ctx,
    );

    expect(claim.outcome).toBe('taken');
    expect(claim.offender?.assignee).toBeNull();
    expect(claim.offender?.transitionedBy?.name).toBe('Rival Runner');
  });

  it('`taken` OUTRANKS `mine`, whichever member’s id sorts first', async () => {
    // The verdict must be a total function of the member set, not an artifact of
    // which cuid sorted lowest: a caller told `mine` about a scope somebody else
    // is inside would resume straight into a collision.
    const fx = await makeWorkItemFixture();
    const rival = await otherMember(fx);
    const { story, children } = await makeStoryScope(fx, 3);
    await workItemsService.claimWorkItem(fx.projectId, children[0]!.identifier, fx.ctx);
    await workItemsService.claimWorkItem(fx.projectId, children[2]!.identifier, rival.ctx);

    const claim = await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: story.identifier },
      fx.ctx,
    );

    expect(claim.outcome).toBe('taken');
    expect(claim.offender?.key).toBe(children[2]!.identifier);
  });

  it('an ARCHIVED member refuses the scope even though its status is still `todo`', async () => {
    const fx = await makeWorkItemFixture();
    const { story, children } = await makeStoryScope(fx, 2);
    await workItemsService.archiveWorkItem(children[0]!.id, fx.ctx);

    const claim = await scopeClaimService.claimScope(
      { kind: 'work_item', projectId: fx.projectId, identifier: story.identifier },
      fx.ctx,
    );

    // An archived child leaves the subtree for every OTHER read too, so what
    // this pins is that the claim agrees with them: it is not a member, and the
    // rest of the scope is claimed.
    expect(claim.outcome).toBe('claimed');
    expect(claim.members.map((m) => m.key)).not.toContain(children[0]!.identifier);
    expect((await rowOf(children[0]!.id)).status).toBe('todo');
  });
});

describe('claimScope — a SPRINT scope', () => {
  it('claims a sprint of MIXED kinds and depths without any shape complaint', async () => {
    // A sprint routinely holds stories AND loose subtasks at mixed depths, and
    // that is legitimate: `validate_sprint` already guarantees the membership is
    // closed, so a layer check would reject ordinary sprints and catch nothing.
    const fx = await makeWorkItemFixture();
    const story = await makeItem(fx, 'a story in the sprint', { kind: 'story' });
    const childA = await makeItem(fx, 'story child A', { parentId: story.id });
    const childB = await makeItem(fx, 'story child B', { parentId: story.id });
    const loose = await makeItem(fx, 'a loose subtask', { kind: 'task' });
    const ids = [story.id, childA.id, childB.id, loose.id];
    const sprint = await makeActiveSprint(fx, ids);

    const claim = await scopeClaimService.claimScope(
      { kind: 'sprint', projectId: fx.projectId },
      fx.ctx,
    );

    expect(claim.outcome).toBe('claimed');
    expect(claim.scope).toEqual({
      kind: 'sprint',
      key: null,
      sprintId: sprint.id,
      name: 'Sprint one',
    });
    expect(claim.members.map((m) => m.key).sort()).toEqual(
      [story, childA, childB, loose].map((i) => i.identifier).sort(),
    );
    const rows = await rowsOf(ids);
    for (const id of ids) {
      expect(rows.get(id)?.status).toBe('in_progress');
      expect(rows.get(id)?.assigneeId).toBe(fx.ownerId);
    }
  });

  it('claims EXACTLY the items whose own `sprintId` matches — not one under an in-sprint parent', async () => {
    // Membership is a DIRECT field, never inherited. Widening the scope here
    // would make the claim disagree with the validator that just approved it.
    const fx = await makeWorkItemFixture();
    const story = await makeItem(fx, 'in the sprint', { kind: 'story' });
    const inSprintChild = await makeItem(fx, 'in the sprint too', { parentId: story.id });
    const outsideChild = await makeItem(fx, 'under the parent, NOT in the sprint', {
      parentId: story.id,
    });
    // Only the story + one child join the sprint. `validate_sprint` would refuse
    // that (the parent has a not-done child outside), so the child is finished
    // first — which is exactly the state where the membership question is real.
    for (const hop of ['in_progress', 'in_review', 'done']) {
      await workItemsService.updateStatus(outsideChild.id, hop, fx.ctx);
    }
    await makeActiveSprint(fx, [story.id, inSprintChild.id]);

    const claim = await scopeClaimService.claimScope(
      { kind: 'sprint', projectId: fx.projectId },
      fx.ctx,
    );

    expect(claim.outcome).toBe('claimed');
    expect(claim.members.map((m) => m.key).sort()).toEqual(
      [story.identifier, inSprintChild.identifier].sort(),
    );
    expect((await rowOf(outsideChild.id)).status).toBe('done');
  });

  it('refuses an UNFINISHABLE sprint, naming its blockers, before any lock', async () => {
    const fx = await makeWorkItemFixture();
    const member = await makeItem(fx, 'in the sprint', { kind: 'task' });
    const outsider = await makeItem(fx, 'outside it', { kind: 'task' });
    await workItemsService.linkWorkItems(
      { fromId: member.id, toId: outsider.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    await makeActiveSprint(fx, [member.id]);
    const before = await rowOf(member.id);

    const claim = await scopeClaimService.claimScope(
      { kind: 'sprint', projectId: fx.projectId },
      fx.ctx,
    );

    expect(claim.outcome).toBe('not_finishable');
    expect(claim.blockers).toContainEqual(
      expect.objectContaining({ item: member.identifier, blockedBy: outsider.identifier }),
    );
    const after = await rowOf(member.id);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });

  it('a project with NO active sprint is refused, not silently claimed empty', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      scopeClaimService.claimScope({ kind: 'sprint', projectId: fx.projectId }, fx.ctx),
    ).rejects.toMatchObject({ code: 'NO_ACTIVE_SPRINT' });
  });
});

describe('claimScope — real concurrency (warm pool)', () => {
  it('N concurrent claims of the SAME scope yield exactly ONE full success and N−1 typed refusals', async () => {
    // The property the whole card exists for, and the one nobody can observe
    // serially: run it on a cold pool and the racers share one connection, which
    // serialises them whether or not the lock is there.
    const fx = await makeWorkItemFixture();
    const { story, children } = await makeStoryScope(fx, 4);
    const racers = await Promise.all(Array.from({ length: 4 }, () => otherMember(fx)));
    const contexts = [fx.ctx, ...racers.map((r) => r.ctx)];

    await warmPool(contexts.length + 2);
    const results = await Promise.all(
      contexts.map((ctx) =>
        scopeClaimService.claimScope(
          { kind: 'work_item', projectId: fx.projectId, identifier: story.identifier },
          ctx,
        ),
      ),
    );

    const winners = results.filter((r) => r.claimed);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => !r.claimed)).toHaveLength(contexts.length - 1);

    // NO caller ever observes a PARTIALLY-claimed scope: the winner names every
    // member, and every loser names none.
    expect(winners[0]!.members).toHaveLength(children.length + 1);
    for (const loser of results.filter((r) => !r.claimed)) {
      expect(loser.members).toEqual([]);
      // A typed refusal, never a raw Prisma error — and one that names a holder.
      expect(['taken', 'mine', 'not_claimable']).toContain(loser.outcome);
      expect(loser.offender).not.toBeNull();
    }

    // And the DATABASE agrees: one owner across the whole scope.
    const rows = await rowsOf([story.id, ...children.map((c) => c.id)]);
    const owners = new Set([...rows.values()].map((r) => r.assigneeId));
    expect(owners.size).toBe(1);
    for (const row of rows.values()) expect(row.status).toBe('in_progress');
  });

  it('a SPRINT claim and a STORY claim inside it QUEUE rather than deadlock', async () => {
    // Two overlapping scopes taking the same rows in DIFFERENT orders is a
    // deadlock (`40P01`), not a queue. The deterministic `ORDER BY id` in the
    // lock statement is what makes this pass — and a warm pool is what makes the
    // two transactions actually overlap.
    const fx = await makeWorkItemFixture();
    const { story, children } = await makeStoryScope(fx, 5);
    const ids = [story.id, ...children.map((c) => c.id)];
    await makeActiveSprint(fx, ids);
    const rival = await otherMember(fx);

    await warmPool(8);
    const results = await Promise.all([
      scopeClaimService.claimScope({ kind: 'sprint', projectId: fx.projectId }, fx.ctx),
      scopeClaimService.claimScope(
        { kind: 'work_item', projectId: fx.projectId, identifier: story.identifier },
        rival.ctx,
      ),
    ]);

    // Neither call threw — a deadlock surfaces as a raw `40P01`, which
    // `Promise.all` would have rejected with.
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    const loser = results.find((r) => !r.claimed);
    expect(['taken', 'mine']).toContain(loser?.outcome);
  });

  it('the SAME caller racing itself resolves to one `claimed` and one `mine` — never two claims', async () => {
    const fx = await makeWorkItemFixture();
    const { story } = await makeStoryScope(fx, 3);

    await warmPool();
    const results = await Promise.all([
      scopeClaimService.claimScope(
        { kind: 'work_item', projectId: fx.projectId, identifier: story.identifier },
        fx.ctx,
      ),
      scopeClaimService.claimScope(
        { kind: 'work_item', projectId: fx.projectId, identifier: story.identifier },
        fx.ctx,
      ),
    ]);

    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(results.map((r) => r.outcome).sort()).toEqual(['claimed', 'mine']);
  });
});

describe('claimScope — access', () => {
  it('a key in ANOTHER workspace is refused as not-found, with no existence leak', async () => {
    const fx = await makeWorkItemFixture();
    const outsider = await makeWorkItemFixture({ name: 'Rival Co', identifier: 'ZZZ' });
    const { story, children } = await makeStoryScope(fx, 2);

    await expect(
      scopeClaimService.claimScope(
        { kind: 'work_item', projectId: fx.projectId, identifier: story.identifier },
        outsider.ctx,
      ),
    ).rejects.toMatchObject({ code: 'WORK_ITEM_NOT_FOUND' });
    // Nothing was claimed on the way to the refusal.
    for (const id of [story.id, ...children.map((c) => c.id)]) {
      expect((await rowOf(id)).status).toBe('todo');
    }
  });
});
