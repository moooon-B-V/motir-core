import { Prisma, type WorkItemRevision } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { toWorkItemRevisionDto } from '@/lib/mappers/workItemRevisionMappers';
import type { CreateWorkItemInput } from '@/lib/dto/workItems';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';

// Service-layer integration tests for the work-item REVISION audit trail
// (Subtask 1.4.6) against a REAL Postgres (Yue's no-mocks rule — the single
// allowed spy here is a vi.spyOn on the revision repository to INJECT a
// mid-transaction failure for the atomicity proof, never to stub the DB).
//
// These lock in that every workItemsService write emits exactly one revision
// row, atomically with the mutation it describes, with the right changeKind +
// diff shape; that no-op writes emit nothing; that the create/revision pair
// rolls back together on failure; that listByWorkItem orders newest-first; and
// that the work_item_revision RLS policy isolates revisions by the parent work
// item's workspace (mirroring tests/work-item-rls.test.ts's prodect_app
// pattern, since the revision row has no workspaceId of its own).

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateAll();
});

afterEach(() => {
  // The atomicity test spies on workItemRevisionRepository.create; make sure
  // no spy survives into another test (belt-and-suspenders with beforeEach).
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

// makeFixture (the workspace/project/owner bundle) is the shared
// makeWorkItemFixture from tests/fixtures/ (Subtask 1.4.7); its superset
// return shape still exposes the { ownerId, workspaceId, projectId, ctx }
// fields these revision tests read.
const makeFixture = makeWorkItemFixture;

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

/** Typed view of a field-diff cell stored in a revision's JSON. */
type DiffCell = { from: unknown; to: unknown };
function diffOf(row: WorkItemRevision): Record<string, DiffCell> {
  return row.diff as Record<string, DiffCell>;
}

// ── created revision ──────────────────────────────────────────────────────

describe('createWorkItem — revision', () => {
  it('writes ONE "created" revision whose diff is the initial state (non-null fields as { from: null, to })', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      createInput(fx, { title: 'Born', descriptionMd: 'why', priority: 'high' }),
      fx.ctx,
    );

    const revs = await workItemRevisionRepository.listByWorkItem(created.id);
    expect(revs).toHaveLength(1);
    const rev = revs[0]!;
    expect(rev.changeKind).toBe('created');
    expect(rev.changedById).toBe(fx.ctx.userId);
    // changedAt is freshly minted — within the last second.
    expect(Date.now() - rev.changedAt.getTime()).toBeLessThan(1000);

    const diff = diffOf(rev);
    // Non-null fields present as { from: null, to: <value> }.
    expect(diff.title).toEqual({ from: null, to: 'Born' });
    expect(diff.descriptionMd).toEqual({ from: null, to: 'why' });
    expect(diff.priority).toEqual({ from: null, to: 'high' });
    expect(diff.kind).toEqual({ from: null, to: 'task' });
    expect(diff.reporterId).toEqual({ from: null, to: fx.ctx.userId });
    // Every recorded cell has a null `from` (the row had no prior state).
    for (const cell of Object.values(diff)) expect(cell.from).toBeNull();
    // Fields that were null/absent on the created row are omitted.
    expect(diff.assigneeId).toBeUndefined();
    expect(diff.explanationMd).toBeUndefined();
    expect(diff.dueDate).toBeUndefined();
  });

  it('maps a revision row to its DTO (ISO changedAt, narrowed changeKind)', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(createInput(fx), fx.ctx);
    const [rev] = await workItemRevisionRepository.listByWorkItem(created.id);
    const dto = toWorkItemRevisionDto(rev!);
    expect(dto.changeKind).toBe('created');
    expect(dto.workItemId).toBe(created.id);
    expect(dto.changedById).toBe(fx.ctx.userId);
    expect(dto.changedAt).toBe(rev!.changedAt.toISOString());
  });
});

// ── updated revision + no-op skip ───────────────────────────────────────────

describe('updateWorkItem — revision', () => {
  it('writes ONE "updated" revision with only the changed field in the diff', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      createInput(fx, { title: 'old', priority: 'medium' }),
      fx.ctx,
    );
    await workItemsService.updateWorkItem(created.id, { title: 'new' }, fx.ctx);

    const revs = await workItemRevisionRepository.listByWorkItem(created.id);
    // created + updated
    expect(revs.map((r) => r.changeKind)).toEqual(['updated', 'created']);
    const updatedRev = revs[0]!;
    const diff = diffOf(updatedRev);
    expect(diff.title).toEqual({ from: 'old', to: 'new' });
    // Unchanged fields are absent from the diff.
    expect(Object.keys(diff)).toEqual(['title']);
    expect(diff.priority).toBeUndefined();
  });

  // Subtask 1.4.7 gap-fill: the card's "update title + assigneeId → both in
  // the diff" case. A multi-field patch records every changed field (and only
  // changed fields) in one 'updated' revision.
  it('writes ONE "updated" revision capturing BOTH changed fields (title + assigneeId)', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      createInput(fx, { title: 'old' }),
      fx.ctx,
    );
    // assign to the owner (a valid workspace member) AND rename in one patch.
    await workItemsService.updateWorkItem(
      created.id,
      { title: 'new', assigneeId: fx.ownerId },
      fx.ctx,
    );

    const revs = await workItemRevisionRepository.listByWorkItem(created.id);
    expect(revs.map((r) => r.changeKind)).toEqual(['updated', 'created']);
    const diff = diffOf(revs[0]!);
    expect(diff.title).toEqual({ from: 'old', to: 'new' });
    expect(diff.assigneeId).toEqual({ from: null, to: fx.ownerId });
    expect(Object.keys(diff).sort()).toEqual(['assigneeId', 'title']);
  });

  it('an empty patch writes NO revision', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(createInput(fx), fx.ctx);
    await workItemsService.updateWorkItem(created.id, {}, fx.ctx);
    const revs = await workItemRevisionRepository.listByWorkItem(created.id);
    expect(revs).toHaveLength(1); // only the 'created' one
    expect(revs[0]!.changeKind).toBe('created');
  });

  it('a patch that assigns identical values (effective no-op) writes NO revision', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      createInput(fx, { title: 'same' }),
      fx.ctx,
    );
    await workItemsService.updateWorkItem(created.id, { title: 'same' }, fx.ctx);
    const revs = await workItemRevisionRepository.listByWorkItem(created.id);
    expect(revs).toHaveLength(1);
    expect(revs[0]!.changeKind).toBe('created');
  });

  it('explanationMd edit on an ai_draft auto-transitions source — diff captures BOTH changes', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      createInput(fx, { explanationMd: 'draft text', explanationSource: 'ai_draft' }),
      fx.ctx,
    );
    // Patch ONLY explanationMd; the state machine flips source to user_edited.
    await workItemsService.updateWorkItem(created.id, { explanationMd: 'human text' }, fx.ctx);

    const revs = await workItemRevisionRepository.listByWorkItem(created.id);
    const diff = diffOf(revs[0]!);
    expect(diff.explanationMd).toEqual({ from: 'draft text', to: 'human text' });
    expect(diff.explanationSource).toEqual({ from: 'ai_draft', to: 'user_edited' });
  });
});

// ── archived revision ───────────────────────────────────────────────────────

describe('archiveWorkItem — revision', () => {
  it('writes an "archived" revision with diff { archivedAt: { from: null, to: <timestamp> } }', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(createInput(fx), fx.ctx);
    const archived = await workItemsService.archiveWorkItem(created.id, fx.ctx);

    const revs = await workItemRevisionRepository.listByWorkItem(created.id);
    const rev = revs[0]!;
    expect(rev.changeKind).toBe('archived');
    const diff = diffOf(rev);
    expect(diff.archivedAt).toEqual({ from: null, to: archived.archivedAt });
    expect(archived.archivedAt).not.toBeNull();
  });

  it('writes an "unarchived" revision with diff { archivedAt: { from: <timestamp>, to: null } }', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(createInput(fx), fx.ctx);
    const archived = await workItemsService.archiveWorkItem(created.id, fx.ctx);
    const restored = await workItemsService.unarchiveWorkItem(created.id, fx.ctx);

    const revs = await workItemRevisionRepository.listByWorkItem(created.id);
    const rev = revs[0]!; // newest first
    expect(rev.changeKind).toBe('unarchived');
    const diff = diffOf(rev);
    expect(diff.archivedAt).toEqual({ from: archived.archivedAt, to: null });
    expect(restored.archivedAt).toBeNull();
  });
});

// ── findLatestArchivedActor (the 2.9.6 detail-banner data path) ──────────────

describe('findLatestArchivedActor', () => {
  it('resolves the actor of the latest "archived" revision (the banner WHO)', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(createInput(fx), fx.ctx);
    await workItemsService.archiveWorkItem(created.id, fx.ctx);

    const actor = await workItemRevisionRepository.findLatestArchivedActor(created.id);
    expect(actor?.id).toBe(fx.ctx.userId);
    // The display name + avatar ride the same read (joined from `user`).
    expect(actor).toHaveProperty('name');
    expect(actor).toHaveProperty('image');
  });

  it('takes the MOST RECENT "archived" revision when an item was re-archived', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(createInput(fx), fx.ctx);
    // Archive → restore → archive again: two "archived" revisions exist; the
    // method must pick the latest (it shares listByWorkItem's total order).
    await workItemsService.archiveWorkItem(created.id, fx.ctx);
    await workItemsService.unarchiveWorkItem(created.id, fx.ctx);
    await workItemsService.archiveWorkItem(created.id, fx.ctx);

    const archivedRevs = (await workItemRevisionRepository.listByWorkItem(created.id)).filter(
      (r) => r.changeKind === 'archived',
    );
    expect(archivedRevs).toHaveLength(2);

    const actor = await workItemRevisionRepository.findLatestArchivedActor(created.id);
    expect(actor?.id).toBe(fx.ctx.userId);
  });

  it('returns null for an item that has no "archived" revision (defensive)', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(createInput(fx), fx.ctx);
    // A live item: only a "created" revision, no "archived" one.
    const actor = await workItemRevisionRepository.findLatestArchivedActor(created.id);
    expect(actor).toBeNull();
  });
});

// ── link / unlink revisions (FROM item only) ─────────────────────────────────

describe('linkWorkItems / unlinkWorkItems — revisions', () => {
  it('is_blocked_by writes ONE "updated" revision on the FROM item; the TO item gets none', async () => {
    const fx = await makeFixture();
    const a = await workItemsService.createWorkItem(createInput(fx, { title: 'A' }), fx.ctx);
    const b = await workItemsService.createWorkItem(createInput(fx, { title: 'B' }), fx.ctx);

    await workItemsService.linkWorkItems(
      { fromId: a.id, toId: b.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    const aRevs = await workItemRevisionRepository.listByWorkItem(a.id);
    expect(aRevs.map((r) => r.changeKind)).toEqual(['updated', 'created']);
    expect(diffOf(aRevs[0]!).links).toEqual({ added: [{ toId: b.id, kind: 'is_blocked_by' }] });

    // The TO item only has its own 'created' revision — no link revision.
    const bRevs = await workItemRevisionRepository.listByWorkItem(b.id);
    expect(bRevs.map((r) => r.changeKind)).toEqual(['created']);
  });

  it('relates_to writes exactly ONE revision on the FROM item (the reciprocal link is bookkeeping, not an event)', async () => {
    const fx = await makeFixture();
    const a = await workItemsService.createWorkItem(createInput(fx, { title: 'A' }), fx.ctx);
    const b = await workItemsService.createWorkItem(createInput(fx, { title: 'B' }), fx.ctx);

    await workItemsService.linkWorkItems({ fromId: a.id, toId: b.id, kind: 'relates_to' }, fx.ctx);

    const aRevs = await workItemRevisionRepository.listByWorkItem(a.id);
    // Only ONE 'updated' revision despite the reciprocal B→A row being written.
    expect(aRevs.filter((r) => r.changeKind === 'updated')).toHaveLength(1);
    expect(diffOf(aRevs[0]!).links).toEqual({ added: [{ toId: b.id, kind: 'relates_to' }] });
    // B gets none from this action.
    const bRevs = await workItemRevisionRepository.listByWorkItem(b.id);
    expect(bRevs.map((r) => r.changeKind)).toEqual(['created']);
  });

  it('unlink writes an "updated" revision on the FROM item with diff { links: { removed } }', async () => {
    const fx = await makeFixture();
    const a = await workItemsService.createWorkItem(createInput(fx, { title: 'A' }), fx.ctx);
    const b = await workItemsService.createWorkItem(createInput(fx, { title: 'B' }), fx.ctx);
    const link = await workItemsService.linkWorkItems(
      { fromId: a.id, toId: b.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    await workItemsService.unlinkWorkItems(link.id, fx.ctx);

    const aRevs = await workItemRevisionRepository.listByWorkItem(a.id);
    // created + linked + unlinked
    expect(aRevs.map((r) => r.changeKind)).toEqual(['updated', 'updated', 'created']);
    expect(diffOf(aRevs[0]!).links).toEqual({ removed: [{ toId: b.id, kind: 'is_blocked_by' }] });
  });
});

// ── atomicity (load-bearing) ─────────────────────────────────────────────────

describe('atomicity — revision write failure rolls back the mutation', () => {
  it('createWorkItem: an injected failure in the revision write leaves NO work_item and NO revision', async () => {
    const fx = await makeFixture();

    // Inject a failure into the revision INSERT mid-transaction. createWorkItem
    // does: allocate key → insert work_item → recordRevision (this create). The
    // throw must roll the whole $transaction back, including the work_item
    // insert and the key allocation.
    const spy = vi
      .spyOn(workItemRevisionRepository, 'create')
      .mockRejectedValue(new Error('injected revision failure'));

    await expect(
      workItemsService.createWorkItem(createInput(fx, { title: 'Doomed' }), fx.ctx),
    ).rejects.toThrow('injected revision failure');

    expect(spy).toHaveBeenCalledTimes(1);

    // The work_item write rolled back — nothing landed in the project.
    const items = await workItemRepository.findByProjectFiltered(fx.projectId);
    expect(items).toEqual([]);
    // And no orphan revision row exists.
    const revCount = await db.workItemRevision.count();
    expect(revCount).toBe(0);

    spy.mockRestore();
  });

  // Subtask 1.4.7 gap-fill: the OTHER direction. The test above fails the
  // REVISION write and proves the work_item rolls back. This one fails the
  // WORK-ITEM write and proves no orphan revision is left behind — the
  // atomicity guarantee is symmetric.
  it('createWorkItem: an injected failure in the work_item write leaves NO revision and NO work_item', async () => {
    const fx = await makeFixture();

    // Inject a failure into the work_item INSERT. createWorkItem does:
    // allocate key → insert work_item (THIS throws) → recordRevision. The
    // revision write is never reached, and the $transaction rolls back the
    // key allocation too — so neither table gains a row.
    const spy = vi
      .spyOn(workItemRepository, 'create')
      .mockRejectedValue(new Error('injected work_item failure'));

    await expect(
      workItemsService.createWorkItem(createInput(fx, { title: 'Doomed' }), fx.ctx),
    ).rejects.toThrow('injected work_item failure');

    expect(spy).toHaveBeenCalledTimes(1);

    // No revision orphaned (the revision write never ran), and no work_item.
    const revCount = await db.workItemRevision.count();
    expect(revCount).toBe(0);
    const items = await workItemRepository.findByProjectFiltered(fx.projectId);
    expect(items).toEqual([]);

    spy.mockRestore();
  });

  // Subtask 1.4.7 gap-fill: the update flow's atomicity. A revision-write
  // failure mid-UPDATE must roll back the field change too — the work_item
  // keeps its prior value and gains no 'updated' revision.
  it('updateWorkItem: an injected failure in the revision write rolls back the field change', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(
      createInput(fx, { title: 'Before' }),
      fx.ctx,
    );

    // Let the 'created' revision land, then fail the NEXT revision write (the
    // 'updated' one). The mutation it accompanies must roll back with it.
    const spy = vi
      .spyOn(workItemRevisionRepository, 'create')
      .mockRejectedValueOnce(new Error('injected revision failure on update'));

    await expect(
      workItemsService.updateWorkItem(created.id, { title: 'After' }, fx.ctx),
    ).rejects.toThrow('injected revision failure on update');

    // The title is unchanged (the work_item update rolled back).
    const row = await workItemRepository.findById(created.id);
    expect(row?.title).toBe('Before');
    // Only the original 'created' revision survives — no 'updated' orphan.
    const revs = await workItemRevisionRepository.listByWorkItem(created.id);
    expect(revs.map((r) => r.changeKind)).toEqual(['created']);

    spy.mockRestore();
  });
});

// ── listByWorkItem ordering ──────────────────────────────────────────────────

describe('listByWorkItem — ordering', () => {
  it('returns revisions newest-first (changedAt DESC)', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(createInput(fx, { title: 'v1' }), fx.ctx);
    await workItemsService.updateWorkItem(created.id, { title: 'v2' }, fx.ctx);
    await workItemsService.archiveWorkItem(created.id, fx.ctx);

    const revs = await workItemRevisionRepository.listByWorkItem(created.id);
    expect(revs.map((r) => r.changeKind)).toEqual(['archived', 'updated', 'created']);
    // changedAt is non-increasing down the list.
    for (let i = 1; i < revs.length; i += 1) {
      expect(revs[i - 1]!.changedAt.getTime()).toBeGreaterThanOrEqual(revs[i]!.changedAt.getTime());
    }
  });

  // Subtask 1.4.7 coverage-fill: the cursor-pagination branch of
  // listByWorkItem (skip the row AT the cursor and resume after it).
  it('resumes after a cursor, skipping the cursor row', async () => {
    const fx = await makeFixture();
    const created = await workItemsService.createWorkItem(createInput(fx, { title: 'v1' }), fx.ctx);
    await workItemsService.updateWorkItem(created.id, { title: 'v2' }, fx.ctx);
    await workItemsService.archiveWorkItem(created.id, fx.ctx);

    // The three revisions are written within the same millisecond, so their
    // `changedAt` values tie — which (before PRODECT_FINDINGS #38 added the
    // `id` secondary sort) made the newest-first order non-deterministic under
    // load. Stamp DISTINCT timestamps so this assertion is independent of both
    // timing and id ordering; the secondary sort is the production safety net.
    const base = Date.UTC(2026, 0, 1);
    await db.workItemRevision.updateMany({
      where: { workItemId: created.id, changeKind: 'created' },
      data: { changedAt: new Date(base) },
    });
    await db.workItemRevision.updateMany({
      where: { workItemId: created.id, changeKind: 'updated' },
      data: { changedAt: new Date(base + 1000) },
    });
    await db.workItemRevision.updateMany({
      where: { workItemId: created.id, changeKind: 'archived' },
      data: { changedAt: new Date(base + 2000) },
    });

    const all = await workItemRevisionRepository.listByWorkItem(created.id);
    expect(all.map((r) => r.changeKind)).toEqual(['archived', 'updated', 'created']);

    // Page after the newest ('archived') revision → the next two, in order.
    const afterFirst = await workItemRevisionRepository.listByWorkItem(created.id, {
      cursor: all[0]!.id,
    });
    expect(afterFirst.map((r) => r.changeKind)).toEqual(['updated', 'created']);

    // Cap the page size.
    const firstOnly = await workItemRevisionRepository.listByWorkItem(created.id, { take: 1 });
    expect(firstOnly.map((r) => r.changeKind)).toEqual(['archived']);
  });
});

// ── RLS isolation (prodect_app, mirrors tests/work-item-rls.test.ts) ─────────

/**
 * Run `fn` inside a transaction that binds the user/workspace/project GUCs the
 * RLS policies read and drops to the non-bypass `prodect_app` role for the
 * duration (the role switch is what makes RLS bite — the dev/CI superuser has
 * BYPASSRLS). Local copy of the helper in tests/work-item-rls.test.ts; the RLS
 * suites each carry their own copy.
 */
async function asAppRole<T>(
  ctx: { userId?: string; workspaceId?: string; projectId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    if (ctx.projectId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.project_id', ${ctx.projectId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE prodect_app');
    return fn(tx);
  });
}

interface RevisionTenants {
  userAId: string;
  workspaceW1Id: string;
  itemW1Id: string;
  revW1Id: string;
  workspaceW2Id: string;
  itemW2Id: string;
  revW2Id: string;
}

// Two tenants, each with one work item created via the real service (so each
// already carries a 'created' revision). Built as the superuser (RLS inert),
// which is how production's middleware-bound writes also reach the DB.
async function makeRevisionTenants(): Promise<RevisionTenants> {
  const fxA = await makeFixture({ identifier: 'WONE', name: 'WS One' });
  const fxB = await makeFixture({ identifier: 'WTWO', name: 'WS Two' });
  const itemA = await workItemsService.createWorkItem(
    createInput(fxA, { title: 'A-item' }),
    fxA.ctx,
  );
  const itemB = await workItemsService.createWorkItem(
    createInput(fxB, { title: 'B-item' }),
    fxB.ctx,
  );
  const [revA] = await workItemRevisionRepository.listByWorkItem(itemA.id);
  const [revB] = await workItemRevisionRepository.listByWorkItem(itemB.id);
  return {
    userAId: fxA.ownerId,
    workspaceW1Id: fxA.workspaceId,
    itemW1Id: itemA.id,
    revW1Id: revA!.id,
    workspaceW2Id: fxB.workspaceId,
    itemW2Id: itemB.id,
    revW2Id: revB!.id,
  };
}

describe('work_item_revision RLS — read isolation', () => {
  it('with the W1 GUC bound, W1 revisions are visible', async () => {
    const fx = await makeRevisionTenants();
    const rows = await asAppRole(
      { userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: '' },
      (tx) => tx.workItemRevision.findMany({ where: { workItemId: fx.itemW1Id } }),
    );
    expect(rows.map((r) => r.id)).toEqual([fx.revW1Id]);
  });

  it("tenant A (W1 GUC) cannot SELECT tenant B's revisions — even by explicit id", async () => {
    const fx = await makeRevisionTenants();
    const byWorkItem = await asAppRole(
      { userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: '' },
      (tx) => tx.workItemRevision.findMany({ where: { workItemId: fx.itemW2Id } }),
    );
    expect(byWorkItem).toEqual([]);

    const byId = await asAppRole(
      { userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: '' },
      (tx) => tx.workItemRevision.findMany({ where: { id: fx.revW2Id } }),
    );
    expect(byId).toEqual([]);
  });

  it('with NO GUC set, prodect_app sees zero revisions', async () => {
    await makeRevisionTenants();
    const rows = await asAppRole({}, (tx) => tx.workItemRevision.findMany());
    expect(rows).toEqual([]);
  });
});

describe('work_item_revision RLS — write isolation (WITH CHECK)', () => {
  it("INSERT of a revision pointing at W2's work item while bound to W1 is denied (42501)", async () => {
    const fx = await makeRevisionTenants();
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceW1Id, projectId: '' }, (tx) =>
        tx.workItemRevision.create({
          data: {
            workItemId: fx.itemW2Id, // foreign work item — fails WITH CHECK
            changedById: fx.userAId,
            changeKind: 'updated',
            diff: { smuggled: true },
          },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });

    // Sanity (superuser): nothing landed against W2's item beyond its own
    // 'created' revision.
    const w2revs = await workItemRevisionRepository.listByWorkItem(fx.itemW2Id);
    expect(w2revs.map((r) => r.changeKind)).toEqual(['created']);
  });
});
