import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRole } from '@/generated/prisma/client';

// The page HISTORY routes (Story MOTIR-5754 · MOTIR-7386), called as handlers
// against real Postgres, the way `pages-routes.test.ts` calls their siblings.
// Only the session and the active project are mocked, so every gate, the
// service and the refusal map run for real.

const session = vi.hoisted(() => ({ current: null as { user: { id: string } } | null }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => session.current),
}));
const activeProject = vi.hoisted(() => ({
  current: null as { userId: string; workspaceId: string; projectId: string } | null,
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: vi.fn(async () => activeProject.current),
}));

const { GET: LIST } = await import('@/app/api/pages/[pageId]/versions/route');
const { GET: READ } = await import('@/app/api/pages/[pageId]/versions/[number]/route');
const { POST: RESTORE } = await import('@/app/api/pages/[pageId]/versions/[number]/restore/route');
const { pagesService } = await import('@/lib/services/pagesService');
const { PAGE_BODY_MAX_BYTES, applyUpdate, emptyState, markdownToUpdate, stateToMarkdown } =
  await import('@/lib/pages');
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
}

interface Fixture {
  workspaceId: string;
  projectId: string;
  otherProjectId: string;
  manager: Actor;
}

async function makeUser(tag: string) {
  return usersService.createUser({
    email: `pages-hist-route-${tag}@example.com`,
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
    identifier: 'PHR',
  });
  const other = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'Other',
    identifier: 'OHR',
  });
  return {
    workspaceId,
    projectId: project.id,
    otherProjectId: other.id,
    manager: { userId: owner.id, workspaceId, projectId: project.id },
  };
}

async function actorAs(f: Fixture, tag: string, role: WorkspaceRole | null): Promise<Actor> {
  const user = await makeUser(tag);
  if (role) {
    await adminDb.workspaceMembership.create({
      data: { userId: user.id, workspaceId: f.workspaceId, workspaceRole: role },
    });
  }
  return { userId: user.id, workspaceId: f.workspaceId, projectId: f.projectId };
}

function as(actor: Actor | null): void {
  session.current = actor ? { user: { id: actor.userId } } : null;
  activeProject.current = actor;
}

const list = (pageId: string, query = '') =>
  LIST(new Request(`${BASE}/${pageId}/versions${query}`), {
    params: Promise.resolve({ pageId }),
  });

const read = (pageId: string, number: string | number) =>
  READ(new Request(`${BASE}/${pageId}/versions/${number}`), {
    params: Promise.resolve({ pageId, number: String(number) }),
  });

const restore = (pageId: string, number: string | number) =>
  RESTORE(new Request(`${BASE}/${pageId}/versions/${number}/restore`, { method: 'POST' }), {
    params: Promise.resolve({ pageId, number: String(number) }),
  });

/** A page with v1 (empty) and v2 ("First"), by the manager. */
async function pageWithTwoVersions(f: Fixture): Promise<string> {
  const page = await pagesService.createPage(f.manager, { projectId: f.projectId });
  await adminDb.pageVersion.updateMany({
    where: { pageId: page.id },
    data: { startedAt: new Date(0), savedAt: new Date(0) },
  });
  await pagesService.savePageUpdate(f.manager, {
    projectId: f.projectId,
    pageId: page.id,
    update: markdownToUpdate(emptyState(), 'First'),
  });
  return page.id;
}

/** Appends one version straight to the table, after the page's newest. */
async function appendVersion(f: Fixture, pageId: string, state: Uint8Array): Promise<number> {
  const latest = await adminDb.pageVersion.findFirstOrThrow({
    where: { pageId },
    orderBy: { number: 'desc' },
  });
  const at = new Date(latest.savedAt.getTime() + 60 * 60 * 1000);
  await adminDb.pageVersion.create({
    data: {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      pageId,
      number: latest.number + 1,
      authorId: f.manager.userId,
      bodyState: Buffer.from(state),
      bodyMarkdown: stateToMarkdown(state),
      startedAt: at,
      savedAt: at,
    },
  });
  return latest.number + 1;
}

describe('the page history routes', () => {
  it('lists, reads and restores a version for an editor', async () => {
    const f = await makeFixture();
    const pageId = await pageWithTwoVersions(f);
    as(await actorAs(f, 'editor', 'member'));

    const listed = await list(pageId);
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as { items: { number: number }[]; nextBefore: unknown };
    expect(page.items.map((v) => v.number)).toEqual([2, 1]);
    expect(page.nextBefore).toBeNull();

    const paged = await list(pageId, '?limit=1');
    expect(await paged.json()).toMatchObject({ items: [{ number: 2 }], nextBefore: 2 });
    expect(await (await list(pageId, '?before=2')).json()).toMatchObject({
      items: [{ number: 1 }],
      nextBefore: null,
    });

    const v2 = await read(pageId, 2);
    expect(v2.status).toBe(200);
    const version = (await v2.json()) as { number: number; bodyState: string; isCurrent: boolean };
    expect(version).toMatchObject({ number: 2, isCurrent: true });
    expect(stateToMarkdown(new Uint8Array(Buffer.from(version.bodyState, 'base64')))).toBe('First');

    const restored = await restore(pageId, 1);
    expect(restored.status).toBe(200);
    const result = (await restored.json()) as {
      revision: number;
      version: { number: number; restoredFromNumber: number };
      bodyState: string;
    };
    expect(result.version).toMatchObject({ number: 3, restoredFromNumber: 1 });
    expect(typeof result.revision).toBe('number');
    expect(stateToMarkdown(new Uint8Array(Buffer.from(result.bodyState, 'base64')))).toBe('');
  });

  it('refuses a malformed `before`, `limit` or number as 400', async () => {
    const f = await makeFixture();
    const pageId = await pageWithTwoVersions(f);
    as(f.manager);

    for (const res of [
      await list(pageId, '?before=abc'),
      await list(pageId, '?limit=0'),
      await list(pageId, '?limit=-3'),
      await read(pageId, 0),
      await read(pageId, 'abc'),
      await read(pageId, '1.5'),
      await restore(pageId, 0),
    ]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
    }
  });

  it('answers an unknown or pruned version as 404 PAGE_VERSION_NOT_FOUND', async () => {
    const f = await makeFixture();
    const pageId = await pageWithTwoVersions(f);
    as(f.manager);

    const unknown = await read(pageId, 9);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: 'PAGE_VERSION_NOT_FOUND' });

    await adminDb.pageVersion.delete({ where: { pageId_number: { pageId, number: 1 } } });
    const pruned = await restore(pageId, 1);
    expect(pruned.status).toBe(404);
    expect(await pruned.json()).toMatchObject({ code: 'PAGE_VERSION_NOT_FOUND' });
  });

  it('refuses a restore past the body limit as 413 with limit and size', async () => {
    const f = await makeFixture();
    const pageId = await pageWithTwoVersions(f);
    const huge = await appendVersion(
      f,
      pageId,
      applyUpdate(
        emptyState(),
        markdownToUpdate(emptyState(), 'x'.repeat(PAGE_BODY_MAX_BYTES + 1024)),
      ),
    );
    await appendVersion(f, pageId, emptyState());
    as(f.manager);

    const res = await restore(pageId, huge);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string; limit: number; size: number };
    expect(body).toMatchObject({ code: 'PAGE_BODY_TOO_LARGE', limit: PAGE_BODY_MAX_BYTES });
    expect(body.size).toBeGreaterThan(PAGE_BODY_MAX_BYTES);
  });

  it('a viewer lists and reads, and is refused a restore as 403', async () => {
    const f = await makeFixture();
    const pageId = await pageWithTwoVersions(f);
    as(await actorAs(f, 'viewer', 'viewer'));

    expect((await list(pageId)).status).toBe(200);
    expect((await read(pageId, 1)).status).toBe(200);
    expect((await restore(pageId, 1)).status).toBe(403);
    expect(await adminDb.pageVersion.count({ where: { pageId } })).toBe(2);
  });

  it('a non-member and a page from another project get the page’s one 404', async () => {
    const f = await makeFixture();
    const mine = await pageWithTwoVersions(f);
    const elsewhere = await pagesService.createPage(f.manager, { projectId: f.otherProjectId });

    const bodies: unknown[] = [];
    const record = async (res: Response) => {
      expect(res.status).toBe(404);
      bodies.push(await res.json());
    };

    as(await actorAs(f, 'stranger', null));
    await record(await list(mine));
    await record(await read(mine, 1));
    await record(await restore(mine, 1));

    as(f.manager);
    await record(await list(elsewhere.id));
    await record(await read(elsewhere.id, 1));
    await record(await restore(elsewhere.id, 1));

    for (const body of bodies) {
      expect(body).toEqual({ code: 'PAGE_NOT_FOUND', error: 'Page not found.' });
    }
  });

  it('an unauthenticated request is refused by the session gate', async () => {
    as(null);
    for (const res of [await list('any'), await read('any', 1), await restore('any', 1)]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ code: 'UNAUTHENTICATED' });
    }
  });

  it('a session with no active project is refused as 400', async () => {
    const f = await makeFixture();
    session.current = { user: { id: f.manager.userId } };
    activeProject.current = null;
    for (const res of [await list('any'), await read('any', 1), await restore('any', 1)]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'NO_ACTIVE_PROJECT' });
    }
  });
});
