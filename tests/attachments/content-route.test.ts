import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// GET /api/attachments/[id]/content (Story MOTIR-1665 · Subtask MOTIR-1667/1668)
// — the authenticated content read for a PRIVATE attachment. Real Postgres: the
// route → attachmentsService.getContentRedirect → resolveGatedWorkItem →
// repository chain runs for real; only the two env-unprovidable seams are
// stubbed — `getWorkspaceContext` (session/active-workspace, no cookies in the
// test env) and `signedDownloadUrl` (no live Blob store). This asserts the
// TRANSPORT + AUTH contract the route owns: 401 unauthenticated, 302 → the
// signed URL for a viewer who can see the owning item, and the finding-#44
// hide-gate (missing / cross-workspace / orphan all read 404, never 403).

const ctxRef = { current: null as WorkspaceContext | null };

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

vi.mock('@/lib/blob/uploader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/blob/uploader')>();
  return {
    ...actual,
    signedDownloadUrl: vi.fn(async (pathname: string) => `https://blob.example/signed/${pathname}`),
  };
});

// Import the handler AFTER the mocks are registered.
const { GET } = await import('@/app/api/attachments/[id]/content/route');

const BASE = 'http://localhost:3000';

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

async function makeAttachment(
  fx: WorkItemFixture,
  overrides: { workItemId?: string | null; blobPathname?: string } = {},
) {
  return db.attachment.create({
    data: {
      workspaceId: fx.workspaceId,
      uploaderUserId: fx.ownerId,
      workItemId: overrides.workItemId ?? null,
      source: 'editor',
      blobPathname: overrides.blobPathname ?? 'attachments/ws/shot.png',
      mimeType: 'image/png',
      sizeBytes: 4,
      originalFilename: 'shot.png',
    },
  });
}

const call = (id: string) =>
  GET(new Request(`${BASE}/api/attachments/${id}/content`), {
    params: Promise.resolve({ id }),
  });

describe('GET /api/attachments/[id]/content', () => {
  it('no session → 401', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Has image' });
    const att = await makeAttachment(fx, { workItemId: item.id });

    const res = await call(att.id);
    expect(res.status).toBe(401);
  });

  it('a viewer who can see the owning item → 302 to the signed URL', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Has image' });
    const att = await makeAttachment(fx, {
      workItemId: item.id,
      blobPathname: 'attachments/w/a.png',
    });
    signInAs(fx);

    const res = await call(att.id);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://blob.example/signed/attachments/w/a.png');
  });

  it('a missing id → 404 (no existence leak)', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const res = await call('cmmissing0000000000000000');
    expect(res.status).toBe(404);
  });

  it("another workspace's attachment → 404", async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Rival', identifier: 'RVL' });
    const otherItem = await createTestWorkItem(other, { kind: 'task', title: 'Theirs' });
    const foreign = await makeAttachment(other, { workItemId: otherItem.id });
    signInAs(fx); // signed into fx, not other

    const res = await call(foreign.id);
    expect(res.status).toBe(404);
  });

  it('an orphan (unlinked) attachment → 404 (on no item to gate against)', async () => {
    const fx = await makeWorkItemFixture();
    const orphan = await makeAttachment(fx, { workItemId: null });
    signInAs(fx);

    const res = await call(orphan.id);
    expect(res.status).toBe(404);
  });
});
