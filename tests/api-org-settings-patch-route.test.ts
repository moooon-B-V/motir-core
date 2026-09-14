import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// Transport tests for PATCH /api/organizations/[orgId] — the org RENAME route
// (Story 6.10.5), after MOTIR-5172 retired its acceptance-video arm.
//
// ⚠️ THE ROUTE USED TO ACCEPT `name` OR `acceptanceVideoEnabled` AND REQUIRE ONE.
// The toggle is a PROJECT setting now (`PATCH /api/projects/[key]/approval-gates`),
// so removing its arm is not a deletion in place: it changes what the route
// ACCEPTS (a body carrying only the old key is refused, not silently a no-op)
// and what it SAYS when it refuses. Those two changes are what this file pins.
//
// No transport test existed for this handler before — the card that retired the
// arm asked for its route tests to be updated, and there were none to update, so
// they are written here.
//
// The compliance gate is the one stub (a route test has no cookie jar); the
// service, the org-admin gate, RLS and Postgres are the shipped path.

const { requireCompliantSession } = vi.hoisted(() => ({ requireCompliantSession: vi.fn() }));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantSession }));

const { PATCH } = await import('@/app/api/organizations/[orgId]/route');
const { createTestWorkspace, createTestUser } = await import('./fixtures');

function signInAs(user: { id: string; email: string }) {
  requireCompliantSession.mockResolvedValue({
    ok: true,
    session: { user: { id: user.id, email: user.email } },
  });
}

function patch(orgId: string, body: unknown) {
  return PATCH(
    new Request(`http://localhost:3000/api/organizations/${orgId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ orgId }) },
  );
}

/** The org row's name and its retired column, read by SQL rather than through the
 *  generated client — the column has no application reader any more, and a test
 *  must not become one (MOTIR-5173 takes the field out of the client). */
async function orgRow(orgId: string) {
  const rows = await adminDb.$queryRaw<{ name: string; acceptance_video_enabled: boolean }[]>`
    SELECT name, acceptance_video_enabled FROM organization WHERE id = ${orgId}`;
  return rows[0]!;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('PATCH /api/organizations/[orgId]', () => {
  it('renames the organization and serializes the DTO — with no acceptance-video field on it', async () => {
    const { workspace, owner } = await createTestWorkspace();
    signInAs(owner);

    const res = await patch(workspace.organizationId, { name: '  Beacon Labs  ' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { organization: Record<string, unknown> };
    expect(body.organization).toMatchObject({ id: workspace.organizationId, name: 'Beacon Labs' });
    expect(body.organization).not.toHaveProperty('acceptanceVideoEnabled');
    expect((await orgRow(workspace.organizationId)).name).toBe('Beacon Labs');
  });

  it('refuses a body carrying ONLY the retired toggle — 400, and the column does not move', async () => {
    const { workspace, owner } = await createTestWorkspace();
    signInAs(owner);
    const before = await orgRow(workspace.organizationId);

    const res = await patch(workspace.organizationId, {
      acceptanceVideoEnabled: !before.acceptance_video_enabled,
    });

    expect(res.status).toBe(400);
    // The message names the ONE field the route takes. It used to read
    // "`name` or `acceptanceVideoEnabled` is required." — offering a key that
    // would now write a flag nothing reads.
    expect(await res.json()).toEqual({ code: 'BAD_REQUEST', error: '`name` is required.' });
    expect(await orgRow(workspace.organizationId)).toEqual(before);
  });

  it('ignores the retired toggle beside a valid name — the rename lands, the column does not move', async () => {
    const { workspace, owner } = await createTestWorkspace();
    signInAs(owner);
    const before = await orgRow(workspace.organizationId);

    const res = await patch(workspace.organizationId, {
      name: 'Renamed',
      acceptanceVideoEnabled: !before.acceptance_video_enabled,
    });

    expect(res.status).toBe(200);
    const after = await orgRow(workspace.organizationId);
    expect(after.name).toBe('Renamed');
    expect(after.acceptance_video_enabled).toBe(before.acceptance_video_enabled);
  });

  it('400 on an empty body and on a blank name', async () => {
    const { workspace, owner } = await createTestWorkspace();
    signInAs(owner);

    for (const body of [{}, { name: '   ' }, { name: 42 }]) {
      const res = await patch(workspace.organizationId, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: 'BAD_REQUEST', error: '`name` is required.' });
    }
  });

  it('404 for a signed-in user who is not a member of the organization', async () => {
    const { workspace } = await createTestWorkspace();
    const stranger = await createTestUser();
    signInAs(stranger);

    const res = await patch(workspace.organizationId, { name: 'Hijacked' });

    expect(res.status).toBe(404);
    expect((await orgRow(workspace.organizationId)).name).not.toBe('Hijacked');
  });

  it('401 passes straight through from the session gate', async () => {
    requireCompliantSession.mockResolvedValue({
      ok: false,
      response: Response.json({ code: 'UNAUTHENTICATED' }, { status: 401 }),
    });

    const res = await patch('any-org', { name: 'x' });

    expect(res.status).toBe(401);
  });
});
