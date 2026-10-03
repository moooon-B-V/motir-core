import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceRole } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { toPageArchivedListItemDto } from '@/lib/mappers/pageMappers';
import { PageNotFoundError, emptyState, markdownToUpdate } from '@/lib/pages';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `pagesService`'s ARCHIVE on real Postgres (Story MOTIR-5755 · MOTIR-7421,
// `docs/decisions/pages.md` §7): archive and restore under `page:edit`, permanent
// delete under `page:delete` (Manager only), the Archived pages list under
// `page:view`, an archived page read with its state, every existing write door
// surfacing the package's archived-page refusal, and two races proved with real
// parallel transactions.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  workspaceId: string;
  projectId: string;
  otherProjectId: string;
  manager: ServiceContext;
  managerName: string;
}

async function makeUser(tag: string) {
  return usersService.createUser({
    email: `pages-archive-${tag}@example.com`,
    password: 'hunter2hunter2',
    name: `Archive ${tag}`,
  });
}

async function makeFixture(): Promise<Fixture> {
  const owner = await makeUser('owner');
  const ws = await workspacesService.createWorkspace({ name: 'Pages', ownerUserId: owner.id });
  const workspaceId = ws.workspace.id;
  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'Pages',
    identifier: 'PGS',
  });
  const other = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'Other',
    identifier: 'OTH',
  });
  return {
    workspaceId,
    projectId: project.id,
    otherProjectId: other.id,
    manager: { userId: owner.id, workspaceId },
    managerName: owner.name,
  };
}

async function memberAs(f: Fixture, tag: string, role: WorkspaceRole): Promise<ServiceContext> {
  const user = await makeUser(tag);
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: f.workspaceId, workspaceRole: role },
  });
  return { userId: user.id, workspaceId: f.workspaceId };
}

const create = (f: Fixture, title: string, parent?: { kind: string; id?: string }) =>
  pagesService.createPage(f.manager, { projectId: f.projectId, title, parent });

const act = (f: Fixture, pageId: string) => ({ projectId: f.projectId, pageId });

/** The page rows of one tree level (the project's default folders sit at the root too). */
async function levelPages(f: Fixture, ctx: ServiceContext, parent: { kind: string; id?: string }) {
  const level = await pagesService.listTreeLevel(ctx, { projectId: f.projectId, parent });
  return level.rows.filter((r) => r.kind === 'page').map((r) => r.id);
}

const refusal = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);

describe('pagesService.archivePage', () => {
  it('a Member archives a page with its live sub-pages, and the level omits them', async () => {
    const f = await makeFixture();
    const member = await memberAs(f, 'member', 'member');
    const keep = await create(f, 'Keep');
    const page = await create(f, 'Page');
    const sub = await create(f, 'Sub', { kind: 'page', id: page.id });

    const result = await pagesService.archivePage(member, act(f, page.id));
    expect(result).toEqual({ archivedIds: [page.id, sub.id], rootId: page.id, subPageCount: 1 });
    expect(await levelPages(f, member, { kind: 'root' })).toEqual([keep.id]);
    expect(await adminDb.page.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({
      archiveRootId: page.id,
      archivedById: member.userId,
    });
  });

  it('a Viewer is forbidden and nothing changes; another project’s page is not found', async () => {
    const f = await makeFixture();
    const viewer = await memberAs(f, 'viewer', 'viewer');
    const page = await create(f, 'Page');

    const err = await refusal(pagesService.archivePage(viewer, act(f, page.id)));
    expect(err).toBeInstanceOf(ProjectAccessDeniedError);
    expect(err).toMatchObject({ kind: 'edit' });
    expect(await adminDb.page.findUniqueOrThrow({ where: { id: page.id } })).toMatchObject({
      archivedAt: null,
    });

    const foreign = await refusal(
      pagesService.archivePage(f.manager, { projectId: f.otherProjectId, pageId: page.id }),
    );
    expect(foreign).toBeInstanceOf(PageNotFoundError);
  });

  it('a non-member is refused every archive door as not found (`browse`)', async () => {
    const f = await makeFixture();
    const page = await create(f, 'Page');
    const stranger = await makeUser('stranger');
    const ctx = { userId: stranger.id, workspaceId: f.workspaceId };
    for (const call of [
      () => pagesService.archivePage(ctx, act(f, page.id)),
      () => pagesService.restorePage(ctx, act(f, page.id)),
      () => pagesService.deletePage(ctx, act(f, page.id)),
      () => pagesService.listArchivedPages(ctx, { projectId: f.projectId }),
    ]) {
      const err = await refusal(call());
      expect(err).toBeInstanceOf(ProjectAccessDeniedError);
      expect((err as ProjectAccessDeniedError).kind).toBe('browse');
    }
  });
});

describe('pagesService.restorePage', () => {
  it('lands where it was when the parent survives, at its original position', async () => {
    const f = await makeFixture();
    const member = await memberAs(f, 'member', 'member');
    const first = await create(f, 'First');
    const page = await create(f, 'Page');
    const last = await create(f, 'Last');
    await pagesService.archivePage(member, act(f, page.id));
    expect(await levelPages(f, member, { kind: 'root' })).toEqual([first.id, last.id]);

    const restored = await pagesService.restorePage(member, act(f, page.id));
    expect(restored).toEqual({
      restoredIds: [page.id],
      landing: { kind: 'original', parentPageId: null, folderId: null, title: null },
    });
    expect(await levelPages(f, member, { kind: 'root' })).toEqual([first.id, page.id, last.id]);
    expect(await adminDb.page.findUniqueOrThrow({ where: { id: page.id } })).toMatchObject({
      position: page.position,
      archivedAt: null,
      archiveRootId: null,
      archivedById: null,
    });
  });

  it('lands under the nearest live ancestor when its parent was archived since', async () => {
    const f = await makeFixture();
    const member = await memberAs(f, 'member', 'member');
    const grand = await create(f, 'Grand');
    const parent = await create(f, 'Parent', { kind: 'page', id: grand.id });
    const page = await create(f, 'Page', { kind: 'page', id: parent.id });
    await pagesService.archivePage(member, act(f, page.id));
    await pagesService.archivePage(member, act(f, parent.id));

    const restored = await pagesService.restorePage(member, act(f, page.id));
    expect(restored.landing).toEqual({
      kind: 'ancestorPage',
      parentPageId: grand.id,
      folderId: null,
      title: 'Grand',
    });
    expect(await levelPages(f, member, { kind: 'page', id: grand.id })).toEqual([page.id]);
  });

  it('names the folder when it lands in one', async () => {
    const f = await makeFixture();
    const folder = await adminDb.folder.create({
      data: {
        workspaceId: f.workspaceId,
        projectId: f.projectId,
        name: 'Specs',
        position: 'a0',
        createdById: f.manager.userId,
      },
    });
    const page = await create(f, 'Page', { kind: 'folder', id: folder.id });
    await pagesService.archivePage(f.manager, act(f, page.id));
    const restored = await pagesService.restorePage(f.manager, act(f, page.id));
    expect(restored.landing).toEqual({
      kind: 'original',
      parentPageId: null,
      folderId: folder.id,
      title: 'Specs',
    });
  });
});

describe('pagesService.deletePage', () => {
  it('a Member is forbidden; a Manager is refused a live page, then deletes the set', async () => {
    const f = await makeFixture();
    const member = await memberAs(f, 'member', 'member');
    const page = await create(f, 'Page');
    const sub = await create(f, 'Sub', { kind: 'page', id: page.id });
    await pagesService.savePageUpdate(f.manager, {
      ...act(f, sub.id),
      update: markdownToUpdate(emptyState(), 'Draft'),
    });

    const forbidden = await refusal(pagesService.deletePage(member, act(f, page.id)));
    expect(forbidden).toBeInstanceOf(ProjectAccessDeniedError);
    expect(forbidden).toMatchObject({ kind: 'edit' });

    await expect(pagesService.deletePage(f.manager, act(f, page.id))).rejects.toMatchObject({
      code: 'PAGE_NOT_ARCHIVED',
    });

    await pagesService.archivePage(member, act(f, page.id));
    await expect(pagesService.deletePage(f.manager, act(f, sub.id))).rejects.toMatchObject({
      code: 'PAGE_ARCHIVE_ROOT_REQUIRED',
    });
    const ids = [page.id, sub.id];
    expect(await adminDb.pageVersion.count({ where: { pageId: { in: ids } } })).toBeGreaterThan(0);

    const result = await pagesService.deletePage(f.manager, act(f, page.id));
    expect([...result.deletedIds].sort()).toEqual([...ids].sort());
    expect(await adminDb.page.count({ where: { id: { in: ids } } })).toBe(0);
    expect(await adminDb.pageVersion.count({ where: { pageId: { in: ids } } })).toBe(0);
    for (const id of ids) {
      await expect(pagesService.getPage(f.manager, act(f, id))).rejects.toBeInstanceOf(
        PageNotFoundError,
      );
    }
  });
});

describe('pagesService.getPage — an archived page', () => {
  it('reads with its archive state, never editable, and only its root restores', async () => {
    const f = await makeFixture();
    const member = await memberAs(f, 'member', 'member');
    const page = await create(f, 'Root page');
    const sub = await create(f, 'Sub', { kind: 'page', id: page.id });

    const live = await pagesService.getPage(f.manager, act(f, page.id));
    expect(live).toMatchObject({
      canEdit: true,
      canDelete: true,
      canRestore: false,
      archivedAt: null,
      archiveRoot: null,
      archivedBy: null,
    });

    await pagesService.archivePage(member, act(f, page.id));
    const root = await pagesService.getPage(f.manager, act(f, page.id));
    const stored = await adminDb.page.findUniqueOrThrow({ where: { id: page.id } });
    expect(root).toMatchObject({
      archivedAt: stored.archivedAt!.toISOString(),
      archiveRoot: { id: page.id, title: 'Root page' },
      archivedBy: { id: member.userId, name: 'Archive member' },
      canEdit: false,
      canDelete: true,
      canRestore: true,
    });

    const child = await pagesService.getPage(member, act(f, sub.id));
    expect(child).toMatchObject({
      archiveRoot: { id: page.id, title: 'Root page' },
      canEdit: false,
      canDelete: false,
      canRestore: false,
    });
  });
});

describe('pagesService — every write door refuses an archived page', () => {
  it('save, rename, move and version restore are PAGE_ARCHIVED; create under it is PAGE_PARENT_ARCHIVED', async () => {
    const f = await makeFixture();
    const page = await create(f, 'Page');
    await pagesService.archivePage(f.manager, act(f, page.id));
    const before = await adminDb.page.findUniqueOrThrow({ where: { id: page.id } });

    await expect(
      pagesService.savePageUpdate(f.manager, {
        ...act(f, page.id),
        update: markdownToUpdate(emptyState(), 'x'),
      }),
    ).rejects.toMatchObject({ code: 'PAGE_ARCHIVED' });
    await expect(
      pagesService.renamePage(f.manager, { ...act(f, page.id), title: 'Renamed' }),
    ).rejects.toMatchObject({ code: 'PAGE_ARCHIVED' });
    await expect(
      pagesService.movePage(f.manager, { ...act(f, page.id), parent: { kind: 'root' } }),
    ).rejects.toMatchObject({ code: 'PAGE_ARCHIVED' });
    await expect(
      pagesService.restorePageVersion(f.manager, { ...act(f, page.id), number: 1 }),
    ).rejects.toMatchObject({ code: 'PAGE_ARCHIVED' });
    await expect(create(f, 'Child', { kind: 'page', id: page.id })).rejects.toMatchObject({
      code: 'PAGE_PARENT_ARCHIVED',
    });

    const after = await adminDb.page.findUniqueOrThrow({ where: { id: page.id } });
    expect(after).toMatchObject({ title: before.title, revision: before.revision });
  });
});

describe('pagesService.listArchivedPages', () => {
  it('roots newest first, with sub-page counts, the came-from trail and the archiver; a Viewer reads it', async () => {
    const f = await makeFixture();
    const member = await memberAs(f, 'member', 'member');
    const viewer = await memberAs(f, 'viewer', 'viewer');
    const outer = await adminDb.folder.create({
      data: {
        workspaceId: f.workspaceId,
        projectId: f.projectId,
        name: 'Outer',
        position: 'a0',
        createdById: f.manager.userId,
      },
    });
    const inner = await adminDb.folder.create({
      data: {
        workspaceId: f.workspaceId,
        projectId: f.projectId,
        parentFolderId: outer.id,
        name: 'Inner',
        position: 'a0',
        createdById: f.manager.userId,
      },
    });
    const top = await create(f, 'Top', { kind: 'folder', id: inner.id });
    const mid = await create(f, 'Mid', { kind: 'page', id: top.id });
    const deep = await create(f, 'Deep', { kind: 'page', id: mid.id });
    await create(f, 'Deep child', { kind: 'page', id: deep.id });
    const loose = await create(f, 'Loose');

    await pagesService.archivePage(member, act(f, deep.id));
    await pagesService.archivePage(f.manager, act(f, loose.id));
    // Newest first: `loose` was archived after `deep`; pin the order regardless
    // of how close the two clocks were.
    await adminDb.page.updateMany({
      where: { archiveRootId: deep.id },
      data: { archivedAt: new Date('2026-01-01T00:00:00.000Z') },
    });

    const first = await pagesService.listArchivedPages(viewer, {
      projectId: f.projectId,
      limit: 1,
    });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      id: loose.id,
      subPageCount: 0,
      archivedBy: { id: f.manager.userId, name: f.managerName },
      cameFrom: { folders: [], pages: [] },
    });
    expect(first.nextCursor).not.toBeNull();

    const second = await pagesService.listArchivedPages(viewer, {
      projectId: f.projectId,
      cursor: first.nextCursor,
    });
    expect(second.nextCursor).toBeNull();
    expect(second.items).toEqual([
      {
        id: deep.id,
        title: 'Deep',
        archivedAt: '2026-01-01T00:00:00.000Z',
        archivedBy: { id: member.userId, name: 'Archive member' },
        subPageCount: 1,
        parent: { kind: 'page', id: mid.id },
        ancestorPageIds: [top.id, mid.id],
        cameFrom: {
          folders: [
            { id: outer.id, name: 'Outer' },
            { id: inner.id, name: 'Inner' },
          ],
          pages: [
            { id: top.id, title: 'Top' },
            { id: mid.id, title: 'Mid' },
          ],
        },
        archivedAncestorIds: [],
      },
    ]);

    await expect(
      pagesService.listArchivedPages(viewer, { projectId: f.projectId, cursor: 'nope' }),
    ).rejects.toMatchObject({ code: 'PAGE_CURSOR_INVALID' });
  });

  it('marks a came-from ancestor that was archived after it (MOTIR-7424)', async () => {
    const f = await makeFixture();
    const top = await create(f, 'Top');
    const mid = await create(f, 'Mid', { kind: 'page', id: top.id });
    const deep = await create(f, 'Deep', { kind: 'page', id: mid.id });
    await pagesService.archivePage(f.manager, act(f, deep.id));
    await pagesService.archivePage(f.manager, act(f, mid.id));

    const { items } = await pagesService.listArchivedPages(f.manager, {
      projectId: f.projectId,
    });
    const row = items.find((i) => i.id === deep.id)!;
    expect(row.cameFrom.pages.map((p) => p.title)).toEqual(['Top', 'Mid']);
    expect(row.archivedAncestorIds).toEqual([mid.id]);
    expect(items.find((i) => i.id === mid.id)!.archivedAncestorIds).toEqual([]);
  });

  it('keeps a came-from slot for an ancestor that is gone, as an em dash', () => {
    const row = toPageArchivedListItemDto(
      {
        id: 'p',
        title: 'P',
        archivedAt: new Date('2026-01-01T00:00:00.000Z'),
        archivedById: null,
        subPageCount: 0,
        parentPageId: 'gone',
        folderId: null,
        ancestorPageIds: ['kept', 'gone'],
      },
      undefined,
      new Map([['kept', 'Kept']]),
      [],
    );
    expect(row.cameFrom.pages).toEqual([
      { id: 'kept', title: 'Kept' },
      { id: 'gone', title: '—' },
    ]);
    expect(row.archivedBy).toBeNull();
  });
});

describe('pagesService archive — real parallel transactions', () => {
  it('archive versus a move of its sub-page: the move wins or is refused, never both (×20)', async () => {
    const f = await makeFixture();
    const member = await memberAs(f, 'racer', 'member');
    for (let run = 0; run < 20; run++) {
      const page = await create(f, `Page ${run}`);
      const sub = await create(f, `Sub ${run}`, { kind: 'page', id: page.id });

      const [archived, moved] = await Promise.allSettled([
        pagesService.archivePage(f.manager, act(f, page.id)),
        pagesService.movePage(member, { ...act(f, sub.id), parent: { kind: 'root' } }),
      ]);
      expect(archived.status, `run ${run}: archive`).toBe('fulfilled');
      const row = await adminDb.page.findUniqueOrThrow({ where: { id: sub.id } });

      if (moved.status === 'fulfilled') {
        // The move won: the sub-page is live at the root, outside the set.
        expect(row, `run ${run}`).toMatchObject({
          parentPageId: null,
          archivedAt: null,
          archiveRootId: null,
        });
        expect(archived.status === 'fulfilled' && archived.value.archivedIds).toEqual([page.id]);
      } else {
        // The archive won: the move is refused, and the sub-page left with its parent.
        expect(moved.reason, `run ${run}`).toMatchObject({ code: 'PAGE_ARCHIVED' });
        expect(row, `run ${run}`).toMatchObject({ parentPageId: page.id, archiveRootId: page.id });
        expect(row.archivedAt).toBeInstanceOf(Date);
      }
    }
  });

  it('two restores of one root: one succeeds, the other is PAGE_NOT_ARCHIVED (×20)', async () => {
    const f = await makeFixture();
    const member = await memberAs(f, 'racer', 'member');
    const page = await create(f, 'Page');
    await create(f, 'Sub', { kind: 'page', id: page.id });
    for (let run = 0; run < 20; run++) {
      await pagesService.archivePage(member, act(f, page.id));
      const outcomes = await Promise.allSettled([
        pagesService.restorePage(f.manager, act(f, page.id)),
        pagesService.restorePage(member, act(f, page.id)),
      ]);
      const won = outcomes.filter((o) => o.status === 'fulfilled');
      const lost = outcomes.filter((o) => o.status === 'rejected');
      expect(won, `run ${run}`).toHaveLength(1);
      expect(lost[0]!.reason, `run ${run}`).toMatchObject({ code: 'PAGE_NOT_ARCHIVED' });
      expect(
        await adminDb.page.count({ where: { projectId: f.projectId, archivedAt: { not: null } } }),
      ).toBe(0);
    }
  });
});
