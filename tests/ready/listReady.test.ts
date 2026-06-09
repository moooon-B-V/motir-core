import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import {
  InvalidReadyCursorError,
  encodeReadyCursor,
  READY_MAX_LIMIT,
} from '@/lib/workItems/readyFilter';
import { extractContextRefs } from '@/lib/markdown/contextRefs';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { truncateAuthTables } from '../helpers/db';

// Ready set — service (`listReady` / `getNextReady`) + repository
// (`findReadyCandidates`) over real Postgres (Subtask 7.0.2). The DTOs/mappers
// are 7.0.3 (PR #328, which this stacks on); these tests exercise the service
// behaviour + the `extractContextRefs` parser that supplies the dispatch DTO's
// `contextRefs` input. createTestProject auto-seeds the default workflow:
// `done` + `cancelled` are category=done; the initial status is category=todo.
// A work item is READY when its own status is in the `todo` category (not yet
// started) AND every is_blocked_by blocker is terminal in its own project.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

type Priority = 'lowest' | 'low' | 'medium' | 'high' | 'highest';

async function make(
  fx: WorkItemFixture,
  opts: {
    title?: string;
    kind?: 'task' | 'bug' | 'story';
    priority?: Priority;
    assigneeId?: string | null;
    descriptionMd?: string | null;
  } = {},
) {
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: opts.kind ?? 'task',
      title: opts.title ?? 'Item',
      priority: opts.priority,
      assigneeId: opts.assigneeId ?? null,
      descriptionMd: opts.descriptionMd ?? null,
    },
    fx.ctx,
  );
}

async function block(fx: WorkItemFixture, fromId: string, toId: string) {
  await workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, fx.ctx);
}

/** The identifier keys of a ready page, in order. */
function keys(items: { key: string }[]): string[] {
  return items.map((i) => i.key);
}

describe('listReady — readiness predicate', () => {
  it('an item with no blockers is ready', async () => {
    const fx = await makeWorkItemFixture();
    const x = await make(fx, { title: 'X' });
    const { items } = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
    expect(keys(items)).toContain(x.identifier);
  });

  it('an item whose only blocker is terminal is ready; a non-terminal blocker keeps it out', async () => {
    const fx = await makeWorkItemFixture();
    const x = await make(fx, { title: 'X' });
    const blocker = await make(fx, { title: 'B' });
    await block(fx, x.id, blocker.id);

    // Blocker in initial (todo) → X blocked, absent. Blocker itself is ready.
    let res = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
    expect(keys(res.items)).not.toContain(x.identifier);
    expect(keys(res.items)).toContain(blocker.identifier);

    // Resolve the blocker (done is category=done) → X ready; the done blocker
    // drops out of the ready set (its own status is now terminal).
    await db.workItem.update({ where: { id: blocker.id }, data: { status: 'done' } });
    res = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
    expect(keys(res.items)).toContain(x.identifier);
    expect(keys(res.items)).not.toContain(blocker.identifier);
  });

  it('ready = todo-category only: in_progress and done items are both excluded', async () => {
    const fx = await makeWorkItemFixture();
    const open = await make(fx, { title: 'open' }); // initial status = todo
    const started = await make(fx, { title: 'started' });
    const finished = await make(fx, { title: 'finished' });
    // `in_progress` (category in_progress) and `done` (category done) are both
    // valid keys in the default workflow; a ready item is one to START, so
    // neither belongs in the dispatch set.
    await db.workItem.update({ where: { id: started.id }, data: { status: 'in_progress' } });
    await db.workItem.update({ where: { id: finished.id }, data: { status: 'done' } });

    const { items } = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
    expect(keys(items)).toContain(open.identifier);
    expect(keys(items)).not.toContain(started.identifier);
    expect(keys(items)).not.toContain(finished.identifier);
  });

  it('cross-project: a blocker is classified against ITS OWN project terminal set', async () => {
    const fx = await makeWorkItemFixture();
    const projectB = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Project B',
      identifier: 'PROJB',
    });
    // In project B, recategorize `cancelled` to a non-terminal bucket.
    await db.workflowStatus.updateMany({
      where: { projectId: projectB.id, key: 'cancelled' },
      data: { category: 'todo' },
    });
    const x = await make(fx, { title: 'X' });
    const blockerInB = await workItemsService.createWorkItem(
      { projectId: projectB.id, kind: 'task', title: 'BB' },
      fx.ctx,
    );
    await db.workItem.update({ where: { id: blockerInB.id }, data: { status: 'cancelled' } });
    await block(fx, x.id, blockerInB.id);

    // B's terminal set excludes cancelled → X still blocked → absent.
    const { items } = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
    expect(keys(items)).not.toContain(x.identifier);
  });

  it('no N+1: one blocker-states read + one terminal-set read regardless of how many blocked items', async () => {
    const fx = await makeWorkItemFixture();
    // Two blocked items (plus their blockers) → the batched readiness read sees
    // multiple blockers across the window, yet issues exactly ONE blocker-states
    // query + ONE terminal-set query — not one-per-item/-per-project.
    const x1 = await make(fx, { title: 'x1' });
    const x2 = await make(fx, { title: 'x2' });
    await block(fx, x1.id, (await make(fx, { title: 'b1' })).id);
    await block(fx, x2.id, (await make(fx, { title: 'b2' })).id);

    const blockerSpy = vi.spyOn(workItemLinkRepository, 'findBlockerStatesForItems');
    const terminalSpy = vi.spyOn(workflowsRepository, 'findStatusesByProjects');
    try {
      await workItemsService.listReady(fx.projectId, {}, fx.ctx);
      expect(blockerSpy).toHaveBeenCalledTimes(1);
      expect(terminalSpy).toHaveBeenCalledTimes(1);
    } finally {
      blockerSpy.mockRestore();
      terminalSpy.mockRestore();
    }
  });
});

describe('listReady — sort, filters, pagination', () => {
  it('sorts priority desc, then key asc within an equal type', async () => {
    const fx = await makeWorkItemFixture();
    // All the same kind (task) → the primary type key is inert here; priority
    // orders them within the single type bucket and key breaks the
    // highest/highest tie. (Type-primary ordering is covered by the dedicated
    // 7.0.12 type-primary suite below.)
    const low = await make(fx, { title: 'low', priority: 'low' });
    const hi1 = await make(fx, { title: 'hi1', priority: 'highest' });
    const hi2 = await make(fx, { title: 'hi2', priority: 'highest' });
    const mid = await make(fx, { title: 'mid', priority: 'medium' });

    const { items } = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
    expect(keys(items)).toEqual([hi1.identifier, hi2.identifier, mid.identifier, low.identifier]);
  });

  it('kinds filter narrows to the requested kinds', async () => {
    const fx = await makeWorkItemFixture();
    const bug = await make(fx, { title: 'bug', kind: 'bug' });
    const task = await make(fx, { title: 'task', kind: 'task' });
    const { items } = await workItemsService.listReady(fx.projectId, { kinds: ['bug'] }, fx.ctx);
    expect(keys(items)).toEqual([bug.identifier]);
    expect(keys(items)).not.toContain(task.identifier);
  });

  it('assigneeId: null returns unassigned only; a user id returns that user', async () => {
    const fx = await makeWorkItemFixture();
    const mine = await make(fx, { title: 'mine', assigneeId: fx.ownerId });
    const nobody = await make(fx, { title: 'nobody', assigneeId: null });

    const unassigned = await workItemsService.listReady(fx.projectId, { assigneeId: null }, fx.ctx);
    expect(keys(unassigned.items)).toEqual([nobody.identifier]);

    const owned = await workItemsService.listReady(
      fx.projectId,
      { assigneeId: fx.ownerId },
      fx.ctx,
    );
    expect(keys(owned.items)).toEqual([mine.identifier]);
  });

  it('priority filter returns only the requested tones', async () => {
    const fx = await makeWorkItemFixture();
    const hi = await make(fx, { title: 'hi', priority: 'high' });
    const top = await make(fx, { title: 'top', priority: 'highest' });
    await make(fx, { title: 'lo', priority: 'low' });
    const { items } = await workItemsService.listReady(
      fx.projectId,
      { priority: ['high', 'highest'] },
      fx.ctx,
    );
    expect(keys(items).sort()).toEqual([hi.identifier, top.identifier].sort());
  });

  it('resolves the assignee name + avatar on the row DTO', async () => {
    const fx = await makeWorkItemFixture();
    await make(fx, { title: 'assigned', assigneeId: fx.ownerId });
    const { items } = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
    expect(items[0]?.assignee).toMatchObject({ id: fx.ownerId, name: fx.owner.name });
  });

  it('cursor round-trips deterministically and reaches the same tail twice', async () => {
    const fx = await makeWorkItemFixture();
    const created: string[] = [];
    for (let i = 0; i < 5; i++) created.push((await make(fx, { title: `n${i}` })).identifier);
    // All same (default medium) priority → order is key asc = creation order.

    const walk = async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await workItemsService.listReady(fx.projectId, { limit: 2, cursor }, fx.ctx);
        seen.push(...keys(page.items));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return seen;
    };

    const first = await walk();
    const second = await walk();
    expect(first).toEqual(created);
    expect(second).toEqual(created);
    expect(first.at(-1)).toBe(created.at(-1));
  });

  it('a valid cursor past the tail returns an empty page', async () => {
    const fx = await makeWorkItemFixture();
    await make(fx, { title: 'only', priority: 'high' });
    // Past the tail under (type ASC, priority DESC, key ASC): the last type rank
    // (epic), lowest priority, and a huge key — nothing sorts after it.
    const pastEnd = encodeReadyCursor({ kind: 'epic', priority: 'lowest', key: 9_999_999 });
    const { items, nextCursor } = await workItemsService.listReady(
      fx.projectId,
      { cursor: pastEnd },
      fx.ctx,
    );
    expect(items).toEqual([]);
    expect(nextCursor).toBeNull();
  });

  it('a malformed cursor throws InvalidReadyCursorError', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      workItemsService.listReady(fx.projectId, { cursor: 'not-a-cursor!!' }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidReadyCursorError);
  });

  it('limit is clamped to READY_MAX_LIMIT (no error on an over-cap request)', async () => {
    const fx = await makeWorkItemFixture();
    await make(fx, { title: 'a' });
    const { items } = await workItemsService.listReady(
      fx.projectId,
      { limit: READY_MAX_LIMIT + 500 },
      fx.ctx,
    );
    expect(items.length).toBeLessThanOrEqual(READY_MAX_LIMIT);
    expect(items.length).toBe(1);
  });

  it('a cross-workspace project id throws ProjectNotFoundError (no existence leak)', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    await expect(workItemsService.listReady(other.projectId, {}, fx.ctx)).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
  });
});

describe('listReady — type-primary sort (type → priority → key, Subtask 7.0.12)', () => {
  // Sort is (type ASC, priority DESC, key ASC). Type is PRIMARY in dispatch
  // order subtask < bug < task < story < epic; priority breaks the type tie
  // (highest first, within a type bucket); key is the final tiebreaker.
  // (Containers are already excluded by 7.0.10.)
  const mk = (
    fx: WorkItemFixture,
    kind: 'epic' | 'story' | 'task' | 'bug' | 'subtask',
    title: string,
    opts: { parentId?: string; priority?: Priority } = {},
  ) =>
    workItemsService.createWorkItem(
      { projectId: fx.projectId, kind, title, parentId: opts.parentId, priority: opts.priority },
      fx.ctx,
    );

  it('type leads in dispatch order: bug < task < story < epic', async () => {
    const fx = await makeWorkItemFixture();
    // Same (default medium) priority, all childless roots → only type orders them.
    // Insert out of rank order to prove the sort, not creation order, decides.
    const epic = await mk(fx, 'epic', 'E');
    const story = await mk(fx, 'story', 'S');
    const bug = await mk(fx, 'bug', 'B');
    const task = await mk(fx, 'task', 'T');

    const { items } = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
    expect(keys(items)).toEqual([
      bug.identifier,
      task.identifier,
      story.identifier,
      epic.identifier,
    ]);
  });

  it('subtask sorts ahead of other types at the same priority', async () => {
    const fx = await makeWorkItemFixture();
    const container = await mk(fx, 'task', 'Container'); // gains a child → excluded
    const sub = await mk(fx, 'subtask', 'Sub', { parentId: container.id });
    const bug = await mk(fx, 'bug', 'Bug'); // standalone leaf

    const { items } = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
    // Container excluded (7.0.10); subtask (rank 0) precedes bug (rank 1).
    expect(keys(items)).toEqual([sub.identifier, bug.identifier]);
  });

  it('type now outranks priority: a lowest subtask precedes a highest epic', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await mk(fx, 'epic', 'Epic', { priority: 'highest' }); // root leaf
    const container = await mk(fx, 'task', 'Container'); // excluded
    const sub = await mk(fx, 'subtask', 'Sub', { parentId: container.id, priority: 'lowest' });

    const { items } = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
    // Type is primary (7.0.12, reversing 7.0.11): the subtask (rank 0) precedes
    // the epic (rank 4) even though the epic is the higher priority.
    expect(keys(items)).toEqual([sub.identifier, epic.identifier]);
  });

  it('priority orders within a type bucket (highest first)', async () => {
    const fx = await makeWorkItemFixture();
    // All the same type (bug) → priority is the active discriminant; highest
    // first, key breaks the highest/highest tie. Insert out of priority order.
    const low = await mk(fx, 'bug', 'low', { priority: 'low' });
    const top1 = await mk(fx, 'bug', 'top1', { priority: 'highest' });
    const mid = await mk(fx, 'bug', 'mid', { priority: 'medium' });
    const top2 = await mk(fx, 'bug', 'top2', { priority: 'highest' });

    const { items } = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
    expect(keys(items)).toEqual([top1.identifier, top2.identifier, mid.identifier, low.identifier]);
  });

  it('subtask-first holds across priorities: a lowest subtask precedes a highest task', async () => {
    const fx = await makeWorkItemFixture();
    const container = await mk(fx, 'task', 'Container'); // excluded (gains a child)
    const sub = await mk(fx, 'subtask', 'Sub', { parentId: container.id, priority: 'lowest' });
    const task = await mk(fx, 'task', 'Task', { priority: 'highest' }); // standalone leaf

    const { items } = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
    // Type bucket wins outright: every subtask precedes every task regardless of
    // priority. (Within each bucket priority would order — but the buckets don't
    // interleave.)
    expect(keys(items)).toEqual([sub.identifier, task.identifier]);
  });

  it('the cursor pages across a type boundary deterministically (3-tuple seek-after)', async () => {
    const fx = await makeWorkItemFixture();
    // Same priority, mixed kinds → the type rank is the discriminator the cursor
    // must carry to page correctly across the kind boundary.
    const epic = await mk(fx, 'epic', 'E');
    const story = await mk(fx, 'story', 'S');
    const bug = await mk(fx, 'bug', 'B');
    const task = await mk(fx, 'task', 'T');
    const expected = [bug.identifier, task.identifier, story.identifier, epic.identifier];

    const single = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
    expect(keys(single.items)).toEqual(expected);

    const walked: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await workItemsService.listReady(fx.projectId, { limit: 2, cursor }, fx.ctx);
      walked.push(...keys(page.items));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(walked).toEqual(expected);
  });

  it('the cursor pages across a priority boundary within a type deterministically', async () => {
    const fx = await makeWorkItemFixture();
    // One type (task), four priorities → the cursor must carry priority to page
    // across the priority boundary within the single type bucket.
    const top = await mk(fx, 'task', 'top', { priority: 'highest' });
    const high = await mk(fx, 'task', 'high', { priority: 'high' });
    const mid = await mk(fx, 'task', 'mid', { priority: 'medium' });
    const low = await mk(fx, 'task', 'low', { priority: 'low' });
    const expected = [top.identifier, high.identifier, mid.identifier, low.identifier];

    const single = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
    expect(keys(single.items)).toEqual(expected);

    const walked: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await workItemsService.listReady(fx.projectId, { limit: 2, cursor }, fx.ctx);
      walked.push(...keys(page.items));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(walked).toEqual(expected);
  });
});

describe('getNextReady — single dispatch', () => {
  it('returns the first ready item under the sort; excludeIds walks the set; exhaust → null', async () => {
    const fx = await makeWorkItemFixture();
    const top = await make(fx, { title: 'top', priority: 'highest' });
    const mid = await make(fx, { title: 'mid', priority: 'medium' });
    const low = await make(fx, { title: 'low', priority: 'low' });

    const first = await workItemsService.getNextReady(fx.projectId, {}, fx.ctx);
    expect(first?.key).toBe(top.identifier);

    const second = await workItemsService.getNextReady(
      fx.projectId,
      { excludeIds: [top.id] },
      fx.ctx,
    );
    expect(second?.key).toBe(mid.identifier);

    const third = await workItemsService.getNextReady(
      fx.projectId,
      { excludeIds: [top.id, mid.id] },
      fx.ctx,
    );
    expect(third?.key).toBe(low.identifier);

    const none = await workItemsService.getNextReady(
      fx.projectId,
      { excludeIds: [top.id, mid.id, low.id] },
      fx.ctx,
    );
    expect(none).toBeNull();
  });

  it('the dispatch DTO carries the full body, parsed context refs, resolved blocker keys, parent key, run command', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Parent story' },
      fx.ctx,
    );
    const descriptionMd = [
      'Do the thing.',
      '',
      '## Acceptance criteria',
      '',
      '- it works',
      '',
      '## Context refs',
      '',
      '- `lib/services/workItemsService.ts` — the service to extend',
      '- `prisma/schema.prisma` — the enum order',
    ].join('\n');
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Child task',
        parentId: parent.id,
        descriptionMd,
      },
      fx.ctx,
    );
    const blocker = await make(fx, { title: 'gate' });
    await block(fx, item.id, blocker.id);
    await db.workItem.update({ where: { id: blocker.id }, data: { status: 'done' } });

    const dto = await workItemsService.getNextReady(
      fx.projectId,
      { excludeIds: [parent.id] },
      fx.ctx,
    );
    expect(dto).not.toBeNull();
    expect(dto?.key).toBe(item.identifier);
    expect(dto?.descriptionMd).toBe(descriptionMd);
    expect(dto?.contextRefs).toEqual(['lib/services/workItemsService.ts', 'prisma/schema.prisma']);
    expect(dto?.blockerKeys).toEqual([blocker.identifier]);
    expect(dto?.parentKey).toBe(parent.identifier);
    expect(dto?.runCommand).toBe(`prodect run ${item.identifier}`);
    expect(dto?.runCommand).toMatch(/^prodect run PROD-\d+$/);
  });

  it('an item with no blockers and no parent dispatches with empty refs/blockers and null parent', async () => {
    const fx = await makeWorkItemFixture();
    const item = await make(fx, { title: 'plain', descriptionMd: 'Just a plain body.' });
    const dto = await workItemsService.getNextReady(fx.projectId, {}, fx.ctx);
    expect(dto?.key).toBe(item.identifier);
    expect(dto?.contextRefs).toEqual([]);
    expect(dto?.blockerKeys).toEqual([]);
    expect(dto?.parentKey).toBeNull();
  });
});

describe('listReady — leaf-only (a container is not dispatchable, Subtask 7.0.10)', () => {
  // Decision (card's open decision, decision-ladder rung 1): the GENERAL reading —
  // ANY work item with ≥1 live child is a container, excluded from the ready set;
  // the ready set is the dispatchable LEAVES of the execution tree. The reported
  // rule named epic/story, but the kind-parent matrix (finding #41) lets a task/bug
  // parent children too, so a childed task/bug is a container as well.
  const create = (
    fx: WorkItemFixture,
    kind: 'epic' | 'story' | 'task' | 'bug' | 'subtask',
    title: string,
    opts: { parentId?: string; priority?: Priority } = {},
  ) =>
    workItemsService.createWorkItem(
      { projectId: fx.projectId, kind, title, parentId: opts.parentId, priority: opts.priority },
      fx.ctx,
    );

  it('an epic/story WITH a child is excluded; the child (a leaf) stays ready', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await create(fx, 'epic', 'Epic');
    const story = await create(fx, 'story', 'Story', { parentId: epic.id });

    const { items } = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
    // epic has a child (the story) → container → excluded; story is a leaf → ready.
    expect(keys(items)).toContain(story.identifier);
    expect(keys(items)).not.toContain(epic.identifier);
  });

  it('a childless epic/story is ready; once it gains a child it drops out, and archiving that child brings it back', async () => {
    const fx = await makeWorkItemFixture();
    const story = await create(fx, 'story', 'Story');

    // No children yet → the story is an un-decomposed leaf → ready.
    let res = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
    expect(keys(res.items)).toContain(story.identifier);

    // Break it down → it becomes a container → excluded; the child is ready.
    const child = await create(fx, 'task', 'Child task', { parentId: story.id });
    res = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
    expect(keys(res.items)).not.toContain(story.identifier);
    expect(keys(res.items)).toContain(child.identifier);

    // Archive the only child (soft-delete) → no LIVE children → leaf again → ready.
    await db.workItem.update({ where: { id: child.id }, data: { archivedAt: new Date() } });
    res = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
    expect(keys(res.items)).toContain(story.identifier);
    expect(keys(res.items)).not.toContain(child.identifier); // archived → gone
  });

  it('GENERAL rule: a task with a child (bug) is also excluded — not epic/story-only', async () => {
    const fx = await makeWorkItemFixture();
    const task = await create(fx, 'task', 'Parent task');
    const bug = await create(fx, 'bug', 'Child bug', { parentId: task.id });

    const { items } = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
    expect(keys(items)).not.toContain(task.identifier);
    expect(keys(items)).toContain(bug.identifier);
  });

  it('countReady matches the list when containers are present (single predicate, no disagreement)', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await create(fx, 'epic', 'Epic');
    await create(fx, 'story', 'Story under epic', { parentId: epic.id }); // a leaf
    await create(fx, 'task', 'Standalone task'); // a leaf

    const { items } = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
    const { count } = await workItemsService.countReady(fx.projectId, {}, fx.ctx);
    // Ready = the story leaf + the standalone task; the epic container is excluded.
    expect(items.length).toBe(2);
    expect(keys(items)).not.toContain(epic.identifier);
    expect(count).toBe(items.length);
  });

  it('getNextReady never dispatches a container, even when it sorts first', async () => {
    const fx = await makeWorkItemFixture();
    // Story sorts ABOVE the task (highest > medium), but it is a container → skipped.
    const story = await create(fx, 'story', 'High container', { priority: 'highest' });
    const child = await create(fx, 'task', 'Low leaf', {
      parentId: story.id,
      priority: 'medium',
    });

    const dto = await workItemsService.getNextReady(fx.projectId, {}, fx.ctx);
    expect(dto?.key).toBe(child.identifier);
    expect(dto?.key).not.toBe(story.identifier);
  });
});

describe('extractContextRefs (pure)', () => {
  it('reads the Context refs bullets (backtick path or plain text); ignores other sections', () => {
    expect(extractContextRefs(null)).toEqual([]);
    expect(extractContextRefs('No refs here.')).toEqual([]);
    const md = [
      'Body.',
      '## Context refs',
      '- `path/one.ts` — the first',
      '- plain ref two — trailing prose',
      '## Next section',
      '- `path/three.ts` should NOT be picked up',
    ].join('\n');
    expect(extractContextRefs(md)).toEqual(['path/one.ts', 'plain ref two']);
  });
});
