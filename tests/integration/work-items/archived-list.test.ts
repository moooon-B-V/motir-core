import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { truncateAuthTables } from '../../helpers/db';
import {
  makeWorkItemFixture as makeFixture,
  createTestWorkItem as createWorkItem,
} from '../../fixtures';

// The archived-items read path (Story 2.9 · Subtask 2.9.2) against a REAL
// Postgres (Yue's no-mocks rule). `workItemsService.listArchivedWorkItems` is
// the inverse of every active view's `archivedAt IS NULL` filter: a FLAT,
// `archivedAt DESC`, paginated page of the soft-deleted items, each carrying
// its `archivedAt` stamp + the actor who archived it (from the latest
// `'archived'` revision). These cover the only-archived filter, the
// archived-by/`archivedAt` projection, cross-workspace scope isolation,
// pagination + the page-size clamp, and the empty archive.

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

const ids = (rows: { identifier: string }[]) => rows.map((r) => r.identifier);

/** Force a known `archivedAt` so the DESC ordering is deterministic (the
 *  service stamps `now()` — distinct-millisecond ordering is too racy to
 *  assert on). The actor revision archiveWorkItem recorded is untouched. */
async function setArchivedAt(id: string, iso: string): Promise<void> {
  await db.workItem.update({ where: { id }, data: { archivedAt: new Date(iso) } });
}

describe('listArchivedWorkItems — only-archived projection + ordering', () => {
  it('returns ONLY archived items, archivedAt DESC; active items never appear', async () => {
    const fx = await makeFixture();
    const a = await createWorkItem(fx, { kind: 'task', title: 'A' });
    const b = await createWorkItem(fx, { kind: 'task', title: 'B' });
    const c = await createWorkItem(fx, { kind: 'task', title: 'C' });
    await createWorkItem(fx, { kind: 'task', title: 'D (stays active)' });

    await workItemsService.archiveWorkItem(a.id, fx.ctx);
    await workItemsService.archiveWorkItem(b.id, fx.ctx);
    await workItemsService.archiveWorkItem(c.id, fx.ctx);
    // b archived most recently, then c, then a (DESC by archivedAt).
    await setArchivedAt(a.id, '2026-06-01T00:00:00.000Z');
    await setArchivedAt(c.id, '2026-06-02T00:00:00.000Z');
    await setArchivedAt(b.id, '2026-06-03T00:00:00.000Z');

    const page = await workItemsService.listArchivedWorkItems(fx.projectId, {}, fx.ctx);

    expect(ids(page.items)).toEqual([b.identifier, c.identifier, a.identifier]);
    expect(page.total).toBe(3);
    // The active item D is absent.
    expect(ids(page.items)).not.toContain('PROD-4');
  });

  it('projects archivedAt + the archived-by actor from the latest archived revision', async () => {
    const fx = await makeFixture();
    const item = await createWorkItem(fx, { kind: 'story', title: 'archive me' });
    await workItemsService.archiveWorkItem(item.id, fx.ctx);

    const { items } = await workItemsService.listArchivedWorkItems(fx.projectId, {}, fx.ctx);

    expect(items).toHaveLength(1);
    const row = items[0]!;
    expect(row.identifier).toBe(item.identifier);
    expect(typeof row.archivedAt).toBe('string');
    expect(Number.isNaN(Date.parse(row.archivedAt))).toBe(false);
    // Resolved actor = the user who ran archiveWorkItem (the fixture owner).
    expect(row.archivedBy).toEqual({
      id: fx.owner.id,
      name: fx.owner.name,
      image: fx.owner.image ?? null,
    });
  });

  it('archivedBy is null when no archived revision recorded the actor', async () => {
    const fx = await makeFixture();
    const item = await createWorkItem(fx, { kind: 'task', title: 'soft-deleted sans revision' });
    // Soft-delete directly (no 'archived' revision) — the LATERAL pick finds no
    // author, so the view degrades to a "former member" fallback (null actor).
    await setArchivedAt(item.id, '2026-06-05T00:00:00.000Z');

    const { items } = await workItemsService.listArchivedWorkItems(fx.projectId, {}, fx.ctx);
    expect(items).toHaveLength(1);
    expect(items[0]!.archivedBy).toBeNull();
    expect(items[0]!.archivedAt).toBe(new Date('2026-06-05T00:00:00.000Z').toISOString());
  });
});

describe('listArchivedWorkItems — scope isolation', () => {
  it('is workspace-scoped: a cross-workspace project id is not-found, never a leak', async () => {
    const a = await makeFixture({ name: 'Acme', identifier: 'AAA' });
    const b = await makeFixture({ name: 'Beta', identifier: 'BBB' });
    const aItem = await createWorkItem(a, { kind: 'task', title: 'A archived' });
    const bItem = await createWorkItem(b, { kind: 'task', title: 'B archived' });
    await workItemsService.archiveWorkItem(aItem.id, a.ctx);
    await workItemsService.archiveWorkItem(bItem.id, b.ctx);

    // Workspace A's project, read with A's ctx → only A's archived item.
    const pageA = await workItemsService.listArchivedWorkItems(a.projectId, {}, a.ctx);
    expect(ids(pageA.items)).toEqual(['AAA-1']);

    // A's project id read with B's ctx → ProjectNotFound (a foreign id is
    // missing, not an empty list) — the canBrowse gate is reached only after
    // the tenant resolves.
    await expect(
      workItemsService.listArchivedWorkItems(a.projectId, {}, b.ctx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('listArchivedWorkItems — pagination + clamp', () => {
  it('pages by 50, holds the remainder on the last page, and clamps an over-range page', async () => {
    const fx = await makeFixture();
    // 52 archived → 2 pages (50 + 2).
    for (let i = 0; i < 52; i++) {
      const it = await createWorkItem(fx, { kind: 'task', title: `T${i}` });
      await workItemsService.archiveWorkItem(it.id, fx.ctx);
    }

    const p1 = await workItemsService.listArchivedWorkItems(fx.projectId, { page: 1 }, fx.ctx);
    expect({
      total: p1.total,
      page: p1.page,
      pageSize: p1.pageSize,
      count: p1.items.length,
    }).toEqual({ total: 52, page: 1, pageSize: 50, count: 50 });

    const p2 = await workItemsService.listArchivedWorkItems(fx.projectId, { page: 2 }, fx.ctx);
    expect({ page: p2.page, count: p2.items.length }).toEqual({ page: 2, count: 2 });

    // No row appears on both pages (OFFSET over a total order: archivedAt DESC,
    // key ASC tiebreak).
    const overlap = ids(p1.items).filter((id) => ids(p2.items).includes(id));
    expect(overlap).toEqual([]);

    // An out-of-range page clamps to the last page.
    const over = await workItemsService.listArchivedWorkItems(fx.projectId, { page: 99 }, fx.ctx);
    expect(over.page).toBe(2);
    expect(ids(over.items)).toEqual(ids(p2.items));
  });

  it('clamps a request pageSize above the cap to ISSUE_LIST_PAGE_SIZE', async () => {
    const fx = await makeFixture();
    const it = await createWorkItem(fx, { kind: 'task', title: 'one' });
    await workItemsService.archiveWorkItem(it.id, fx.ctx);

    const page = await workItemsService.listArchivedWorkItems(
      fx.projectId,
      { pageSize: 999 },
      fx.ctx,
    );
    expect(page.pageSize).toBe(50);
    expect(page.items).toHaveLength(1);
  });

  it('an empty archive paginates to total 0, page 1, no items', async () => {
    const fx = await makeFixture();
    // An ACTIVE item exists but nothing is archived.
    await createWorkItem(fx, { kind: 'task', title: 'active only' });

    const page = await workItemsService.listArchivedWorkItems(fx.projectId, {}, fx.ctx);
    expect(page).toEqual({ items: [], total: 0, page: 1, pageSize: 50 });
  });
});
