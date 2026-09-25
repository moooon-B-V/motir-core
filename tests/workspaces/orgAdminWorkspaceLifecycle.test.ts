import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminDb } from '../helpers/adminDb';

// Creating and removing a workspace is an ORG-ADMIN act (MOTIR-6309;
// `docs/decisions/role-model.md` §1). Real Postgres throughout (the no-mocks
// rule); the boundary mocks are the session (no cookie in the test env) and the
// post-commit seat-sync ENQUEUE that org-membership writes fire.
//
// The fixture is the one the role model is about: an org with an Owner, an
// Admin who is NOT a member of the workspace being removed, and a Member who IS
// one — so "the Admin may, without membership" and "the Member may not, despite
// membership" are both measured on the same workspace.

const session = { current: null as { user: { id: string; email: string } } | null };
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));

const { GET } = await import('@/app/api/organizations/[orgId]/workspaces/route');
const { DELETE } = await import('@/app/api/organizations/[orgId]/workspaces/[workspaceId]/route');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { projectsService } = await import('@/lib/services/projectsService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { truncateAuthTables } = await import('../helpers/db');
const { OrganizationNotFoundError, OrgForbiddenError } = await import('@/lib/organizations/errors');
const { WorkspaceNotSoleMemberError } = await import('@/lib/workspaces/errors');

function signInAs(user: { id: string; email: string }) {
  session.current = { user: { id: user.id, email: user.email } };
}

async function makeOrg() {
  const owner = await createTestUser();
  const { workspace: home } = await workspacesService.createWorkspace({
    name: 'Home',
    ownerUserId: owner.id,
  });
  const organizationId = home.organizationId;
  const admin = await createTestUser();
  await organizationsService.addMember({
    organizationId,
    userId: admin.id,
    role: 'admin',
    actorUserId: owner.id,
  });
  const member = await createTestUser();
  await organizationsService.addMember({
    organizationId,
    userId: member.id,
    role: 'member',
    actorUserId: owner.id,
  });
  // Adding an org member at one workspace also joins them to it (the
  // progressive-disclosure rule), so the Member IS a member of `home` already.
  // The Admin's row is taken away: the point of the fixture is an Admin who is
  // NOT in the workspace they act on.
  await adminDb.workspaceMembership.deleteMany({
    where: { workspaceId: home.id, userId: admin.id },
  });
  const outsider = await createTestUser();
  return { organizationId, home, owner, admin, member, outsider };
}

beforeEach(async () => {
  session.current = null;
  await truncateAuthTables();
});

afterAll(async () => {
  await adminDb.$disconnect();
});

describe('createWorkspace into an existing organization', () => {
  it('succeeds for the Owner and for an Admin', async () => {
    const { organizationId, owner, admin } = await makeOrg();
    const byOwner = await workspacesService.createWorkspace({
      name: 'By owner',
      ownerUserId: owner.id,
      organizationId,
    });
    const byAdmin = await workspacesService.createWorkspace({
      name: 'By admin',
      ownerUserId: admin.id,
      organizationId,
    });
    expect(byOwner.workspace.organizationId).toBe(organizationId);
    expect(byAdmin.workspace.organizationId).toBe(organizationId);
  });

  it('refuses an org Member (403) and creates nothing', async () => {
    const { organizationId, member } = await makeOrg();
    await expect(
      workspacesService.createWorkspace({
        name: 'By member',
        ownerUserId: member.id,
        organizationId,
      }),
    ).rejects.toBeInstanceOf(OrgForbiddenError);
    expect(await adminDb.workspace.count({ where: { organizationId } })).toBe(1);
  });

  it('hides the org from a non-member (404) and does NOT auto-join them', async () => {
    const { organizationId, outsider } = await makeOrg();
    await expect(
      workspacesService.createWorkspace({
        name: 'By outsider',
        ownerUserId: outsider.id,
        organizationId,
      }),
    ).rejects.toBeInstanceOf(OrganizationNotFoundError);
    expect(
      await adminDb.organizationMembership.count({
        where: { organizationId, userId: outsider.id },
      }),
    ).toBe(0);
  });

  it('still lets someone with no organization create their own, as its Owner', async () => {
    const newcomer = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Mine',
      ownerUserId: newcomer.id,
    });
    const membership = await adminDb.organizationMembership.findFirstOrThrow({
      where: { organizationId: workspace.organizationId, userId: newcomer.id },
    });
    expect(membership.role).toBe('owner');
  });
});

describe('DELETE /api/organizations/[orgId]/workspaces/[workspaceId]', () => {
  function del(orgId: string, workspaceId: string) {
    return DELETE(
      new Request(`http://localhost/api/organizations/${orgId}/workspaces/${workspaceId}`, {
        method: 'DELETE',
      }),
      {
        params: Promise.resolve({ orgId, workspaceId }),
      },
    );
  }

  it('removes the workspace for an Admin who holds NO membership in it', async () => {
    const { organizationId, home, admin, owner } = await makeOrg();
    await projectsService.createProject({
      workspaceId: home.id,
      actorUserId: owner.id,
      name: 'Core',
    });
    signInAs(admin);

    const res = await del(organizationId, home.id);

    expect(res.status).toBe(200);
    expect(await adminDb.workspace.count({ where: { id: home.id } })).toBe(0);
    // The survival the shared body carries: the offboarding row, fed with the
    // project ids read before the cascade.
    const rows = await adminDb.codeGraphOffboarding.findMany({
      where: { coreWorkspaceId: home.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('workspace_deleted');
  });

  it('refuses an org Member who IS a member of the workspace (403)', async () => {
    const { organizationId, home, member } = await makeOrg();
    signInAs(member);

    const res = await del(organizationId, home.id);

    expect(res.status).toBe(403);
    expect(await adminDb.workspace.count({ where: { id: home.id } })).toBe(1);
  });

  it('404s a non-member of the org', async () => {
    const { organizationId, home, outsider } = await makeOrg();
    signInAs(outsider);
    expect((await del(organizationId, home.id)).status).toBe(404);
    expect(await adminDb.workspace.count({ where: { id: home.id } })).toBe(1);
  });

  it('404s a workspace addressed through ANOTHER organization’s URL', async () => {
    const { home, admin } = await makeOrg();
    const other = await makeOrg();
    // The Admin of the first org, pointing at its workspace through the second
    // org's path: never removable, and not even confirmed to exist.
    await organizationsService.addMember({
      organizationId: other.organizationId,
      userId: admin.id,
      role: 'admin',
      actorUserId: other.owner.id,
    });
    signInAs(admin);
    const res = await del(other.organizationId, home.id);
    expect(res.status).toBe(404);
    expect(await adminDb.workspace.count({ where: { id: home.id } })).toBe(1);
  });

  it('401s without a session', async () => {
    const { organizationId, home } = await makeOrg();
    expect((await del(organizationId, home.id)).status).toBe(401);
  });
});

describe('GET /api/organizations/[orgId]/workspaces', () => {
  function list(orgId: string, query = '') {
    return GET(new Request(`http://localhost/api/organizations/${orgId}/workspaces${query}`), {
      params: Promise.resolve({ orgId }),
    });
  }

  it('pages the org’s workspaces with member and project counts an Admin outside them can see', async () => {
    const { organizationId, home, owner, admin } = await makeOrg();
    await projectsService.createProject({
      workspaceId: home.id,
      actorUserId: owner.id,
      name: 'Core',
    });
    for (const name of ['Two', 'Three']) {
      await workspacesService.createWorkspace({ name, ownerUserId: owner.id, organizationId });
    }
    signInAs(admin);

    const first = await list(organizationId, '?limit=2');
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as {
      workspaces: { id: string; name: string; memberCount: number; projectCount: number }[];
      nextCursor: string | null;
      total: number;
    };
    expect(page1.total).toBe(3);
    // Sorted by NAME (MOTIR-6312 · the Workspaces card's order).
    expect(page1.workspaces.map((w) => w.name)).toEqual(['Home', 'Three']);
    // Counted under a per-row workspace binding — an Admin who is in NONE of
    // these workspaces must still see the true numbers, not zeros.
    expect(page1.workspaces[0]).toMatchObject({ memberCount: 2, projectCount: 1 }); // Owner + Member
    expect(page1.nextCursor).not.toBeNull();

    const second = (await (
      await list(organizationId, `?limit=2&cursor=${page1.nextCursor}`)
    ).json()) as typeof page1;
    expect(second.workspaces.map((w) => w.name)).toEqual(['Two']);
    expect(second.nextCursor).toBeNull();
  });

  it('403s an org Member', async () => {
    const { organizationId, member } = await makeOrg();
    signInAs(member);
    expect((await list(organizationId)).status).toBe(403);
  });

  it('404s a non-member', async () => {
    const { organizationId, outsider } = await makeOrg();
    signInAs(outsider);
    expect((await list(organizationId)).status).toBe(404);
  });
});

describe('deleteWorkspaceForErasure — the system entry account erasure takes', () => {
  it('deletes a sole-member workspace belonging to a plain org MEMBER', async () => {
    const { organizationId, owner, member } = await makeOrg();
    // A workspace the Owner makes and then leaves the Member alone in.
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Solo',
      ownerUserId: owner.id,
      organizationId,
    });
    await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
    await adminDb.workspaceMembership.deleteMany({
      where: { workspaceId: workspace.id, userId: owner.id },
    });

    await workspacesService.deleteWorkspaceForErasure({
      workspaceId: workspace.id,
      userId: member.id,
    });

    expect(await adminDb.workspace.count({ where: { id: workspace.id } })).toBe(0);
  });

  it('refuses a workspace that has a second member, and leaves it standing', async () => {
    const { home, member } = await makeOrg();
    // `home` holds the Owner and the Member.
    await expect(
      workspacesService.deleteWorkspaceForErasure({ workspaceId: home.id, userId: member.id }),
    ).rejects.toBeInstanceOf(WorkspaceNotSoleMemberError);
    expect(await adminDb.workspace.count({ where: { id: home.id } })).toBe(1);
  });
});
