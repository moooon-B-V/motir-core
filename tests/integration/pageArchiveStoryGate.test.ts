import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRole } from '@/generated/prisma/client';

// STORY MOTIR-5755's INTEGRATION GATE (MOTIR-7425) — ARCHIVE, RESTORE and DELETE
// of a page, assembled, on real Postgres, through the real doors.
//
// Each card of the story tested its own layer with the next one faked: the
// package's procedures over an in-memory store (MOTIR-7418), the repository's
// reads and writes (MOTIR-7420), the service on Postgres (MOTIR-7421), the
// routes with the service real (MOTIR-7422), the UI with `fetch` stubbed. What
// none of them could see is the SEAMS — the foreign-key order of a set's delete,
// its cascade to `page_version`, the attachment sweep after it, every rung of
// the restore ladder read back through the tree, the lock order under
// contention, and the row-level policies. This file drives each of those:
//
//   1  archive → delete of a three-level subtree with versions and an image:
//      no page and no version of the set survives, and the image surfaces in
//      `attachmentRepository.listOrphans` once past the safety window;
//   2  every restore landing (`docs/decisions/pages.md` §7 + AMENDMENT 2), the
//      package's ladder driven through `pagesService.restorePage`, each one read
//      back by `listTreeLevel` and `getPageTrail`;
//   3  the read sweep: with an archived page beside a live one at every level,
//      no tree read the app makes returns it;
//   4  three races on two connections, ×20 each, every outcome one the service
//      card names, and no page ever half in an archive set;
//   5  the role matrix of ADR §5 through the routes, and a public project's
//      visitor at the service (no page route admits one);
//   6  row-level isolation: another workspace's context sees and deletes nothing.
//
// Mocked, and only these: the session and the active project (`getSession`,
// `getActiveProject`), which need cookies — the pattern
// `pagesTreeStoryGate.test.ts` and `tests/api/pages-archive-routes.test.ts` set.

interface Actor {
  userId: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
}

const actor = vi.hoisted(() => ({ current: null as Actor | null }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => (actor.current ? { user: { id: actor.current.userId } } : null)),
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: vi.fn(async () =>
    actor.current ? { ...actor.current, project: { identifier: actor.current.projectKey } } : null,
  ),
}));

const { POST: ARCHIVE, DELETE: RESTORE } = await import('@/app/api/pages/[pageId]/archive/route');
const { DELETE: DESTROY } = await import('@/app/api/pages/[pageId]/route');
const { GET: ARCHIVED } = await import('@/app/api/pages/archived/route');
const { pagesService } = await import('@/lib/services/pagesService');
const { foldersService } = await import('@/lib/services/foldersService');
const { projectsService } = await import('@/lib/services/projectsService');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { ORPHAN_SAFETY_WINDOW_MS } = await import('@/lib/services/attachmentsService');
const { pageRepository } = await import('@/lib/repositories/pageRepository');
const { attachmentRepository } = await import('@/lib/repositories/attachmentRepository');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { PageNotFoundError, emptyState, markdownToUpdate } = await import('@/lib/pages');
const { projectAccessData } = await import('../helpers/projectAccess');
const { visitorServiceContext } = await import('@/lib/visitor/context');
const { VISITOR_PERMISSIONS } = await import('@/lib/permissions/builtinRoles');
const { ProjectAccessDeniedError } = await import('@/lib/projects/errors');
const { db } = await import('@/lib/db');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

const BASE = 'http://localhost:3000/api/pages';

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "attachment", "page", "folder" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  actor.current = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

let seq = 0;
async function makeUser(tag: string) {
  seq += 1;
  return usersService.createUser({
    email: `page-archive-gate-${tag}-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Archive gate ${tag}`,
  });
}

interface Tenant {
  workspaceId: string;
  projectId: string;
  owner: Actor;
}

async function makeTenant(tag: string, key: string): Promise<Tenant> {
  const owner = await makeUser(tag);
  const ws = await workspacesService.createWorkspace({ name: tag, ownerUserId: owner.id });
  const workspaceId = ws.workspace.id;
  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: `${tag} project`,
    identifier: key,
  });
  // Project creation seeds starter pages; the levels below are exactly the test's.
  await adminDb.page.deleteMany({ where: { workspaceId } });
  return {
    workspaceId,
    projectId: project.id,
    owner: { userId: owner.id, workspaceId, projectId: project.id, projectKey: key },
  };
}

async function memberOf(t: Tenant, tag: string, role: WorkspaceRole): Promise<Actor> {
  const user = await makeUser(tag);
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: t.workspaceId, workspaceRole: role },
  });
  return { ...t.owner, userId: user.id };
}

const svc = (a: Actor) => ({ userId: a.userId, workspaceId: a.workspaceId });
const on = (t: Tenant, pageId: string) => ({ projectId: t.projectId, pageId });

type Parent = { kind: 'root' } | { kind: 'folder' | 'page'; id: string };

async function page(t: Tenant, title: string, parent?: Parent): Promise<string> {
  const created = await pagesService.createPage(svc(t.owner), {
    projectId: t.projectId,
    title,
    parent,
  });
  return created.id;
}

const folder = (t: Tenant, name: string, parentFolderId: string | null = null) =>
  foldersService.createFolder({ projectId: t.projectId, parentFolderId, name }, svc(t.owner));

/** Save a body through the real save door — which is what writes a `page_version`. */
async function write(t: Tenant, pageId: string, markdown: string) {
  await pagesService.savePageUpdate(svc(t.owner), {
    ...on(t, pageId),
    update: markdownToUpdate(emptyState(), markdown),
  });
}

/** The page rows of one level, as `/pages` reads it (the default folders filtered out). */
async function levelPages(t: Tenant, parent: Parent): Promise<string[]> {
  const level = await pagesService.listTreeLevel(svc(t.owner), {
    projectId: t.projectId,
    parent,
  });
  return level.rows.filter((r) => r.kind === 'page').map((r) => r.id);
}

async function levelRow(t: Tenant, parent: Parent, id: string) {
  const level = await pagesService.listTreeLevel(svc(t.owner), {
    projectId: t.projectId,
    parent,
  });
  return level.rows.find((r) => r.id === id);
}

const trail = (t: Tenant, pageId: string) => pagesService.getPageTrail(svc(t.owner), on(t, pageId));

async function pageRow(id: string) {
  return adminDb.page.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      parentPageId: true,
      folderId: true,
      ancestorPageIds: true,
      position: true,
      archivedAt: true,
      archiveRootId: true,
    },
  });
}

/**
 * No page is ever HALF in an archive set. A live page carries no root and sits
 * under a live parent; an archived page names a root that is itself an archived
 * root, and is that root or one of its descendants. Every stored chain is the
 * walked one.
 */
async function expectSetsWhole(projectId: string, label: string) {
  const rows = await adminDb.page.findMany({
    where: { projectId },
    select: {
      id: true,
      parentPageId: true,
      ancestorPageIds: true,
      archivedAt: true,
      archiveRootId: true,
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const row of rows) {
    const parent = row.parentPageId ? byId.get(row.parentPageId) : null;
    expect(row.ancestorPageIds, label).toEqual(
      parent ? [...parent.ancestorPageIds, parent.id] : [],
    );
    if (row.archivedAt === null) {
      expect(row.archiveRootId, label).toBeNull();
      if (parent) expect(parent.archivedAt, `${label}: live under archived`).toBeNull();
    } else {
      const root = byId.get(row.archiveRootId!);
      expect(root, label).toBeDefined();
      expect(root!.archiveRootId, label).toBe(root!.id);
      expect(root!.archivedAt, label).not.toBeNull();
      if (row.id !== root!.id) expect(row.ancestorPageIds, label).toContain(root!.id);
    }
  }
}

// ── The doors, as the UI calls them ──────────────────────────────────────────

const params = (pageId: string) => ({ params: Promise.resolve({ pageId }) });
const archiveRoute = (pageId: string) =>
  ARCHIVE(new Request(`${BASE}/${pageId}/archive`, { method: 'POST' }), params(pageId));
const restoreRoute = (pageId: string) =>
  RESTORE(new Request(`${BASE}/${pageId}/archive`, { method: 'DELETE' }), params(pageId));
const deleteRoute = (pageId: string) =>
  DESTROY(new Request(`${BASE}/${pageId}`, { method: 'DELETE' }), params(pageId));
const listRoute = () => ARCHIVED(new Request(`${BASE}/archived`));

// ── 1 — archive, then delete: the FK order, the cascade, the sweep ───────────

describe('seam 1 — archive then delete a three-level subtree with versions and an image', () => {
  it('leaves no page and no version of the set, and its image surfaces as an orphan past the window', async () => {
    const t = await makeTenant('delete', 'DLT');
    const specs = await folder(t, 'Specs');
    const top = await page(t, 'Top', { kind: 'folder', id: specs.id });
    const mid = await page(t, 'Mid', { kind: 'page', id: top });
    const deep = await page(t, 'Deep', { kind: 'page', id: mid });
    const stays = await page(t, 'Stays', { kind: 'folder', id: specs.id });
    for (const [id, body] of [
      [top, 'Top body'],
      [mid, 'Mid body'],
      [deep, 'Deep body'],
      [stays, 'Stays body'],
    ] as const) {
      await write(t, id, body);
    }
    const set = [top, mid, deep];
    expect(await adminDb.pageVersion.count({ where: { pageId: { in: set } } })).toBe(3);

    // An image pasted into the deepest page, and one into the page that stays.
    const image = (pageId: string, name: string) =>
      adminDb.attachment.create({
        data: {
          workspaceId: t.workspaceId,
          pageId,
          uploaderUserId: t.owner.userId,
          blobPathname: `attachments/${t.workspaceId}/${name}`,
          mimeType: 'image/png',
          sizeBytes: 8,
          originalFilename: name,
        },
      });
    const doomedImage = await image(deep, 'deep.png');
    const keptImage = await image(stays, 'stays.png');

    const archived = await pagesService.archivePage(svc(t.owner), on(t, top));
    expect(archived).toEqual({ archivedIds: set, rootId: top, subPageCount: 2 });
    // Archiving deletes nothing: the versions and the image still belong to their page.
    expect(await adminDb.pageVersion.count({ where: { pageId: { in: set } } })).toBe(3);
    expect(
      (await adminDb.attachment.findUniqueOrThrow({ where: { id: doomedImage.id } })).pageId,
    ).toBe(deep);

    const deleted = await pagesService.deletePage(svc(t.owner), on(t, top));
    expect(deleted.deletedIds).toEqual(set);

    expect(await adminDb.page.count({ where: { id: { in: set } } })).toBe(0);
    expect(await adminDb.pageVersion.count({ where: { pageId: { in: set } } })).toBe(0);
    // The image outlives its page, unowned — and the page beside it keeps everything.
    expect(
      (await adminDb.attachment.findUniqueOrThrow({ where: { id: doomedImage.id } })).pageId,
    ).toBeNull();
    expect(
      (await adminDb.attachment.findUniqueOrThrow({ where: { id: keptImage.id } })).pageId,
    ).toBe(stays);
    expect(await adminDb.pageVersion.count({ where: { pageId: stays } })).toBe(1);
    expect(await levelPages(t, { kind: 'folder', id: specs.id })).toEqual([stays]);

    // Inside the window the sweep must leave it alone; past it, it is an orphan.
    const now = () => new Date(Date.now() - ORPHAN_SAFETY_WINDOW_MS);
    expect(
      (await attachmentRepository.listOrphans({ olderThan: now() }, adminDb)).map((a) => a.id),
    ).toEqual([]);
    await adminDb.attachment.updateMany({
      where: { id: { in: [doomedImage.id, keptImage.id] } },
      data: { createdAt: new Date(Date.now() - ORPHAN_SAFETY_WINDOW_MS - 60_000) },
    });
    expect(
      (await attachmentRepository.listOrphans({ olderThan: now() }, adminDb)).map((a) => a.id),
    ).toEqual([doomedImage.id]);

    // Every door now answers "not found" for the set.
    for (const id of set) {
      await expect(pagesService.getPage(svc(t.owner), on(t, id))).rejects.toBeInstanceOf(
        PageNotFoundError,
      );
    }
    expect(
      (await pagesService.listArchivedPages(svc(t.owner), { projectId: t.projectId })).items,
    ).toEqual([]);
  });

  it('a sub-page archived on its own first survives its ancestor’s delete, re-homed and still archived', async () => {
    const t = await makeTenant('rehome', 'RHM');
    const grand = await page(t, 'Grand');
    const parent = await page(t, 'Parent', { kind: 'page', id: grand });
    const own = await page(t, 'Own archive', { kind: 'page', id: parent });
    const ownChild = await page(t, 'Own child', { kind: 'page', id: own });
    await write(t, own, 'kept');

    await pagesService.archivePage(svc(t.owner), on(t, own));
    await pagesService.archivePage(svc(t.owner), on(t, parent));
    const parentWas = await pageRow(parent);
    const result = await pagesService.deletePage(svc(t.owner), on(t, parent));
    expect(result.deletedIds).toEqual([parent]);

    // Re-homed to the deleted root's place, its chain and its child's rebased.
    expect(await pageRow(own)).toMatchObject({
      parentPageId: grand,
      ancestorPageIds: [grand],
      position: parentWas.position,
      archiveRootId: own,
    });
    expect(await pageRow(ownChild)).toMatchObject({ ancestorPageIds: [grand, own] });
    expect(await adminDb.pageVersion.count({ where: { pageId: own } })).toBe(1);
    await expectSetsWhole(t.projectId, 'after re-home');
  });
});

// ── 2 — every restore landing ────────────────────────────────────────────────

describe('seam 2 — every rung of the restore ladder, read back through the tree', () => {
  it('rung 1 — the original parent page is live: back under it, at its own position', async () => {
    const t = await makeTenant('rung-original', 'RGO');
    const specs = await folder(t, 'Specs');
    const parent = await page(t, 'Parent', { kind: 'folder', id: specs.id });
    const first = await page(t, 'First', { kind: 'page', id: parent });
    const x = await page(t, 'X', { kind: 'page', id: parent });
    const last = await page(t, 'Last', { kind: 'page', id: parent });
    const xChild = await page(t, 'X child', { kind: 'page', id: x });
    const was = await pageRow(x);

    await pagesService.archivePage(svc(t.owner), on(t, x));
    expect(await levelPages(t, { kind: 'page', id: parent })).toEqual([first, last]);

    const restored = await pagesService.restorePage(svc(t.owner), on(t, x));
    expect(restored).toEqual({
      restoredIds: [x, xChild],
      landing: { kind: 'original', parentPageId: parent, folderId: null, title: 'Parent' },
    });
    expect(await levelPages(t, { kind: 'page', id: parent })).toEqual([first, x, last]);
    expect(await pageRow(x)).toMatchObject({ position: was.position, archivedAt: null });
    expect(await trail(t, xChild)).toEqual({
      folders: [{ id: specs.id, name: 'Specs' }],
      pages: [
        { id: parent, title: 'Parent' },
        { id: x, title: 'X' },
      ],
    });
    await expectSetsWhole(t.projectId, 'rung 1');
  });

  it('rung 2 — the original parent was archived on its own: under the nearest live ancestor, last', async () => {
    const t = await makeTenant('rung-ancestor', 'RGA');
    const grand = await page(t, 'Grand');
    const parent = await page(t, 'Parent', { kind: 'page', id: grand });
    const x = await page(t, 'X', { kind: 'page', id: parent });
    const xChild = await page(t, 'X child', { kind: 'page', id: x });

    await pagesService.archivePage(svc(t.owner), on(t, x));
    await pagesService.archivePage(svc(t.owner), on(t, parent));
    const restored = await pagesService.restorePage(svc(t.owner), on(t, x));
    expect(restored.landing).toEqual({
      kind: 'ancestorPage',
      parentPageId: grand,
      folderId: null,
      title: 'Grand',
    });
    // Grand's only live child now is X: Parent is still archived.
    expect(await levelPages(t, { kind: 'page', id: grand })).toEqual([x]);
    expect(await levelPages(t, { kind: 'page', id: x })).toEqual([xChild]);
    expect(await pageRow(xChild)).toMatchObject({ ancestorPageIds: [grand, x] });
    expect(await trail(t, xChild)).toEqual({
      folders: [],
      pages: [
        { id: grand, title: 'Grand' },
        { id: x, title: 'X' },
      ],
    });
    expect(await pageRow(parent)).toMatchObject({ archiveRootId: parent });
    await expectSetsWhole(t.projectId, 'rung 2');
  });

  it('rung 3 — no live ancestor survives: into the topmost page’s folder', async () => {
    const t = await makeTenant('rung-folder', 'RGF');
    const specs = await folder(t, 'Specs');
    const top = await page(t, 'Top', { kind: 'folder', id: specs.id });
    const parent = await page(t, 'Parent', { kind: 'page', id: top });
    const x = await page(t, 'X', { kind: 'page', id: parent });

    await pagesService.archivePage(svc(t.owner), on(t, x));
    // Archiving Top takes Parent with it; X keeps its own archive.
    expect((await pagesService.archivePage(svc(t.owner), on(t, top))).archivedIds).toEqual([
      top,
      parent,
    ]);
    const restored = await pagesService.restorePage(svc(t.owner), on(t, x));
    expect(restored.landing).toEqual({
      kind: 'folder',
      parentPageId: null,
      folderId: specs.id,
      title: 'Specs',
    });
    expect(await levelPages(t, { kind: 'folder', id: specs.id })).toEqual([x]);
    expect(await pageRow(x)).toMatchObject({ folderId: specs.id, ancestorPageIds: [] });
    expect(await trail(t, x)).toEqual({ folders: [{ id: specs.id, name: 'Specs' }], pages: [] });
    await expectSetsWhole(t.projectId, 'rung 3');
  });

  it('the original parent page was deleted: the delete re-homed it, and it restores there', async () => {
    const t = await makeTenant('rung-deleted', 'RGD');
    const grand = await page(t, 'Grand');
    const parent = await page(t, 'Parent', { kind: 'page', id: grand });
    const x = await page(t, 'X', { kind: 'page', id: parent });

    await pagesService.archivePage(svc(t.owner), on(t, x));
    await pagesService.archivePage(svc(t.owner), on(t, parent));
    await pagesService.deletePage(svc(t.owner), on(t, parent));
    await expect(adminDb.page.findUnique({ where: { id: parent } })).resolves.toBeNull();

    const restored = await pagesService.restorePage(svc(t.owner), on(t, x));
    expect(restored.landing).toEqual({
      kind: 'original',
      parentPageId: grand,
      folderId: null,
      title: 'Grand',
    });
    expect(await levelPages(t, { kind: 'page', id: grand })).toEqual([x]);
    expect(await trail(t, x)).toEqual({ folders: [], pages: [{ id: grand, title: 'Grand' }] });
    await expectSetsWhole(t.projectId, 'parent deleted');
  });

  it('its folder was deleted meanwhile: the folder delete carried it up, and it restores there', async () => {
    const t = await makeTenant('rung-folder-gone', 'RFG');
    const outer = await folder(t, 'Outer');
    const doomed = await folder(t, 'Doomed', outer.id);
    const x = await page(t, 'X', { kind: 'folder', id: doomed.id });
    const xChild = await page(t, 'X child', { kind: 'page', id: x });
    const rootDoomed = await folder(t, 'Root doomed');
    const y = await page(t, 'Y', { kind: 'folder', id: rootDoomed.id });

    await pagesService.archivePage(svc(t.owner), on(t, x));
    await pagesService.archivePage(svc(t.owner), on(t, y));
    for (const f of [doomed, rootDoomed]) {
      // The confirmation counts no archived page, and the delete still carries it up.
      const preview = await foldersService.describeFolderDeletion(
        { projectId: t.projectId, folderId: f.id },
        svc(t.owner),
      );
      expect(preview.pageCount).toBe(0);
      const result = await foldersService.deleteFolder(
        { projectId: t.projectId, folderId: f.id },
        svc(t.owner),
      );
      expect(result.movedPageIds).toEqual([]);
    }
    expect(await pageRow(x)).toMatchObject({ folderId: outer.id, archiveRootId: x });
    expect(await pageRow(y)).toMatchObject({ folderId: null, archiveRootId: y });

    const intoOuter = await pagesService.restorePage(svc(t.owner), on(t, x));
    expect(intoOuter.landing).toEqual({
      kind: 'original',
      parentPageId: null,
      folderId: outer.id,
      title: 'Outer',
    });
    expect(await levelPages(t, { kind: 'folder', id: outer.id })).toEqual([x]);
    expect(await trail(t, xChild)).toEqual({
      folders: [{ id: outer.id, name: 'Outer' }],
      pages: [{ id: x, title: 'X' }],
    });

    const toRoot = await pagesService.restorePage(svc(t.owner), on(t, y));
    expect(toRoot.landing).toEqual({
      kind: 'original',
      parentPageId: null,
      folderId: null,
      title: null,
    });
    expect(await levelPages(t, { kind: 'root' })).toEqual([y]);
    expect(await trail(t, y)).toEqual({ folders: [], pages: [] });
    await expectSetsWhole(t.projectId, 'folder deleted');
  });

  it('the depth-skip rung — a parent whose chain now leaves no room is skipped for the next one up', async () => {
    // ADR AMENDMENT 2 ¶1: the move procedure counts archived descendants, and
    // `page_depth_limit` holds every STORED chain under the limit, so no
    // procedure can leave a parent too deep for its archived child. The rung is
    // a backstop for a chain changed by something else — so that change is
    // PLANTED here: the parent re-hung eight levels down by a write that did not
    // rebase its archived sub-tree, as anything outside the procedures would.
    const t = await makeTenant('rung-depth', 'RGP');
    const deep: string[] = [];
    let at: Parent | undefined;
    for (let level = 1; level <= 8; level++) {
      const id = await page(t, `L${level}`, at);
      deep.push(id);
      at = { kind: 'page', id };
    }
    const grand = await page(t, 'Grand');
    const parent = await page(t, 'Parent', { kind: 'page', id: grand });
    const x = await page(t, 'X', { kind: 'page', id: parent });
    const y = await page(t, 'Y', { kind: 'page', id: x });
    await pagesService.archivePage(svc(t.owner), on(t, x));

    // Planted: Parent now sits under L8 (its own depth 9). X and Y would land at
    // 10 and 11 under it — one past the limit.
    await adminDb.page.update({
      where: { id: parent },
      data: { parentPageId: deep[7]!, ancestorPageIds: deep },
    });

    const restored = await pagesService.restorePage(svc(t.owner), on(t, x));
    expect(restored.landing).toEqual({
      kind: 'ancestorPage',
      parentPageId: grand,
      folderId: null,
      title: 'Grand',
    });
    expect(await levelPages(t, { kind: 'page', id: parent })).toEqual([]);
    expect(await levelPages(t, { kind: 'page', id: grand })).toEqual([x]);
    expect(await pageRow(x)).toMatchObject({ parentPageId: grand, ancestorPageIds: [grand] });
    expect(await pageRow(y)).toMatchObject({ ancestorPageIds: [grand, x] });
    expect(await trail(t, y)).toEqual({
      folders: [],
      pages: [
        { id: grand, title: 'Grand' },
        { id: x, title: 'X' },
      ],
    });
    await expectSetsWhole(t.projectId, 'depth skip');
  });
});

// ── 3 — the read sweep ───────────────────────────────────────────────────────

describe('seam 3 — an archived page beside a live one at every level, and no tree read returns it', () => {
  it('the root, a folder and a page level; hasChildren; the trail; the folder-delete count', async () => {
    const t = await makeTenant('sweep', 'SWP');
    const specs = await folder(t, 'Specs');
    const onlyArchived = await folder(t, 'Only archived');
    const rootLive = await page(t, 'Root live');
    const rootGone = await page(t, 'Root gone');
    const folderLive = await page(t, 'Folder live', { kind: 'folder', id: specs.id });
    const folderGone = await page(t, 'Folder gone', { kind: 'folder', id: specs.id });
    const subLive = await page(t, 'Sub live', { kind: 'page', id: folderLive });
    const subGone = await page(t, 'Sub gone', { kind: 'page', id: folderLive });
    const leaf = await page(t, 'Leaf', { kind: 'page', id: subLive });
    const leafGone = await page(t, 'Leaf gone', { kind: 'page', id: leaf });
    const lonely = await page(t, 'Lonely', { kind: 'folder', id: onlyArchived.id });

    const archivedIds = [rootGone, folderGone, subGone, leafGone, lonely];
    for (const id of archivedIds) await pagesService.archivePage(svc(t.owner), on(t, id));

    // Every level, through the service and the repository's live reads beneath it.
    expect(await levelPages(t, { kind: 'root' })).toEqual([rootLive]);
    expect(await levelPages(t, { kind: 'folder', id: specs.id })).toEqual([folderLive]);
    expect(await levelPages(t, { kind: 'page', id: folderLive })).toEqual([subLive]);
    expect(await levelPages(t, { kind: 'page', id: subLive })).toEqual([leaf]);
    expect(await levelPages(t, { kind: 'page', id: leaf })).toEqual([]);
    expect(await levelPages(t, { kind: 'folder', id: onlyArchived.id })).toEqual([]);

    // A chevron only where a LIVE child waits.
    expect(await levelRow(t, { kind: 'root' }, specs.id)).toMatchObject({ hasChildren: true });
    expect(await levelRow(t, { kind: 'root' }, onlyArchived.id)).toMatchObject({
      hasChildren: false,
    });
    expect(await levelRow(t, { kind: 'root' }, rootLive)).toMatchObject({ hasChildren: false });
    expect(await levelRow(t, { kind: 'page', id: subLive }, leaf)).toMatchObject({
      hasChildren: false,
    });

    // The trail of the deepest live page names live pages only.
    expect(await trail(t, leaf)).toEqual({
      folders: [{ id: specs.id, name: 'Specs' }],
      pages: [
        { id: folderLive, title: 'Folder live' },
        { id: subLive, title: 'Sub live' },
      ],
    });

    // The folder-delete confirmation counts live filed pages only.
    const count = async (folderId: string) =>
      (
        await foldersService.describeFolderDeletion(
          { projectId: t.projectId, folderId },
          svc(t.owner),
        )
      ).pageCount;
    expect(await count(specs.id)).toBe(1);
    expect(await count(onlyArchived.id)).toBe(0);

    // …and every one of them is in the Archived pages list, a root each.
    const list = await pagesService.listArchivedPages(svc(t.owner), { projectId: t.projectId });
    expect(list.items.map((i) => i.id).sort()).toEqual([...archivedIds].sort());
  });
});

// ── 4 — concurrency, real parallel transactions ──────────────────────────────

const RUNS = 20;

describe('seam 4 — races on real Postgres (×20 each)', () => {
  it('archive versus a move of its sub-page: the move lands outside the set, or is refused PAGE_ARCHIVED', async () => {
    const t = await makeTenant('race-move', 'RMV');
    const member = await memberOf(t, 'mover', 'member');
    const outcomes = new Set<string>();
    for (let run = 0; run < RUNS; run++) {
      const p = await page(t, `Page ${run}`);
      const sub = await page(t, `Sub ${run}`, { kind: 'page', id: p });
      const subChild = await page(t, `Sub child ${run}`, { kind: 'page', id: sub });

      const [archived, moved] = await Promise.allSettled([
        pagesService.archivePage(svc(t.owner), on(t, p)),
        pagesService.movePage(svc(member), { ...on(t, sub), parent: { kind: 'root' } }),
      ]);
      expect(archived.status, `run ${run}: archive`).toBe('fulfilled');
      if (moved.status === 'fulfilled') {
        outcomes.add('move first');
        expect(archived.status === 'fulfilled' && archived.value.archivedIds).toEqual([p]);
        expect(await pageRow(sub)).toMatchObject({ parentPageId: null, archivedAt: null });
        expect(await pageRow(subChild)).toMatchObject({ archivedAt: null });
      } else {
        outcomes.add('archive first');
        expect(moved.reason, `run ${run}`).toMatchObject({ code: 'PAGE_ARCHIVED' });
        expect(archived.status === 'fulfilled' && archived.value.archivedIds).toEqual([
          p,
          sub,
          subChild,
        ]);
      }
      await expectSetsWhole(t.projectId, `run ${run}`);
    }
    expect(outcomes.size).toBeGreaterThan(0);
  });

  it('archive versus a create under it: the new page joins the set, or is refused PAGE_PARENT_ARCHIVED', async () => {
    const t = await makeTenant('race-create', 'RCR');
    const member = await memberOf(t, 'writer', 'member');
    for (let run = 0; run < RUNS; run++) {
      const p = await page(t, `Page ${run}`);
      const [archived, created] = await Promise.allSettled([
        pagesService.archivePage(svc(t.owner), on(t, p)),
        pagesService.createPage(svc(member), {
          projectId: t.projectId,
          title: `Child ${run}`,
          parent: { kind: 'page', id: p },
        }),
      ]);
      expect(archived.status, `run ${run}: archive`).toBe('fulfilled');
      const ids = archived.status === 'fulfilled' ? archived.value.archivedIds : [];
      if (created.status === 'fulfilled') {
        // The create committed first: the archive took it with its parent.
        expect(ids, `run ${run}`).toEqual([p, created.value.id]);
        expect(await pageRow(created.value.id)).toMatchObject({ archiveRootId: p });
      } else {
        expect(created.reason, `run ${run}`).toMatchObject({ code: 'PAGE_PARENT_ARCHIVED' });
        expect(ids, `run ${run}`).toEqual([p]);
        expect(await adminDb.page.count({ where: { parentPageId: p } })).toBe(0);
      }
      await expectSetsWhole(t.projectId, `run ${run}`);
    }
  });

  it('two restores of one root: exactly one lands, the other is PAGE_NOT_ARCHIVED', async () => {
    const t = await makeTenant('race-restore', 'RRS');
    const member = await memberOf(t, 'restorer', 'member');
    const p = await page(t, 'Page');
    const sub = await page(t, 'Sub', { kind: 'page', id: p });
    for (let run = 0; run < RUNS; run++) {
      await pagesService.archivePage(svc(member), on(t, p));
      const outcomes = await Promise.allSettled([
        pagesService.restorePage(svc(t.owner), on(t, p)),
        pagesService.restorePage(svc(member), on(t, p)),
      ]);
      const won = outcomes.filter((o) => o.status === 'fulfilled');
      const lost = outcomes.filter((o) => o.status === 'rejected');
      expect(won, `run ${run}`).toHaveLength(1);
      expect(lost[0]!.reason, `run ${run}`).toMatchObject({ code: 'PAGE_NOT_ARCHIVED' });
      expect(won[0]!.status === 'fulfilled' && won[0]!.value.restoredIds).toEqual([p, sub]);
      expect(await levelPages(t, { kind: 'root' })).toEqual([p]);
      await expectSetsWhole(t.projectId, `run ${run}`);
    }
  });
});

// ── 5 — the role matrix, through the routes ──────────────────────────────────

describe('seam 5 — ADR §5, cell for cell, through the routes', () => {
  // archive / restore ride `page:edit`; delete is `page:delete`; the list is `page:view`.
  const MATRIX = {
    viewer: { archive: 403, restore: 403, delete: 403, list: 200 },
    member: { archive: 200, restore: 200, delete: 403, list: 200 },
    manager: { archive: 200, restore: 200, delete: 200, list: 200 },
  } as const;

  for (const role of ['viewer', 'member', 'manager'] as const) {
    it(`a ${role}`, async () => {
      const t = await makeTenant(`role-${role}`, `RL${role[0]!.toUpperCase()}`);
      const who = await memberOf(t, role, role);
      const expected = MATRIX[role];
      const live = await page(t, 'Live');
      const archived = await page(t, 'Archived');
      await pagesService.archivePage(svc(t.owner), on(t, archived));
      actor.current = who;

      expect((await listRoute()).status, 'list').toBe(expected.list);
      expect((await archiveRoute(live)).status, 'archive').toBe(expected.archive);
      expect((await pageRow(live)).archivedAt !== null, 'archive wrote').toBe(
        expected.archive === 200,
      );
      expect((await restoreRoute(archived)).status, 'restore').toBe(expected.restore);
      expect((await pageRow(archived)).archivedAt === null, 'restore wrote').toBe(
        expected.restore === 200,
      );

      // Delete needs something archived to delete, whatever the restore did.
      const doomed = await page(t, 'Doomed');
      await pagesService.archivePage(svc(t.owner), on(t, doomed));
      expect((await deleteRoute(doomed)).status, 'delete').toBe(expected.delete);
      expect(await adminDb.page.count({ where: { id: doomed } }), 'delete wrote').toBe(
        expected.delete === 200 ? 0 : 1,
      );
    });
  }

  // A Visitor reaches no page ROUTE — every one opens on the session's active
  // project, which a non-member has none of — so the cell is asserted at the
  // service, under the narrowed context the public rooms run their reads under
  // (`visitorServiceContext`, `VISITOR_PERMISSIONS`: the Viewer's set).
  it('a visitor of a public project reads the list and can act on nothing', async () => {
    const t = await makeTenant('public', 'PUB');
    await adminDb.project.update({
      where: { id: t.projectId },
      data: projectAccessData('public'),
    });
    const live = await page(t, 'Live');
    const archived = await page(t, 'Archived');
    await pagesService.archivePage(svc(t.owner), on(t, archived));
    const before = await adminDb.page.findMany({ orderBy: { id: 'asc' } });

    const stranger = await makeUser('visitor');
    const visitor = visitorServiceContext({
      kind: 'visitor',
      project: await adminDb.project.findUniqueOrThrow({ where: { id: t.projectId } }),
      actorUserId: stranger.id,
      permissions: VISITOR_PERMISSIONS,
      hiddenIds: new Set(),
    });

    const list = await pagesService.listArchivedPages(visitor, { projectId: t.projectId });
    expect(list.items.map((i) => i.id)).toEqual([archived]);
    for (const call of [
      () => pagesService.archivePage(visitor, on(t, live)),
      () => pagesService.restorePage(visitor, on(t, archived)),
      () => pagesService.deletePage(visitor, on(t, archived)),
    ]) {
      const err = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ProjectAccessDeniedError);
      expect(err).toMatchObject({ kind: 'edit' });
    }
    expect(await adminDb.page.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });
});

// ── 6 — row-level isolation ──────────────────────────────────────────────────

describe('seam 6 — another workspace’s context sees and changes nothing', () => {
  it('listArchivedRoots, findArchiveSet and deletePages under B’s context miss A’s archive', async () => {
    const a = await makeTenant('rls-a', 'RLA');
    const b = await makeTenant('rls-b', 'RLB');
    const root = await page(a, 'A root');
    const sub = await page(a, 'A sub', { kind: 'page', id: root });
    await write(a, sub, 'A body');
    await pagesService.archivePage(svc(a.owner), on(a, root));
    const bRoot = await page(b, 'B root');
    await pagesService.archivePage(svc(b.owner), on(b, bRoot));

    const inB = <T>(
      fn: (tx: Parameters<Parameters<typeof withWorkspaceContext>[1]>[0]) => Promise<T>,
    ) =>
      withWorkspaceContext(
        { userId: b.owner.userId, workspaceId: b.workspaceId, projectId: b.projectId },
        fn,
      );

    const seen = await inB(async (tx) => ({
      roots: await pageRepository.listArchivedRoots(a.projectId, {}, tx),
      set: await pageRepository.findArchiveSet(root, tx),
      own: await pageRepository.findArchiveSet(bRoot, tx),
    }));
    expect(seen.roots).toEqual({ rows: [], nextCursor: null });
    expect(seen.set).toEqual([]);
    expect(seen.own.map((p) => p.id)).toEqual([bRoot]);

    const deleted = await inB((tx) => pageRepository.deletePages([root, sub], tx));
    expect(deleted).toBe(0);
    expect(await adminDb.page.count({ where: { id: { in: [root, sub] } } })).toBe(2);
    expect(await adminDb.pageVersion.count({ where: { pageId: sub } })).toBe(1);

    // And through the service and the route: B's manager cannot reach A's pages.
    await expect(
      pagesService.deletePage(svc(b.owner), { projectId: a.projectId, pageId: root }),
    ).rejects.toThrow();
    actor.current = b.owner;
    expect((await deleteRoute(root)).status).toBe(404);
    expect((await restoreRoute(root)).status).toBe(404);
    const bList = (await (await listRoute()).json()) as { items: Array<{ id: string }> };
    expect(bList.items.map((i) => i.id)).toEqual([bRoot]);
    expect(await pageRow(root)).toMatchObject({ archiveRootId: root });
    expect(await adminDb.page.count({ where: { id: { in: [root, sub] } } })).toBe(2);
  });
});
