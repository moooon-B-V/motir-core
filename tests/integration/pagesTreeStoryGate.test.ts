import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// STORY MOTIR-5753's INTEGRATION GATE (MOTIR-7377) — the `/pages` TREE, assembled,
// on real Postgres, through the real doors.
//
// Each card of the story tested its own layer: the package's `movePage` over an
// in-memory store, the adapter's placement writes under one transaction, the
// service's move and level read, the routes with the service real, the folder
// delete's page writes, and the tree island with `fetch` stubbed. What none of
// them could see is the SEAMS between those layers, so this file drives each one
// end to end, the way the island drives it:
//
//   1  a move written by `PATCH /api/pages/<id>/placement` is what
//      `GET /api/pages/tree` and `getPageTrail` (the breadcrumb) then read — a
//      three-level subtree moved into a nested folder, both reads agreeing on
//      the new path;
//   2  a folder delete over pages leaves them where the tree's level read
//      expects them, in their stored order, through the service and the route;
//   3  a page created under a page through `POST /api/pages` is what the level
//      read returns under it, and its parent row gains its chevron;
//   4  two moves racing on two connections through the ROUTE cannot form a
//      cycle — exactly one is refused `PAGE_CYCLE` and every chain still ends at
//      the root; a folder delete racing a route move into that folder ends with
//      no foreign-key failure, whichever commits first;
//   5  cross-tenant isolation: another workspace's — or another project's —
//      page or folder is never readable or targetable through any tree door,
//      and the row-level policies hide it from the workspace's own context.
//
// Mocked, and only these: the session and the active project (`getSession`,
// `getActiveProject`), which need cookies — the pattern `pagesStoryGate.test.ts`
// and `tests/api/pages-routes-tree.test.ts` set.

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
  // The tree door reads `project.identifier` to tell the active project's key apart.
  getActiveProject: vi.fn(async () =>
    actor.current ? { ...actor.current, project: { identifier: actor.current.projectKey } } : null,
  ),
}));

const { POST: CREATE } = await import('@/app/api/pages/route');
const { GET: READ } = await import('@/app/api/pages/[pageId]/route');
const { GET: TREE } = await import('@/app/api/pages/tree/route');
const { PATCH: PLACE } = await import('@/app/api/pages/[pageId]/placement/route');
const { pagesService } = await import('@/lib/services/pagesService');
const { foldersService } = await import('@/lib/services/foldersService');
const { projectsService } = await import('@/lib/services/projectsService');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { pageRepository } = await import('@/lib/repositories/pageRepository');
const { folderRepository } = await import('@/lib/repositories/folderRepository');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { PageNotFoundError } = await import('@/lib/pages');
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
    email: `pages-tree-gate-${tag}-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Tree gate ${tag}`,
  });
}

interface Tenant {
  workspaceId: string;
  projectId: string;
  /** A second project in the same workspace. */
  otherProjectId: string;
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
  const other = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: `${tag} other`,
    identifier: `${key}X`,
  });
  // Project creation seeds starter pages; the levels below are exactly the test's.
  await adminDb.page.deleteMany({ where: { workspaceId } });
  // …and a `Bugs` folder, which `own` filters out of a level.
  return {
    workspaceId,
    projectId: project.id,
    otherProjectId: other.id,
    owner: { userId: owner.id, workspaceId, projectId: project.id, projectKey: key },
  };
}

const svc = (a: Actor) => ({ userId: a.userId, workspaceId: a.workspaceId });

interface Row {
  kind: 'folder' | 'page';
  id: string;
  title?: string;
  name?: string;
  hasChildren: boolean;
}
interface Level {
  rows: Row[];
  nextCursor: string | null;
}
const own = (level: Level) => level.rows.filter((r) => !(r.kind === 'folder' && r.name === 'Bugs'));
const label = (r: Row) => (r.kind === 'folder' ? `folder ${r.name}` : `page ${r.title}`);

// ── The doors, as the island calls them ──────────────────────────────────────

const params = (pageId: string) => ({ params: Promise.resolve({ pageId }) });

async function treeGet(query: Record<string, string>): Promise<Response> {
  return TREE(new Request(`${BASE}/tree?${new URLSearchParams(query)}`));
}
async function treeLevel(parent: string, query: Record<string, string> = {}): Promise<Level> {
  const res = await treeGet({ parent, ...query });
  expect(res.status).toBe(200);
  return (await res.json()) as Level;
}
async function createPage(body: unknown): Promise<Response> {
  return CREATE(
    new Request(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}
async function createdId(body: unknown): Promise<string> {
  const res = await createPage(body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}
function place(pageId: string, body: unknown): Promise<Response> {
  return PLACE(
    new Request(`${BASE}/${pageId}/placement`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params(pageId),
  );
}
function readPage(pageId: string): Promise<Response> {
  return READ(new Request(`${BASE}/${pageId}`), params(pageId));
}

const folderIn = (
  t: Tenant,
  name: string,
  parentFolderId: string | null = null,
  projectId?: string,
) =>
  foldersService.createFolder(
    { projectId: projectId ?? t.projectId, parentFolderId, name },
    svc(t.owner),
  );

async function pageRow(id: string) {
  return adminDb.page.findUniqueOrThrow({
    where: { id },
    select: { id: true, folderId: true, parentPageId: true, ancestorPageIds: true, position: true },
  });
}

/** Every chain in the project ends at the root without revisiting a page. */
async function expectAcyclic(projectId: string) {
  const rows = await adminDb.page.findMany({
    where: { projectId },
    select: { id: true, parentPageId: true, ancestorPageIds: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const row of rows) {
    const chain: string[] = [];
    let cur = row.parentPageId;
    while (cur) {
      expect(chain).not.toContain(cur);
      chain.unshift(cur);
      cur = byId.get(cur)!.parentPageId;
    }
    // The stored ancestor chain is the walked one.
    expect(row.ancestorPageIds).toEqual(chain);
  }
}

// ── Two connections ──────────────────────────────────────────────────────────

async function lockWaiters(event?: 'advisory'): Promise<number> {
  const rows = await adminDb.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM pg_stat_activity
     WHERE datname = current_database()
       AND wait_event_type = 'Lock'
       AND (${event ?? null}::text IS NULL OR wait_event = ${event ?? null}::text)
  `;
  return Number(rows[0]!.n);
}

function latch(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

const inProject = <T>(
  t: Tenant,
  fn: (tx: Parameters<Parameters<typeof withWorkspaceContext>[1]>[0]) => Promise<T>,
) =>
  withWorkspaceContext(
    { userId: t.owner.userId, workspaceId: t.workspaceId, projectId: t.projectId },
    fn,
  );

// ── 1 · 2 · 3 — the seams ────────────────────────────────────────────────────

describe('seam 1 — a route move is what the tree and the breadcrumb read', () => {
  it('moves a three-level subtree into a nested folder; the level reads and the trail agree', async () => {
    const t = await makeTenant('seam-move', 'SMV');
    actor.current = t.owner;
    const outer = await folderIn(t, 'Specs');
    const inner = await folderIn(t, 'API', outer.id);
    const a = await createdId({ title: 'Auth' });
    const b = await createdId({ title: 'Tokens', parent: { kind: 'page', id: a } });
    const c = await createdId({ title: 'Refresh', parent: { kind: 'page', id: b } });
    const stay = await createdId({ title: 'Stays' });

    const res = await place(a, { parent: { kind: 'folder', id: inner.id } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: a,
      parent: { kind: 'folder', id: inner.id },
      ancestorPageIds: [],
      moved: true,
    });

    // The tree, walked the way the island expands it: root → Specs → API → Auth → Tokens.
    expect(own(await treeLevel('root')).map(label)).toEqual(['folder Specs', 'page Stays']);
    const specs = own(await treeLevel('root')).find((r) => r.id === outer.id)!;
    expect(specs.hasChildren).toBe(true);
    expect((await treeLevel(`folder:${outer.id}`)).rows.map(label)).toEqual(['folder API']);
    expect((await treeLevel(`folder:${inner.id}`)).rows).toEqual([
      { kind: 'page', id: a, title: 'Auth', hasChildren: true },
    ]);
    expect((await treeLevel(`page:${a}`)).rows.map(label)).toEqual(['page Tokens']);
    expect((await treeLevel(`page:${b}`)).rows).toEqual([
      { kind: 'page', id: c, title: 'Refresh', hasChildren: false },
    ]);

    // The breadcrumb names the same path: the folders the TOP page is filed in,
    // then the ancestor pages.
    const trail = await pagesService.getPageTrail(svc(t.owner), {
      projectId: t.projectId,
      pageId: c,
    });
    expect(trail).toEqual({
      folders: [
        { id: outer.id, name: 'Specs' },
        { id: inner.id, name: 'API' },
      ],
      pages: [
        { id: a, title: 'Auth' },
        { id: b, title: 'Tokens' },
      ],
    });
    // Only the moved page carries the folder; its descendants' chains are intact.
    expect(await pageRow(b)).toMatchObject({
      folderId: null,
      parentPageId: a,
      ancestorPageIds: [a],
    });
    expect(await pageRow(c)).toMatchObject({
      folderId: null,
      parentPageId: b,
      ancestorPageIds: [a, b],
    });
    expect(await pageRow(stay)).toMatchObject({ folderId: null, parentPageId: null });

    // Moving the subtree under a page rewrites every chain — and the trail follows.
    const under = await place(a, { parent: { kind: 'page', id: stay } });
    expect(under.status).toBe(200);
    expect(await pageRow(c)).toMatchObject({ ancestorPageIds: [stay, a, b] });
    expect(
      await pagesService.getPageTrail(svc(t.owner), { projectId: t.projectId, pageId: c }),
    ).toEqual({
      folders: [],
      pages: [
        { id: stay, title: 'Stays' },
        { id: a, title: 'Auth' },
        { id: b, title: 'Tokens' },
      ],
    });
    expect((await treeLevel(`folder:${inner.id}`)).rows).toEqual([]);
    await expectAcyclic(t.projectId);
  });
});

describe('seam 2 — a folder delete leaves its pages where the level read expects them', () => {
  it('moves the folder’s pages to its parent after that level’s own pages, in order', async () => {
    const t = await makeTenant('seam-delete', 'SDL');
    actor.current = t.owner;
    const parent = await folderIn(t, 'Parent');
    const doomed = await folderIn(t, 'Doomed', parent.id);
    const sibling = await folderIn(t, 'Sibling', parent.id);
    const first = await createdId({
      title: 'Already here',
      parent: { kind: 'folder', id: parent.id },
    });
    const one = await createdId({ title: 'One', parent: { kind: 'folder', id: doomed.id } });
    const two = await createdId({ title: 'Two', parent: { kind: 'folder', id: doomed.id } });
    const sub = await createdId({ title: 'Sub of one', parent: { kind: 'page', id: one } });

    expect((await treeLevel(`folder:${parent.id}`)).rows.map(label)).toEqual([
      'folder Doomed',
      'folder Sibling',
      'page Already here',
    ]);

    const result = await foldersService.deleteFolder(
      { projectId: t.projectId, folderId: doomed.id },
      svc(t.owner),
    );
    expect(result.movedPageIds).toEqual([one, two]);

    // The service's level read and the route's agree, folders first then pages.
    const viaService = await pagesService.listTreeLevel(svc(t.owner), {
      projectId: t.projectId,
      parent: { kind: 'folder', id: parent.id },
    });
    const viaRoute = await treeLevel(`folder:${parent.id}`);
    expect(viaRoute).toEqual(JSON.parse(JSON.stringify(viaService)));
    expect(viaRoute.rows.map(label)).toEqual([
      'folder Sibling',
      'page Already here',
      'page One',
      'page Two',
    ]);
    expect(viaRoute.rows.find((r) => r.id === one)!.hasChildren).toBe(true);
    // The sub-page stayed under its page; the folder is gone from every door.
    expect((await treeLevel(`page:${one}`)).rows.map((r) => r.id)).toEqual([sub]);
    const gone = await treeGet({ parent: `folder:${doomed.id}` });
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ code: 'FOLDER_NOT_FOUND' });
    expect(
      await pagesService.getPageTrail(svc(t.owner), { projectId: t.projectId, pageId: sub }),
    ).toEqual({ folders: [{ id: parent.id, name: 'Parent' }], pages: [{ id: one, title: 'One' }] });
    expect(viaRoute.rows.slice(0, 2).map((r) => r.id)).toEqual([sibling.id, first]);
  });

  it('a root folder’s pages land at the project root, after the root’s pages', async () => {
    const t = await makeTenant('seam-delete-root', 'SDR');
    actor.current = t.owner;
    const doomed = await folderIn(t, 'Doomed');
    await createdId({ title: 'Root page' });
    await createdId({ title: 'Filed', parent: { kind: 'folder', id: doomed.id } });
    await foldersService.deleteFolder(
      { projectId: t.projectId, folderId: doomed.id },
      svc(t.owner),
    );
    expect(own(await treeLevel('root')).map(label)).toEqual(['page Root page', 'page Filed']);
  });
});

describe('seam 3 — create under a page through the route, then the level read', () => {
  it('the new page is the parent’s last child, and the parent row gains its chevron', async () => {
    const t = await makeTenant('seam-create', 'SCR');
    actor.current = t.owner;
    const folder = await folderIn(t, 'Specs');
    const parent = await createdId({ title: 'Parent', parent: { kind: 'folder', id: folder.id } });
    expect((await treeLevel(`folder:${folder.id}`)).rows[0]!.hasChildren).toBe(false);

    const older = await createdId({ title: 'Older', parent: { kind: 'page', id: parent } });
    const child = await createdId({ title: 'Child', parent: { kind: 'page', id: parent } });

    expect((await treeLevel(`page:${parent}`)).rows.map((r) => r.id)).toEqual([older, child]);
    expect((await treeLevel(`folder:${folder.id}`)).rows[0]).toMatchObject({
      id: parent,
      hasChildren: true,
    });
    // The new page's address reads back, and its breadcrumb is folder › parent.
    expect((await readPage(child)).status).toBe(200);
    expect(
      await pagesService.getPageTrail(svc(t.owner), { projectId: t.projectId, pageId: child }),
    ).toEqual({
      folders: [{ id: folder.id, name: 'Specs' }],
      pages: [{ id: parent, title: 'Parent' }],
    });
  });
});

// ── 4 — concurrency, two real connections ────────────────────────────────────

describe('concurrent moves through the route', () => {
  it('two moves that together would form a cycle: one lands, one is refused PAGE_CYCLE', async () => {
    const t = await makeTenant('race-cycle', 'RCY');
    actor.current = t.owner;
    const a = await createdId({ title: 'A' });
    const b = await createdId({ title: 'B' });
    const bChild = await createdId({ title: 'B child', parent: { kind: 'page', id: b } });

    // Park both moves on the project's page-structure lock, then let them run.
    const held = latch();
    const release = latch();
    const holder = inProject(t, async (tx) => {
      await pageRepository.lockStructure(t.projectId, tx);
      held.open();
      await release.opened;
    });
    await held.opened;
    // Each is fine alone: A under B's child, B under A. Together they close a loop.
    const first = place(a, { parent: { kind: 'page', id: bChild } });
    const second = place(b, { parent: { kind: 'page', id: a } });
    await expect.poll(() => lockWaiters('advisory')).toBe(2);
    release.open();
    await holder;
    const answers = await Promise.all([first, second]);

    const statuses = answers.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 422]);
    const refused = answers.find((r) => r.status === 422)!;
    expect(await refused.json()).toMatchObject({ code: 'PAGE_CYCLE' });
    await expectAcyclic(t.projectId);

    // Whichever won, the tree read shows it, and the loser is where it was.
    const aRow = await pageRow(a);
    const bRow = await pageRow(b);
    if (answers[0]!.status === 200) {
      expect(aRow).toMatchObject({ parentPageId: bChild, ancestorPageIds: [b, bChild] });
      expect(bRow).toMatchObject({ parentPageId: null, ancestorPageIds: [] });
      expect((await treeLevel(`page:${bChild}`)).rows.map((r) => r.id)).toEqual([a]);
    } else {
      expect(bRow).toMatchObject({ parentPageId: a, ancestorPageIds: [a] });
      expect(aRow).toMatchObject({ parentPageId: null, ancestorPageIds: [] });
      expect((await treeLevel(`page:${a}`)).rows.map((r) => r.id)).toEqual([b]);
    }
  });

  it('a folder delete that commits first: the route move into it is 404, with no FK failure', async () => {
    const t = await makeTenant('race-delete-first', 'RDF');
    actor.current = t.owner;
    const doomed = await folderIn(t, 'Doomed');
    const traveller = await createdId({ title: 'Traveller' });
    const was = await pageRow(traveller);

    // Hold the folder ROW, so the delete stops at its own row lock AFTER it has
    // taken both structure locks; the move then queues behind the delete.
    const held = latch();
    const release = latch();
    const blocker = inProject(t, async (tx) => {
      await folderRepository.lockById(doomed.id, tx);
      held.open();
      await release.opened;
    });
    await held.opened;
    const del = foldersService.deleteFolder(
      { projectId: t.projectId, folderId: doomed.id },
      svc(t.owner),
    );
    await expect.poll(() => lockWaiters()).toBe(1);
    const move = place(traveller, { parent: { kind: 'folder', id: doomed.id } });
    await expect.poll(() => lockWaiters('advisory')).toBe(1);
    release.open();
    await blocker;

    await expect(del).resolves.toMatchObject({ deletedFolderId: doomed.id, movedPageIds: [] });
    const res = await move;
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'FOLDER_NOT_FOUND' });
    expect(await pageRow(traveller)).toEqual(was);
    expect(own(await treeLevel('root')).map(label)).toEqual(['page Traveller']);
  });

  it('a folder delete and a route move into it, released together: either order ends clean', async () => {
    const t = await makeTenant('race-delete-any', 'RDA');
    actor.current = t.owner;
    const parent = await folderIn(t, 'Parent');
    const doomed = await folderIn(t, 'Doomed', parent.id);
    const traveller = await createdId({ title: 'Traveller' });

    const held = latch();
    const release = latch();
    const holder = inProject(t, async (tx) => {
      await pageRepository.lockStructure(t.projectId, tx);
      held.open();
      await release.opened;
    });
    await held.opened;
    const del = foldersService
      .deleteFolder({ projectId: t.projectId, folderId: doomed.id }, svc(t.owner))
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    const move = place(traveller, { parent: { kind: 'folder', id: doomed.id } });
    await expect.poll(() => lockWaiters('advisory')).toBe(2);
    release.open();
    await holder;
    const [deleted, moved] = await Promise.all([del, move]);

    // The delete always lands; the move either landed first (and the delete
    // carried the page up to Parent) or found the folder gone (404). Never a 500.
    expect(deleted.ok).toBe(true);
    const row = await pageRow(traveller);
    if (moved.status === 200) {
      expect(deleted.ok && deleted.value.movedPageIds).toEqual([traveller]);
      expect(row).toMatchObject({ folderId: parent.id, parentPageId: null });
      expect((await treeLevel(`folder:${parent.id}`)).rows.map((r) => r.id)).toEqual([traveller]);
    } else {
      expect(moved.status).toBe(404);
      expect(row).toMatchObject({ folderId: null, parentPageId: null });
    }
    await expect(adminDb.folder.findUnique({ where: { id: doomed.id } })).resolves.toBeNull();
  });
});

// ── 5 — cross-tenant isolation ───────────────────────────────────────────────

describe('cross-tenant isolation — the tree doors', () => {
  async function twoTenants() {
    const mine = await makeTenant('mine', 'MIN');
    const theirs = await makeTenant('theirs', 'THR');
    const theirFolder = await folderIn(theirs, 'Their folder');
    const theirPage = await pagesService.createPage(svc(theirs.owner), {
      projectId: theirs.projectId,
      title: 'Their page',
      parent: { kind: 'folder', id: theirFolder.id },
    });
    // Same workspace, another project: a folder and a page the actor CAN reach
    // in their own project's view, and must still not use as a place here.
    const sideFolder = await folderIn(mine, 'Side folder', null, mine.otherProjectId);
    const sidePage = await pagesService.createPage(svc(mine.owner), {
      projectId: mine.otherProjectId,
      title: 'Side page',
    });
    actor.current = mine.owner;
    const myPage = await createdId({ title: 'My page' });
    return { mine, theirs, theirFolder, theirPage, sideFolder, sidePage, myPage };
  }

  it('another workspace’s page or folder is never readable, by id or by project key', async () => {
    const { theirs, theirFolder, theirPage } = await twoTenants();
    for (const parent of [`page:${theirPage.id}`, `folder:${theirFolder.id}`]) {
      expect((await treeGet({ parent })).status).toBe(404);
    }
    expect((await treeGet({ parent: 'root', projectKey: theirs.owner.projectKey })).status).toBe(
      404,
    );
    expect((await readPage(theirPage.id)).status).toBe(404);
    await expect(
      pagesService.getPageTrail(svc(actor.current!), {
        projectId: actor.current!.projectId,
        pageId: theirPage.id,
      }),
    ).rejects.toBeInstanceOf(PageNotFoundError);
  });

  it('another workspace’s page or folder is never a target — create, move, neighbour — and nothing moves', async () => {
    const { theirFolder, theirPage, myPage } = await twoTenants();
    const before = await adminDb.page.findMany({ orderBy: { id: 'asc' } });

    expect(
      (await createPage({ title: 'X', parent: { kind: 'page', id: theirPage.id } })).status,
    ).toBe(404);
    expect(
      (await createPage({ title: 'X', parent: { kind: 'folder', id: theirFolder.id } })).status,
    ).toBe(404);
    expect((await place(myPage, { parent: { kind: 'page', id: theirPage.id } })).status).toBe(404);
    expect((await place(myPage, { parent: { kind: 'folder', id: theirFolder.id } })).status).toBe(
      404,
    );
    // Their page is not mine to move, anywhere.
    expect((await place(theirPage.id, { parent: { kind: 'root' } })).status).toBe(404);
    // Nor a neighbour to sort against.
    const neighbour = await place(myPage, { parent: { kind: 'root' }, beforeId: theirPage.id });
    expect([404, 422]).toContain(neighbour.status);

    expect(await adminDb.page.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });

  it('another project’s page or folder in the same workspace is not a place for this project’s pages', async () => {
    const { sideFolder, sidePage, myPage, mine } = await twoTenants();
    const before = await pageRow(myPage);
    const folderRes = await place(myPage, { parent: { kind: 'folder', id: sideFolder.id } });
    expect(folderRes.status).toBe(404);
    expect(await folderRes.json()).toMatchObject({ code: 'FOLDER_NOT_FOUND' });
    const pageRes = await place(myPage, { parent: { kind: 'page', id: sidePage.id } });
    expect([404, 422]).toContain(pageRes.status);
    expect((await createPage({ parent: { kind: 'folder', id: sideFolder.id } })).status).toBe(404);
    expect(await pageRow(myPage)).toEqual(before);
    // The other project's level is read by naming its key, and only there.
    const side = await treeLevel('root', { projectKey: `${mine.owner.projectKey}X` });
    expect(own(side).map(label)).toEqual(['folder Side folder', 'page Side page']);
    expect(own(await treeLevel('root')).map(label)).toEqual(['page My page']);
  });

  it('a session whose active context names a workspace it does not belong to reads and writes nothing', async () => {
    const { theirs, theirPage } = await twoTenants();
    // A forged active project: the stranger's own user, the other tenant's ids.
    actor.current = { ...theirs.owner, userId: actor.current!.userId };
    expect((await treeGet({ parent: 'root' })).status).toBe(404);
    expect((await treeGet({ parent: `page:${theirPage.id}` })).status).toBe(404);
    expect((await place(theirPage.id, { parent: { kind: 'root' } })).status).toBe(404);
    expect((await createPage({ title: 'Planted' })).status).toBe(404);
    expect(await adminDb.page.count({ where: { workspaceId: theirs.workspaceId } })).toBe(1);
  });

  it('the row-level policies hide the other workspace’s pages and folders from this one’s context', async () => {
    const { mine, theirFolder, theirPage, myPage } = await twoTenants();
    const seen = await inProject(mine, async (tx) => ({
      page: await pageRepository.findById(theirPage.id, tx),
      folder: await pageRepository.findFolderForPlacement(theirFolder.id, tx),
      subtree: await pageRepository.findSubtree(theirPage.id, tx),
      mine: await pageRepository.findById(myPage, tx),
    }));
    expect(seen.page).toBeNull();
    expect(seen.folder).toBeNull();
    expect(seen.subtree).toEqual([]);
    expect(seen.mine?.id).toBe(myPage);
  });
});
