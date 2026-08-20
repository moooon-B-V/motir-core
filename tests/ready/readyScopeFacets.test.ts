import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { backlogService } from '@/lib/services/backlogService';
import { InvalidReadyFilterError, SPRINT_ACTIVE } from '@/lib/workItems/readyFilter';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The two SCOPE facets on the ready read (Story MOTIR-3001 · MOTIR-3196) —
// `ancestorKeys` and `sprintRef` — at the SERVICE tier, over real Postgres.
//
// ── What these tests are actually guarding ─────────────────────────────────
// The cheap implementation of an ancestor facet is to seed the top-down walk at
// the named container and descend from there. It passes every obvious test: the
// leaves are beneath the container, they are `todo`, their own blockers are
// done. And it is WRONG, because `collectReadyLeaves` starts at the project
// roots for a reason — the walk IS the parent-ready cascade, and a leaf is
// reached only via an all-ready ancestor chain. Re-seeding throws that chain
// away and reports work as ready under a container whose own ancestors are
// gated, which is precisely the answer a caller must not get when the next
// thing it does is CLAIM and DISPATCH the result.
//
// So `narrows and never widens` below is the load-bearing test, and its fixture
// is built to fail against the re-seeded implementation and pass against a
// filter over the collected set. Every other assertion here would pass either
// way.

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
      kind: opts.kind ?? 'task',
      title: opts.title ?? 'Item',
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
    },
    fx.ctx,
  );
}

async function block(fx: WorkItemFixture, fromId: string, toId: string) {
  await workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, fx.ctx);
}

/** An ACTIVE sprint holding `itemIds`. */
async function makeActiveSprint(fx: WorkItemFixture, itemIds: string[], name = 'Sprint one') {
  const sprint = await sprintsService.createSprint(fx.projectId, { name }, fx.ctx);
  if (itemIds.length > 0) await backlogService.bulkAssignToSprint(itemIds, sprint.id, fx.ctx);
  await sprintsService.startSprint(sprint.id, {}, fx.ctx);
  return sprint;
}

async function readyKeys(
  fx: WorkItemFixture,
  filter: Parameters<typeof workItemsService.listReady>[1] = {},
): Promise<string[]> {
  const { items } = await workItemsService.listReady(fx.projectId, filter, fx.ctx);
  return items.map((i) => i.key);
}

describe('the ANCESTOR facet', () => {
  it('returns every ready leaf STRICTLY beneath the container, at any depth', async () => {
    // `story → task → subtask` is a depth the kind-parent matrix permits
    // (`lib/issues/parentRules.ts`), so the "at any depth" clause is a real
    // case and not a hypothetical: a one-level implementation passes a
    // story→subtask fixture and fails this one.
    const fx = await makeWorkItemFixture();
    const story = await make(fx, { title: 'The story', kind: 'story' });
    const direct = await make(fx, { title: 'Direct child', kind: 'subtask', parentId: story.id });
    const mid = await make(fx, { title: 'Middle task', kind: 'task', parentId: story.id });
    const deep = await make(fx, { title: 'Grandchild', kind: 'subtask', parentId: mid.id });
    const outside = await make(fx, { title: 'Somewhere else' });

    const keys = await readyKeys(fx, { ancestorKeys: [story.identifier] });

    expect(new Set(keys)).toEqual(new Set([direct.identifier, deep.identifier]));
    // Not the container itself, and not its sibling elsewhere in the project.
    expect(keys).not.toContain(story.identifier);
    expect(keys).not.toContain(mid.identifier); // a container is not a leaf
    expect(keys).not.toContain(outside.identifier);
  });

  it('NARROWS and never widens: a leaf under a NOT-ready intermediate ancestor stays absent', async () => {
    // ⚠️ THE TEST THAT FAILS IF THE WALK IS RE-SEEDED AT THE CONTAINER.
    //
    //   epic ─┬─ blockedStory (blocked by `gate`, which is NOT done)
    //         │     └── leaf            ← its OWN blockers are all satisfied
    //         └── openStory
    //               └── sibling
    //
    // `leaf` names no blocker at all, so any check that starts at `epic` and
    // walks down while asking only "are THIS node's blockers done?" reports it
    // — unless the answer inherits `blockedStory`'s gate. The unfaceted read
    // already excludes it; the facet must not resurrect it.
    const fx = await makeWorkItemFixture();
    const epic = await make(fx, { title: 'The epic', kind: 'epic' });
    const gate = await make(fx, { title: 'Not done yet' });
    const blockedStory = await make(fx, { title: 'Gated story', kind: 'story', parentId: epic.id });
    await block(fx, blockedStory.id, gate.id);
    const leaf = await make(fx, {
      title: 'Under the gate',
      kind: 'subtask',
      parentId: blockedStory.id,
    });
    const openStory = await make(fx, { title: 'Open story', kind: 'story', parentId: epic.id });
    const sibling = await make(fx, { title: 'Reachable', kind: 'subtask', parentId: openStory.id });

    const scoped = await readyKeys(fx, { ancestorKeys: [epic.identifier] });
    const unfaceted = await readyKeys(fx);

    expect(scoped).not.toContain(leaf.identifier);
    expect(scoped).toContain(sibling.identifier);
    // The invariant, stated as a set relation rather than as a list: whatever
    // the facet returns is a SUBSET of the answer without it. There is no
    // fixture-specific expectation here to drift.
    expect(unfaceted).toEqual(expect.arrayContaining(scoped));
    expect(new Set(unfaceted).size).toBeGreaterThan(new Set(scoped).size);
  });

  it('a CHILDLESS container returns an empty page — not itself, and not an error', async () => {
    // The honest answer to "what is ready under this story" for a story nobody
    // has decomposed. The childless container IS ready in its own right and
    // appears in the unfaceted set, which is exactly why excluding it here has
    // to be deliberate.
    const fx = await makeWorkItemFixture();
    const story = await make(fx, { title: 'Never expanded', kind: 'story' });

    expect(await readyKeys(fx)).toContain(story.identifier);
    expect(await readyKeys(fx, { ancestorKeys: [story.identifier] })).toEqual([]);
  });

  it('repeated values return the UNION, de-duplicated, still in dispatch rank', async () => {
    const fx = await makeWorkItemFixture();
    const first = await make(fx, { title: 'Story one', kind: 'story' });
    const second = await make(fx, { title: 'Story two', kind: 'story' });
    const a = await make(fx, { title: 'A', kind: 'subtask', parentId: first.id });
    const b = await make(fx, { title: 'B', kind: 'subtask', parentId: second.id });

    const keys = await readyKeys(fx, {
      ancestorKeys: [first.identifier, second.identifier, first.identifier],
    });

    expect(new Set(keys)).toEqual(new Set([a.identifier, b.identifier]));
    expect(keys).toHaveLength(2); // the repeat did not duplicate a row
    // Still the dispatch order the unfaceted read produces — this facet
    // narrows the set, it does not reorder it.
    const unfaceted = (await readyKeys(fx)).filter((k) => keys.includes(k));
    expect(keys).toEqual(unfaceted);
  });

  it('ANDs with the vocabulary facets', async () => {
    const fx = await makeWorkItemFixture();
    const story = await make(fx, { title: 'Story', kind: 'story' });
    const sub = await make(fx, { title: 'A subtask', kind: 'subtask', parentId: story.id });
    const bug = await make(fx, { title: 'A bug', kind: 'bug', parentId: story.id });

    expect(await readyKeys(fx, { ancestorKeys: [story.identifier], kinds: ['bug'] })).toEqual([
      bug.identifier,
    ]);
    expect(await readyKeys(fx, { ancestorKeys: [story.identifier], kinds: ['subtask'] })).toEqual([
      sub.identifier,
    ]);
  });

  it('refuses an unknown key, and a key from ANOTHER project identically', async () => {
    const fx = await makeWorkItemFixture();
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHER',
    });
    const foreign = await workItemsService.createWorkItem(
      { projectId: other.id, kind: 'story', title: 'Not ours' },
      fx.ctx,
    );
    const unknownKey = `${fx.projectIdentifier}-999999`;

    const unknown = await workItemsService
      .listReady(fx.projectId, { ancestorKeys: [unknownKey] }, fx.ctx)
      .catch((e: unknown) => e);
    const crossProject = await workItemsService
      .listReady(fx.projectId, { ancestorKeys: [foreign.identifier] }, fx.ctx)
      .catch((e: unknown) => e);

    expect(unknown).toBeInstanceOf(InvalidReadyFilterError);
    expect(crossProject).toBeInstanceOf(InvalidReadyFilterError);
    // ⚠️ The two must be INDISTINGUISHABLE. Not "both refuse" — the same shape
    // of refusal, or the endpoint becomes an oracle answering "does this key
    // exist somewhere you cannot see?". Only the echoed key differs.
    expect((unknown as InvalidReadyFilterError).message).toBe(
      `Unknown \`ancestor\`: ${unknownKey}.`,
    );
    expect((crossProject as InvalidReadyFilterError).message).toBe(
      `Unknown \`ancestor\`: ${foreign.identifier}.`,
    );
  });

  it('pages on the existing cursor without repeating or skipping a row', async () => {
    const fx = await makeWorkItemFixture();
    const story = await make(fx, { title: 'Story', kind: 'story' });
    for (const t of ['a', 'b', 'c', 'd', 'e']) {
      await make(fx, { title: t, kind: 'subtask', parentId: story.id });
    }
    const filter = { ancestorKeys: [story.identifier] };
    const whole = await readyKeys(fx, filter);
    expect(whole).toHaveLength(5);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await workItemsService.listReady(
        fx.projectId,
        { ...filter, limit: 2, ...(cursor ? { cursor } : {}) },
        fx.ctx,
      );
      seen.push(...page.items.map((i) => i.key));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(seen).toEqual(whole);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe('the SPRINT facet', () => {
  it('scopes to the items whose OWN sprintId matches — never an inherited one', async () => {
    // The distinction the card calls out: sprint membership is a scalar column,
    // not something a child inherits from an in-sprint parent. A leaf under an
    // in-sprint story that is not itself in the sprint is OUT of scope.
    const fx = await makeWorkItemFixture();
    const story = await make(fx, { title: 'In the sprint', kind: 'story' });
    const inSprint = await make(fx, { title: 'Member', kind: 'subtask', parentId: story.id });
    const notInSprint = await make(fx, {
      title: 'Not a member',
      kind: 'subtask',
      parentId: story.id,
    });
    const sprint = await makeActiveSprint(fx, [story.id, inSprint.id]);

    const keys = await readyKeys(fx, { sprintRef: sprint.id });

    expect(keys).toEqual([inSprint.identifier]);
    expect(keys).not.toContain(notInSprint.identifier);
  });

  it('resolves the reserved literal `active` to the project’s active sprint', async () => {
    const fx = await makeWorkItemFixture();
    const item = await make(fx, { title: 'Sprint work' });
    await make(fx, { title: 'Backlog work' });
    const sprint = await makeActiveSprint(fx, [item.id]);

    expect(await readyKeys(fx, { sprintRef: SPRINT_ACTIVE })).toEqual([item.identifier]);
    expect(await readyKeys(fx, { sprintRef: sprint.id })).toEqual([item.identifier]);
  });

  it('refuses `active` on a project between sprints, rather than returning everything', async () => {
    // The failure mode this exists to prevent: a filter that quietly matches
    // everything is how a scoped run claims the whole project.
    const fx = await makeWorkItemFixture();
    await make(fx, { title: 'Would have been swept up' });

    await expect(
      workItemsService.listReady(fx.projectId, { sprintRef: SPRINT_ACTIVE }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidReadyFilterError);
  });

  it('refuses a sprint id belonging to another project', async () => {
    const fx = await makeWorkItemFixture();
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHER',
    });
    const foreign = await sprintsService.createSprint(other.id, { name: 'Theirs' }, fx.ctx);

    await expect(
      workItemsService.listReady(fx.projectId, { sprintRef: foreign.id }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidReadyFilterError);
  });

  it('ANDs with the ancestor facet', async () => {
    const fx = await makeWorkItemFixture();
    const story = await make(fx, { title: 'Story', kind: 'story' });
    const both = await make(fx, { title: 'Under and in', kind: 'subtask', parentId: story.id });
    const underOnly = await make(fx, { title: 'Under only', kind: 'subtask', parentId: story.id });
    const inOnly = await make(fx, { title: 'In only' });
    const sprint = await makeActiveSprint(fx, [both.id, inOnly.id]);

    const keys = await readyKeys(fx, {
      ancestorKeys: [story.identifier],
      sprintRef: sprint.id,
    });

    expect(keys).toEqual([both.identifier]);
    expect(keys).not.toContain(underOnly.identifier);
    expect(keys).not.toContain(inOnly.identifier);
  });

  it('pages on the existing cursor without repeating or skipping a row', async () => {
    const fx = await makeWorkItemFixture();
    const ids: string[] = [];
    for (const t of ['a', 'b', 'c', 'd', 'e']) ids.push((await make(fx, { title: t })).id);
    await make(fx, { title: 'backlog' });
    const sprint = await makeActiveSprint(fx, ids);
    const filter = { sprintRef: sprint.id };
    const whole = await readyKeys(fx, filter);
    expect(whole).toHaveLength(5);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await workItemsService.listReady(
        fx.projectId,
        { ...filter, limit: 2, ...(cursor ? { cursor } : {}) },
        fx.ctx,
      );
      seen.push(...page.items.map((i) => i.key));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(seen).toEqual(whole);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
