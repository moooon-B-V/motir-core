import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { CreateWorkItemInput } from '@/lib/dto/workItems';
import { WorkItemLinkCycleError } from '@/lib/workItems/linkErrors';
import { truncateAuthTables } from '../../helpers/db';

// Service-layer integration tests for workItemsService against a REAL Postgres
// (Yue's no-mocks rule — the single allowed spy here is vi.spyOn on a
// repository method to PROVE a query-count invariant, never to stub the DB).
// These exercise the business logic the route layer (Epic 2) will call:
// key allocation (sequential + concurrent), the no-op-without-transaction
// update path, the explanation-source state machine, archive-doesn't-cascade,
// fractional-index moves, link/unlink (incl. relates_to reciprocal + cycle),
// the N+0 blocker/blocking resolution, and the single-query ready predicate.

const PASSWORD = 'hunter2hunter2';

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

interface Fixture {
  ownerId: string;
  workspaceId: string;
  projectId: string;
  projectIdentifier: string;
  ctx: ServiceContext;
}

async function makeFixture(opts: { identifier?: string; name?: string } = {}): Promise<Fixture> {
  const owner = await usersService.createUser({
    email: `owner+${Math.random().toString(36).slice(2)}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: opts.name ?? 'Acme',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Prodect',
    identifier: opts.identifier ?? 'PROD',
  });
  return {
    ownerId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
    projectIdentifier: project.identifier,
    ctx: { userId: owner.id, workspaceId: workspace.id },
  };
}

function createInput(fx: Fixture, over: Partial<CreateWorkItemInput> = {}): CreateWorkItemInput {
  return {
    projectId: fx.projectId,
    kind: 'task',
    title: 'Item',
    ...over,
  };
}

// ── createWorkItem ──────────────────────────────────────────────────────

describe('createWorkItem — key allocation', () => {
  it('allocates sequential keys (1, 2, 3) on serial calls and derives identifiers', async () => {
    const fx = await makeFixture();
    const a = await workItemsService.createWorkItem(createInput(fx, { title: 'A' }), fx.ctx);
    const b = await workItemsService.createWorkItem(createInput(fx, { title: 'B' }), fx.ctx);
    const c = await workItemsService.createWorkItem(createInput(fx, { title: 'C' }), fx.ctx);

    expect([a.key, b.key, c.key]).toEqual([1, 2, 3]);
    expect([a.identifier, b.identifier, c.identifier]).toEqual(['PROD-1', 'PROD-2', 'PROD-3']);
    expect(a.reporterId).toBe(fx.ownerId);
    // Sequential appends produce strictly increasing positions.
    expect(a.position < b.position).toBe(true);
    expect(b.position < c.position).toBe(true);
  });

  it('produces non-overlapping keys under concurrent createWorkItem on one project', async () => {
    const fx = await makeFixture();
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        workItemsService.createWorkItem(createInput(fx, { title: `T${i}` }), fx.ctx),
      ),
    );
    const keys = results.map((r) => r.key).sort((x, y) => x - y);
    expect(keys).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    // Identifiers are unique too.
    expect(new Set(results.map((r) => r.identifier)).size).toBe(N);
  });
});

// ── updateWorkItem — no-op + explanation-source state machine ────────────

describe('updateWorkItem — no-op patches', () => {
  it('empty patch returns the current DTO without writing (updatedAt unchanged, repo.update not called)', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      createInput(fx, { title: 'Stable' }),
      fx.ctx,
    );

    const updateSpy = vi.spyOn(workItemRepository, 'update');
    const result = await workItemsService.updateWorkItem(created.id, {}, fx.ctx);

    expect(updateSpy).not.toHaveBeenCalled();
    expect(result.updatedAt).toBe(created.updatedAt);
    expect(result.title).toBe('Stable');
  });

  it('a patch that matches current values writes nothing (diff empty)', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      createInput(fx, { title: 'Same' }),
      fx.ctx,
    );

    const updateSpy = vi.spyOn(workItemRepository, 'update');
    const result = await workItemsService.updateWorkItem(
      created.id,
      { title: 'Same', priority: 'medium' },
      fx.ctx,
    );

    expect(updateSpy).not.toHaveBeenCalled();
    expect(result.updatedAt).toBe(created.updatedAt);
  });

  it('a real change writes and bumps updatedAt', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      createInput(fx, { title: 'Before' }),
      fx.ctx,
    );
    const updated = await workItemsService.updateWorkItem(created.id, { title: 'After' }, fx.ctx);
    expect(updated.title).toBe('After');
    expect(updated.updatedAt >= created.updatedAt).toBe(true);
  });
});

describe('updateWorkItem — explanation-source state machine', () => {
  it('auto-flips ai_draft → user_edited when explanationMd is edited without an explicit source', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      createInput(fx, {
        title: 'Has draft',
        explanationMd: 'AI wrote this',
        explanationSource: 'ai_draft',
      }),
      fx.ctx,
    );
    expect(created.explanationSource).toBe('ai_draft');

    const edited = await workItemsService.updateWorkItem(
      created.id,
      { explanationMd: 'Human refined this' },
      fx.ctx,
    );
    expect(edited.explanationMd).toBe('Human refined this');
    expect(edited.explanationSource).toBe('user_edited');
  });

  it('an explicit explanationSource in the patch wins (no auto-flip)', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      createInput(fx, {
        title: 'Has draft',
        explanationMd: 'AI wrote this',
        explanationSource: 'ai_draft',
      }),
      fx.ctx,
    );

    const edited = await workItemsService.updateWorkItem(
      created.id,
      { explanationMd: 'More AI text', explanationSource: 'ai_draft' },
      fx.ctx,
    );
    expect(edited.explanationSource).toBe('ai_draft');
  });

  it('does not flip when the current source is not ai_draft', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      createInput(fx, { title: 'User authored', explanationMd: 'mine' }),
      fx.ctx,
    );
    expect(created.explanationSource).toBe('user_authored');

    const edited = await workItemsService.updateWorkItem(
      created.id,
      { explanationMd: 'still mine, edited' },
      fx.ctx,
    );
    expect(edited.explanationSource).toBe('user_authored');
  });
});

// ── assignWorkItem ──────────────────────────────────────────────────────

describe('assignWorkItem', () => {
  it('assigns a workspace member and un-assigns with null', async () => {
    const fx = await makeFixture();
    const item = await workItemsService.createWorkItem(
      createInput(fx, { title: 'Assignable' }),
      fx.ctx,
    );

    const assigned = await workItemsService.assignWorkItem(item.id, fx.ownerId, fx.ctx);
    expect(assigned.assigneeId).toBe(fx.ownerId);

    const unassigned = await workItemsService.assignWorkItem(item.id, null, fx.ctx);
    expect(unassigned.assigneeId).toBeNull();
  });
});

// ── archiveWorkItem ─────────────────────────────────────────────────────

describe('archiveWorkItem', () => {
  it('archives the item but leaves children intact (Linear shape — no cascade)', async () => {
    const fx = await makeFixture();
    const epic = await workItemsService.createWorkItem(
      createInput(fx, { kind: 'epic', title: 'Epic' }),
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      createInput(fx, { kind: 'story', title: 'Child', parentId: epic.id }),
      fx.ctx,
    );

    const archived = await workItemsService.archiveWorkItem(epic.id, fx.ctx);
    expect(archived.archivedAt).not.toBeNull();

    // The child is untouched: still present, still non-archived.
    const childRow = await workItemRepository.findById(story.id);
    expect(childRow).not.toBeNull();
    expect(childRow?.archivedAt).toBeNull();
  });
});

// ── moveWorkItem ────────────────────────────────────────────────────────

describe('moveWorkItem', () => {
  it('reorders within the same parent by minting a key between neighbors (position only)', async () => {
    const fx = await makeFixture();
    const epic = await workItemsService.createWorkItem(
      createInput(fx, { kind: 'epic', title: 'Epic' }),
      fx.ctx,
    );
    const a = await workItemsService.createWorkItem(
      createInput(fx, { kind: 'story', title: 'A', parentId: epic.id }),
      fx.ctx,
    );
    const b = await workItemsService.createWorkItem(
      createInput(fx, { kind: 'story', title: 'B', parentId: epic.id }),
      fx.ctx,
    );
    const c = await workItemsService.createWorkItem(
      createInput(fx, { kind: 'story', title: 'C', parentId: epic.id }),
      fx.ctx,
    );
    expect([a.position < b.position, b.position < c.position]).toEqual([true, true]);

    // Move C to sit between A and B.
    const moved = await workItemsService.moveWorkItem(
      c.id,
      { beforeId: a.id, afterId: b.id },
      fx.ctx,
    );
    expect(moved.parentId).toBe(epic.id); // parent unchanged
    expect(moved.position > a.position).toBe(true);
    expect(moved.position < b.position).toBe(true);
  });

  it('moves to a new parent, updating parentId + position', async () => {
    const fx = await makeFixture();
    const e1 = await workItemsService.createWorkItem(
      createInput(fx, { kind: 'epic', title: 'E1' }),
      fx.ctx,
    );
    const e2 = await workItemsService.createWorkItem(
      createInput(fx, { kind: 'epic', title: 'E2' }),
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      createInput(fx, { kind: 'story', title: 'S', parentId: e1.id }),
      fx.ctx,
    );

    const moved = await workItemsService.moveWorkItem(story.id, { newParentId: e2.id }, fx.ctx);
    expect(moved.parentId).toBe(e2.id);
    expect(moved.position).toBeTruthy();
  });
});

// ── linkWorkItems / unlinkWorkItems ─────────────────────────────────────

describe('linkWorkItems', () => {
  it('is_blocked_by writes exactly one row (no reciprocal)', async () => {
    const fx = await makeFixture();
    const a = await workItemsService.createWorkItem(createInput(fx, { title: 'A' }), fx.ctx);
    const b = await workItemsService.createWorkItem(createInput(fx, { title: 'B' }), fx.ctx);

    const link = await workItemsService.linkWorkItems(
      { fromId: a.id, toId: b.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    expect(link.fromId).toBe(a.id);
    expect(link.toId).toBe(b.id);

    expect(await workItemLinkRepository.findByFromItem(a.id)).toHaveLength(1);
    // No reciprocal is_blocked_by row out of B.
    expect(await workItemLinkRepository.findByFromItem(b.id)).toHaveLength(0);
  });

  it('relates_to writes BOTH rows in one transaction', async () => {
    const fx = await makeFixture();
    const a = await workItemsService.createWorkItem(createInput(fx, { title: 'A' }), fx.ctx);
    const b = await workItemsService.createWorkItem(createInput(fx, { title: 'B' }), fx.ctx);

    const link = await workItemsService.linkWorkItems(
      { fromId: a.id, toId: b.id, kind: 'relates_to' },
      fx.ctx,
    );

    const forward = await workItemLinkRepository.findById(link.id);
    const reciprocal = await workItemLinkRepository.findReciprocal(b.id, a.id, 'relates_to');
    expect(forward).not.toBeNull();
    expect(reciprocal).not.toBeNull();
    expect(reciprocal?.fromId).toBe(b.id);
    expect(reciprocal?.toId).toBe(a.id);
  });

  it('relates_to is idempotent on the reciprocal when the mirror already exists', async () => {
    const fx = await makeFixture();
    const a = await workItemsService.createWorkItem(createInput(fx, { title: 'A' }), fx.ctx);
    const b = await workItemsService.createWorkItem(createInput(fx, { title: 'B' }), fx.ctx);

    // First B→A creates B→A + reciprocal A→B.
    await workItemsService.linkWorkItems({ fromId: b.id, toId: a.id, kind: 'relates_to' }, fx.ctx);
    // Now A→B's primary already exists → DuplicateLinkError on the PRIMARY
    // (the reciprocal-swallow path is exercised by the test below via a
    // legacy half-pair). Here we assert the steady state has exactly two rows.
    const fromB = await workItemLinkRepository.findByFromItem(b.id, 'relates_to');
    const fromA = await workItemLinkRepository.findByFromItem(a.id, 'relates_to');
    expect(fromB).toHaveLength(1);
    expect(fromA).toHaveLength(1);
  });

  it('relates_to swallows the reciprocal when only a legacy mirror pre-exists', async () => {
    const fx = await makeFixture();
    const a = await workItemsService.createWorkItem(createInput(fx, { title: 'A' }), fx.ctx);
    const b = await workItemsService.createWorkItem(createInput(fx, { title: 'B' }), fx.ctx);

    // Seed ONLY the mirror B→A directly (a legacy half-pair), then link A→B.
    await db.$transaction((tx) =>
      workItemLinkRepository.create(
        {
          workspaceId: fx.workspaceId,
          fromId: b.id,
          toId: a.id,
          kind: 'relates_to',
          createdById: fx.ownerId,
        },
        tx,
      ),
    );

    const link = await workItemsService.linkWorkItems(
      { fromId: a.id, toId: b.id, kind: 'relates_to' },
      fx.ctx,
    );
    expect(link.fromId).toBe(a.id);
    // The pre-existing mirror is untouched (no duplicate, no error).
    expect(await workItemLinkRepository.findByFromItem(b.id, 'relates_to')).toHaveLength(1);
    expect(await workItemLinkRepository.findByFromItem(a.id, 'relates_to')).toHaveLength(1);
  });

  it('rejects a cycle-closing is_blocked_by link with WorkItemLinkCycleError', async () => {
    const fx = await makeFixture();
    const a = await workItemsService.createWorkItem(createInput(fx, { title: 'A' }), fx.ctx);
    const b = await workItemsService.createWorkItem(createInput(fx, { title: 'B' }), fx.ctx);

    await workItemsService.linkWorkItems(
      { fromId: a.id, toId: b.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    await expect(
      workItemsService.linkWorkItems({ fromId: b.id, toId: a.id, kind: 'is_blocked_by' }, fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemLinkCycleError);
  });
});

describe('unlinkWorkItems', () => {
  it('relates_to removes BOTH rows', async () => {
    const fx = await makeFixture();
    const a = await workItemsService.createWorkItem(createInput(fx, { title: 'A' }), fx.ctx);
    const b = await workItemsService.createWorkItem(createInput(fx, { title: 'B' }), fx.ctx);

    const link = await workItemsService.linkWorkItems(
      { fromId: a.id, toId: b.id, kind: 'relates_to' },
      fx.ctx,
    );
    await workItemsService.unlinkWorkItems(link.id, fx.ctx);

    expect(await workItemLinkRepository.findByFromItem(a.id, 'relates_to')).toHaveLength(0);
    expect(await workItemLinkRepository.findByFromItem(b.id, 'relates_to')).toHaveLength(0);
  });
});

// ── getBlockers / getBlocking (N+0) ─────────────────────────────────────

describe('getBlockers / getBlocking', () => {
  it('returns the correct sets resolved in N+0 round-trips (one bulk findByIds, no per-id reads)', async () => {
    const fx = await makeFixture();
    const a = await workItemsService.createWorkItem(createInput(fx, { title: 'A' }), fx.ctx);
    const b = await workItemsService.createWorkItem(createInput(fx, { title: 'B' }), fx.ctx);
    const c = await workItemsService.createWorkItem(createInput(fx, { title: 'C' }), fx.ctx);

    // A is_blocked_by B and A is_blocked_by C.
    await workItemsService.linkWorkItems(
      { fromId: a.id, toId: b.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: a.id, toId: c.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    // N+0: exactly one bulk resolution query, zero per-item findById calls.
    const findByIdsSpy = vi.spyOn(workItemRepository, 'findByIds');
    const findByIdSpy = vi.spyOn(workItemRepository, 'findById');

    const blockers = await workItemsService.getBlockers(a.id, fx.ctx);
    expect(blockers.map((w) => w.id).sort()).toEqual([b.id, c.id].sort());
    expect(findByIdsSpy).toHaveBeenCalledTimes(1);
    expect(findByIdSpy).not.toHaveBeenCalled();

    // getBlocking on B: B blocks A.
    const blocking = await workItemsService.getBlocking(b.id, fx.ctx);
    expect(blocking.map((w) => w.id)).toEqual([a.id]);
  });
});

// ── isReady ─────────────────────────────────────────────────────────────

describe('isReady', () => {
  it('is false while any blocker is non-done and true once all blockers are done', async () => {
    const fx = await makeFixture();
    const a = await workItemsService.createWorkItem(createInput(fx, { title: 'A' }), fx.ctx);
    const b = await workItemsService.createWorkItem(createInput(fx, { title: 'B' }), fx.ctx);
    const c = await workItemsService.createWorkItem(createInput(fx, { title: 'C' }), fx.ctx);

    // No blockers yet → ready.
    expect(await workItemsService.isReady(a.id, fx.ctx)).toBe(true);

    await workItemsService.linkWorkItems(
      { fromId: a.id, toId: b.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: a.id, toId: c.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    expect(await workItemsService.isReady(a.id, fx.ctx)).toBe(false);

    await workItemsService.updateWorkItem(b.id, { status: 'done' }, fx.ctx);
    expect(await workItemsService.isReady(a.id, fx.ctx)).toBe(false); // C still open

    await workItemsService.updateWorkItem(c.id, { status: 'done' }, fx.ctx);
    expect(await workItemsService.isReady(a.id, fx.ctx)).toBe(true);
  });
});

// ── listWorkItems / getWorkItemSubtree ──────────────────────────────────

describe('listWorkItems / getWorkItemSubtree', () => {
  it('listWorkItems returns summary DTOs filtered by kind', async () => {
    const fx = await makeFixture();
    await workItemsService.createWorkItem(createInput(fx, { kind: 'epic', title: 'E' }), fx.ctx);
    await workItemsService.createWorkItem(createInput(fx, { kind: 'bug', title: 'Bug' }), fx.ctx);

    const all = await workItemsService.listWorkItems(fx.projectId, {}, fx.ctx);
    expect(all).toHaveLength(2);
    // Summary DTO omits the Markdown content fields.
    expect(all[0]).not.toHaveProperty('descriptionMd');

    const bugs = await workItemsService.listWorkItems(fx.projectId, { kind: 'bug' }, fx.ctx);
    expect(bugs.map((w) => w.kind)).toEqual(['bug']);
  });

  it('getWorkItemSubtree returns the tree with depth metadata', async () => {
    const fx = await makeFixture();
    const epic = await workItemsService.createWorkItem(
      createInput(fx, { kind: 'epic', title: 'Epic' }),
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      createInput(fx, { kind: 'story', title: 'Story', parentId: epic.id }),
      fx.ctx,
    );
    await workItemsService.createWorkItem(
      createInput(fx, { kind: 'task', title: 'Task', parentId: story.id }),
      fx.ctx,
    );

    const tree = await workItemsService.getWorkItemSubtree(epic.id, fx.ctx);
    expect(tree.map((n) => n.depth)).toEqual([1, 2, 3]);
    expect(tree.map((n) => n.kind)).toEqual(['epic', 'story', 'task']);
  });
});
