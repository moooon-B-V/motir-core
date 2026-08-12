import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces';

import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// PATCH /api/projects/[key] — the `image` half of the details route (MOTIR-2676),
// driven end-to-end: real route → projectsService → projectRepository → Prisma.
// The service's own semantics (the own-project gate's edge cases, the
// after-commit blob collection) are covered in `project-details-service.test.ts`;
// these tests assert the TRANSPORT contract this route owns:
//   * the field round-trips at all — set, replace, clear;
//   * an ABSENT `image` is untouched while a PRESENT `null` clears it (the
//     distinction `readNullableString` exists to preserve, and the one a naive
//     `body.image ?? undefined` would silently collapse);
//   * a wrong TYPE is a 400 from the route, before the service is reached;
//   * a foreign ref is the service's typed 400, not a 500.
//
// Only `getWorkspaceContext` is stubbed — the session + active-workspace resolver
// the test env cannot supply (no cookies). The mock is PARTIAL (importOriginal),
// so the real `withWorkspaceContext` (the RLS-binding transaction) is preserved.

const ctxRef = { current: null as WorkspaceContext | null };

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

// The blob GC is a network side effect; the ROUTE contract does not depend on it
// having run, and the ordering it must obey is asserted at the service tier.
vi.mock('@/lib/blob/uploader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/blob/uploader')>();
  return { ...actual, deletePublicAsset: vi.fn(async () => undefined) };
});

const { PATCH } = await import('@/app/api/projects/[key]/route');

const BASE = 'http://localhost:3000/api/projects';

beforeEach(async () => {
  await truncateAuthTables();
  ctxRef.current = null;
});

afterAll(async () => {
  await db.$disconnect();
});

function signInAs(fx: WorkItemFixture, userId = fx.ownerId) {
  ctxRef.current = { userId, workspaceId: fx.workspaceId };
}

function routeParams(key: string) {
  return { params: Promise.resolve({ key }) };
}

function patch(key: string, body: unknown) {
  return PATCH(
    new Request(`${BASE}/${key}`, { method: 'PATCH', body: JSON.stringify(body) }),
    routeParams(key),
  );
}

/** The RAW stored value — an object key — as opposed to the DTO's resolved URL. */
async function storedImageOf(projectId: string): Promise<string | null> {
  const row = await db.project.findUnique({ where: { id: projectId }, select: { image: true } });
  return row?.image ?? null;
}

describe('PATCH /api/projects/[key] — the project image', () => {
  it('round-trips set → replace → clear, storing a KEY and returning a URL', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const first = `projects/${fx.projectId}/logo.png`;
    const second = `projects/${fx.projectId}/logo-v2.png`;

    const set = await patch(fx.projectIdentifier, { image: first });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { project: { image: string } }).project.image).toContain(first);
    expect(await storedImageOf(fx.projectId)).toBe(first);

    const replaced = await patch(fx.projectIdentifier, { image: second });
    expect(replaced.status).toBe(200);
    expect(await storedImageOf(fx.projectId)).toBe(second);

    const cleared = await patch(fx.projectIdentifier, { image: null });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { project: { image: null } }).project.image).toBeNull();
    expect(await storedImageOf(fx.projectId)).toBeNull();
  });

  it('distinguishes an ABSENT image from a PRESENT null', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);
    const stored = `projects/${fx.projectId}/logo.png`;
    await patch(fx.projectIdentifier, { image: stored });

    // A name-only patch must not touch the mark.
    const renamed = await patch(fx.projectIdentifier, { name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(await storedImageOf(fx.projectId)).toBe(stored);

    // …while an explicit null does.
    await patch(fx.projectIdentifier, { image: null });
    expect(await storedImageOf(fx.projectId)).toBeNull();
  });

  it('rejects a non-string, non-null image with a 400 before the service runs', async () => {
    const fx = await makeWorkItemFixture();
    signInAs(fx);

    const res = await patch(fx.projectIdentifier, { image: 42 });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('BAD_REQUEST');
    expect(await storedImageOf(fx.projectId)).toBeNull();
  });

  it('maps a foreign ref to the typed 400, not a 500', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ identifier: 'OTHR' });
    signInAs(fx);

    const res = await patch(fx.projectIdentifier, {
      image: `projects/${other.projectId}/logo.png`,
    });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('INVALID_PROJECT_IMAGE');
    expect(await storedImageOf(fx.projectId)).toBeNull();
  });

  it('401s with no session', async () => {
    const fx = await makeWorkItemFixture();
    ctxRef.current = null;

    const res = await patch(fx.projectIdentifier, { image: null });

    expect(res.status).toBe(401);
  });
});
