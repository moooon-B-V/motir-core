import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { truncateAuthTables } from '../../helpers/db';
import {
  makeWorkItemFixture as makeFixture,
  createTestWorkItem as createWorkItem,
  createTestLink,
} from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';

// READY-to-start flag on the roadmap read (MOTIR-1417). A node is `ready` iff it is
// in a startable (`todo`-category) status AND every item it is `blocked_by` is done
// — the shipped own-blocker readiness (`list_ready`). A done / in-progress node, or
// a to-do with an open blocker, is NOT ready. Real Postgres, no mocks (Yue's rule).

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

async function setStatus(id: string, status: string): Promise<void> {
  await db.workItem.update({ where: { id }, data: { status } });
}
async function link(fx: WorkItemFixture, blockedId: string, blockerId: string): Promise<void> {
  await createTestLink({
    workspaceId: fx.workspaceId,
    fromId: blockedId,
    toId: blockerId,
    kind: 'is_blocked_by',
    createdById: fx.ownerId,
  });
}

describe('getProjectRoadmap — ready-to-start flag (MOTIR-1417)', () => {
  it('marks startable, fully-unblocked nodes ready; done / in-progress / open-blocked are not', async () => {
    const fx = await makeFixture();
    const story = await createWorkItem(fx, { kind: 'story', title: 'Story' });
    // children of the story = the queried level.
    const aDoneBlocker = await createWorkItem(fx, {
      kind: 'subtask',
      title: 'a',
      parentId: story.id,
    });
    const cOpenBlocker = await createWorkItem(fx, {
      kind: 'subtask',
      title: 'c',
      parentId: story.id,
    });
    const gNoBlockers = await createWorkItem(fx, {
      kind: 'subtask',
      title: 'g',
      parentId: story.id,
    });
    const eDone = await createWorkItem(fx, { kind: 'subtask', title: 'e', parentId: story.id });
    const fInProgress = await createWorkItem(fx, {
      kind: 'subtask',
      title: 'f',
      parentId: story.id,
    });

    // blockers live off the queried level (under a second story).
    const other = await createWorkItem(fx, { kind: 'story', title: 'Other' });
    const bDone = await createWorkItem(fx, { kind: 'subtask', title: 'b', parentId: other.id });
    const dTodo = await createWorkItem(fx, { kind: 'subtask', title: 'd', parentId: other.id });
    // createTestWorkItem uses the raw DB default ("open"); the real createWorkItem
    // assigns the workflow's initial `todo`. Set the startable items to `todo` so
    // they have a real `todo`-category status (as a production node would).
    await setStatus(aDoneBlocker.id, 'todo');
    await setStatus(cOpenBlocker.id, 'todo');
    await setStatus(gNoBlockers.id, 'todo');
    await setStatus(dTodo.id, 'todo');
    await setStatus(bDone.id, 'done');
    await link(fx, aDoneBlocker.id, bDone.id); // a blocked_by b(done) → ready
    await link(fx, cOpenBlocker.id, dTodo.id); // c blocked_by d(todo, open) → NOT ready
    await setStatus(eDone.id, 'done');
    await setStatus(fInProgress.id, 'in_progress');

    const roadmap = await workItemsService.getProjectRoadmap(fx.projectId, story.id, fx.ctx);
    const readyById = new Map(roadmap.nodes.map((n) => [n.id, n.ready]));
    expect(readyById.get(aDoneBlocker.id)).toBe(true); // all blockers done
    expect(readyById.get(gNoBlockers.id)).toBe(true); // no blockers → trivially ready
    expect(readyById.get(cOpenBlocker.id)).toBe(false); // an open blocker
    expect(readyById.get(eDone.id)).toBe(false); // done → not startable
    expect(readyById.get(fInProgress.id)).toBe(false); // started → not startable
  });

  it('a child under a BLOCKED ancestor is NOT ready, even with no own blockers (cascade, MOTIR-1563)', async () => {
    const fx = await makeFixture();
    // A parent STORY held out of the ready set by its OWN open blocker.
    const parent = await createWorkItem(fx, { kind: 'story', title: 'Parent' });
    const parentBlocker = await createWorkItem(fx, { kind: 'story', title: 'Parent blocker' });
    await setStatus(parentBlocker.id, 'todo'); // open (not done) → parent not ready
    await link(fx, parent.id, parentBlocker.id);
    // A childless todo child with NO own blockers — own-ready, but its ancestor is blocked.
    const child = await createWorkItem(fx, {
      kind: 'subtask',
      title: 'child',
      parentId: parent.id,
    });
    await setStatus(child.id, 'todo');

    // Drill INTO the blocked parent: the child must NOT be ready (the ancestor
    // cascade holds it out, matching list_ready / getReadiness). The pre-fix
    // own-blocker-only path returned ready:true here.
    const drilled = await workItemsService.getProjectRoadmap(fx.projectId, parent.id, fx.ctx);
    expect(drilled.nodes.find((n) => n.id === child.id)!.ready).toBe(false);

    // Once the parent's blocker is done, the parent is ready → the child is too.
    await setStatus(parentBlocker.id, 'done');
    const after = await workItemsService.getProjectRoadmap(fx.projectId, parent.id, fx.ctx);
    expect(after.nodes.find((n) => n.id === child.id)!.ready).toBe(true);
  });

  it('a node becomes ready once its last open blocker is marked done', async () => {
    const fx = await makeFixture();
    const story = await createWorkItem(fx, { kind: 'story', title: 'Story' });
    const item = await createWorkItem(fx, { kind: 'subtask', title: 'item', parentId: story.id });
    const other = await createWorkItem(fx, { kind: 'story', title: 'Other' });
    const blocker = await createWorkItem(fx, { kind: 'subtask', title: 'blk', parentId: other.id });
    await setStatus(item.id, 'todo'); // a real startable status (vs the raw "open" default)
    await link(fx, item.id, blocker.id);

    const before = await workItemsService.getProjectRoadmap(fx.projectId, story.id, fx.ctx);
    expect(before.nodes.find((n) => n.id === item.id)!.ready).toBe(false);

    await setStatus(blocker.id, 'done');
    const after = await workItemsService.getProjectRoadmap(fx.projectId, story.id, fx.ctx);
    expect(after.nodes.find((n) => n.id === item.id)!.ready).toBe(true);
  });
});
