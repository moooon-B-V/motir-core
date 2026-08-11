import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';

import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { truncateAuthTables } from '../helpers/db';
import {
  PROJECT_IMAGE_ACCEPT,
  PROJECT_IMAGE_MAX_BYTES,
  PROJECT_IMAGE_TYPES,
} from '@/lib/projects/imageUpload';

// POST /api/upload/project-image (MOTIR-2677) — the byte path, driven end-to-end:
// real route → projectsService.uploadImage → putPublicAsset. The object store is
// mocked at the uploader (the network is not the subject); everything above it —
// the session gate, the MANAGE gate, the size/MIME policy, the returned key's
// prefix — is real.
//
// The test that matters most is the last one: the key this route returns is
// handed straight to `updateDetails`. Those are two different cards, and each can
// pass its own suite while producing something the other rejects.

const ctxRef = { current: null as WorkspaceContext | null };

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const stored: { pathname: string; contentType: string }[] = [];
vi.mock('@/lib/blob/uploader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/blob/uploader')>();
  return {
    ...actual,
    putPublicAsset: vi.fn(async (pathname: string, _body: unknown, contentType: string) => {
      stored.push({ pathname, contentType });
      // The real adapter random-suffixes before the extension; mirror that so the
      // returned key is shaped like a real one.
      const dot = pathname.lastIndexOf('.');
      const key =
        dot > pathname.lastIndexOf('/')
          ? `${pathname.slice(0, dot)}-abc123${pathname.slice(dot)}`
          : `${pathname}-abc123`;
      return { key };
    }),
    deletePublicAsset: vi.fn(async () => undefined),
  };
});

const { POST } = await import('@/app/api/upload/project-image/route');
const { projectsService } = await import('@/lib/services/projectsService');

beforeEach(async () => {
  await truncateAuthTables();
  ctxRef.current = null;
  stored.length = 0;
});

afterAll(async () => {
  await db.$disconnect();
});

function signInAs(fx: WorkItemFixture, userId = fx.ownerId) {
  ctxRef.current = { userId, workspaceId: fx.workspaceId };
}

function upload(projectKey: string, file: File | null, extra?: Record<string, string>) {
  const form = new FormData();
  if (file) form.append('file', file);
  if (projectKey) form.append('projectKey', projectKey);
  for (const [k, v] of Object.entries(extra ?? {})) form.append(k, v);
  return POST(
    new Request('http://localhost:3000/api/upload/project-image', { method: 'POST', body: form }),
  );
}

function pngOf(bytes: number, name = 'logo.png') {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' });
}

describe('POST /api/upload/project-image', () => {
  it('stores under the project’s own prefix and returns the KEY, not a URL', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);

    const res = await upload(fx.projectIdentifier, pngOf(64));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string };
    expect(body.key.startsWith(`projects/${fx.projectId}/`)).toBe(true);
    expect(body.key).not.toMatch(/^https?:/);
    // The real content type rides to the store, so the object renders as an
    // image instead of downloading.
    expect(stored[0]?.contentType).toBe('image/png');
  });

  it('401s with no session, and stores nothing', async () => {
    const fx = await makeWorkItemFixture();
    ctxRef.current = null;

    const res = await upload(fx.projectIdentifier, pngOf(64));

    expect(res.status).toBe(401);
    expect(stored).toHaveLength(0);
  });

  // The gate that does not exist on the avatar route, and the reason this card
  // is not a copy of it: a workspace member who cannot manage the project must
  // not be able to write into its prefix.
  it('refuses a workspace member who cannot manage the project — BEFORE storing a byte', async () => {
    const fx = await makeWorkItemFixture();
    const member = await createTestUser({ email: 'member-upload@example.com' });
    await db.workspaceMembership.create({
      data: { userId: member.id, workspaceId: fx.workspaceId, role: 'member' },
    });
    signInAs(fx, member.id);

    const res = await upload(fx.projectIdentifier, pngOf(64));

    expect([403, 404]).toContain(res.status);
    expect(stored).toHaveLength(0);
  });

  it('rejects a type the copy never offered (SVG is image/* but not accepted)', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);

    const res = await upload(
      fx.projectIdentifier,
      new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }),
    );

    expect(res.status).toBe(415);
    expect(stored).toHaveLength(0);
  });

  // The gap this card deliberately does NOT copy from the avatar route: there,
  // the 2 MB promise lives only in the client. Here the server keeps it.
  it('enforces the STATED ceiling server-side, not just in the client', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);

    const res = await upload(fx.projectIdentifier, pngOf(PROJECT_IMAGE_MAX_BYTES + 1));

    expect(res.status).toBe(413);
    expect(stored).toHaveLength(0);
  });

  it('400s on a missing file or a missing projectKey', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);

    expect((await upload(fx.projectIdentifier, null)).status).toBe(400);
    expect((await upload('', pngOf(64))).status).toBe(400);
    expect(stored).toHaveLength(0);
  });

  // THE SEAM. Two cards own the two halves; a key one produces that the other
  // rejects is two green suites and a broken feature.
  it('returns a key that updateDetails ACCEPTS', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const { key } = (await (await upload(fx.projectIdentifier, pngOf(64))).json()) as {
      key: string;
    };

    const dto = await projectsService.updateDetails({
      key: fx.projectIdentifier,
      ctx: ctxRef.current!,
      image: key,
    });

    expect(dto.image).toContain(key);
    const row = await db.project.findUnique({
      where: { id: fx.projectId },
      select: { image: true },
    });
    expect(row?.image).toBe(key);
  });
});

describe('the project-logo policy constants', () => {
  // The design's copy table states "PNG or JPG, up to 2 MB" verbatim. If either
  // value moves, the copy and the enforcement have drifted and one of them is
  // lying to the person reading it.
  it('match the figures the design copy states', () => {
    expect(PROJECT_IMAGE_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect([...PROJECT_IMAGE_TYPES]).toEqual(['image/png', 'image/jpeg']);
    expect(PROJECT_IMAGE_ACCEPT).toBe('image/png,image/jpeg');
  });
});
