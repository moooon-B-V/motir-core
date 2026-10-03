import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { toPageArchivedRootDto, toPageDto, toLockedPageRow } from '@/lib/mappers/pageMappers';
import {
  archivePage,
  createPage,
  markdownToUpdate,
  emptyState,
  pageStoreFor,
  positionBetween,
  savePageUpdate,
  systemClock,
  type PagePlacement,
} from '@/lib/pages';
import {
  archivedRootsLimit,
  decodeArchivedRootsCursor,
  encodeArchivedRootsCursor,
} from '@/lib/pages/archivedRootsCursor';
import { folderRepository } from '@/lib/repositories/folderRepository';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { foldersService } from '@/lib/services/foldersService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Page ARCHIVE in the repository and the `PageStore` adapter, on real Postgres
// (Story MOTIR-5755 · MOTIR-7420, `docs/decisions/pages.md` §7). An archived page
// has LEFT THE TREE: every live read — a level, its `hasChildren`, a breadcrumb,
// the flat index, a level's positions, a folder's filed pages and its counts —
// skips it, each asserted against a live page at the same level. It stays
// reachable by id, by its archive set and by the Archived pages list. And the
// archive's own writes: the set written in one statement, deleted in one
// statement with its versions, and carried up by a folder delete.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Tenant {
  userId: string;
  workspaceId: string;
  projectId: string;
}

async function makeTenant(tag: string): Promise<Tenant> {
  const user = await usersService.createUser({
    email: `page-archive-${tag}@example.com`,
    password: 'hunter2hunter2',
    name: `Page Archive ${tag}`,
  });
  const ws = await workspacesService.createWorkspace({
    name: `Page Archive ${tag}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: ws.workspace.id,
    actorUserId: user.id,
    name: `Page Archive ${tag}`,
    identifier: `PR${tag.toUpperCase()}`,
  });
  return { userId: user.id, workspaceId: ws.workspace.id, projectId: project.id };
}

const inTenant = <T>(t: Tenant, fn: Parameters<typeof withWorkspaceContext<T>>[1]) =>
  withWorkspaceContext(
    { userId: t.userId, workspaceId: t.workspaceId, projectId: t.projectId },
    fn,
  );

const createUnder = (t: Tenant, parent: PagePlacement, title?: string) =>
  inTenant(t, (tx) =>
    createPage(pageStoreFor(tx), systemClock, {
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      actorId: t.userId,
      title,
      parent,
    }),
  );

const archive = (t: Tenant, pageId: string) =>
  inTenant(t, (tx) =>
    archivePage(pageStoreFor(tx), systemClock, {
      pageId,
      projectId: t.projectId,
      actorId: t.userId,
    }),
  );

async function makeFolder(t: Tenant, name: string, parentFolderId: string | null = null) {
  return adminDb.folder.create({
    data: {
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      parentFolderId,
      name,
      position: 'a0',
      createdById: t.userId,
    },
  });
}

const ROOT: PagePlacement = { kind: 'root' };

describe('pageRepository — every LIVE read skips an archived page', () => {
  it('a tree level, its hasChildren, the breadcrumb and the flat index', async () => {
    const t = await makeTenant('live');
    const live = await createUnder(t, ROOT, 'Live');
    const gone = await createUnder(t, ROOT, 'Gone');
    const child = await createUnder(t, { kind: 'page', pageId: live.id }, 'Child');
    const grandchild = await createUnder(t, { kind: 'page', pageId: child.id }, 'Grandchild');

    // Before: both root pages, and `live` has a child.
    const before = await inTenant(t, (tx) =>
      pageRepository.findLevelAfter(t.projectId, { kind: 'root' }, null, 10, tx),
    );
    expect(before.map((r) => [r.id, Boolean(r.hasChildren)])).toEqual([
      [live.id, true],
      [gone.id, false],
    ]);

    // Archive `gone`, and `child` WITH its sub-page — `live`'s only children.
    await archive(t, gone.id);
    expect([...(await archive(t, child.id)).archivedIds].sort()).toEqual(
      [child.id, grandchild.id].sort(),
    );

    const level = await inTenant(t, (tx) =>
      pageRepository.findLevelAfter(t.projectId, { kind: 'root' }, null, 10, tx),
    );
    expect(level.map((r) => [r.id, Boolean(r.hasChildren)])).toEqual([[live.id, false]]);
    const under = await inTenant(t, (tx) =>
      pageRepository.findLevelAfter(t.projectId, { kind: 'page', pageId: live.id }, null, 10, tx),
    );
    expect(under).toEqual([]);

    // A live child beside the archived one: the level returns it alone, and the
    // parent's expander comes back.
    const sibling = await createUnder(t, { kind: 'page', pageId: live.id }, 'Sibling');
    const underAgain = await inTenant(t, (tx) =>
      pageRepository.findLevelAfter(t.projectId, { kind: 'page', pageId: live.id }, null, 10, tx),
    );
    expect(underAgain.map((r) => r.id)).toEqual([sibling.id]);
    const levelAgain = await inTenant(t, (tx) =>
      pageRepository.findLevelAfter(t.projectId, { kind: 'root' }, null, 10, tx),
    );
    expect(levelAgain.map((r) => [r.id, Boolean(r.hasChildren)])).toEqual([[live.id, true]]);

    const trail = await inTenant(t, (tx) =>
      pageRepository.findTrailByIds([live.id, gone.id, child.id], tx),
    );
    expect(trail.map((r) => r.id)).toEqual([live.id]);

    const index = await inTenant(t, (tx) => pageRepository.listByProject(t.projectId, tx));
    expect(index.map((r) => r.id).sort()).toEqual([live.id, sibling.id].sort());
  });

  it('positions among live siblings only: a page created beside an archived last sibling', async () => {
    const t = await makeTenant('pos');
    const a = await createUnder(t, ROOT, 'A');
    const b = await createUnder(t, ROOT, 'B');
    const c = await createUnder(t, ROOT, 'C');
    await archive(t, c.id);

    const read = (fn: Parameters<typeof inTenant<unknown>>[1]) => inTenant(t, fn);
    expect(await read((tx) => pageRepository.lastPosition(t.projectId, ROOT, tx))).toBe(b.position);
    // Unnamed sides read the live level only.
    expect(
      await read((tx) => pageRepository.neighbourPositions(t.projectId, ROOT, null, null, tx)),
    ).toEqual({ before: b.position, after: null });
    expect(
      await read((tx) => pageRepository.neighbourPositions(t.projectId, ROOT, b.id, null, tx)),
    ).toEqual({ before: b.position, after: null });
    await archive(t, b.id);
    expect(
      await read((tx) => pageRepository.neighbourPositions(t.projectId, ROOT, a.id, null, tx)),
    ).toEqual({ before: a.position, after: null });
    const d = await createUnder(t, ROOT, 'D');
    expect(
      await read((tx) => pageRepository.neighbourPositions(t.projectId, ROOT, null, d.id, tx)),
    ).toEqual({ before: a.position, after: d.position });

    // D is minted from the live `a` alone — the very key the archived `b` keeps,
    // which is why a restore asks `positionTaken` (live only) before reusing one.
    expect(d.position).toBe(positionBetween(a.position, null));
    expect(d.position).toBe(b.position);
    const store = (fn: (s: ReturnType<typeof pageStoreFor>) => Promise<boolean>) =>
      inTenant(t, (tx) => fn(pageStoreFor(tx)));
    expect(await store((s) => s.positionTaken(t.projectId, ROOT, d.position))).toBe(true);
    expect(await store((s) => s.positionTaken(t.projectId, ROOT, c.position))).toBe(false);
  });

  it('a folder’s filed pages, its count, its tree hasChildren and its direct page count', async () => {
    const t = await makeTenant('fold');
    const mixed = await makeFolder(t, 'Mixed');
    const onlyArchived = await makeFolder(t, 'Only archived');
    const filedLive = await createUnder(t, { kind: 'folder', folderId: mixed.id }, 'Live');
    const filedGone = await createUnder(t, { kind: 'folder', folderId: mixed.id }, 'Gone');
    const lone = await createUnder(t, { kind: 'folder', folderId: onlyArchived.id }, 'Lone');
    await archive(t, filedGone.id);
    await archive(t, lone.id);

    expect(await inTenant(t, (tx) => pageRepository.findFiledInFolder(mixed.id, tx))).toEqual([
      { id: filedLive.id, position: filedLive.position },
    ]);
    expect(await inTenant(t, (tx) => pageRepository.countFiledInFolder(mixed.id, tx))).toBe(1);
    expect(await inTenant(t, (tx) => pageRepository.countFiledInFolder(onlyArchived.id, tx))).toBe(
      0,
    );

    const tree = await inTenant(t, (tx) =>
      folderRepository.findLevelForPages(t.projectId, null, null, 10, tx),
    );
    // The project's own default folders sit at this level too; the two here decide.
    const expander = new Map(tree.map((f) => [f.id, Boolean(f.hasChildren)]));
    expect([expander.get(mixed.id), expander.get(onlyArchived.id)]).toEqual([true, false]);

    const counts = await inTenant(t, (tx) =>
      folderRepository.countDirectContents([mixed.id, onlyArchived.id], tx),
    );
    expect(Object.fromEntries(counts.map((c) => [c.id, c.pageCount]))).toEqual({
      [mixed.id]: 1,
      [onlyArchived.id]: 0,
    });
  });
});

describe('pageRepository — the reads that still see an archived page', () => {
  it('findById, findWithBodyById, findSubtree and the archive set', async () => {
    const t = await makeTenant('rows');
    const root = await createUnder(t, ROOT, 'Root');
    const sub = await createUnder(t, { kind: 'page', pageId: root.id }, 'Sub');
    const { rootId } = await archive(t, root.id);
    expect(rootId).toBe(root.id);

    for (const id of [root.id, sub.id]) {
      const plain = await inTenant(t, (tx) => pageRepository.findById(id, tx));
      const withBody = await inTenant(t, (tx) => pageRepository.findWithBodyById(id, tx));
      for (const row of [plain, withBody]) {
        expect(row).toMatchObject({ id, archiveRootId: root.id, archivedById: t.userId });
        expect(row!.archivedAt).toBeInstanceOf(Date);
      }
    }

    const subtree = await inTenant(t, (tx) => pageRepository.findSubtree(root.id, tx));
    expect(subtree).toEqual([
      expect.objectContaining({ id: sub.id, archiveRootId: root.id, ancestorPageIds: [root.id] }),
    ]);
    const set = await inTenant(t, (tx) => pageStoreFor(tx).findArchiveSet(root.id));
    expect(set.map((p) => p.id).sort()).toEqual([root.id, sub.id].sort());
    expect(set.every((p) => p.archivedAt instanceof Date && p.archiveRootId === root.id)).toBe(
      true,
    );

    // The DTO carries the archive state; `archivedBy` is null on a live page.
    const locked = await inTenant(t, (tx) => pageRepository.findWithBodyById(sub.id, tx));
    expect(
      toPageDto(toLockedPageRow(locked!), { canEdit: true, canDelete: false }, 'Ann'),
    ).toMatchObject({
      archivedAt: locked!.archivedAt!.toISOString(),
      archiveRootId: root.id,
      archivedBy: { id: t.userId, name: 'Ann' },
    });
    expect(toPageDto(toLockedPageRow(locked!), { canEdit: true, canDelete: false })).toMatchObject({
      archivedBy: { id: t.userId, name: '' },
    });
  });

  it('setArchived writes the whole set in one statement and clears it back', async () => {
    const t = await makeTenant('set');
    const a = await createUnder(t, ROOT, 'A');
    const b = await createUnder(t, { kind: 'page', pageId: a.id }, 'B');
    const at = new Date('2026-10-03T09:00:00.000Z');
    expect(
      await inTenant(t, (tx) => pageRepository.setArchived([a.id, b.id], at, a.id, t.userId, tx)),
    ).toBe(2);
    expect(
      await adminDb.page.findMany({
        where: { id: { in: [a.id, b.id] } },
        select: { archivedAt: true, archiveRootId: true, archivedById: true },
      }),
    ).toEqual([
      { archivedAt: at, archiveRootId: a.id, archivedById: t.userId },
      { archivedAt: at, archiveRootId: a.id, archivedById: t.userId },
    ]);

    await inTenant(t, (tx) => pageStoreFor(tx).setArchived([a.id, b.id], null, null, null));
    expect(
      await adminDb.page.count({ where: { id: { in: [a.id, b.id] }, archivedAt: null } }),
    ).toBe(2);
    expect(await inTenant(t, (tx) => pageRepository.setArchived([], at, a.id, null, tx))).toBe(0);
  });
});

describe('pageRepository.deletePages — one statement, versions with it', () => {
  it('deletes a whole archive set and its page_version rows', async () => {
    const t = await makeTenant('del');
    const root = await createUnder(t, ROOT, 'Root');
    const sub = await createUnder(t, { kind: 'page', pageId: root.id }, 'Sub');
    const keep = await createUnder(t, ROOT, 'Keep');
    await inTenant(t, (tx) =>
      savePageUpdate(pageStoreFor(tx), systemClock, {
        pageId: sub.id,
        actorId: t.userId,
        update: markdownToUpdate(emptyState(), 'Draft'),
      }),
    );
    await archive(t, root.id);
    const ids = [root.id, sub.id];
    expect(await adminDb.pageVersion.count({ where: { pageId: { in: ids } } })).toBeGreaterThan(0);

    await inTenant(t, (tx) => pageStoreFor(tx).deletePages(ids));
    expect(await adminDb.page.count({ where: { id: { in: ids } } })).toBe(0);
    expect(await adminDb.pageVersion.count({ where: { pageId: { in: ids } } })).toBe(0);
    expect(await adminDb.page.count({ where: { id: keep.id } })).toBe(1);
    expect(await inTenant(t, (tx) => pageRepository.deletePages([], tx))).toBe(0);
  });

  it('a set that leaves a child pointing at a deleted parent fails and deletes nothing', async () => {
    const t = await makeTenant('fk');
    const parent = await createUnder(t, ROOT, 'Parent');
    const child = await createUnder(t, { kind: 'page', pageId: parent.id }, 'Child');

    await expect(inTenant(t, (tx) => pageRepository.deletePages([parent.id], tx))).rejects.toThrow(
      /page_parent_page_id_fkey/,
    );
    expect(await adminDb.page.count({ where: { id: { in: [parent.id, child.id] } } })).toBe(2);
  });
});

describe('pageRepository.listArchivedRoots — the Archived pages keyset read', () => {
  it('returns archive roots only, newest first, with their sub-page counts and placement', async () => {
    const t = await makeTenant('roots');
    const folder = await makeFolder(t, 'Specs');
    const big = await createUnder(t, { kind: 'folder', folderId: folder.id }, 'Big');
    const mid = await createUnder(t, { kind: 'page', pageId: big.id }, 'Mid');
    const leaf = await createUnder(t, { kind: 'page', pageId: mid.id }, 'Leaf');
    const loner = await createUnder(t, { kind: 'page', pageId: big.id }, 'Loner');
    // `loner` leaves on its own first; `big` then takes `mid` and `leaf` only.
    await archive(t, loner.id);
    await adminDb.page.update({
      where: { id: loner.id },
      data: { archivedAt: new Date('2026-01-01T00:00:00.000Z') },
    });
    await archive(t, big.id);
    await createUnder(t, ROOT, 'Still live');

    const { rows, nextCursor } = await inTenant(t, (tx) =>
      pageRepository.listArchivedRoots(t.projectId, {}, tx),
    );
    expect(nextCursor).toBeNull();
    expect(rows).toEqual([
      expect.objectContaining({
        id: big.id,
        title: 'Big',
        archivedById: t.userId,
        subPageCount: 2,
        parentPageId: null,
        folderId: folder.id,
        ancestorPageIds: [],
      }),
      expect.objectContaining({
        id: loner.id,
        subPageCount: 0,
        parentPageId: big.id,
        folderId: null,
        ancestorPageIds: [big.id],
      }),
    ]);
    expect(rows.map((r) => r.id)).not.toContain(leaf.id);

    expect(toPageArchivedRootDto(rows[1]!, undefined)).toEqual({
      id: loner.id,
      title: 'Loner',
      archivedAt: '2026-01-01T00:00:00.000Z',
      archivedBy: { id: t.userId, name: '' },
      subPageCount: 0,
      parent: { kind: 'page', id: big.id },
      ancestorPageIds: [big.id],
    });
    expect(toPageArchivedRootDto({ ...rows[0]!, archivedById: null }, 'x').archivedBy).toBeNull();
  });

  it('pages 120 roots as 50 / 50 / 20 with no overlap and no gap', async () => {
    const t = await makeTenant('keyset');
    const template = await createUnder(t, ROOT, 'Template');
    const row = await adminDb.page.findUniqueOrThrow({ where: { id: template.id } });
    await adminDb.page.delete({ where: { id: template.id } });
    const base = Date.parse('2026-09-01T00:00:00.000Z');
    // Three roots per instant, so the `id` tiebreak carries real weight.
    const ids = Array.from({ length: 120 }, (_, i) => `root-${String(i).padStart(3, '0')}`);
    await adminDb.page.createMany({
      data: ids.map((id, i) => ({
        ...row,
        bodyJson: row.bodyJson ?? {},
        id,
        title: id,
        position: `a${String(i).padStart(3, '0')}`,
        archivedAt: new Date(base + Math.floor(i / 3) * 1000),
        archiveRootId: id,
        archivedById: t.userId,
      })),
    });

    const pages: Array<{ ids: string[]; at: number[] }> = [];
    let cursor: string | null = null;
    do {
      const result = await inTenant(t, (tx) =>
        pageRepository.listArchivedRoots(t.projectId, { cursor }, tx),
      );
      pages.push({
        ids: result.rows.map((r) => r.id),
        at: result.rows.map((r) => r.archivedAt.getTime()),
      });
      cursor = result.nextCursor;
    } while (cursor !== null && pages.length < 5);

    expect(pages.map((p) => p.ids.length)).toEqual([50, 50, 20]);
    const all = pages.flatMap((p) => p.ids);
    expect(new Set(all).size).toBe(120);
    expect([...all].sort()).toEqual([...ids].sort());
    const times = pages.flatMap((p) => p.at);
    expect(times).toEqual([...times].sort((x, y) => y - x));

    // A page size of 100 is the cap, and a bigger ask is held to it.
    const capped = await inTenant(t, (tx) =>
      pageRepository.listArchivedRoots(t.projectId, { limit: 500 }, tx),
    );
    expect(capped.rows).toHaveLength(100);
  });

  it('refuses a malformed cursor with PAGE_CURSOR_INVALID', async () => {
    const t = await makeTenant('cursor');
    const bad = [
      'not base64 json',
      Buffer.from('{"a":1}').toString('base64url'),
      Buffer.from('["2026-01-01T00:00:00.000Z"]').toString('base64url'),
      Buffer.from('["yesterday","id"]').toString('base64url'),
      Buffer.from('["2026-01-01T00:00:00.000Z",""]').toString('base64url'),
      Buffer.from('[1,"id"]').toString('base64url'),
    ];
    for (const cursor of bad) {
      await expect(
        inTenant(t, (tx) => pageRepository.listArchivedRoots(t.projectId, { cursor }, tx)),
      ).rejects.toMatchObject({ code: 'PAGE_CURSOR_INVALID' });
    }
  });
});

describe('archivedRootsCursor — the codec', () => {
  it('round-trips the seek key and holds the page size to the tree level’s', () => {
    const key = { archivedAt: new Date('2026-10-03T10:00:00.123Z'), id: 'p1' };
    expect(decodeArchivedRootsCursor(encodeArchivedRootsCursor(key))).toEqual(key);
    expect(archivedRootsLimit()).toBe(50);
    expect(archivedRootsLimit(null)).toBe(50);
    expect(archivedRootsLimit(0)).toBe(1);
    expect(archivedRootsLimit(101)).toBe(100);
  });
});

describe('foldersService.deleteFolder — an archived filed page moves up, still archived', () => {
  it('beside a live filed page, and when the folder holds only archived pages', async () => {
    const t = await makeTenant('fdel');
    const ctx = { userId: t.userId, workspaceId: t.workspaceId };
    const parent = await makeFolder(t, 'Parent');
    const doomed = await makeFolder(t, 'Doomed', parent.id);
    const live = await createUnder(t, { kind: 'folder', folderId: doomed.id }, 'Live');
    const gone = await createUnder(t, { kind: 'folder', folderId: doomed.id }, 'Gone');
    await archive(t, gone.id);

    const result = await foldersService.deleteFolder(
      { projectId: t.projectId, folderId: doomed.id },
      ctx,
    );
    expect(result.movedPageIds).toEqual([live.id]);
    expect(await adminDb.folder.count({ where: { id: doomed.id } })).toBe(0);
    const goneRow = await adminDb.page.findUniqueOrThrow({ where: { id: gone.id } });
    expect(goneRow).toMatchObject({
      folderId: parent.id,
      parentPageId: null,
      position: gone.position,
      archiveRootId: gone.id,
    });
    expect(goneRow.archivedAt).toBeInstanceOf(Date);
    expect(await adminDb.page.findUniqueOrThrow({ where: { id: live.id } })).toMatchObject({
      folderId: parent.id,
      archivedAt: null,
    });

    // Only archived pages in the folder: no live page to place, and the delete
    // still lands, taking the archived page to the root.
    const lonely = await makeFolder(t, 'Lonely');
    const ghost = await createUnder(t, { kind: 'folder', folderId: lonely.id }, 'Ghost');
    await archive(t, ghost.id);
    const second = await foldersService.deleteFolder(
      { projectId: t.projectId, folderId: lonely.id },
      ctx,
    );
    expect(second.movedPageIds).toEqual([]);
    expect(await adminDb.page.findUniqueOrThrow({ where: { id: ghost.id } })).toMatchObject({
      folderId: null,
      archiveRootId: ghost.id,
    });
  });
});
