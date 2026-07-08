import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-1665 · Subtask MOTIR-1669 — the ASSEMBLED access-controlled read
// seam that the unit tests mock apart. content-route.test.ts owns the pure
// route auth matrix (direct rows); this drives the REAL writer→consumer chain:
// attachmentsService.attachToWorkItem (private put, mocked) → the DTO's content
// path → GET /api/attachments/[id]/content → signed-URL redirect / hide-gate,
// plus the public/private CONTRAST (an avatar is a PUBLIC blob URL, content is
// the private content path). Only the two env-unprovidable seams are stubbed —
// the session (`getWorkspaceContext`) and the Blob store (the uploader).

const ctxRef = { current: null as WorkspaceContext | null };

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

vi.mock('@/lib/blob/uploader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/blob/uploader')>();
  return {
    ...actual,
    // Private content: the put returns only a pathname (no public URL exists).
    putPrivateAttachment: vi.fn(async (pathname: string) => ({ pathname })),
    // Avatars: the PUBLIC store returns a directly-fetchable public URL.
    putPublicAsset: vi.fn(async (pathname: string) => ({
      url: `https://pub123.public.blob.vercel-storage.com/${pathname}`,
    })),
    signedDownloadUrl: vi.fn(async (pathname: string) => `https://blob.example/signed/${pathname}`),
  };
});

// Import consumers AFTER the mocks register.
const { attachmentsService } = await import('@/lib/services/attachmentsService');
const { usersService } = await import('@/lib/services/usersService');
const { GET } = await import('@/app/api/attachments/[id]/content/route');

const BASE = 'http://localhost:3000';
const png = (name = 'shot.png') => new File([new Uint8Array(8)], name, { type: 'image/png' });

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE TABLE "attachment" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  ctxRef.current = null;
});

afterAll(async () => {
  await db.$disconnect();
});

function signInAs(fx: WorkItemFixture) {
  ctxRef.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
}

const getContent = (id: string) =>
  GET(new Request(`${BASE}/api/attachments/${id}/content`), { params: Promise.resolve({ id }) });

describe('access-controlled attachments — the assembled write→DTO→route seam', () => {
  it('a real content upload exposes a content PATH (never a blob URL) that round-trips through the auth route', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Has an image' });

    const dto = await attachmentsService.attachToWorkItem(item.id, png(), {
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
    });

    // The DTO carries the app content path, NOT a world-readable blob URL.
    expect(dto.blobUrl).toBe(`/api/attachments/${dto.id}/content`);
    expect(dto.blobUrl).not.toMatch(/blob\.vercel-storage\.com/);

    // The authorized owner is redirected to the signed URL...
    signInAs(fx);
    const ok = await getContent(dto.id);
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toMatch(/^https:\/\/blob\.example\/signed\//);

    // ...anonymous is refused...
    ctxRef.current = null;
    expect((await getContent(dto.id)).status).toBe(401);
  });

  it('a member of ANOTHER workspace cannot read the content (404, no existence leak)', async () => {
    const owner = await makeWorkItemFixture();
    const item = await createTestWorkItem(owner, { kind: 'task', title: 'Private shot' });
    const dto = await attachmentsService.attachToWorkItem(item.id, png(), {
      userId: owner.ownerId,
      workspaceId: owner.workspaceId,
    });

    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RVL' });
    signInAs(rival);
    expect((await getContent(dto.id)).status).toBe(404);
  });

  it('avatars stay PUBLIC — uploadAvatar yields a public blob URL, not the content path', async () => {
    const fx = await makeWorkItemFixture();

    const { url } = await usersService.uploadAvatar(png('me.png'), fx.ownerId);

    // The public/private contrast: an avatar is a directly-fetchable public URL,
    // never routed through the authenticated content path.
    expect(url).toMatch(/\.public\.blob\.vercel-storage\.com\//);
    expect(url).not.toMatch(/\/api\/attachments\//);
  });
});
