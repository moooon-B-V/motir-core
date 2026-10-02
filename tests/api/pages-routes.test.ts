import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRole } from '@/generated/prisma/client';

// The `/api/pages` session routes (Story MOTIR-5752 · MOTIR-7278), called as
// handlers against real Postgres. Only the two request-bound reads are mocked —
// the session and the active project, which need cookies — so every gate, the
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

const { POST: CREATE } = await import('@/app/api/pages/route');
const { GET, PATCH } = await import('@/app/api/pages/[pageId]/route');
const { POST: SAVE } = await import('@/app/api/pages/[pageId]/updates/route');
const { pagesService } = await import('@/lib/services/pagesService');
const { emptyState, markdownToUpdate, stateToMarkdown } = await import('@/lib/pages');
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
    email: `pages-route-${tag}@example.com`,
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
    identifier: 'PGR',
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

const params = (pageId: string) => ({ params: Promise.resolve({ pageId }) });

function create(body?: unknown): Promise<Response> {
  return CREATE(
    new Request(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

function read(pageId: string): Promise<Response> {
  return GET(new Request(`${BASE}/${pageId}`), params(pageId));
}

function rename(pageId: string, title: unknown): Promise<Response> {
  return PATCH(
    new Request(`${BASE}/${pageId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
    params(pageId),
  );
}

function save(pageId: string, bytes: Uint8Array, headers: Record<string, string> = {}) {
  return SAVE(
    new Request(`${BASE}/${pageId}/updates`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', ...headers },
      body: bytes as BodyInit,
    }),
    params(pageId),
  );
}

/** A body sent as a stream, so the request carries no `Content-Length`. */
function saveStreamed(pageId: string, bytes: Uint8Array) {
  const chunk = 64 * 1024;
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + chunk));
      offset += chunk;
    },
  });
  const req = new Request(`${BASE}/${pageId}/updates`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: stream,
    duplex: 'half',
  } as RequestInit);
  expect(req.headers.get('content-length')).toBeNull();
  return SAVE(req, params(pageId));
}

async function createdId(res: Response): Promise<string> {
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe('the page routes — a member', () => {
  it('creates, reads, saves and renames a page', async () => {
    const f = await makeFixture();
    as(await actorAs(f, 'member', 'member'));

    const id = await createdId(await create());
    const first = await read(id);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ id, revision: 1, title: '', canEdit: true });

    const saved = await save(id, markdownToUpdate(emptyState(), 'Hello from the route'));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ revision: 2 });

    const after = (await (await read(id)).json()) as { bodyState: string; revision: number };
    expect(after.revision).toBe(2);
    expect(stateToMarkdown(new Uint8Array(Buffer.from(after.bodyState, 'base64')))).toContain(
      'Hello from the route',
    );

    const renamed = await rename(id, 'Roadmap');
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ title: 'Roadmap' });
  });

  it('creates with a title from the optional JSON body', async () => {
    const f = await makeFixture();
    as(f.manager);
    const id = await createdId(await create({ title: 'Spec' }));
    expect(await (await read(id)).json()).toMatchObject({ title: 'Spec' });
  });

  it('refuses a malformed body as 400', async () => {
    const f = await makeFixture();
    as(f.manager);
    expect((await create({ title: 7 })).status).toBe(400);
    const id = await createdId(await create());
    expect((await rename(id, 7)).status).toBe(400);
  });

  it('refuses a 256-character title as 422', async () => {
    const f = await makeFixture();
    as(f.manager);
    const id = await createdId(await create());
    const res = await rename(id, 'x'.repeat(256));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'PAGE_TITLE_TOO_LONG', limit: 255 });
  });
});

describe('the save cap', () => {
  it('refuses a declared Content-Length over the cap before the service is called', async () => {
    const f = await makeFixture();
    as(f.manager);
    const id = await createdId(await create());
    const spy = vi.spyOn(pagesService, 'savePageUpdate');

    const res = await save(id, new Uint8Array(1_048_577), { 'content-length': '1048577' });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      code: 'PAGE_BODY_TOO_LARGE',
      limit: 1_048_576,
      size: 1_048_577,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses the same body sent with no Content-Length, on the running count', async () => {
    const f = await makeFixture();
    as(f.manager);
    const id = await createdId(await create());
    const spy = vi.spyOn(pagesService, 'savePageUpdate');

    const res = await saveStreamed(id, new Uint8Array(1_048_577));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: 'PAGE_BODY_TOO_LARGE', limit: 1_048_576 });
    expect(spy).not.toHaveBeenCalled();
    const stored = await adminDb.page.findUniqueOrThrow({ where: { id } });
    expect(stored.revision).toBe(1);
  });
});

describe('who reaches a page', () => {
  it('a viewer reads with canEdit false and is refused every write as 403', async () => {
    const f = await makeFixture();
    const page = await pagesService.createPage(f.manager, { projectId: f.projectId });
    as(await actorAs(f, 'viewer', 'viewer'));

    const res = await read(page.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: page.id, canEdit: false });
    expect((await rename(page.id, 'x')).status).toBe(403);
    expect((await save(page.id, markdownToUpdate(emptyState(), 'x'))).status).toBe(403);
    expect((await create()).status).toBe(403);
  });

  it('a non-member and a page from another project get one identical 404', async () => {
    const f = await makeFixture();
    const mine = await pagesService.createPage(f.manager, { projectId: f.projectId });
    const elsewhere = await pagesService.createPage(f.manager, { projectId: f.otherProjectId });

    const bodies: unknown[] = [];
    const record = async (res: Response) => {
      expect(res.status).toBe(404);
      bodies.push(await res.json());
    };

    as(await actorAs(f, 'stranger', null));
    await record(await read(mine.id));
    await record(await rename(mine.id, 'x'));
    await record(await save(mine.id, markdownToUpdate(emptyState(), 'x')));

    as(f.manager);
    await record(await read(elsewhere.id));
    await record(await rename(elsewhere.id, 'x'));
    await record(await save(elsewhere.id, markdownToUpdate(emptyState(), 'x')));

    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(bodies[0]).toEqual({ code: 'PAGE_NOT_FOUND', error: 'Page not found.' });
  });

  it('an unauthenticated request is refused by the session gate', async () => {
    as(null);
    for (const res of [
      await create(),
      await read('any'),
      await rename('any', 'x'),
      await save('any', new Uint8Array(1)),
    ]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ code: 'UNAUTHENTICATED' });
    }
  });

  it('a session with no active project is refused as 400', async () => {
    const f = await makeFixture();
    session.current = { user: { id: f.manager.userId } };
    activeProject.current = null;
    const res = await create();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'NO_ACTIVE_PROJECT' });
  });
});
