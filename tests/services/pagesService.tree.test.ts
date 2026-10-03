import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceRole } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { PageTreeRowDto } from '@/lib/dto/pages';
import {
  PAGE_DEPTH_LIMIT,
  PAGE_LEVEL_PAGE_SIZE_MAX,
  PageCycleError,
  PageDepthExceededError,
  PageFolderNotFoundError,
  PageLevelCursorInvalidError,
  PageNeighbourInvalidError,
  PageNotFoundError,
} from '@/lib/pages';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `pagesService`'s TREE on real Postgres (Story MOTIR-5753 · MOTIR-7370): the
// move in one transaction (a whole subtree re-parented, every refusal rolled
// back), the banded keyset level read (folders, then pages, one cursor across
// both), the breadcrumb trail, and two moves racing on two real connections.

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
}

async function makeUser(tag: string) {
  return usersService.createUser({
    email: `pages-tree-${tag}@example.com`,
    password: 'hunter2hunter2',
    name: `Pages Tree ${tag}`,
  });
}

async function makeFixture(): Promise<Fixture> {
  const owner = await makeUser('owner');
  const ws = await workspacesService.createWorkspace({ name: 'Tree', ownerUserId: owner.id });
  const workspaceId = ws.workspace.id;
  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'Tree',
    identifier: 'TRE',
  });
  const other = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'Other',
    identifier: 'OTR',
  });
  return {
    workspaceId,
    projectId: project.id,
    otherProjectId: other.id,
    manager: { userId: owner.id, workspaceId },
  };
}

async function memberAs(f: Fixture, tag: string, role: WorkspaceRole): Promise<ServiceContext> {
  const user = await makeUser(tag);
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: f.workspaceId, workspaceRole: role },
  });
  return { userId: user.id, workspaceId: f.workspaceId };
}

async function makeFolder(
  f: Fixture,
  name: string,
  opts: { parentFolderId?: string | null; position?: string; projectId?: string } = {},
) {
  return adminDb.folder.create({
    data: {
      workspaceId: f.workspaceId,
      projectId: opts.projectId ?? f.projectId,
      parentFolderId: opts.parentFolderId ?? null,
      name,
      position: opts.position ?? 'a0',
      createdById: f.manager.userId,
    },
  });
}

const createIn = (f: Fixture, parent: { kind: string; id?: string }, title?: string) =>
  pagesService.createPage(f.manager, { projectId: f.projectId, title, parent });

/** Every row of a level, walked page by page; returns the pages of rows too. */
async function walkLevel(
  f: Fixture,
  ctx: ServiceContext,
  parent: { kind: string; id?: string },
  limit?: number,
): Promise<PageTreeRowDto[][]> {
  const reads: PageTreeRowDto[][] = [];
  let cursor: string | null = null;
  do {
    const level = await pagesService.listTreeLevel(ctx, {
      projectId: f.projectId,
      parent,
      cursor,
      limit,
    });
    reads.push(level.rows);
    cursor = level.nextCursor;
  } while (cursor !== null && reads.length < 50);
  return reads;
}

const label = (row: PageTreeRowDto) => (row.kind === 'folder' ? row.name : row.title);

async function snapshot(projectId: string) {
  return adminDb.page.findMany({
    where: { projectId },
    select: {
      id: true,
      parentPageId: true,
      folderId: true,
      position: true,
      ancestorPageIds: true,
      updatedAt: true,
    },
    orderBy: { id: 'asc' },
  });
}

async function advisoryWaiters(): Promise<number> {
  const rows = await adminDb.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM pg_stat_activity
     WHERE datname = current_database()
       AND wait_event_type = 'Lock' AND wait_event = 'advisory'
  `;
  return Number(rows[0]!.n);
}

function latch(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

describe('pagesService.movePage — one transaction', () => {
  it('moves a page with a three-level subtree into a folder; every chain and trail follows', async () => {
    const f = await makeFixture();
    const outer = await makeFolder(f, 'Outer');
    const inner = await makeFolder(f, 'Inner', { parentFolderId: outer.id });
    const host = await createIn(f, { kind: 'root' }, 'Host');
    const top = await createIn(f, { kind: 'page', id: host.id }, 'Top');
    const child = await createIn(f, { kind: 'page', id: top.id }, 'Child');
    const grand = await createIn(f, { kind: 'page', id: child.id }, 'Grand');
    const great = await createIn(f, { kind: 'page', id: grand.id }, 'Great');

    const result = await pagesService.movePage(f.manager, {
      projectId: f.projectId,
      pageId: top.id,
      parent: { kind: 'folder', id: inner.id },
    });
    expect(result).toMatchObject({
      id: top.id,
      parent: { kind: 'folder', id: inner.id },
      ancestorPageIds: [],
      moved: true,
    });

    const byId = new Map((await snapshot(f.projectId)).map((r) => [r.id, r]));
    expect(byId.get(top.id)).toMatchObject({ folderId: inner.id, parentPageId: null });
    expect(byId.get(child.id)!.ancestorPageIds).toEqual([top.id]);
    expect(byId.get(grand.id)!.ancestorPageIds).toEqual([top.id, child.id]);
    expect(byId.get(great.id)!.ancestorPageIds).toEqual([top.id, child.id, grand.id]);

    const trail = await pagesService.getPageTrail(f.manager, {
      projectId: f.projectId,
      pageId: great.id,
    });
    expect(trail).toEqual({
      folders: [
        { id: outer.id, name: 'Outer' },
        { id: inner.id, name: 'Inner' },
      ],
      pages: [
        { id: top.id, title: 'Top' },
        { id: child.id, title: 'Child' },
        { id: grand.id, title: 'Grand' },
      ],
    });
    // The page it left no longer holds it.
    const hostLevel = await pagesService.listTreeLevel(f.manager, {
      projectId: f.projectId,
      parent: { kind: 'page', id: host.id },
    });
    expect(hostLevel).toEqual({ rows: [], nextCursor: null });
  });

  it('reports each parent kind: under a page, back to the root, and a no-op move', async () => {
    const f = await makeFixture();
    const a = await createIn(f, { kind: 'root' }, 'A');
    const b = await createIn(f, { kind: 'root' }, 'B');
    const bChild = await createIn(f, { kind: 'page', id: b.id }, 'B child');

    const under = await pagesService.movePage(f.manager, {
      projectId: f.projectId,
      pageId: a.id,
      parent: { kind: 'page', id: bChild.id },
    });
    expect(under).toMatchObject({
      parent: { kind: 'page', id: bChild.id },
      ancestorPageIds: [b.id, bChild.id],
      moved: true,
    });

    const back = await pagesService.movePage(f.manager, {
      projectId: f.projectId,
      pageId: a.id,
      parent: { kind: 'root' },
    });
    expect(back).toMatchObject({ parent: { kind: 'root' }, ancestorPageIds: [], moved: true });

    const again = await pagesService.movePage(f.manager, {
      projectId: f.projectId,
      pageId: a.id,
      parent: { kind: 'root' },
    });
    expect(again).toEqual({ ...back, moved: false });
  });

  it('reorders among siblings with a named neighbour', async () => {
    const f = await makeFixture();
    const folder = await makeFolder(f, 'Docs');
    const a = await createIn(f, { kind: 'folder', id: folder.id }, 'A');
    await createIn(f, { kind: 'folder', id: folder.id }, 'B');
    const c = await createIn(f, { kind: 'folder', id: folder.id }, 'C');

    const result = await pagesService.movePage(f.manager, {
      projectId: f.projectId,
      pageId: c.id,
      parent: { kind: 'folder', id: folder.id },
      afterId: a.id,
    });
    expect(result.moved).toBe(true);
    const [rows] = await walkLevel(f, f.manager, { kind: 'folder', id: folder.id });
    expect(rows!.map(label)).toEqual(['C', 'A', 'B']);
  });

  it('a cycle, a depth overrun, a cross-project parent and a bad neighbour each leave every row as it was', async () => {
    const f = await makeFixture();
    const a = await createIn(f, { kind: 'root' }, 'A');
    const aChild = await createIn(f, { kind: 'page', id: a.id }, 'A child');
    const aGrand = await createIn(f, { kind: 'page', id: aChild.id }, 'A grand');
    // A chain PAGE_DEPTH_LIMIT - 1 deep under `deep`: placing A's 3-level subtree there overruns.
    let deep = await createIn(f, { kind: 'root' }, 'D1');
    for (let level = 2; level <= PAGE_DEPTH_LIMIT - 1; level++) {
      deep = await createIn(f, { kind: 'page', id: deep.id }, `D${level}`);
    }
    const foreignFolder = await makeFolder(f, 'Foreign', { projectId: f.otherProjectId });
    const foreignPage = await pagesService.createPage(f.manager, {
      projectId: f.otherProjectId,
      title: 'Foreign',
    });
    const before = await snapshot(f.projectId);

    const refusals: Array<[() => Promise<unknown>, new (...args: never[]) => Error]> = [
      [
        () =>
          pagesService.movePage(f.manager, {
            projectId: f.projectId,
            pageId: a.id,
            parent: { kind: 'page', id: aGrand.id },
          }),
        PageCycleError,
      ],
      [
        () =>
          pagesService.movePage(f.manager, {
            projectId: f.projectId,
            pageId: a.id,
            parent: { kind: 'page', id: deep.id },
          }),
        PageDepthExceededError,
      ],
      [
        () =>
          pagesService.movePage(f.manager, {
            projectId: f.projectId,
            pageId: a.id,
            parent: { kind: 'folder', id: foreignFolder.id },
          }),
        // The other project's folder is invisible under the project-narrowed
        // context (`folder_project_narrow`), so it reads as missing — the
        // package's CROSS_PROJECT_PAGE_PARENT is its last line behind that.
        PageFolderNotFoundError,
      ],
      [
        () =>
          pagesService.movePage(f.manager, {
            projectId: f.projectId,
            pageId: a.id,
            parent: { kind: 'page', id: foreignPage.id },
          }),
        // Likewise `page_project_narrow`: a foreign page parent reads as missing.
        PageNotFoundError,
      ],
      [
        () =>
          pagesService.movePage(f.manager, {
            projectId: f.projectId,
            pageId: a.id,
            parent: { kind: 'root' },
            beforeId: aChild.id,
          }),
        PageNeighbourInvalidError,
      ],
      [
        () =>
          pagesService.movePage(f.manager, {
            projectId: f.projectId,
            pageId: foreignPage.id,
            parent: { kind: 'root' },
          }),
        PageNotFoundError,
      ],
    ];
    for (const [refusal, type] of refusals) {
      const err = await refusal().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(type);
    }
    expect(await snapshot(f.projectId)).toEqual(before);
  });

  it('refuses a work item as a parent', async () => {
    const f = await makeFixture();
    const a = await createIn(f, { kind: 'root' }, 'A');
    await expect(
      pagesService.movePage(f.manager, {
        projectId: f.projectId,
        pageId: a.id,
        parent: { kind: 'work_item', id: 'wi-1' },
      }),
    ).rejects.toMatchObject({ code: 'PAGE_PARENT_NOT_ALLOWED' });
  });
});

describe('pagesService.listTreeLevel — banded keyset paging', () => {
  it('a folder with 60 sub-folders and 60 pages pages 50 · 10+40 · 20, no row twice', async () => {
    const f = await makeFixture();
    const parent = await makeFolder(f, 'Parent');
    const pad = (n: number) => String(n).padStart(2, '0');
    await adminDb.folder.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        workspaceId: f.workspaceId,
        projectId: f.projectId,
        parentFolderId: parent.id,
        name: `F${pad(i + 1)}`,
        position: `a${pad(i + 1)}`,
        createdById: f.manager.userId,
      })),
    });
    for (let i = 1; i <= 60; i++)
      await createIn(f, { kind: 'folder', id: parent.id }, `P${pad(i)}`);

    const reads = await walkLevel(f, f.manager, { kind: 'folder', id: parent.id });
    expect(reads.map((r) => r.length)).toEqual([50, 50, 20]);
    const names = (from: number, to: number, prefix: string) =>
      Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${pad(from + i)}`);
    expect(reads[0]!.map(label)).toEqual(names(1, 50, 'F'));
    expect(reads[1]!.map(label)).toEqual([...names(51, 60, 'F'), ...names(1, 40, 'P')]);
    expect(reads[2]!.map(label)).toEqual(names(41, 60, 'P'));
    const ids = reads.flat().map((r) => `${r.kind}:${r.id}`);
    expect(new Set(ids).size).toBe(120);
  });

  it('a full folder band followed by pages hands over cleanly; limits are clamped', async () => {
    const f = await makeFixture();
    const parent = await makeFolder(f, 'Parent');
    await makeFolder(f, 'F1', { parentFolderId: parent.id, position: 'a1' });
    await makeFolder(f, 'F2', { parentFolderId: parent.id, position: 'a2' });
    await createIn(f, { kind: 'folder', id: parent.id }, 'P1');

    const reads = await walkLevel(f, f.manager, { kind: 'folder', id: parent.id }, 2);
    expect(reads.map((r) => r.map(label))).toEqual([['F1', 'F2'], ['P1']]);

    // 0 is clamped up to 1; over the cap is clamped down to the cap.
    const one = await pagesService.listTreeLevel(f.manager, {
      projectId: f.projectId,
      parent: { kind: 'folder', id: parent.id },
      limit: 0,
    });
    expect(one.rows.map(label)).toEqual(['F1']);
    const capped = await pagesService.listTreeLevel(f.manager, {
      projectId: f.projectId,
      parent: { kind: 'folder', id: parent.id },
      limit: PAGE_LEVEL_PAGE_SIZE_MAX + 50,
    });
    expect(capped).toMatchObject({ nextCursor: null });
    expect(capped.rows).toHaveLength(3);
  });

  it('a page level returns its sub-pages only, with hasChildren', async () => {
    const f = await makeFixture();
    const folder = await makeFolder(f, 'Shelf');
    const page = await createIn(f, { kind: 'folder', id: folder.id }, 'Page');
    const sub1 = await createIn(f, { kind: 'page', id: page.id }, 'Sub 1');
    await createIn(f, { kind: 'page', id: page.id }, 'Sub 2');
    await createIn(f, { kind: 'page', id: sub1.id }, 'Sub 1 child');

    const level = await pagesService.listTreeLevel(f.manager, {
      projectId: f.projectId,
      parent: { kind: 'page', id: page.id },
    });
    expect(level).toEqual({
      rows: [
        { kind: 'page', id: sub1.id, title: 'Sub 1', hasChildren: true },
        expect.objectContaining({ kind: 'page', title: 'Sub 2', hasChildren: false }),
      ],
      nextCursor: null,
    });

    // The folder holding it: no child folders, one page that has children.
    const folderLevel = await pagesService.listTreeLevel(f.manager, {
      projectId: f.projectId,
      parent: { kind: 'folder', id: folder.id },
    });
    expect(folderLevel.rows).toEqual([
      { kind: 'page', id: page.id, title: 'Page', hasChildren: true },
    ]);

    // At the root, the folder (which holds a page) leads the root pages.
    const rootPage = await createIn(f, { kind: 'root' }, 'Root page');
    const root = await walkLevel(f, f.manager, { kind: 'root' });
    const rows = root.flat();
    expect(rows).toContainEqual({
      kind: 'folder',
      id: folder.id,
      name: 'Shelf',
      hasChildren: true,
    });
    expect(rows[rows.length - 1]).toEqual({
      kind: 'page',
      id: rootPage.id,
      title: 'Root page',
      hasChildren: false,
    });
    expect(rows.findIndex((r) => r.kind === 'page')).toBe(rows.length - 1);
  });

  it('refuses a foreign or unknown parent as not found, and a forged cursor', async () => {
    const f = await makeFixture();
    const foreignFolder = await makeFolder(f, 'Foreign', { projectId: f.otherProjectId });
    const foreignPage = await pagesService.createPage(f.manager, { projectId: f.otherProjectId });
    const page = await createIn(f, { kind: 'root' }, 'Here');

    await expect(
      pagesService.listTreeLevel(f.manager, {
        projectId: f.projectId,
        parent: { kind: 'folder', id: foreignFolder.id },
      }),
    ).rejects.toBeInstanceOf(PageFolderNotFoundError);
    await expect(
      pagesService.listTreeLevel(f.manager, {
        projectId: f.projectId,
        parent: { kind: 'page', id: foreignPage.id },
      }),
    ).rejects.toBeInstanceOf(PageNotFoundError);
    await expect(
      pagesService.listTreeLevel(f.manager, {
        projectId: f.projectId,
        parent: { kind: 'root' },
        cursor: 'not-a-cursor',
      }),
    ).rejects.toBeInstanceOf(PageLevelCursorInvalidError);
    // Decodable, but not a cursor this service issues.
    const misshapen = Buffer.from(JSON.stringify(['page', 1, 'x'])).toString('base64url');
    await expect(
      pagesService.listTreeLevel(f.manager, {
        projectId: f.projectId,
        parent: { kind: 'root' },
        cursor: misshapen,
      }),
    ).rejects.toBeInstanceOf(PageLevelCursorInvalidError);
    // A folder-band cursor on a page level, which has no folder band.
    const folderCursor = Buffer.from(JSON.stringify(['folder', 'a0', 'x'])).toString('base64url');
    await expect(
      pagesService.listTreeLevel(f.manager, {
        projectId: f.projectId,
        parent: { kind: 'page', id: page.id },
        cursor: folderCursor,
      }),
    ).rejects.toBeInstanceOf(PageLevelCursorInvalidError);
    await expect(
      pagesService.listTreeLevel(f.manager, {
        projectId: f.projectId,
        parent: { kind: 'work_item', id: 'wi' },
      }),
    ).rejects.toMatchObject({ code: 'PAGE_PARENT_NOT_ALLOWED' });
  });
});

describe('pagesService.getPageTrail', () => {
  it('a root page has an empty trail; a folder-filed page names its folders only', async () => {
    const f = await makeFixture();
    const rootPage = await createIn(f, { kind: 'root' }, 'Root');
    expect(
      await pagesService.getPageTrail(f.manager, { projectId: f.projectId, pageId: rootPage.id }),
    ).toEqual({ folders: [], pages: [] });

    const outer = await makeFolder(f, 'Outer');
    const inner = await makeFolder(f, 'Inner', { parentFolderId: outer.id });
    const filed = await createIn(f, { kind: 'folder', id: inner.id }, 'Filed');
    const sub = await createIn(f, { kind: 'page', id: filed.id }, 'Sub');
    expect(
      await pagesService.getPageTrail(f.manager, { projectId: f.projectId, pageId: filed.id }),
    ).toEqual({
      folders: [
        { id: outer.id, name: 'Outer' },
        { id: inner.id, name: 'Inner' },
      ],
      pages: [],
    });
    expect(
      await pagesService.getPageTrail(f.manager, { projectId: f.projectId, pageId: sub.id }),
    ).toEqual({
      folders: [
        { id: outer.id, name: 'Outer' },
        { id: inner.id, name: 'Inner' },
      ],
      pages: [{ id: filed.id, title: 'Filed' }],
    });
  });

  it('a page of another project is not found', async () => {
    const f = await makeFixture();
    const foreign = await pagesService.createPage(f.manager, { projectId: f.otherProjectId });
    await expect(
      pagesService.getPageTrail(f.manager, { projectId: f.projectId, pageId: foreign.id }),
    ).rejects.toBeInstanceOf(PageNotFoundError);
  });
});

describe('pagesService tree — permissions', () => {
  it('a Viewer reads levels and trails and is refused createPage and movePage as `edit`', async () => {
    const f = await makeFixture();
    const viewer = await memberAs(f, 'viewer', 'viewer');
    const folder = await makeFolder(f, 'Shelf');
    const page = await createIn(f, { kind: 'folder', id: folder.id }, 'Page');
    const sub = await createIn(f, { kind: 'page', id: page.id }, 'Sub');

    const level = await pagesService.listTreeLevel(viewer, {
      projectId: f.projectId,
      parent: { kind: 'folder', id: folder.id },
    });
    expect(level.rows.map(label)).toEqual(['Page']);
    expect(
      await pagesService.getPageTrail(viewer, { projectId: f.projectId, pageId: sub.id }),
    ).toEqual({
      folders: [{ id: folder.id, name: 'Shelf' }],
      pages: [{ id: page.id, title: 'Page' }],
    });

    const before = await snapshot(f.projectId);
    const refusals = [
      () =>
        pagesService.createPage(viewer, {
          projectId: f.projectId,
          parent: { kind: 'page', id: page.id },
        }),
      () =>
        pagesService.movePage(viewer, {
          projectId: f.projectId,
          pageId: sub.id,
          parent: { kind: 'root' },
        }),
    ];
    for (const refusal of refusals) {
      const err = await refusal().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ProjectAccessDeniedError);
      expect((err as ProjectAccessDeniedError).kind).toBe('edit');
    }
    expect(await snapshot(f.projectId)).toEqual(before);
  });

  it('a non-member is refused every tree read and write as not found (`browse`)', async () => {
    const f = await makeFixture();
    const page = await createIn(f, { kind: 'root' }, 'Page');
    const stranger = await makeUser('stranger');
    const ctx = { userId: stranger.id, workspaceId: f.workspaceId };

    const calls = [
      () => pagesService.listTreeLevel(ctx, { projectId: f.projectId, parent: { kind: 'root' } }),
      () => pagesService.getPageTrail(ctx, { projectId: f.projectId, pageId: page.id }),
      () =>
        pagesService.movePage(ctx, {
          projectId: f.projectId,
          pageId: page.id,
          parent: { kind: 'root' },
        }),
      () => pagesService.createPage(ctx, { projectId: f.projectId, parent: { kind: 'root' } }),
    ];
    for (const call of calls) {
      const err = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ProjectAccessDeniedError);
      expect((err as ProjectAccessDeniedError).kind).toBe('browse');
    }
  });
});

describe('pagesService.movePage — concurrency, two real connections', () => {
  it('two moves reordering the same two siblings: each commits or is refused; the level stays a set', async () => {
    const f = await makeFixture();
    const member = await memberAs(f, 'mover', 'member');
    const folder = await makeFolder(f, 'Race');
    const a = await createIn(f, { kind: 'folder', id: folder.id }, 'A');
    const b = await createIn(f, { kind: 'folder', id: folder.id }, 'B');
    const c = await createIn(f, { kind: 'folder', id: folder.id }, 'C');
    const parent = { kind: 'folder', id: folder.id };

    // Hold the project's structure lock so both moves are parked on it together,
    // then release: they run one after the other on their own connections.
    const held = latch();
    const release = latch();
    const holder = withWorkspaceContext(
      { userId: f.manager.userId, workspaceId: f.workspaceId, projectId: f.projectId },
      async (tx) => {
        await pageRepository.lockStructure(f.projectId, tx);
        held.open();
        await release.opened;
      },
    );
    await held.opened;
    const settle = (p: Promise<unknown>) =>
      p.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    // A lands right after B; B lands right after A.
    const first = settle(
      pagesService.movePage(f.manager, {
        projectId: f.projectId,
        pageId: a.id,
        parent,
        beforeId: b.id,
      }),
    );
    const second = settle(
      pagesService.movePage(member, {
        projectId: f.projectId,
        pageId: b.id,
        parent,
        beforeId: a.id,
      }),
    );
    await expect.poll(advisoryWaiters).toBe(2);
    release.open();
    await holder;
    const outcomes = await Promise.all([first, second]);

    for (const outcome of outcomes) {
      if (!outcome.ok) expect(outcome.error).toBeInstanceOf(PageNeighbourInvalidError);
    }
    expect(outcomes.some((o) => o.ok)).toBe(true);

    const [rows] = await walkLevel(f, f.manager, parent);
    expect(rows!.map((r) => r.id).sort()).toEqual([a.id, b.id, c.id].sort());
    const positions = await adminDb.page.findMany({
      where: { folderId: folder.id },
      select: { position: true },
    });
    expect(new Set(positions.map((p) => p.position)).size).toBe(3);
  });
});
