import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminDb } from '../helpers/adminDb';

// MOTIR-6308 — the org OWNER acts with full rights in every workspace and project
// of the org, member or not; an org ADMIN reaches a workspace through membership
// (`docs/decisions/role-model.md` §1, reading R1). Real Postgres; run it under the
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
const { ProjectAccessDeniedError } = await import('@/lib/projects/errors');

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
    expect(access).toMatchObject({ effectiveRole: 'owner', workspaceRole: null, isOrgOwner: true });
  });

  it('opens the workspace: the gates pass and the role reads owner', async () => {
    const { owner, sales } = await orgWithForeignWorkspace();
    await expect(workspacesService.assertMembership(owner.id, sales.id)).resolves.toBeUndefined();
    await expect(projectsService.assertMembership(owner.id, sales.id)).resolves.toBeUndefined();
    expect(await workspacesService.getMemberRole(owner.id, sales.id)).toBe('owner');
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
});

describe('an org Admin reaches a workspace through membership', () => {
  it('resolves NO active project in a workspace they are not a member of', async () => {
    const { owner, admin, organizationId } = await orgWithForeignWorkspace();
    // A workspace the Owner creates now: the Admin was never added to it.
    const { workspace: ops } = await workspacesService.createWorkspace({
      name: 'Ops',
      ownerUserId: owner.id,
      organizationId,
    });
    expect(await readMembership(admin.id, ops.id)).toBeNull();
    // A project exists, so a null answer is the REFUSAL and not an empty workspace.
    await createTestProject({ workspaceId: ops.id, actorUserId: owner.id, identifier: 'OPS' });
    expect(await projectsService.getActiveProject(admin.id, ops.id)).toBeNull();
    expect(await projectsService.getActiveProject(owner.id, ops.id)).not.toBeNull();
  });

  it('is refused a workspace they are not a member of, and its projects', async () => {
    const { owner, admin, organizationId } = await orgWithForeignWorkspace();
    // Created AFTER the keep-whole migration: the Admin holds no membership here.
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
    expect(await organizationsService.resolveWorkspaceAccess(admin.id, later.id)).toBeNull();
    await expect(workspacesService.assertMembership(admin.id, later.id)).rejects.toBeInstanceOf(
      NotAMemberError,
    );
    // The project gate's non-member refusal (the same one any workspace non-member meets).
    await expect(
      projectAccessService.assertCanBrowse(project.id, { userId: admin.id, workspaceId: later.id }),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    // Not in the switcher, and a pinned cookie does not open it.
    const ids = (await workspacesService.listUserWorkspaces(admin.id)).map((w) => w.id);
    expect(ids).not.toContain(later.id);
    expect(await workspacesService.resolveActiveWorkspace(admin.id, later.id)).not.toBe(later.id);
  });

  it('as a MEMBER of it, gets exactly the member role’s permissions — no org raise', async () => {
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
    // The yardstick: a plain org MEMBER holding the same workspace role.
    const plain = await createTestUser();
    await workspacesService.addMember({ userId: plain.id, workspaceId: later.id, role: 'member' });

    const access = await organizationsService.resolveWorkspaceAccess(admin.id, later.id);
    expect(access).toMatchObject({ effectiveRole: 'member', isOrgOwner: false });
    const held = await projectAccessService.getPermissions(project.id, {
      userId: admin.id,
      workspaceId: later.id,
    });
    const yardstick = await projectAccessService.getPermissions(project.id, {
      userId: plain.id,
      workspaceId: later.id,
    });
    expect([...held].sort()).toEqual([...yardstick].sort());
    // …and that is less than the manager tier the org raise used to hand them.
    expect(held.has('project:administer')).toBe(false);
  });
});
