import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import {
  makeWorkItemFixture as makeFixture,
  createTestWorkItem as createWorkItem,
  type WorkItemFixture,
} from '../../fixtures';

// A LEVEL NAMED BY ITS MEMBERS (Story MOTIR-1789 · MOTIR-3895).
//
// A dispatch run's set is not one parent's children — `motir batch` and
// `motir auto` take whatever was ready, across parents — so the run surface asks
// the roadmap read for exactly its members. This file holds the properties that
// make that safe to expose: it is the SAME level in every other respect (the
// tenant gate, the archived/triage exclusions, the edges among the set), an
// empty set is answered rather than queried, and no id can widen the read.
//
// Real Postgres, no mocks (CLAUDE.md).

let fx: WorkItemFixture;

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Two subtasks under DIFFERENT stories — the shape a batch run produces. */
async function acrossParents() {
  const epic = await createWorkItem(fx, { kind: 'epic', title: 'Epic' });
  const a = await createWorkItem(fx, { kind: 'story', title: 'Story A', parentId: epic.id });
  const b = await createWorkItem(fx, { kind: 'story', title: 'Story B', parentId: epic.id });
  const a1 = await createWorkItem(fx, { kind: 'subtask', title: 'A1', parentId: a.id });
  const b1 = await createWorkItem(fx, { kind: 'subtask', title: 'B1', parentId: b.id });
  return { epic, a, b, a1, b1 };
}

describe('a level named by its MEMBERS', () => {
  it('returns exactly the ids asked for, across different parents', async () => {
    const { a1, b1 } = await acrossParents();

    const level = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      ids: [a1.id, b1.id],
    });

    expect(level.nodes.map((n) => n.id).sort()).toEqual([a1.id, b1.id].sort());
    // The parent read is REPLACED, not filtered: neither story nor the epic
    // comes back, though they are what `parentId: null` would have returned.
    expect(level.nodes.some((n) => n.kind === 'epic')).toBe(false);
  });

  it('carries the EDGES between two members, which is what the running edge needs', async () => {
    const { a1, b1 } = await acrossParents();
    await workItemsService.linkWorkItems(
      { fromId: b1.id, toId: a1.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    const level = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      ids: [a1.id, b1.id],
    });

    expect(level.edges).toEqual([{ blockedId: b1.id, blockerId: a1.id }]);
  });

  it('carries each node’s own status and its drill flag, like any other level', async () => {
    const { a, a1 } = await acrossParents();

    const level = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      ids: [a.id, a1.id],
    });

    const story = level.nodes.find((n) => n.id === a.id)!;
    const leaf = level.nodes.find((n) => n.id === a1.id)!;
    expect(story.hasChildren).toBe(true);
    expect(leaf.hasChildren).toBe(false);
    expect(story.status).toBeTruthy();
  });

  it('⚠️ an EMPTY set is ANSWERED, never queried — `IN ()` is not valid SQL', async () => {
    await acrossParents();

    const level = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      ids: [],
    });

    expect(level).toEqual({ nodes: [], edges: [], offLevelBlockers: [], levelTotal: 0 });
  });

  it('an id from ANOTHER project simply does not come back', async () => {
    const { a1 } = await acrossParents();
    const other = await makeFixture({ name: 'Other', identifier: 'OTHR' });
    const theirs = await createWorkItem(other, { kind: 'story', title: 'Theirs' });

    const level = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      ids: [a1.id, theirs.id],
    });

    expect(level.nodes.map((n) => n.id)).toEqual([a1.id]);
  });

  it('an ARCHIVED member is excluded, exactly as it is from a parent level', async () => {
    const { a1, b1 } = await acrossParents();
    await adminDb.workItem.update({ where: { id: b1.id }, data: { archivedAt: new Date() } });

    const level = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      ids: [a1.id, b1.id],
    });

    expect(level.nodes.map((n) => n.id)).toEqual([a1.id]);
  });

  it('the level TOTAL counts the same set the read returned', async () => {
    const { a1, b1 } = await acrossParents();

    const level = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {
      ids: [a1.id, b1.id],
    });

    expect(level.levelTotal).toBe(2);
  });

  it('omitting `ids` leaves the parent read byte-for-byte what it was', async () => {
    const { epic } = await acrossParents();

    const roots = await workItemsService.getProjectRoadmap(fx.projectId, null, fx.ctx, {});
    expect(roots.nodes.map((n) => n.id)).toEqual([epic.id]);
  });
});
