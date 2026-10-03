import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRole } from '@/generated/prisma/client';

// The page-tree doors (Story MOTIR-5753 · MOTIR-7372): `GET /api/pages/tree`,
// `POST /api/pages` with a `parent`, and `PATCH /api/pages/[pageId]/placement`,
// called as handlers against real Postgres. Only the session and the active
// project are mocked, as in the sibling suites.

const session = vi.hoisted(() => ({ current: null as { user: { id: string } } | null }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => session.current),
}));
const activeProject = vi.hoisted(() => ({
  current: null as {
    userId: string;
    workspaceId: string;
    projectId: string;
    projectKey?: string;
  } | null,
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  // Only `project.identifier` is read by the tree door, so a stub carries it.
  getActiveProject: vi.fn(async () => {
    const a = activeProject.current;
    return a ? { ...a, project: { identifier: a.projectKey ?? 'TRE' } } : null;
  }),
}));

const { POST: CREATE } = await import('@/app/api/pages/route');
const { GET: TREE } = await import('@/app/api/pages/tree/route');
const { PATCH: PLACE } = await import('@/app/api/pages/[pageId]/placement/route');
const { pagesService } = await import('@/lib/services/pagesService');
const { foldersService } = await import('@/lib/services/foldersService');
const { db } = await import('@/lib/db');
const { projectsService } = await import('@/lib/services/projectsService');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

const BASE = 'http://localhost:3000/api/pages';

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  activeProject.current = null;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Actor {
  userId: string;
  workspaceId: string;
  projectId: string;
  projectKey?: string;
}

async function makeUser(tag: string) {
  return usersService.createUser({
    email: `pages-tree-${tag}@example.com`,
    password: 'hunter2hunter2',
    name: `Tree ${tag}`,
  });
}

async function makeFixture() {
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
    identifier: 'OTH',
  });
  // Project creation seeds starter pages (cleared here) and a Bugs folder (filtered by `own`).
  await adminDb.page.deleteMany({});
  const manager: Actor = {
    userId: owner.id,
    workspaceId,
    projectId: project.id,
    projectKey: 'TRE',
  };
  return { workspaceId, projectId: project.id, otherProjectId: other.id, manager };
}
type Fixture = Awaited<ReturnType<typeof makeFixture>>;

async function actorAs(f: Fixture, tag: string, role: WorkspaceRole | null): Promise<Actor> {
  const user = await makeUser(tag);
  if (role) {
    await adminDb.workspaceMembership.create({
      data: { userId: user.id, workspaceId: f.workspaceId, workspaceRole: role },
    });
  }
  return { userId: user.id, workspaceId: f.workspaceId, projectId: f.projectId, projectKey: 'TRE' };
}

function as(actor: Actor | null): void {
  session.current = actor ? { user: { id: actor.userId } } : null;
  activeProject.current = actor;
}

const params = (pageId: string) => ({ params: Promise.resolve({ pageId }) });
const svc = (a: Actor) => ({ userId: a.userId, workspaceId: a.workspaceId });

function tree(query: Record<string, string>): Promise<Response> {
  return TREE(new Request(`${BASE}/tree?${new URLSearchParams(query)}`));
}

function create(body: unknown): Promise<Response> {
  return CREATE(
    new Request(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
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

async function mkPage(f: Fixture, title: string, parent?: { kind: string; id?: string }) {
  return pagesService.createPage(svc(f.manager), { projectId: f.projectId, title, parent });
}

/** A level's rows without the project's seeded `Bugs` folder. */
const own = (l: Level) => l.rows.filter((r) => r.name !== 'Bugs');

interface Level {
  rows: Array<{ kind: string; id: string; title?: string; name?: string; hasChildren: boolean }>;
  nextCursor: string | null;
}

describe('GET /api/pages/tree', () => {
  it('lists folders then pages at the root, and sub-pages under a page', async () => {
    const f = await makeFixture();
    as(f.manager);
    const folder = await foldersService.createFolder(
      { projectId: f.projectId, parentFolderId: null, name: 'Specs' },
      svc(f.manager),
    );
    const a = await mkPage(f, 'A');
    const sub = await mkPage(f, 'Sub', { kind: 'page', id: a.id });

    const root = await tree({ projectKey: 'TRE', parent: 'root' });
    expect(root.status).toBe(200);
    const rootBody = (await root.json()) as Level;
    expect(own(rootBody).map((r) => [r.kind, r.id])).toEqual([
      ['folder', folder.id],
      ['page', a.id],
    ]);
    expect(own(rootBody)[1]!.hasChildren).toBe(true);
    expect(rootBody.nextCursor).toBeNull();

    const under = (await (
      await tree({ projectKey: 'TRE', parent: `page:${a.id}` })
    ).json()) as Level;
    expect(under.rows.map((r) => r.id)).toEqual([sub.id]);

    const inFolder = await tree({ projectKey: 'TRE', parent: `folder:${folder.id}` });
    expect(inFolder.status).toBe(200);
    expect(((await inFolder.json()) as Level).rows).toEqual([]);
  });

  it('continues a level with nextCursor', async () => {
    const f = await makeFixture();
    as(f.manager);
    const ids = [
      (await mkPage(f, 'P1')).id,
      (await mkPage(f, 'P2')).id,
      (await mkPage(f, 'P3')).id,
    ];

    const first = (await (
      await tree({ projectKey: 'TRE', parent: 'root', limit: '2' })
    ).json()) as Level;
    expect(first.rows).toHaveLength(2);
    expect(first.rows[0]!.kind).toBe('folder');
    expect(first.nextCursor).not.toBeNull();
    const second = (await (
      await tree({ projectKey: 'TRE', parent: 'root', limit: '2', cursor: first.nextCursor! })
    ).json()) as Level;
    expect(second.nextCursor).toBeNull();
    expect([...own(first), ...own(second)].map((r) => r.id).sort()).toEqual([...ids].sort());
  });

  it('defaults the parent to the root and resolves another project by key', async () => {
    const f = await makeFixture();
    as(f.manager);
    const elsewhere = await pagesService.createPage(svc(f.manager), {
      projectId: f.otherProjectId,
      title: 'Elsewhere',
    });
    const res = await tree({ projectKey: 'OTH' });
    expect(res.status).toBe(200);
    expect(own((await res.json()) as Level).map((r) => r.id)).toEqual([elsewhere.id]);
  });

  it.each([
    ['a bare word', { parent: 'banana' }],
    ['a page with no id', { parent: 'page:' }],
    ['a limit of zero', { parent: 'root', limit: '0' }],
    ['a non-numeric limit', { parent: 'root', limit: 'many' }],
  ])('refuses %s as 400', async (_l, query) => {
    const f = await makeFixture();
    as(f.manager);
    const res = await tree({ projectKey: 'TRE', ...query });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses a cursor it did not issue as 400 PAGE_CURSOR_INVALID', async () => {
    const f = await makeFixture();
    as(f.manager);
    const res = await tree({ projectKey: 'TRE', parent: 'root', cursor: 'not-a-cursor' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'PAGE_CURSOR_INVALID' });
  });

  it('answers a work-item parent as 422 and a missing page or folder parent as 404', async () => {
    const f = await makeFixture();
    as(f.manager);
    const wi = await tree({ projectKey: 'TRE', parent: 'work_item:abc' });
    expect(wi.status).toBe(422);
    expect(await wi.json()).toMatchObject({ code: 'PAGE_PARENT_NOT_ALLOWED' });
    const missingPage = await tree({ projectKey: 'TRE', parent: 'page:nope' });
    expect(missingPage.status).toBe(404);
    const missingFolder = await tree({ projectKey: 'TRE', parent: 'folder:nope' });
    expect(missingFolder.status).toBe(404);
    expect(await missingFolder.json()).toMatchObject({ code: 'FOLDER_NOT_FOUND' });
  });

  it('answers a non-member 404, and an unauthenticated request 401', async () => {
    const f = await makeFixture();
    as(await actorAs(f, 'stranger', null));
    expect((await tree({ projectKey: 'TRE', parent: 'root' })).status).toBe(404);
    as(null);
    expect((await tree({ projectKey: 'TRE', parent: 'root' })).status).toBe(401);
  });
});

describe('POST /api/pages with a parent', () => {
  it('creates a sub-page under a page', async () => {
    const f = await makeFixture();
    as(f.manager);
    const parent = await mkPage(f, 'Parent');
    const res = await create({ title: 'Child', parent: { kind: 'page', id: parent.id } });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await adminDb.page.findUniqueOrThrow({ where: { id } });
    expect(row.ancestorPageIds).toEqual([parent.id]);
  });

  it('refuses a malformed parent 400, a work-item parent 422, a missing parent 404', async () => {
    const f = await makeFixture();
    as(f.manager);
    expect((await create({ parent: 'page:x' })).status).toBe(400);
    expect((await create({ parent: { kind: 'page' } })).status).toBe(400);
    const wi = await create({ parent: { kind: 'work_item', id: 'x' } });
    expect(wi.status).toBe(422);
    expect(await wi.json()).toMatchObject({ code: 'PAGE_PARENT_NOT_ALLOWED' });
    expect((await create({ parent: { kind: 'page', id: 'nope' } })).status).toBe(404);
  });

  it('a viewer is refused 403 and a non-member 404', async () => {
    const f = await makeFixture();
    as(await actorAs(f, 'viewer', 'viewer'));
    expect((await create({ parent: { kind: 'root' } })).status).toBe(403);
    as(await actorAs(f, 'stranger', null));
    expect((await create({ parent: { kind: 'root' } })).status).toBe(404);
  });
});

describe('PATCH /api/pages/[pageId]/placement', () => {
  it('moves a page under another, and back to the root beside a neighbour', async () => {
    const f = await makeFixture();
    as(f.manager);
    const a = await mkPage(f, 'A');
    const b = await mkPage(f, 'B');
    const moved = await place(b.id, { parent: { kind: 'page', id: a.id } });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({
      id: b.id,
      parent: { kind: 'page', id: a.id },
      ancestorPageIds: [a.id],
      moved: true,
    });

    const back = await place(b.id, { parent: { kind: 'root' }, beforeId: a.id });
    expect(back.status).toBe(200);
    expect(await back.json()).toMatchObject({ parent: { kind: 'root' }, ancestorPageIds: [] });
  });

  it('refuses a cycle as 422 PAGE_CYCLE', async () => {
    const f = await makeFixture();
    as(f.manager);
    const a = await mkPage(f, 'A');
    const b = await mkPage(f, 'B', { kind: 'page', id: a.id });
    const res = await place(a.id, { parent: { kind: 'page', id: b.id } });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'PAGE_CYCLE' });
    const self = await place(a.id, { parent: { kind: 'page', id: a.id } });
    expect(self.status).toBe(422);
  });

  it('refuses a move past the depth limit as 422 PAGE_DEPTH_EXCEEDED carrying limit 10', async () => {
    const f = await makeFixture();
    as(f.manager);
    let tip = await mkPage(f, 'L1');
    for (let i = 2; i <= 10; i++) tip = await mkPage(f, `L${i}`, { kind: 'page', id: tip.id });
    const loose = await mkPage(f, 'Loose');
    const res = await place(loose.id, { parent: { kind: 'page', id: tip.id } });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: 'PAGE_DEPTH_EXCEEDED',
      limit: 10,
      attemptedLevel: 11,
    });
  });

  it('refuses a bad neighbour as 422 PAGE_NEIGHBOUR_INVALID with side and reason', async () => {
    const f = await makeFixture();
    as(f.manager);
    const a = await mkPage(f, 'A');
    const b = await mkPage(f, 'B');
    const res = await place(a.id, { parent: { kind: 'root' }, beforeId: a.id });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: 'PAGE_NEIGHBOUR_INVALID',
      side: 'before',
      reason: 'self',
    });
    const parent = await mkPage(f, 'P');
    const notSibling = await place(a.id, {
      parent: { kind: 'page', id: parent.id },
      afterId: b.id,
    });
    expect(notSibling.status).toBe(422);
    expect(await notSibling.json()).toMatchObject({
      code: 'PAGE_NEIGHBOUR_INVALID',
      side: 'after',
      reason: 'not_sibling',
    });
  });

  it('refuses a work-item parent 422, a missing parent or page 404, a bad body 400', async () => {
    const f = await makeFixture();
    as(f.manager);
    const a = await mkPage(f, 'A');
    const wi = await place(a.id, { parent: { kind: 'work_item', id: 'x' } });
    expect(wi.status).toBe(422);
    expect(await wi.json()).toMatchObject({ code: 'PAGE_PARENT_NOT_ALLOWED' });
    expect((await place(a.id, { parent: { kind: 'page', id: 'nope' } })).status).toBe(404);
    const folder = await place(a.id, { parent: { kind: 'folder', id: 'nope' } });
    expect(folder.status).toBe(404);
    expect((await place('nope', { parent: { kind: 'root' } })).status).toBe(404);
    expect((await place(a.id, {})).status).toBe(400);
    expect((await place(a.id, { parent: { kind: 'page' } })).status).toBe(400);
    expect((await place(a.id, { parent: { kind: 'root' }, beforeId: 7 })).status).toBe(400);
  });

  it('a page parent from another project is refused (what actually happens end to end)', async () => {
    const f = await makeFixture();
    as(f.manager);
    const mine = await mkPage(f, 'Mine');
    const foreign = await pagesService.createPage(svc(f.manager), {
      projectId: f.otherProjectId,
      title: 'Foreign',
    });
    const res = await place(mine.id, { parent: { kind: 'page', id: foreign.id } });
    // RLS hides the foreign page (404) under the app role; a bypass role reaches the
    // package's own rule (422). Either way it is refused and nothing moves.
    expect([404, 422]).toContain(res.status);
    if (res.status === 422)
      expect(await res.json()).toMatchObject({ code: 'CROSS_PROJECT_PAGE_PARENT' });
    const row = await adminDb.page.findUniqueOrThrow({ where: { id: mine.id } });
    expect(row.ancestorPageIds).toEqual([]);
  });

  it('a viewer is refused 403 and a non-member 404', async () => {
    const f = await makeFixture();
    const a = await mkPage(f, 'A');
    as(await actorAs(f, 'viewer', 'viewer'));
    expect((await place(a.id, { parent: { kind: 'root' } })).status).toBe(403);
    as(await actorAs(f, 'stranger', null));
    expect((await place(a.id, { parent: { kind: 'root' } })).status).toBe(404);
  });
});
