import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminDb } from '../helpers/adminDb';

// MOTIR-6308 — the org OWNER acts with full rights in every workspace and project
// of the org, member or not. An org ADMIN now does too, as a Manager (MOTIR-6168:
// the owner overturned reading R1 of `docs/decisions/role-model.md` at the
// MOTIR-6456 design gate, 2026-09-26; the record's AMENDMENT says so). Real Postgres; run it under the
// non-bypass role (`TEST_DB_APP_ROLE=1`) to prove RLS ADMITS the non-member Owner:
// the reads below go through `withWorkspaceContext`, whose `workspace_active` /
// `project_active_workspace` / `work_item_active_workspace` arms key on the bound
// `app.workspace_id`, and the owner check reads the Owner's OWN
// `organization_membership` row through `org_membership_visible_active_or_own`.
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));

const { workspacesService } = await import('@/lib/services/workspacesService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { projectAccessService } = await import('@/lib/services/projectAccessService');
const { projectsService } = await import('@/lib/services/projectsService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { ROLE_GATED_PERMISSIONS } = await import('@/lib/permissions/builtinRoles');
const { createTestUser } = await import('../fixtures/userFixtures');
const { createTestProject } = await import('../fixtures/projectFixtures');
const { createTestWorkItem } = await import('../fixtures/workItemFixtures');
const { truncateAuthTables } = await import('../helpers/db');
const { readMembership } = await import('@/lib/workspaces/membershipGate');
const { NotAMemberError } = await import('@/lib/workspaces/errors');

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await adminDb.$disconnect();
});

/**
 * An org with an Owner and an Admin, and a workspace the ADMIN created — so the
 * Owner holds NO membership in it — holding a PRIVATE project with one item.
 */
async function orgWithForeignWorkspace() {
  const owner = await createTestUser();
  const admin = await createTestUser();
  const { workspace: home } = await workspacesService.createWorkspace({
    name: 'Home',
    ownerUserId: owner.id,
  });
  const organizationId = (await adminDb.workspace.findUniqueOrThrow({ where: { id: home.id } }))
    .organizationId;
  await organizationsService.addMember({
    organizationId,
    userId: admin.id,
    role: 'admin',
    actorUserId: owner.id,
  });
  const { workspace: sales } = await workspacesService.createWorkspace({
    name: 'Sales',
    ownerUserId: admin.id,
    organizationId,
  });
  const project = await createTestProject({
    workspaceId: sales.id,
    actorUserId: admin.id,
    identifier: 'SALE',
  });
  await adminDb.project.update({ where: { id: project.id }, data: { accessLevel: 'private' } });
  const item = await createTestWorkItem(
    {
      owner: admin,
      workspace: sales,
      project,
      ownerId: admin.id,
      workspaceId: sales.id,
      projectId: project.id,
      projectIdentifier: project.identifier,
      ctx: { userId: admin.id, workspaceId: sales.id },
    } as never,
    { kind: 'task', title: 'Close the quarter' },
  );
  return { owner, admin, organizationId, home, sales, project, item };
}

describe('the org Owner, in a workspace they never joined', () => {
  it('holds no membership there — the scoped read and the reach disagree, which is the point', async () => {
    const { owner, sales } = await orgWithForeignWorkspace();
    expect(await readMembership(owner.id, sales.id)).toBeNull();
    const access = await organizationsService.resolveWorkspaceAccess(owner.id, sales.id);
    expect(access).toMatchObject({
      effectiveRole: 'manager',
      workspaceRole: null,
      isOrgOwner: true,
    });
  });

  it('opens the workspace: the gates pass and the role reads manager', async () => {
    const { owner, sales } = await orgWithForeignWorkspace();
    await expect(workspacesService.assertMembership(owner.id, sales.id)).resolves.toBeUndefined();
    await expect(projectsService.assertMembership(owner.id, sales.id)).resolves.toBeUndefined();
    expect(await workspacesService.getMemberRole(owner.id, sales.id)).toBe('manager');
    expect((await workspacesService.getWorkspaceSummary(sales.id, owner.id))?.id).toBe(sales.id);
  });

  it('passes assertPermission for EVERY role-gated key on a PRIVATE project', async () => {
    const { owner, sales, project } = await orgWithForeignWorkspace();
    const ctx = { userId: owner.id, workspaceId: sales.id };
    for (const key of ROLE_GATED_PERMISSIONS) {
      await expect(
        projectAccessService.assertPermission(project.id, ctx, key),
        key,
      ).resolves.toBeUndefined();
    }
    const listed = await projectsService.listProjects(sales.id, owner.id);
    expect(listed.map((p) => p.id)).toContain(project.id);
  });

  it('edits a work item in that private project', async () => {
    const { owner, sales, item } = await orgWithForeignWorkspace();
    const updated = await workItemsService.updateWorkItem(
      item.id,
      { title: 'Close the quarter — owner edit' },
      { userId: owner.id, workspaceId: sales.id },
    );
    expect(updated.title).toBe('Close the quarter — owner edit');
  });

  it('is listed every workspace of the org in the switcher, and can pin one it never joined', async () => {
    const { owner, home, sales } = await orgWithForeignWorkspace();
    const ids = (await workspacesService.listUserWorkspaces(owner.id)).map((w) => w.id);
    expect(ids).toEqual([home.id, sales.id]);
    expect(await workspacesService.resolveActiveWorkspace(owner.id, sales.id)).toBe(sales.id);
  });

  // MOTIR-6316's acceptance walk found this one: with the active workspace
  // pinned there, every project-scoped page resolves the ACTIVE PROJECT, and the
  // pointer lives on a membership row the Owner does not have — so the resolver
  // answered null, the page redirected to `/sign-in`, and sign-in bounced a
  // signed-in reader back: a redirect loop.
  it('resolves an active project there — read-only, persisting no roster row', async () => {
    const { owner, sales, project } = await orgWithForeignWorkspace();
    const active = await projectsService.getActiveProject(owner.id, sales.id);
    expect(active?.id).toBe(project.id);
    expect(await readMembership(owner.id, sales.id)).toBeNull();
  });

  // The follow-on the walk named: SWITCHING project there. The pointer the
  // switch writes is the membership row's, which the Owner does not have, so
  // their choice rides `User.lastActiveProjectId` instead — and still no row.
  it('switches project there: the choice is honoured, and still no roster row', async () => {
    const { owner, admin, sales, project } = await orgWithForeignWorkspace();
    const second = await createTestProject({
      workspaceId: sales.id,
      actorUserId: admin.id,
      identifier: 'SECND',
    });
    await projectsService.setActiveProject({
      userId: owner.id,
      workspaceId: sales.id,
      projectId: second.id,
    });
    expect((await projectsService.getActiveProject(owner.id, sales.id))?.id).toBe(second.id);
    expect(await readMembership(owner.id, sales.id)).toBeNull();

    // Back again — the pointer is overwritten, not appended.
    await projectsService.setActiveProject({
      userId: owner.id,
      workspaceId: sales.id,
      projectId: project.id,
    });
    expect((await projectsService.getActiveProject(owner.id, sales.id))?.id).toBe(project.id);
  });
});

describe('an org Admin reaches every workspace of the org as its Manager (MOTIR-6168)', () => {
  it('resolves an active project in a workspace they are not a member of', async () => {
    const { owner, admin, organizationId } = await orgWithForeignWorkspace();
    // A workspace the Owner creates now: the Admin was never added to it.
    const { workspace: ops } = await workspacesService.createWorkspace({
      name: 'Ops',
      ownerUserId: owner.id,
      organizationId,
    });
    expect(await readMembership(admin.id, ops.id)).toBeNull();
    const project = await createTestProject({
      workspaceId: ops.id,
      actorUserId: owner.id,
      identifier: 'OPS',
    });
    expect((await projectsService.getActiveProject(admin.id, ops.id))?.id).toBe(project.id);
  });

  it('is admitted to a workspace they are not a member of, and holds every role-gated key in its private project', async () => {
    const { owner, admin, organizationId } = await orgWithForeignWorkspace();
    const { workspace: later } = await workspacesService.createWorkspace({
      name: 'Later',
      ownerUserId: owner.id,
      organizationId,
    });
    const project = await createTestProject({
      workspaceId: later.id,
      actorUserId: owner.id,
      identifier: 'LATE',
    });
    await adminDb.project.update({ where: { id: project.id }, data: { accessLevel: 'private' } });
    expect(await organizationsService.resolveWorkspaceAccess(admin.id, later.id)).toMatchObject({
      effectiveRole: 'manager',
      workspaceRole: null,
      isOrgOwner: false,
      reachesEveryWorkspace: true,
    });
    await expect(workspacesService.assertMembership(admin.id, later.id)).resolves.toBeUndefined();
    const ctx = { userId: admin.id, workspaceId: later.id };
    for (const key of ROLE_GATED_PERMISSIONS) {
      await expect(
        projectAccessService.assertPermission(project.id, ctx, key),
      ).resolves.toBeUndefined();
    }
    // Listed in the switcher, and a pinned cookie opens it.
    const ids = (await workspacesService.listUserWorkspaces(admin.id)).map((w) => w.id);
    expect(ids).toContain(later.id);
    expect(await workspacesService.resolveActiveWorkspace(admin.id, later.id)).toBe(later.id);
  });

  it('as a MEMBER of it on a narrower workspace role, is still a Manager — the org role wins', async () => {
    const { owner, admin, organizationId } = await orgWithForeignWorkspace();
    const { workspace: later } = await workspacesService.createWorkspace({
      name: 'Later',
      ownerUserId: owner.id,
      organizationId,
    });
    const project = await createTestProject({
      workspaceId: later.id,
      actorUserId: owner.id,
      identifier: 'LATE',
    });
    await workspacesService.addMember({ userId: admin.id, workspaceId: later.id, role: 'member' });
    const held = await projectAccessService.getPermissions(project.id, {
      userId: admin.id,
      workspaceId: later.id,
    });
    expect([...held].sort()).toEqual([...ROLE_GATED_PERMISSIONS].sort());
  });

  it('a plain org MEMBER still reaches only the workspaces they belong to', async () => {
    const { owner, organizationId } = await orgWithForeignWorkspace();
    const plain = await createTestUser();
    await organizationsService.addMember({
      organizationId,
      userId: plain.id,
      role: 'member',
      actorUserId: owner.id,
    });
    const { workspace: later } = await workspacesService.createWorkspace({
      name: 'Later',
      ownerUserId: owner.id,
      organizationId,
    });
    expect(await organizationsService.resolveWorkspaceAccess(plain.id, later.id)).toBeNull();
    await expect(workspacesService.assertMembership(plain.id, later.id)).rejects.toBeInstanceOf(
      NotAMemberError,
    );
  });
});
