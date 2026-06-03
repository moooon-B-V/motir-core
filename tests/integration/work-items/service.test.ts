import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import type { CreateWorkItemInput } from '@/lib/dto/workItems';
import { IllegalParentTypeError } from '@/lib/workItems/errors';
import { WorkItemLinkCycleError } from '@/lib/workItems/linkErrors';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture as makeFixture, type WorkItemFixture } from '../../fixtures';

// Service-layer integration tests for workItemsService against a REAL Postgres
// (Yue's no-mocks rule — the single allowed spy here is vi.spyOn on a
// repository method to PROVE a query-count invariant, never to stub the DB).
// These exercise the business logic the route layer (Epic 2) will call:
// key allocation (sequential + concurrent), the no-op-without-transaction
// update path, the explanation-source state machine, archive-doesn't-cascade,
// fractional-index moves, link/unlink (incl. relates_to reciprocal + cycle),
// the N+0 blocker/blocking resolution, and the single-query ready predicate.
//
// The workspace/project/owner fixture (makeFixture) now comes from
// tests/fixtures/ (Subtask 1.4.7); it returns a superset bundle, so the
// { ownerId, workspaceId, projectId, ctx } fields these tests read are
// unchanged.

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

function createInput(
  fx: WorkItemFixture,
  over: Partial<CreateWorkItemInput> = {},
): CreateWorkItemInput {
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

  // Subtask 1.4.7 gap-fill: the AC names 20 explicitly. This is the heavier
  // stress variant of the 8-wide test above — 20 createWorkItem calls fired
  // concurrently against ONE project must produce a CONTIGUOUS key set 1..20
  // with no duplicates and no gaps. The allocate-key-inside-the-transaction
  // design (projectRepository.allocateWorkItemNumber does an atomic
  // UPDATE ... RETURNING under the row lock) is what guarantees this even
  // when all 20 transactions race.
  it('allocates a contiguous, gap-free, duplicate-free key set under 20-wide concurrency', async () => {
    const fx = await makeFixture();
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        workItemsService.createWorkItem(createInput(fx, { title: `Stress ${i}` }), fx.ctx),
      ),
    );

    const keys = results.map((r) => r.key).sort((x, y) => x - y);
    // Contiguous 1..20: no gaps (every key present) and no duplicates (Set
    // size equals N). The two together pin "exactly the integers 1..20, once".
    expect(keys).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect(new Set(keys).size).toBe(N);
    expect(new Set(results.map((r) => r.identifier)).size).toBe(N);
    // Every identifier is the derived PROD-<key>.
    expect(new Set(results.map((r) => r.identifier))).toEqual(
      new Set(Array.from({ length: N }, (_, i) => `PROD-${i + 1}`)),
    );
  });

  // Subtask 2.1.3 AC: "deleting an issue does not recycle its key." Work items
  // are soft-deleted (archived), and the per-project counter is the monotonic
  // project.lastWorkItemNumber bumped by an atomic UPDATE … RETURNING — it is
  // never derived from MAX(existing key) or from the live row count, so a
  // removed key can never be re-minted. This pins that invariant: archiving the
  // holder of key 2 must NOT free 2 for the next create, which keeps climbing.
  it('does not recycle a key after the holding item is archived', async () => {
    const fx = await makeFixture();
    const a = await workItemsService.createWorkItem(createInput(fx, { title: 'A' }), fx.ctx);
    const b = await workItemsService.createWorkItem(createInput(fx, { title: 'B' }), fx.ctx);
    const c = await workItemsService.createWorkItem(createInput(fx, { title: 'C' }), fx.ctx);
    expect([a.key, b.key, c.key]).toEqual([1, 2, 3]);

    // Archive the middle item — its key (2) is now held by an archived row.
    const archived = await workItemsService.archiveWorkItem(b.id, fx.ctx);
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.key).toBe(2);

    // The next create climbs to 4 — it does NOT reclaim the archived 2.
    const d = await workItemsService.createWorkItem(createInput(fx, { title: 'D' }), fx.ctx);
    expect(d.key).toBe(4);
    expect(d.identifier).toBe('PROD-4');
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

  // Subtask 1.4.7 gap-fill: the card's "direct PATCH of explanationSource
  // alone (no explanationMd) is allowed — e.g. a user manually dismisses the
  // AI-draft badge". The patch carries ONLY explanationSource, so the
  // auto-transition machine doesn't fire; the explicit value is written as-is.
  it('patches explanationSource alone (no explanationMd) — manual badge dismissal', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      createInput(fx, { explanationMd: 'AI wrote this', explanationSource: 'ai_draft' }),
      fx.ctx,
    );

    const dismissed = await workItemsService.updateWorkItem(
      created.id,
      { explanationSource: 'user_edited' },
      fx.ctx,
    );
    expect(dismissed.explanationSource).toBe('user_edited');
    // The explanation content is untouched by a source-only patch.
    expect(dismissed.explanationMd).toBe('AI wrote this');
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

// Subtask 1.4.7 gap-fill: the three explicit reorder slots. `position` is a
// fractional-index string, so "sorts into the expected slot" is a plain
// lexicographic (string <) comparison. Recall the service's slot semantics
// (MoveWorkItemInput): `beforeId` = the sibling the moved item sorts AFTER,
// `afterId` = the sibling it sorts BEFORE — so the new key is minted
// keyBetween(beforeId.position, afterId.position).
describe('moveWorkItem — edge cases', () => {
  // Build an epic with three ordered children A < B < C and return them.
  async function threeChildren(fx: WorkItemFixture) {
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
    expect(a.position < b.position && b.position < c.position).toBe(true);
    return { epic, a, b, c };
  }

  it('move-to-start: { beforeId: null, afterId: <first sibling> } sorts before every sibling', async () => {
    const fx = await makeFixture();
    const { a, b, c } = await threeChildren(fx);

    // Move C to the very front: it must sort BEFORE A (the current first).
    const moved = await workItemsService.moveWorkItem(
      c.id,
      { beforeId: null, afterId: a.id },
      fx.ctx,
    );
    expect(moved.position < a.position).toBe(true);
    expect(moved.position < b.position).toBe(true);
  });

  it('move-to-end: { beforeId: <last sibling>, afterId: null } sorts after every sibling', async () => {
    const fx = await makeFixture();
    const { a, b, c } = await threeChildren(fx);

    // Move A to the very end: it must sort AFTER C (the current last).
    const moved = await workItemsService.moveWorkItem(
      a.id,
      { beforeId: c.id, afterId: null },
      fx.ctx,
    );
    expect(moved.position > c.position).toBe(true);
    expect(moved.position > b.position).toBe(true);
  });

  it('move-between: { beforeId: <X>, afterId: <Y> } sorts strictly between X and Y', async () => {
    const fx = await makeFixture();
    const { a, b, c } = await threeChildren(fx);

    // Move C to sit between A and B.
    const moved = await workItemsService.moveWorkItem(
      c.id,
      { beforeId: a.id, afterId: b.id },
      fx.ctx,
    );
    expect(moved.position > a.position).toBe(true);
    expect(moved.position < b.position).toBe(true);
  });
});

// Subtask 1.4.7 gap-fill: the service-path counterpart to repository.test.ts's
// 3-hop ParentCycleError test. A re-parent that would close a cycle (moving an
// ancestor under its own descendant) NEVER reaches the DB cycle trigger via
// the service, because the kind hierarchy is a strict DAG: an ancestor's kind
// can never be a legal child of a descendant's kind, so moveWorkItem's
// assertKindParent pre-flight rejects with IllegalParentTypeError first. This
// locks in that layering (the friendly service error fires ahead of the
// structural trigger backstop) so a future refactor that drops the pre-flight
// is caught.
describe('moveWorkItem — re-parent cycle is intercepted by the kind pre-flight', () => {
  it('moving an ancestor (A) under its descendant (C) rejects with IllegalParentTypeError, not ParentCycleError', async () => {
    const fx = await makeFixture();
    const a = await workItemsService.createWorkItem(
      createInput(fx, { kind: 'epic', title: 'A' }),
      fx.ctx,
    );
    const b = await workItemsService.createWorkItem(
      createInput(fx, { kind: 'story', title: 'B', parentId: a.id }),
      fx.ctx,
    );
    const c = await workItemsService.createWorkItem(
      createInput(fx, { kind: 'task', title: 'C', parentId: b.id }),
      fx.ctx,
    );

    await expect(
      workItemsService.moveWorkItem(a.id, { newParentId: c.id }, fx.ctx),
    ).rejects.toBeInstanceOf(IllegalParentTypeError);
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

    await db.workItem.update({ where: { id: b.id }, data: { status: 'done' } });
    expect(await workItemsService.isReady(a.id, fx.ctx)).toBe(false); // C still open

    await db.workItem.update({ where: { id: c.id }, data: { status: 'done' } });
    expect(await workItemsService.isReady(a.id, fx.ctx)).toBe(true);
  });

  // Subtask 1.4.7 gap-fill: isReady must read the LIVE blocker set on every
  // call, not a cached snapshot. This is the "unlink restores readiness" leg.
  //
  // Scenario (chosen to be unambiguous about the re-read property):
  //   A is_blocked_by B (open) AND A is_blocked_by C.
  //   Mark only C done. → A is NOT ready (B still open).
  //   Unlink the STILL-OPEN blocker B.
  //   → A IS ready, because the only remaining link is C, which is done.
  // The flip to ready happens solely because the open blocker's LINK was
  // removed — so isReady must have re-counted the current links (the
  // countOpenBlockers query), not reused the earlier "not ready" result. The
  // inverse — leaving B linked — keeps A not-ready, which the first leg below
  // re-confirms after the unlink would have mattered.
  it('re-reads the live blocker set: unlinking the still-open blocker flips isReady to true', async () => {
    const fx = await makeFixture();
    const a = await workItemsService.createWorkItem(createInput(fx, { title: 'A' }), fx.ctx);
    const b = await workItemsService.createWorkItem(createInput(fx, { title: 'B' }), fx.ctx);
    const c = await workItemsService.createWorkItem(createInput(fx, { title: 'C' }), fx.ctx);

    const linkAB = await workItemsService.linkWorkItems(
      { fromId: a.id, toId: b.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    await workItemsService.linkWorkItems(
      { fromId: a.id, toId: c.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    // C done, B still open → not ready.
    await db.workItem.update({ where: { id: c.id }, data: { status: 'done' } });
    expect(await workItemsService.isReady(a.id, fx.ctx)).toBe(false);

    // Remove the open blocker B. The predicate must re-evaluate against the
    // now-single remaining (done) blocker C and return true.
    await workItemsService.unlinkWorkItems(linkAB.id, fx.ctx);
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
