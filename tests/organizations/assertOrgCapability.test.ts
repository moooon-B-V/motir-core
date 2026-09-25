import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminDb } from '../helpers/adminDb';

// `organizationAccessService.assertOrgCapability` (MOTIR-6305) — the guard every
// org-level write reads the capability table through. Real Postgres for the org
// and its memberships (the no-mocks rule); the one boundary mock is the
// post-commit seat-sync ENQUEUE that org-membership writes fire.
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));

const { assertOrgCapability, assertOrgAdmin, isOrgAdminForWorkspace } =
  await import('@/lib/services/organizationAccessService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { withOrgContext } = await import('@/lib/organizations/context');
const { createTestUser } = await import('../fixtures/userFixtures');
const { truncateAuthTables } = await import('../helpers/db');
const { OrganizationNotFoundError, OrgForbiddenError } = await import('@/lib/organizations/errors');

async function makeOrgWithRoles() {
  const owner = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  const organizationId = (
    await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
  ).organizationId;
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
  const outsider = await createTestUser();
  return { organizationId, workspaceId: workspace.id, owner, admin, member, outsider };
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await adminDb.$disconnect();
});

describe('assertOrgCapability', () => {
  it('404s a NON-MEMBER — the org stays indistinguishable from one that does not exist', async () => {
    const { organizationId, outsider } = await makeOrgWithRoles();
    await expect(
      assertOrgCapability(outsider.id, organizationId, 'manageOrgSettings'),
    ).rejects.toBeInstanceOf(OrganizationNotFoundError);
  });

  it('403s a MEMBER whose role lacks the capability', async () => {
    const { organizationId, member, admin } = await makeOrgWithRoles();
    await expect(
      assertOrgCapability(member.id, organizationId, 'manageWorkspaces'),
    ).rejects.toBeInstanceOf(OrgForbiddenError);
    // An Admin lacks the two Owner-only capabilities: the refusal is the same 403.
    await expect(
      assertOrgCapability(admin.id, organizationId, 'transferOwnership'),
    ).rejects.toBeInstanceOf(OrgForbiddenError);
    await expect(
      assertOrgCapability(admin.id, organizationId, 'deleteOrganization'),
    ).rejects.toBeInstanceOf(OrgForbiddenError);
  });

  it('admits a holder and returns their role', async () => {
    const { organizationId, owner, admin } = await makeOrgWithRoles();
    await expect(assertOrgCapability(owner.id, organizationId, 'transferOwnership')).resolves.toBe(
      'owner',
    );
    await expect(assertOrgCapability(admin.id, organizationId, 'manageBilling')).resolves.toBe(
      'admin',
    );
  });

  it('reads inside the CALLER’s transaction when one is passed', async () => {
    const { organizationId, admin, member } = await makeOrgWithRoles();
    await withOrgContext({ userId: admin.id, organizationId }, async (tx) => {
      await expect(
        assertOrgCapability(admin.id, organizationId, 'manageWorkspaces', tx),
      ).resolves.toBe('admin');
    });
    await withOrgContext({ userId: member.id, organizationId }, async (tx) => {
      await expect(
        assertOrgCapability(member.id, organizationId, 'manageWorkspaces', tx),
      ).rejects.toBeInstanceOf(OrgForbiddenError);
    });
  });
});

describe('the wrappers read the same table', () => {
  it('assertOrgAdmin admits an Owner and an Admin and refuses a Member', async () => {
    const { organizationId, owner, admin, member } = await makeOrgWithRoles();
    for (const actor of [owner, admin]) {
      await withOrgContext({ userId: actor.id, organizationId }, (tx) =>
        assertOrgAdmin(actor.id, organizationId, tx),
      );
    }
    await expect(
      withOrgContext({ userId: member.id, organizationId }, (tx) =>
        assertOrgAdmin(member.id, organizationId, tx),
      ),
    ).rejects.toBeInstanceOf(OrgForbiddenError);
  });

  it('isOrgAdminForWorkspace answers the org-settings capability', async () => {
    const { workspaceId, owner, admin, member } = await makeOrgWithRoles();
    expect(await isOrgAdminForWorkspace(owner.id, workspaceId)).toBe(true);
    expect(await isOrgAdminForWorkspace(admin.id, workspaceId)).toBe(true);
    expect(await isOrgAdminForWorkspace(member.id, workspaceId)).toBe(false);
  });
});
