import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { NotProjectAdminError } from '@/lib/projects/errors';
import { truncateAuthTables } from '../../helpers/db';
import {
  makeWorkItemFixture,
  createTestUser,
  createTestWorkItem,
  createTestLink,
} from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';

// Service-layer integration tests for workItemsService.deleteWorkItem (Story 2.8
// · Subtask 2.8.2) against a REAL Postgres (Yue's no-mocks rule). Permanent,
// irreversible delete with subtree cascade: it removes the item + ALL its
// descendants + their links in one transaction, is permission-gated to the
// project-admin "manage" capability, audits the deletion on the surviving
// parent, and translates the already-deleted / cross-workspace races to a typed
// WorkItemNotFoundError.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item_revision", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

/**
 * Build a valid 3-level tree: epic → story → [subtask1, subtask2], plus a
 * sibling story2 under the same epic. Returns the ids so a test can delete a
 * mid-level node and assert the cut.
 */
async function makeTree(fx: WorkItemFixture) {
  const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Epic' });
  const story = await createTestWorkItem(fx, { kind: 'story', title: 'Story', parentId: epic.id });
  const sub1 = await createTestWorkItem(fx, {
    kind: 'subtask',
    title: 'Sub 1',
    parentId: story.id,
  });
  const sub2 = await createTestWorkItem(fx, {
    kind: 'subtask',
    title: 'Sub 2',
    parentId: story.id,
  });
  const story2 = await createTestWorkItem(fx, {
    kind: 'story',
    title: 'Story 2',
    parentId: epic.id,
  });
  return { epic, story, sub1, sub2, story2 };
}

async function exists(id: string): Promise<boolean> {
  return (await workItemRepository.findById(id)) !== null;
}

describe('deleteWorkItem — subtree cascade', () => {
  it('permanently removes the node and its WHOLE subtree, leaving siblings + ancestors intact', async () => {
    const fx = await makeWorkItemFixture();
    const { epic, story, sub1, sub2, story2 } = await makeTree(fx);

    await workItemsService.deleteWorkItem(story.id, fx.ctx);

    // The deleted root + every descendant are gone…
    expect(await exists(story.id)).toBe(false);
    expect(await exists(sub1.id)).toBe(false);
    expect(await exists(sub2.id)).toBe(false);
    // …while the parent and the sibling subtree survive.
    expect(await exists(epic.id)).toBe(true);
    expect(await exists(story2.id)).toBe(true);
  });

  it('deletes a top-level root (epic) with its entire tree in one statement', async () => {
    const fx = await makeWorkItemFixture();
    const { epic, story, sub1, sub2, story2 } = await makeTree(fx);

    await workItemsService.deleteWorkItem(epic.id, fx.ctx);

    for (const id of [epic.id, story.id, sub1.id, sub2.id, story2.id]) {
      expect(await exists(id)).toBe(false);
    }
  });

  it('removes all links touching a deleted item (from + reciprocal), leaving the outside endpoint', async () => {
    const fx = await makeWorkItemFixture();
    const { story, sub1 } = await makeTree(fx);
    // An OUTSIDE item the deleted subtree links to (both directions).
    const outside = await createTestWorkItem(fx, { kind: 'task', title: 'Outside' });
    await createTestLink({
      workspaceId: fx.workspaceId,
      fromId: sub1.id,
      toId: outside.id,
      kind: 'is_blocked_by',
      createdById: fx.ownerId,
    });
    await createTestLink({
      workspaceId: fx.workspaceId,
      fromId: outside.id,
      toId: story.id,
      kind: 'relates_to',
      createdById: fx.ownerId,
    });

    await workItemsService.deleteWorkItem(story.id, fx.ctx);

    // No orphaned links survive on the outside endpoint; the endpoint itself lives.
    expect(await workItemLinkRepository.findByFromItem(outside.id)).toHaveLength(0);
    expect(await workItemLinkRepository.findByToItem(outside.id)).toHaveLength(0);
    expect(await exists(outside.id)).toBe(true);
  });
});

describe('deleteSubtree (repository) — empty input', () => {
  it('short-circuits an empty id set to 0 with no DELETE issued', async () => {
    const count = await db.$transaction((tx) => workItemRepository.deleteSubtree([], tx));
    expect(count).toBe(0);
  });
});

describe('deleteWorkItem — audit', () => {
  it('records a `deleted` revision on the SURVIVING parent', async () => {
    const fx = await makeWorkItemFixture();
    const { epic, story, sub1, sub2 } = await makeTree(fx);

    await workItemsService.deleteWorkItem(story.id, fx.ctx);

    const revs = await workItemRevisionRepository.listByWorkItem(epic.id);
    const del = revs.find((r) => r.changeKind === 'deleted');
    expect(del).toBeDefined();
    expect(del!.changedById).toBe(fx.ownerId);
    // The diff summarises the gone item + its descendant count (the rows are gone).
    const diff = del!.diff as { deleted?: { from?: string; to?: unknown } };
    expect(diff.deleted?.to).toBeNull();
    expect(diff.deleted?.from).toContain(story.identifier);
    expect(diff.deleted?.from).toContain('descendant'); // sub1 + sub2

    void [sub1, sub2];
  });

  it('summarises a leaf delete (0 descendants) without a descendant count', async () => {
    const fx = await makeWorkItemFixture();
    const { story, sub1 } = await makeTree(fx);
    // sub2 still under story, so deleting sub1 (a leaf) removes only itself.

    await workItemsService.deleteWorkItem(sub1.id, fx.ctx);

    const del = (await workItemRevisionRepository.listByWorkItem(story.id)).find(
      (r) => r.changeKind === 'deleted',
    );
    expect(del).toBeDefined();
    const from = (del!.diff as { deleted: { from: string } }).deleted.from;
    expect(from).toContain(sub1.identifier);
    expect(from).not.toContain('descendant');
  });

  it('summarises a single-descendant delete with the singular noun', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'E' });
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'S', parentId: epic.id });
    const onlyChild = await createTestWorkItem(fx, {
      kind: 'subtask',
      title: 'Only',
      parentId: story.id,
    });

    await workItemsService.deleteWorkItem(story.id, fx.ctx);

    const del = (await workItemRevisionRepository.listByWorkItem(epic.id)).find(
      (r) => r.changeKind === 'deleted',
    );
    const from = (del!.diff as { deleted: { from: string } }).deleted.from;
    expect(from).toContain('+1 descendant');
    expect(from).not.toContain('descendants');
    expect(await exists(onlyChild.id)).toBe(false);
  });

  it('a root delete (no parent) succeeds with no anchor revision', async () => {
    const fx = await makeWorkItemFixture();
    const { epic } = await makeTree(fx);

    await expect(workItemsService.deleteWorkItem(epic.id, fx.ctx)).resolves.toBeUndefined();
    // Nothing survives to host a revision, and no stray `deleted` row leaks.
    const rows = await db.workItemRevision.count({ where: { changeKind: 'deleted' } });
    expect(rows).toBe(0);
  });
});

describe('deleteWorkItem — permission gate', () => {
  it('rejects a non-admin workspace member with NotProjectAdminError and deletes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { story, sub1 } = await makeTree(fx);
    const member = await createTestUser();
    await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
    const memberCtx = { userId: member.id, workspaceId: fx.workspaceId };

    await expect(workItemsService.deleteWorkItem(story.id, memberCtx)).rejects.toBeInstanceOf(
      NotProjectAdminError,
    );
    // The transaction rolled back — the subtree is untouched.
    expect(await exists(story.id)).toBe(true);
    expect(await exists(sub1.id)).toBe(true);
  });
});

describe('deleteWorkItem — races translate to typed errors', () => {
  it('throws WorkItemNotFoundError for a missing id (already-deleted / idempotent)', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      workItemsService.deleteWorkItem('cmqfmuslu000h04jp00000000', fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('throws WorkItemNotFoundError for a cross-workspace id (no existence leak)', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const item = await createTestWorkItem(other, { kind: 'task', title: 'Theirs' });

    await expect(workItemsService.deleteWorkItem(item.id, fx.ctx)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
    // The item in the other workspace is untouched.
    expect(await exists(item.id)).toBe(true);
  });
});

// The cascade-impact READ the 2.8.4 confirm dialog shows before the user
// commits (Subtask 2.8.7): the subtree size (the "Delete N items" magnitude),
// the descendant count, and the per-kind breakdown of the descendants. Same
// manage gate + tenant gate as deleteWorkItem; a pure read (deletes nothing).
describe('getDeletePreview — cascade impact', () => {
  it('counts the whole subtree with a per-kind descendant breakdown, deleting nothing', async () => {
    const fx = await makeWorkItemFixture();
    const { story, sub1, sub2 } = await makeTree(fx);

    const preview = await workItemsService.getDeletePreview(story.id, fx.ctx);

    // story (root) + sub1 + sub2 = 3 rows; 2 descendants, both subtasks.
    expect(preview).toEqual({ totalCount: 3, descendantCount: 2, byKind: { subtask: 2 } });
    // It's a READ — the subtree is untouched.
    expect(await exists(story.id)).toBe(true);
    expect(await exists(sub1.id)).toBe(true);
    expect(await exists(sub2.id)).toBe(true);
  });

  it('breaks the descendants down across kinds for a top-level root', async () => {
    const fx = await makeWorkItemFixture();
    const { epic } = await makeTree(fx);

    const preview = await workItemsService.getDeletePreview(epic.id, fx.ctx);

    // epic + story + sub1 + sub2 + story2 = 5 rows; descendants = 2 stories + 2 subtasks.
    expect(preview.totalCount).toBe(5);
    expect(preview.descendantCount).toBe(4);
    expect(preview.byKind).toEqual({ story: 2, subtask: 2 });
  });

  it('returns a leaf with zero descendants and an empty breakdown', async () => {
    const fx = await makeWorkItemFixture();
    const { sub1 } = await makeTree(fx);

    expect(await workItemsService.getDeletePreview(sub1.id, fx.ctx)).toEqual({
      totalCount: 1,
      descendantCount: 0,
      byKind: {},
    });
  });

  it('rejects a non-admin member with NotProjectAdminError (no impact-preview leak)', async () => {
    const fx = await makeWorkItemFixture();
    const { story } = await makeTree(fx);
    const member = await createTestUser();
    await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
    const memberCtx = { userId: member.id, workspaceId: fx.workspaceId };

    await expect(workItemsService.getDeletePreview(story.id, memberCtx)).rejects.toBeInstanceOf(
      NotProjectAdminError,
    );
  });

  it('throws WorkItemNotFoundError for a missing id', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      workItemsService.getDeletePreview('cmqfmuslu000h04jp00000000', fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('throws WorkItemNotFoundError for a cross-workspace id (no existence leak)', async () => {
    const fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const item = await createTestWorkItem(other, { kind: 'task', title: 'Theirs' });

    await expect(workItemsService.getDeletePreview(item.id, fx.ctx)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
  });
});
