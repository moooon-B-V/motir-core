import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The `/api/pages` doors' REFUSAL arms (Story MOTIR-5752 · MOTIR-7281, the story's
// coverage gate) — the request-shape and mapping branches the happy-path suites
// (`tests/api/pages-routes.test.ts`, the page-image integration suite and
// `tests/integration/pagesStoryGate.test.ts`) never take: no active project on
// every door, a body that is not JSON / not multipart / has no `file`, a stream
// whose cancel itself fails, and the images door's mapping of the upload
// primitive's billing and permission refusals.
//
// Real Postgres for every arm that reaches the service. The two request-bound
// reads are mocked as the sibling suites mock them; where an arm can only be
// reached by an upstream refusal the test cannot provoke on a self-host build
// (the cloud storage cap), the SERVICE is spied for that one call — the shape
// `tests/attachments/work-item-attachments-route-entitlement.test.ts` uses —
// so what is pinned is the route's own status mapping.

interface Actor {
  userId: string;
  workspaceId: string;
  projectId: string;
}

const session = vi.hoisted(() => ({ current: null as { user: { id: string } } | null }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => session.current),
}));
const active = vi.hoisted(() => ({ current: null as Actor | null }));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: vi.fn(async () => active.current),
}));

const { POST: CREATE } = await import('@/app/api/pages/route');
const { GET: READ, PATCH: RENAME } = await import('@/app/api/pages/[pageId]/route');
const { POST: SAVE } = await import('@/app/api/pages/[pageId]/updates/route');
const { POST: UPLOAD } = await import('@/app/api/pages/[pageId]/images/route');
const { pagesService } = await import('@/lib/services/pagesService');
const { attachmentsService } = await import('@/lib/services/attachmentsService');
const { EntitlementExceededError } = await import('@/lib/billing/errors');
const { PermissionDeniedError } = await import('@/lib/projects/errors');
const { PAGE_SAVE_MAX_BYTES } = await import('@/lib/pages');
const { projectsService } = await import('@/lib/services/projectsService');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { db } = await import('@/lib/db');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

const BASE = 'http://localhost:3000/api/pages';
const params = (pageId: string) => ({ params: Promise.resolve({ pageId }) });

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  active.current = null;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A Manager standing in a project with one empty page. */
async function makeFixture(): Promise<{ manager: Actor; pageId: string }> {
  const owner = await usersService.createUser({
    email: 'pages-refusals-owner@example.com',
    password: 'hunter2hunter2',
    name: 'Refusals owner',
  });
  const ws = await workspacesService.createWorkspace({ name: 'Refusals', ownerUserId: owner.id });
  const project = await projectsService.createProject({
    workspaceId: ws.workspace.id,
    actorUserId: owner.id,
    name: 'Refusals',
    identifier: 'RFS',
  });
  const manager = { userId: owner.id, workspaceId: ws.workspace.id, projectId: project.id };
  const page = await pagesService.createPage(manager, { projectId: project.id });
  return { manager, pageId: page.id };
}

function signIn(a: Actor, withProject = true): void {
  session.current = { user: { id: a.userId } };
  active.current = withProject ? a : null;
}

function uploadForm(file: File | string | null): Request {
  const form = new FormData();
  if (file !== null) form.set('file', file);
  return new Request(`${BASE}/p/images`, { method: 'POST', body: form });
}

describe('a session with no active project', () => {
  it('is refused as 400 NO_ACTIVE_PROJECT by every page door', async () => {
    const f = await makeFixture();
    signIn(f.manager, false);
    const id = f.pageId;
    const responses = [
      await CREATE(new Request(BASE, { method: 'POST' })),
      await READ(new Request(`${BASE}/${id}`), params(id)),
      await RENAME(
        new Request(`${BASE}/${id}`, { method: 'PATCH', body: JSON.stringify({ title: 'x' }) }),
        params(id),
      ),
      await SAVE(
        new Request(`${BASE}/${id}/updates`, { method: 'POST', body: new Uint8Array([1]) }),
        params(id),
      ),
      await UPLOAD(uploadForm(new File(['x'], 'a.png', { type: 'image/png' })), params(id)),
    ];
    for (const res of responses) {
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: 'NO_ACTIVE_PROJECT', error: 'No active project.' });
    }
  });

  it('an unauthenticated upload is refused by the session gate', async () => {
    const res = await UPLOAD(uploadForm(null), params('any'));
    expect(res.status).toBe(401);
  });
});

describe('a body the door cannot read', () => {
  it('create and rename refuse a body that is not JSON as 400', async () => {
    const f = await makeFixture();
    signIn(f.manager);
    const created = await CREATE(new Request(BASE, { method: 'POST', body: '{not json' }));
    expect(created.status).toBe(400);
    expect(await created.json()).toEqual({ code: 'BAD_REQUEST', error: 'Expected JSON.' });

    const renamed = await RENAME(
      new Request(`${BASE}/${f.pageId}`, { method: 'PATCH', body: '{not json' }),
      params(f.pageId),
    );
    expect(renamed.status).toBe(400);
    expect(await renamed.json()).toEqual({ code: 'BAD_REQUEST', error: 'Expected JSON.' });
    expect(await adminDb.page.count()).toBe(1);
  });

  it('create treats a whitespace-only body as no body: an untitled page', async () => {
    const f = await makeFixture();
    signIn(f.manager);
    const res = await CREATE(new Request(BASE, { method: 'POST', body: '   ' }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect((await adminDb.page.findUniqueOrThrow({ where: { id } })).title).toBe('');
  });

  it('the image door refuses a body that is not multipart, and a form with no file', async () => {
    const f = await makeFixture();
    signIn(f.manager);
    const notMultipart = await UPLOAD(
      new Request(`${BASE}/${f.pageId}/images`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      params(f.pageId),
    );
    expect(notMultipart.status).toBe(400);
    expect(await notMultipart.json()).toEqual({
      code: 'BAD_REQUEST',
      error: 'Expected multipart form data.',
    });

    for (const form of [uploadForm(null), uploadForm('just a string')]) {
      const res = await UPLOAD(form, params(f.pageId));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: 'BAD_REQUEST', error: 'Expected a `file` field.' });
    }
    expect(await adminDb.attachment.count()).toBe(0);
  });
});

describe('the save door’s stream', () => {
  it('a request with no body reaches the service as a zero-byte update', async () => {
    const f = await makeFixture();
    signIn(f.manager);
    const spy = vi.spyOn(pagesService, 'savePageUpdate').mockResolvedValueOnce({ revision: 9 });
    const res = await SAVE(
      new Request(`${BASE}/${f.pageId}/updates`, { method: 'POST' }),
      params(f.pageId),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revision: 9 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1].update.byteLength).toBe(0);
  });

  it('an over-cap stream whose cancel itself fails is still refused as 413', async () => {
    const f = await makeFixture();
    signIn(f.manager);
    const spy = vi.spyOn(pagesService, 'savePageUpdate');
    const chunk = new Uint8Array(PAGE_SAVE_MAX_BYTES / 2 + 1);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        throw new Error('the upstream refused to cancel');
      },
    });
    const req = new Request(`${BASE}/${f.pageId}/updates`, {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit);
    const res = await SAVE(req, params(f.pageId));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      code: 'PAGE_BODY_TOO_LARGE',
      limit: PAGE_SAVE_MAX_BYTES,
      size: chunk.byteLength * 2,
    });
    expect(sent).toBeLessThanOrEqual(3);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the image door maps the upload primitive’s refusals', () => {
  it('a storage-cap refusal answers 402 with the upgrade payload', async () => {
    const f = await makeFixture();
    signIn(f.manager);
    const err = new EntitlementExceededError('storage', { limit: 10, usage: 9 });
    vi.spyOn(attachmentsService, 'uploadPageImage').mockRejectedValueOnce(err);
    const res = await UPLOAD(
      uploadForm(new File(['x'], 'a.png', { type: 'image/png' })),
      params(f.pageId),
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({
      code: 'ENTITLEMENT_EXCEEDED',
      error: err.message,
      entitlement: 'storage',
      detail: { limit: 10, usage: 9 },
    });
  });

  it('the shared gate’s `attachment:create` refusal answers 403 naming the key', async () => {
    const f = await makeFixture();
    signIn(f.manager);
    vi.spyOn(attachmentsService, 'uploadPageImage').mockRejectedValueOnce(
      new PermissionDeniedError(f.manager.projectId, 'attachment:create'),
    );
    const res = await UPLOAD(
      uploadForm(new File(['x'], 'a.png', { type: 'image/png' })),
      params(f.pageId),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: 'PERMISSION_DENIED',
      permission: 'attachment:create',
    });
  });

  it('an error nothing maps is rethrown, never answered as a page refusal', async () => {
    const f = await makeFixture();
    signIn(f.manager);
    vi.spyOn(attachmentsService, 'uploadPageImage').mockRejectedValueOnce(new Error('boom'));
    await expect(
      UPLOAD(uploadForm(new File(['x'], 'a.png', { type: 'image/png' })), params(f.pageId)),
    ).rejects.toThrow('boom');
  });
});
