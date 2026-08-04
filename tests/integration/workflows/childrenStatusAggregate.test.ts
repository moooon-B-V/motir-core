import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures/workItemFixtures';
import { truncateAuthTables } from '../../helpers/db';

// `workItemRepository.aggregateChildrenStatus` — the data primitive the upward
// status rollup evaluates its ladder against (Story MOTIR-1615 · Subtask
// MOTIR-1619). Real Postgres, no mocks (CLAUDE.md).
//
// What these lock:
//   * DIRECT children only — a grandchild must never be counted, or the ladder
//     would fire on work that belongs to a different parent;
//   * the buckets come from the project's own `workflow_status.category` join, so
//     a RENAMED / added status still aggregates correctly;
//   * `inReview` is split out of the `in_progress` category by the caller-supplied
//     review key, and `inProgress` excludes it — the two partition the category;
//   * archived and triage children are excluded, the uniform child-read rule;
//   * a childless parent aggregates to all-zero (NOT vacuously "all done").

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Move a work item straight to a status, bypassing the workflow — these tests
 *  exercise the AGGREGATE, not the transition graph. */
async function setStatus(id: string, status: string): Promise<void> {
  await db.workItem.update({ where: { id }, data: { status } });
}

/** A child in an explicit status. The status is ALWAYS set, never left to the
 *  column default: `createTestWorkItem` writes through the repository, which
 *  skips the service's initial-status lookup, so the row would land on the legacy
 *  `work_item.status @default("open")` — a key no `workflow_status` row carries,
 *  which the aggregate's join would then (correctly) drop. Real rows can't reach
 *  that state (the service seeds the workflow's initial status, and a status
 *  in use cannot be deleted), so pinning the status here keeps the fixture honest
 *  rather than papering over the join. */
async function child(fx: WorkItemFixture, parentId: string, title: string, status = 'todo') {
  const item = await createTestWorkItem(fx, { kind: 'subtask', title, parentId });
  await setStatus(item.id, status);
  return item;
}

async function storyIn(fx: WorkItemFixture, title: string) {
  return createTestWorkItem(fx, { kind: 'story', title });
}

describe('aggregateChildrenStatus (MOTIR-1619)', () => {
  it('a parent with NO children aggregates to all-zero, not to "all done"', async () => {
    const fx = await makeWorkItemFixture();
    const story = await storyIn(fx, 'Lonely');

    expect(await workItemRepository.aggregateChildrenStatus(story.id, 'in_review')).toEqual({
      total: 0,
      todo: 0,
      inProgress: 0,
      inReview: 0,
      done: 0,
    });
  });

  it('buckets mixed statuses by CATEGORY, splitting in_review out of in_progress', async () => {
    const fx = await makeWorkItemFixture();
    const story = await storyIn(fx, 'Mixed');
    await child(fx, story.id, 'a', 'todo');
    await child(fx, story.id, 'b', 'blocked'); // todo category
    await child(fx, story.id, 'c', 'in_progress');
    await child(fx, story.id, 'd', 'in_review'); // in_progress category, split out
    await child(fx, story.id, 'e', 'done');
    await child(fx, story.id, 'f', 'cancelled'); // done category

    expect(await workItemRepository.aggregateChildrenStatus(story.id, 'in_review')).toEqual({
      total: 6,
      todo: 2,
      inProgress: 1,
      inReview: 1,
      done: 2,
    });
  });

  it('all children done ⇒ done === total (the ladder’s top rung)', async () => {
    const fx = await makeWorkItemFixture();
    const story = await storyIn(fx, 'Finished');
    await child(fx, story.id, 'a', 'done');
    await child(fx, story.id, 'b', 'cancelled');

    const agg = await workItemRepository.aggregateChildrenStatus(story.id, 'in_review');
    expect(agg.total).toBe(2);
    expect(agg.done).toBe(2);
  });

  it('counts DIRECT children only — a grandchild belongs to its own parent', async () => {
    const fx = await makeWorkItemFixture();
    const story = await storyIn(fx, 'Deep');
    const task = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'mid',
      parentId: story.id,
    });
    await setStatus(task.id, 'in_progress');
    // Two levels down — must NOT appear in the story's aggregate.
    await child(fx, task.id, 'leaf', 'done');

    expect(await workItemRepository.aggregateChildrenStatus(story.id, 'in_review')).toEqual({
      total: 1,
      todo: 0,
      inProgress: 1,
      inReview: 0,
      done: 0,
    });
    // …and the task's own aggregate sees exactly that grandchild.
    expect(await workItemRepository.aggregateChildrenStatus(task.id, 'in_review')).toMatchObject({
      total: 1,
      done: 1,
    });
  });

  it('excludes ARCHIVED and TRIAGE children', async () => {
    const fx = await makeWorkItemFixture();
    const story = await storyIn(fx, 'With noise');
    await child(fx, story.id, 'live', 'done');
    const archived = await child(fx, story.id, 'archived', 'todo');
    const triaged = await child(fx, story.id, 'triaged', 'todo');
    await db.workItem.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
    await db.workItem.update({ where: { id: triaged.id }, data: { triagedAt: new Date() } });

    // An archived child must not hold its parent back from rolling up — so the
    // aggregate reads "one child, done", not "three children, one done".
    expect(await workItemRepository.aggregateChildrenStatus(story.id, 'in_review')).toEqual({
      total: 1,
      todo: 0,
      inProgress: 0,
      inReview: 0,
      done: 1,
    });
  });

  it('follows a RENAMED workflow: the category join and the supplied review key both adapt', async () => {
    const fx = await makeWorkItemFixture();
    // A team that added its own review-ish status in the in_progress category.
    await db.workflowStatus.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'qa',
        label: 'QA',
        category: 'in_progress',
        position: 'z0',
      },
    });
    const story = await storyIn(fx, 'Custom workflow');
    await child(fx, story.id, 'a', 'qa');
    await child(fx, story.id, 'b', 'in_progress');

    // Told that `qa` is this project's review stage, the aggregate splits it out…
    expect(await workItemRepository.aggregateChildrenStatus(story.id, 'qa')).toEqual({
      total: 2,
      todo: 0,
      inProgress: 1,
      inReview: 1,
      done: 0,
    });
    // …and with NO review status declared, both count as plain in-progress (the
    // degenerate reading: that project simply never reaches the in-review rung).
    expect(await workItemRepository.aggregateChildrenStatus(story.id, null)).toEqual({
      total: 2,
      todo: 0,
      inProgress: 2,
      inReview: 0,
      done: 0,
    });
  });
});
