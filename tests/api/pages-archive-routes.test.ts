import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRole } from '@/generated/prisma/client';

// The page ARCHIVE routes (Story MOTIR-5755 · MOTIR-7422), called as handlers
// against real Postgres, the way `pages-history-routes.test.ts` calls its
// siblings. Only the session and the active project are mocked, so every gate,
// the service, the package and the refusal map run for real.

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
    project: { identifier: string };
  } | null,
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: vi.fn(async () => activeProject.current),
}));

const { POST: ARCHIVE, DELETE: RESTORE } = await import('@/app/api/pages/[pageId]/archive/route');
const { GET: READ, DELETE: DESTROY } = await import('@/app/api/pages/[pageId]/route');
const { GET: ARCHIVED } = await import('@/app/api/pages/archived/route');
const { POST: CREATE } = await import('@/app/api/pages/route');
const { POST: SAVE } = await import('@/app/api/pages/[pageId]/updates/route');
const { pagesService } = await import('@/lib/services/pagesService');
const { emptyState, markdownToUpdate } = await import('@/lib/pages');
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
  project: { identifier: string };
}

interface Fixture {
  workspaceId: string;
  projectId: string;
  otherProjectId: string;
  manager: Actor;
}

async function makeUser(tag: string) {
  return usersService.createUser({
    email: `pages-archive-route-${tag}@example.com`,
    password: 'hunter2hunter2',
    name: `Pages ${tag}`,
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
    identifier: 'PAR',
  });
  const other = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'Other',
    identifier: 'OAR',
  });
  return {
    workspaceId,
    projectId: project.id,
    otherProjectId: other.id,
    manager: {
      userId: owner.id,
      workspaceId,
      projectId: project.id,
      project: { identifier: 'PAR' },
    },
  };
}

async function actorAs(f: Fixture, tag: string, role: WorkspaceRole): Promise<Actor> {
  const user = await makeUser(tag);
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: f.workspaceId, workspaceRole: role },
  });
  return { ...f.manager, userId: user.id };
}

function as(actor: Actor | null): void {
  session.current = actor ? { user: { id: actor.userId } } : null;
  activeProject.current = actor;
}

const params = (pageId: string) => ({ params: Promise.resolve({ pageId }) });

const archive = (pageId: string) =>
  ARCHIVE(new Request(`${BASE}/${pageId}/archive`, { method: 'POST' }), params(pageId));
const restore = (pageId: string) =>
  RESTORE(new Request(`${BASE}/${pageId}/archive`, { method: 'DELETE' }), params(pageId));
const destroy = (pageId: string) =>
  DESTROY(new Request(`${BASE}/${pageId}`, { method: 'DELETE' }), params(pageId));
const read = (pageId: string) => READ(new Request(`${BASE}/${pageId}`), params(pageId));
const archived = (query = '') => ARCHIVED(new Request(`${BASE}/archived${query}`));

const make = (f: Fixture, title: string, parent?: { kind: string; id?: string }) =>
  pagesService.createPage(f.manager, { projectId: f.projectId, title, parent });

describe('POST / DELETE /api/pages/[pageId]/archive', () => {
  it('a Member archives (200, the set) and restores (200, the landing)', async () => {
    const f = await makeFixture();
    const member = await actorAs(f, 'member', 'member');
    const page = await make(f, 'Page');
    const sub = await make(f, 'Sub', { kind: 'page', id: page.id });
    as(member);

    const res = await archive(page.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      archivedIds: [page.id, sub.id],
      rootId: page.id,
      subPageCount: 1,
    });

    // The sub-page names its root; the root restores.
    const wrong = await restore(sub.id);
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toMatchObject({
      code: 'PAGE_ARCHIVE_ROOT_REQUIRED',
      rootId: page.id,
    });

    const back = await restore(page.id);
    expect(back.status).toBe(200);
    expect(await back.json()).toEqual({
      restoredIds: [page.id, sub.id],
      landing: { kind: 'original', parentPageId: null, folderId: null, title: null },
    });

    const live = await restore(page.id);
    expect(live.status).toBe(409);
    expect(await live.json()).toMatchObject({ code: 'PAGE_NOT_ARCHIVED' });
  });

  it('a Viewer is 403 and nothing changes; another project’s page and a stranger are 404', async () => {
    const f = await makeFixture();
    const viewer = await actorAs(f, 'viewer', 'viewer');
    const page = await make(f, 'Page');

    as(viewer);
    const res = await archive(page.id);
    expect(res.status).toBe(403);
    expect(await adminDb.page.findUniqueOrThrow({ where: { id: page.id } })).toMatchObject({
      archivedAt: null,
    });

    const foreign = await pagesService.createPage(f.manager, {
      projectId: f.otherProjectId,
      title: 'Elsewhere',
    });
    as(f.manager);
    const missing = await archive(foreign.id);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ code: 'PAGE_NOT_FOUND', error: 'Page not found.' });

    const stranger = await makeUser('stranger');
    as({ ...f.manager, userId: stranger.id });
    expect((await archive(page.id)).status).toBe(404);
    expect((await restore(page.id)).status).toBe(404);
  });

  it('a second archive is 409 PAGE_ARCHIVED', async () => {
    const f = await makeFixture();
    const page = await make(f, 'Page');
    as(f.manager);
    expect((await archive(page.id)).status).toBe(200);
    const again = await archive(page.id);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'PAGE_ARCHIVED' });
  });

  it('answers 401 without a session and 400 without an active project', async () => {
    expect((await archive('p')).status).toBe(401);
    expect((await restore('p')).status).toBe(401);
    const user = await makeUser('lost');
    session.current = { user: { id: user.id } };
    for (const res of [
      await archive('p'),
      await restore('p'),
      await destroy('p'),
      await archived(),
    ]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'NO_ACTIVE_PROJECT' });
    }
  });
});

describe('DELETE /api/pages/[pageId] — permanent delete', () => {
  it('a Member is 403; a Manager is 409 on a live page, then 200, and the page is gone', async () => {
    const f = await makeFixture();
    const member = await actorAs(f, 'member', 'member');
    const page = await make(f, 'Page');
    const sub = await make(f, 'Sub', { kind: 'page', id: page.id });

    as(f.manager);
    const live = await destroy(page.id);
    expect(live.status).toBe(409);
    expect(await live.json()).toMatchObject({ code: 'PAGE_NOT_ARCHIVED' });

    expect((await archive(page.id)).status).toBe(200);

    as(member);
    expect((await destroy(page.id)).status).toBe(403);

    as(f.manager);
    const res = await destroy(page.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deletedIds: string[] };
    expect([...body.deletedIds].sort()).toEqual([page.id, sub.id].sort());
    expect((await read(page.id)).status).toBe(404);
    expect((await read(sub.id)).status).toBe(404);
  });
});

describe('GET /api/pages/[pageId] — an archived page', () => {
  it('reads 200 with its archive state, read-only', async () => {
    const f = await makeFixture();
    const page = await make(f, 'Page');
    as(f.manager);
    await archive(page.id);
    const res = await read(page.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: page.id,
      canEdit: false,
      canRestore: true,
      archiveRoot: { id: page.id, title: 'Page' },
      archivedBy: { id: f.manager.userId },
    });
  });
});

describe('the existing write doors on an archived page', () => {
  it('a save is 409 PAGE_ARCHIVED, and a create under it is 422 PAGE_PARENT_ARCHIVED', async () => {
    const f = await makeFixture();
    const page = await make(f, 'Page');
    as(f.manager);
    await archive(page.id);

    const saved = await SAVE(
      new Request(`${BASE}/${page.id}/updates`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: markdownToUpdate(emptyState(), 'x') as BodyInit,
      }),
      params(page.id),
    );
    expect(saved.status).toBe(409);
    expect(await saved.json()).toMatchObject({ code: 'PAGE_ARCHIVED' });

    const created = await CREATE(
      new Request(BASE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Child', parent: { kind: 'page', id: page.id } }),
      }),
    );
    expect(created.status).toBe(422);
    expect(await created.json()).toMatchObject({ code: 'PAGE_PARENT_ARCHIVED' });
  });
});

describe('GET /api/pages/archived', () => {
  it('pages at 50 by default, clamps limit to 100, and walks on with the cursor', async () => {
    const f = await makeFixture();
    const viewer = await actorAs(f, 'viewer', 'viewer');
    const template = await make(f, 'Template');
    const row = await adminDb.page.findUniqueOrThrow({ where: { id: template.id } });
    await adminDb.page.delete({ where: { id: template.id } });
    const base = Date.parse('2026-09-01T00:00:00.000Z');
    await adminDb.page.createMany({
      data: Array.from({ length: 120 }, (_, i) => {
        const id = `arch-${String(i).padStart(3, '0')}`;
        return {
          ...row,
          bodyJson: row.bodyJson ?? {},
          id,
          title: id,
          position: `a${String(i).padStart(3, '0')}`,
          archivedAt: new Date(base + i * 1000),
          archiveRootId: id,
          archivedById: f.manager.userId,
        };
      }),
    });

    as(viewer);
    const first = await archived();
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as {
      items: Array<{ id: string; archivedBy: { name: string } }>;
      nextCursor: string | null;
    };
    expect(page1.items).toHaveLength(50);
    expect(page1.items[0]).toMatchObject({ id: 'arch-119', archivedBy: { name: 'Pages owner' } });
    expect(page1.nextCursor).not.toBeNull();

    const next = await archived(`?cursor=${encodeURIComponent(page1.nextCursor!)}`);
    const page2 = (await next.json()) as { items: Array<{ id: string }> };
    expect(page2.items[0]!.id).toBe('arch-069');

    const capped = (await (await archived('?limit=500')).json()) as { items: unknown[] };
    expect(capped.items).toHaveLength(100);
    const one = (await (await archived('?limit=1')).json()) as { items: unknown[] };
    expect(one.items).toHaveLength(1);
  });

  it('refuses a bad limit and a malformed cursor with 400', async () => {
    const f = await makeFixture();
    as(f.manager);
    for (const q of ['?limit=0', '?limit=abc']) {
      const res = await archived(q);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
    }
    const res = await archived('?cursor=garbage');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'PAGE_CURSOR_INVALID' });
  });

  it('reads another project of the workspace by projectKey, and the active one by its own key', async () => {
    const f = await makeFixture();
    const elsewhere = await pagesService.createPage(f.manager, {
      projectId: f.otherProjectId,
      title: 'Elsewhere',
    });
    await pagesService.archivePage(f.manager, {
      projectId: f.otherProjectId,
      pageId: elsewhere.id,
    });
    as(f.manager);

    const other = (await (await archived('?projectKey=OAR')).json()) as {
      items: Array<{ id: string }>;
    };
    expect(other.items.map((i) => i.id)).toEqual([elsewhere.id]);
    const own = (await (await archived('?projectKey=par')).json()) as { items: unknown[] };
    expect(own.items).toEqual([]);
    expect((await archived('?projectKey=NOPE')).status).toBe(404);
  });
});
