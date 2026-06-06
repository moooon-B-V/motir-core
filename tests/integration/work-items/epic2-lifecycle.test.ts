import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkItemRevision } from '@prisma/client';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import {
  AssigneeNotInWorkspaceError,
  DepthLimitExceededError,
  IllegalTransitionError,
} from '@/lib/workItems/errors';
import type { WorkItemDto } from '@/lib/dto/workItems';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import { truncateAuthTables } from '../../helpers/db';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';

// Subtask 2.6.3 — the SINGLE cross-story Epic-2 lifecycle scenario.
//
// Every Epic-2 feature story shipped its own SLICE of integration coverage
// (kind-parent matrix · depth/cycle triggers · key allocation · transition
// validation · workflow management · CRUD/links/revisions · tree · list). What
// no individual 2.x test owns is the END-TO-END journey proving those slices
// COMPOSE: build a real tree, assign across membership, walk one item through a
// multi-hop status lifecycle, gate readiness on a blocker, archive a subtree,
// and read it all back through the tree + list surfaces. This file is that
// journey — an INTEGRATION scenario, not unit re-coverage. Everything runs
// through `workItemsService` against the REAL Postgres (Yue's no-mocks rule;
// the only sanctioned cross-layer reach is reading repositories to assert DB
// state — CLAUDE.md).
//
// ── A note on the tree shape (decision-authority ladder, rung 2) ────────────
// The 2.6.3 card describes the chain "epic → story (under it) → task (under the
// story) → bug (under the task) → subtask (under the bug)" — a FIVE-level deep
// chain. But the SHIPPED depth trigger (prisma/sql/work_item_triggers.sql ·
// enforce_work_item_depth_limit, exercised by repository.test.ts) caps the tree
// at FOUR levels: a 5th level is rejected with DepthLimitExceededError. The
// already-shipped code outranks the card (rung 2), so this scenario builds the
// deepest LEGAL arrangement of one of each kind — epic → story → task, with
// BOTH a `bug` and a `subtask` as the depth-4 leaves under the task (task → bug
// and task → subtask are both legal in the kind-parent matrix). It then asserts
// directly that the card's 5th level (a subtask under the depth-4 bug) is
// rejected — documenting WHY the chain stops at four in executable form.
//
//   epic    PROD-1  depth 1  (root)
//   └─ story   PROD-2  depth 2
//      └─ task    PROD-3  depth 3   ← assigned + status-walked (representative)
//         ├─ bug     PROD-4  depth 4   ← readiness: is_blocked_by the subtask
//         └─ subtask PROD-5  depth 4   ← the blocker

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

/** The status `{ from, to }` cells of an item's 'updated' revisions, in
 *  chronological order. listByWorkItem returns newest-first (the walk asserts
 *  oldest-first); the 'created' revision also carries a status cell
 *  (`{ from: null, to: <initial> }`) — it is NOT a transition, so only
 *  'updated' revisions count toward the status walk. */
function statusWalk(revs: WorkItemRevision[]): Array<{ from: string; to: string }> {
  return revs
    .filter((r) => r.changeKind === 'updated')
    .map((r) => (r.diff as Record<string, { from: string; to: string }>).status)
    .filter((cell): cell is { from: string; to: string } => Boolean(cell))
    .reverse();
}

interface Built {
  epic: WorkItemDto;
  story: WorkItemDto;
  task: WorkItemDto;
  bug: WorkItemDto;
  subtask: WorkItemDto;
}

/** Build the canonical legal tree (see header) entirely through the service. */
async function buildTree(fx: WorkItemFixture): Promise<Built> {
  const epic = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'epic', title: 'Checkout revamp' },
    fx.ctx,
  );
  const story = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Guest checkout', parentId: epic.id },
    fx.ctx,
  );
  const task = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Address form', parentId: story.id },
    fx.ctx,
  );
  const bug = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'bug', title: 'Zip validation off-by-one', parentId: task.id },
    fx.ctx,
  );
  const subtask = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', title: 'Add postcode regex', parentId: task.id },
    fx.ctx,
  );
  return { epic, story, task, bug, subtask };
}

describe('Epic-2 lifecycle — build a full kind-legal tree', () => {
  it('creates epic→story→task→{bug,subtask} with gap-free keys, derived identifiers, and parentage', async () => {
    const fx = await makeWorkItemFixture();
    const t = await buildTree(fx);

    // Gap-free per-project sequence in creation order (1..5).
    expect([t.epic.key, t.story.key, t.task.key, t.bug.key, t.subtask.key]).toEqual([
      1, 2, 3, 4, 5,
    ]);
    // Identifiers derive from the project prefix + key.
    expect([t.epic.identifier, t.story.identifier, t.task.identifier]).toEqual([
      'PROD-1',
      'PROD-2',
      'PROD-3',
    ]);
    expect([t.bug.identifier, t.subtask.identifier]).toEqual(['PROD-4', 'PROD-5']);
    // Parentage honours the kind-parent matrix.
    expect(t.epic.parentId).toBeNull();
    expect(t.story.parentId).toBe(t.epic.id);
    expect(t.task.parentId).toBe(t.story.id);
    expect(t.bug.parentId).toBe(t.task.id);
    expect(t.subtask.parentId).toBe(t.task.id);
  });

  it('nests at the right depths and rejects the card’s 5th level (the depth-4 cap, rung 2)', async () => {
    const fx = await makeWorkItemFixture();
    const t = await buildTree(fx);

    const tree = await workItemsService.getProjectTree(fx.projectId, {}, fx.ctx);
    expect(tree.map((n) => n.identifier)).toEqual(['PROD-1']);
    const epic = tree[0]!;
    const story = epic.children[0]!;
    const task = story.children[0]!;
    expect([epic.depth, story.depth, task.depth]).toEqual([1, 2, 3]);
    // task's two depth-4 leaves, key-asc.
    expect(task.children.map((c) => [c.identifier, c.depth, c.kind])).toEqual([
      ['PROD-4', 4, 'bug'],
      ['PROD-5', 4, 'subtask'],
    ]);

    // The card's literal 5th level — a subtask under the depth-4 bug — is
    // kind-legal (bug → subtask) but DEPTH-illegal; the depth trigger fires.
    await expect(
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'subtask', title: 'too deep', parentId: t.bug.id },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(DepthLimitExceededError);
  });
});

describe('Epic-2 lifecycle — assignee gate across membership', () => {
  it('assigns to a workspace member and rejects a non-member with AssigneeNotInWorkspaceError', async () => {
    const fx = await makeWorkItemFixture();
    const t = await buildTree(fx);

    const member = await createTestUser({ name: 'Member' });
    await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });

    const assigned = await workItemsService.assignWorkItem(t.task.id, member.id, fx.ctx);
    expect(assigned.assigneeId).toBe(member.id);

    const outsider = await createTestUser({ name: 'Outsider' });
    await expect(
      workItemsService.assignWorkItem(t.task.id, outsider.id, fx.ctx),
    ).rejects.toBeInstanceOf(AssigneeNotInWorkspaceError);

    // The rejected assignment did not mutate the assignee.
    const after = await workItemsService.getWorkItem(t.task.id, fx.ctx);
    expect(after.assigneeId).toBe(member.id);
  });
});

describe('Epic-2 lifecycle — multi-hop status walk under the restricted default policy', () => {
  it('rejects an illegal jump mid-walk without mutating, then forward + block/unblock + reopen each record a revision', async () => {
    const fx = await makeWorkItemFixture();
    const t = await buildTree(fx);

    // Illegal jump from the initial status: todo → done is not a default edge.
    await expect(workItemsService.updateStatus(t.task.id, 'done', fx.ctx)).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    expect((await workItemsService.getWorkItem(t.task.id, fx.ctx)).status).toBe('todo');
    // No status revision was written for the rejected jump.
    expect(statusWalk(await workItemRevisionRepository.listByWorkItem(t.task.id))).toEqual([]);

    // The legal multi-hop walk: forward → block/unblock detour → forward → reopen.
    const walk: Array<[string, string]> = [
      ['todo', 'in_progress'],
      ['in_progress', 'blocked'],
      ['blocked', 'in_progress'],
      ['in_progress', 'in_review'],
      ['in_review', 'done'],
      ['done', 'in_progress'], // reopen
    ];
    for (const [, to] of walk) {
      await workItemsService.updateStatus(t.task.id, to, fx.ctx);
    }

    const ended = await workItemsService.getWorkItem(t.task.id, fx.ctx);
    expect(ended.status).toBe('in_progress');

    // Each hop wrote exactly one 'updated' status revision, in walk order.
    const revs = await workItemRevisionRepository.listByWorkItem(t.task.id);
    expect(statusWalk(revs)).toEqual(walk.map(([from, to]) => ({ from, to })));
    // A no-op self-transition writes nothing extra.
    await workItemsService.updateStatus(t.task.id, 'in_progress', fx.ctx);
    expect(statusWalk(await workItemRevisionRepository.listByWorkItem(t.task.id))).toHaveLength(
      walk.length,
    );
  });
});

describe('Epic-2 lifecycle — readiness gating on a blocker', () => {
  it('an item with no blockers is ready; a blocked item becomes ready only once its blocker is terminal', async () => {
    const fx = await makeWorkItemFixture();
    const t = await buildTree(fx);

    // bug is_blocked_by subtask (the new bug cannot start until the subtask is done).
    await workItemsService.linkWorkItems(
      { fromId: t.bug.id, toId: t.subtask.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    // Without blockers → ready; with an open (non-terminal) blocker → not ready.
    expect(await workItemsService.isReady(t.subtask.id, fx.ctx)).toBe(true);
    expect(await workItemsService.isReady(t.bug.id, fx.ctx)).toBe(false);

    // Resolve the blocker to a TERMINAL status (cancelled is category=done).
    await workItemsService.updateStatus(t.subtask.id, 'cancelled', fx.ctx);
    expect(await workItemsService.isReady(t.bug.id, fx.ctx)).toBe(true);
  });
});

describe('Epic-2 lifecycle — archive is a no-cascade soft-delete reflected in the reads', () => {
  it('archiving a parent leaves descendants intact, drops the subtree from the tree, but keeps live descendants in the flat list', async () => {
    const fx = await makeWorkItemFixture();
    const t = await buildTree(fx);

    // Set up a realistic end state: assign + walk the task, resolve the subtask.
    const member = await createTestUser({ name: 'Member' });
    await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
    await workItemsService.assignWorkItem(t.task.id, member.id, fx.ctx);
    await workItemsService.updateStatus(t.task.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(t.subtask.id, 'cancelled', fx.ctx);

    // Archive the STORY — a non-leaf with a deep subtree (task → bug, subtask).
    const archived = await workItemsService.archiveWorkItem(t.story.id, fx.ctx);
    expect(archived.archivedAt).not.toBeNull();

    // No cascade: the direct child (and the whole subtree) rows are untouched.
    const childRows = await db.workItem.findMany({
      where: { id: { in: [t.task.id, t.bug.id, t.subtask.id] } },
      select: { archivedAt: true },
    });
    expect(childRows.every((r) => r.archivedAt === null)).toBe(true);

    // Tree read: the archived story (and its now-unreachable subtree) drops out
    // — only the epic remains, with no visible children.
    const tree = await workItemsService.getProjectTree(fx.projectId, {}, fx.ctx);
    expect(tree.map((n) => n.identifier)).toEqual(['PROD-1']);
    expect(tree[0]!.children).toEqual([]);

    // Flat list read: the archived story is excluded, but its LIVE descendants
    // still surface (no cascade) with their correct final status + assignee.
    const list = await workItemsService.getProjectIssuesList(
      fx.projectId,
      { sort: DEFAULT_SORT },
      fx.ctx,
    );
    const byIdentifier = new Map(list.items.map((i) => [i.identifier, i]));
    expect([...byIdentifier.keys()].sort()).toEqual(['PROD-1', 'PROD-3', 'PROD-4', 'PROD-5']);
    expect(byIdentifier.has('PROD-2')).toBe(false); // the archived story
    expect(byIdentifier.get('PROD-3')).toMatchObject({
      status: 'in_progress',
      assigneeId: member.id,
    });
    expect(byIdentifier.get('PROD-5')!.status).toBe('cancelled');
    expect(list.total).toBe(4);

    // Final readiness: the bug is_blocked_by nothing here, so it is ready; the
    // end-state reads are internally consistent.
    expect(await workItemsService.isReady(t.bug.id, fx.ctx)).toBe(true);
  });
});
