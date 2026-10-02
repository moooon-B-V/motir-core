import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRole } from '@/generated/prisma/client';

// Page IMAGES (Story MOTIR-5752 · MOTIR-7279) on real Postgres: the upload
// route files an image under its page, the content read authorises it by
// `page:view`, and the owner CHECK holds. The blob store is mocked (no live
// store in the test env); so are the three request-bound reads — the session,
// the active project and the workspace context — which need cookies. Every gate,
// the upload primitive and the row writes run for real.

vi.mock('@/lib/blob/uploader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blob/uploader')>()),
  putPrivateAttachment: vi.fn(async (pathname: string) => ({ pathname })),
  signedDownloadUrl: vi.fn(async (pathname: string) => `https://blob.example/signed/${pathname}`),
}));

interface Actor {
  userId: string;
  workspaceId: string;
  projectId: string;
}

const actor = vi.hoisted(() => ({ current: null as Actor | null }));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => (actor.current ? { user: { id: actor.current.userId } } : null)),
}));
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: vi.fn(async () => actor.current),
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: vi.fn(async () =>
    actor.current ? { userId: actor.current.userId, workspaceId: actor.current.workspaceId } : null,
  ),
}));

const { POST: UPLOAD } = await import('@/app/api/pages/[pageId]/images/route');
const { GET: CONTENT } = await import('@/app/api/attachments/[id]/content/route');
const { attachmentsService } = await import('@/lib/services/attachmentsService');
const { pagesService } = await import('@/lib/services/pagesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { PageNotFoundError } = await import('@/lib/pages');
const { db } = await import('@/lib/db');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const { makeWorkItemFixture, createTestWorkItem } = await import('../fixtures');

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "attachment", "page" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  actor.current = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  workspaceId: string;
  projectId: string;
  otherProjectId: string;
  manager: Actor;
  pageId: string;
}

async function makeUser(tag: string) {
  return usersService.createUser({
    email: `page-image-${tag}@example.com`,
    password: 'hunter2hunter2',
    name: `Page image ${tag}`,
  });
}

async function makeFixture(): Promise<Fixture> {
  const owner = await makeUser('owner');
  const ws = await workspacesService.createWorkspace({ name: 'Images', ownerUserId: owner.id });
  const workspaceId = ws.workspace.id;
  const project = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'Images',
    identifier: 'IMG',
  });
  const other = await projectsService.createProject({
    workspaceId,
    actorUserId: owner.id,
    name: 'Other',
    identifier: 'OIM',
  });
  const manager = { userId: owner.id, workspaceId, projectId: project.id };
  const page = await pagesService.createPage(manager, { projectId: project.id });
  return { workspaceId, projectId: project.id, otherProjectId: other.id, manager, pageId: page.id };
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

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function upload(pageId: string, opts: { type?: string; name?: string } = {}): Promise<Response> {
  const form = new FormData();
  form.set(
    'file',
    new File([PNG as BlobPart], opts.name ?? 'diagram.png', { type: opts.type ?? 'image/png' }),
  );
  return UPLOAD(
    new Request(`http://localhost:3000/api/pages/${pageId}/images`, {
      method: 'POST',
      body: form,
    }),
    { params: Promise.resolve({ pageId }) },
  );
}

function content(id: string): Promise<Response> {
  return CONTENT(new Request(`http://localhost:3000/api/attachments/${id}/content`), {
    params: Promise.resolve({ id }),
  });
}

const idFrom = (url: string) => /\/api\/attachments\/([^/]+)\/content$/.exec(url)![1]!;

describe('uploading an image into a page', () => {
  it('a member’s PNG is filed under the page, owned by no work item', async () => {
    const f = await makeFixture();
    actor.current = await actorAs(f, 'member', 'member');

    const res = await upload(f.pageId);
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toMatch(/^\/api\/attachments\/[^/]+\/content$/);

    const row = await adminDb.attachment.findUniqueOrThrow({ where: { id: idFrom(url) } });
    expect(row).toMatchObject({ pageId: f.pageId, workItemId: null, mimeType: 'image/png' });
  });

  it('a viewer is refused 403 and nothing is written', async () => {
    const f = await makeFixture();
    actor.current = await actorAs(f, 'viewer', 'viewer');
    expect((await upload(f.pageId)).status).toBe(403);
    expect(await adminDb.attachment.count()).toBe(0);
  });

  it('a non-member, and a page from another project, are refused 404', async () => {
    const f = await makeFixture();
    const elsewhere = await pagesService.createPage(f.manager, { projectId: f.otherProjectId });

    actor.current = await actorAs(f, 'stranger', null);
    expect((await upload(f.pageId)).status).toBe(404);

    actor.current = f.manager;
    const res = await upload(elsewhere.id);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'PAGE_NOT_FOUND' });
    expect(await adminDb.attachment.count()).toBe(0);
  });

  it('a text/plain file is refused with the allowlist’s typed error', async () => {
    const f = await makeFixture();
    actor.current = f.manager;
    const res = await upload(f.pageId, { type: 'text/plain', name: 'notes.txt' });
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
    expect(await adminDb.attachment.count()).toBe(0);
  });

  it('the service refuses an unknown page before any byte is stored', async () => {
    const f = await makeFixture();
    const file = new File([PNG as BlobPart], 'x.png', { type: 'image/png' });
    await expect(
      attachmentsService.uploadPageImage(file, {
        ctx: f.manager,
        projectId: f.projectId,
        pageId: 'no-such-page',
      }),
    ).rejects.toBeInstanceOf(PageNotFoundError);
    expect(await adminDb.attachment.count()).toBe(0);
  });
});

describe('reading a page image', () => {
  it('redirects for a member and a viewer of the project, and is 404 for a non-member', async () => {
    const f = await makeFixture();
    actor.current = f.manager;
    const { url } = (await (await upload(f.pageId)).json()) as { url: string };
    const id = idFrom(url);

    actor.current = await actorAs(f, 'reader', 'member');
    const asMember = await content(id);
    expect(asMember.status).toBe(302);
    expect(asMember.headers.get('location')).toMatch(/^https:\/\/blob\.example\/signed\//);

    actor.current = await actorAs(f, 'viewer', 'viewer');
    expect((await content(id)).status).toBe(302);

    actor.current = await actorAs(f, 'outsider', null);
    expect((await content(id)).status).toBe(404);
  });

  it('a work-item attachment still reads through its item, as before', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Holder' });
    const row = await adminDb.attachment.create({
      data: {
        workspaceId: fx.workspaceId,
        uploaderUserId: fx.ownerId,
        workItemId: item.id,
        blobPathname: `attachments/${fx.workspaceId}/f.png`,
        mimeType: 'image/png',
        sizeBytes: 8,
        originalFilename: 'f.png',
      },
    });
    actor.current = { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId };
    expect((await content(row.id)).status).toBe(302);
  });
});

describe('an attachment has at most one owner', () => {
  it('an insert naming both a work item and a page fails attachment_owner_at_most_one', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Holder' });
    const page = await pagesService.createPage(fx.ctx, { projectId: fx.projectId });
    await expect(
      adminDb.attachment.create({
        data: {
          workspaceId: fx.workspaceId,
          uploaderUserId: fx.ownerId,
          workItemId: item.id,
          pageId: page.id,
          blobPathname: `attachments/${fx.workspaceId}/both.png`,
          mimeType: 'image/png',
          sizeBytes: 8,
          originalFilename: 'both.png',
        },
      }),
    ).rejects.toThrow(/attachment_owner_at_most_one/);
  });
});
