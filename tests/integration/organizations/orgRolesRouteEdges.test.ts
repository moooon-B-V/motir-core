import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminDb } from '../../helpers/adminDb';

// The HTTP edges of the story's new org routes (Story MOTIR-6167 · MOTIR-6315):
// the arms a route OWNS and the capability matrix never reaches — the session
// gate, body parsing and query parsing. Every authorization answer is the
// matrix's (`orgRolesMatrix.test.ts`); nothing here restates it.

const session = { current: null as { user: { id: string; email: string } } | null };
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));

const transferRoute = await import('@/app/api/organizations/[orgId]/ownership-transfer/route');
const workspacesRoute = await import('@/app/api/organizations/[orgId]/workspaces/route');
const workspaceRoute =
  await import('@/app/api/organizations/[orgId]/workspaces/[workspaceId]/route');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { createTestUser } = await import('../../fixtures/userFixtures');
const { truncateAuthTables } = await import('../../helpers/db');

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
});

afterAll(async () => {
  await adminDb.$disconnect();
});

async function ownerWithOrg() {
  const owner = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Home',
    ownerUserId: owner.id,
  });
  session.current = { user: { id: owner.id, email: owner.email } };
  return { owner, organizationId: workspace.organizationId, workspace };
}

function transfer(orgId: string, body: string) {
  return transferRoute.POST(
    new Request(`http://localhost/api/organizations/${orgId}/ownership-transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }),
    { params: Promise.resolve({ orgId }) },
  );
}

describe('POST …/ownership-transfer — what the route owns', () => {
  it('401s without a session', async () => {
    const res = await transfer('org_x', JSON.stringify({ toUserId: 'u', confirmName: 'n' }));
    expect(res.status).toBe(401);
  });

  it('400s a body that is not JSON', async () => {
    const { organizationId } = await ownerWithOrg();
    const res = await transfer(organizationId, '{not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('400s a missing or empty `toUserId`', async () => {
    const { organizationId } = await ownerWithOrg();
    for (const body of [{ confirmName: 'x' }, { toUserId: '', confirmName: 'x' }]) {
      const res = await transfer(organizationId, JSON.stringify(body));
      expect(res.status).toBe(400);
    }
  });

  it('400s a `confirmName` that is not a string', async () => {
    const { organizationId, owner } = await ownerWithOrg();
    const res = await transfer(organizationId, JSON.stringify({ toUserId: owner.id }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: '`confirmName` is required.' });
  });

  it('400s a typed name that does not match, and changes nothing', async () => {
    const { organizationId, owner } = await ownerWithOrg();
    const target = await createTestUser();
    await adminDb.organizationMembership.create({
      data: { organizationId, userId: target.id, role: 'member' },
    });
    const res = await transfer(
      organizationId,
      JSON.stringify({ toUserId: target.id, confirmName: 'not the name' }),
    );
    expect(res.status).toBe(400);
    const owners = await adminDb.organizationMembership.findMany({
      where: { organizationId, role: 'owner' },
    });
    expect(owners.map((m) => m.userId)).toEqual([owner.id]);
  });
});

describe('GET …/workspaces — the paging query the route parses', () => {
  function list(orgId: string, query: string) {
    return workspacesRoute.GET(
      new Request(`http://localhost/api/organizations/${orgId}/workspaces${query}`),
      { params: Promise.resolve({ orgId }) },
    );
  }

  it('401s without a session', async () => {
    expect((await list('org_x', '')).status).toBe(401);
  });

  it('clamps an out-of-range `limit` and ignores a non-numeric one', async () => {
    const { organizationId } = await ownerWithOrg();
    for (const query of ['?limit=0', '?limit=5000', '?limit=abc', '?limit=1']) {
      const res = await list(organizationId, query);
      expect(res.status, query).toBe(200);
      const page = (await res.json()) as { workspaces: unknown[] };
      expect(page.workspaces.length, query).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('DELETE …/workspaces/[workspaceId] — what the route owns', () => {
  function del(orgId: string, workspaceId: string) {
    return workspaceRoute.DELETE(
      new Request(`http://localhost/api/organizations/${orgId}/workspaces/${workspaceId}`, {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ orgId, workspaceId }) },
    );
  }

  it('401s without a session', async () => {
    expect((await del('org_x', 'ws_x')).status).toBe(401);
  });

  it('404s a workspace id that names nothing', async () => {
    const { organizationId } = await ownerWithOrg();
    expect((await del(organizationId, 'ws_does_not_exist')).status).toBe(404);
  });
});
