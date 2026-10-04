import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError, PlatformOrganizationNotFoundError } from '@/lib/platform/errors';

/**
 * The org page's OPERATIONS tab read and the member-side suspended notice
 * (MOTIR-752, design `platform-admin` AMENDMENT 2026-10-03 Panels 1, 3b, 3d) —
 * over the real database.
 *
 * `platformOrgPageService.getOperations`: one `estate.read` naming the org, the
 * member and workspace counts the status line quotes, who suspended it, and the
 * operator writes on it; any staff role; a missing org leaves no audit row.
 *
 * `organizationsService.getSuspensionNotice`: names an organization only to its
 * own member and only while it is suspended, and offers the member's OTHER open
 * organizations to switch to.
 */

let currentPrincipal: PlatformPrincipal | null = null;

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        if (!currentPrincipal) throw new NotPlatformStaffError();
        if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum))
          throw new NotPlatformStaffError();
        return currentPrincipal;
      },
    ),
  };
});

const { db } = await import('@/lib/db');
const { platformOrgPageService } = await import('@/lib/services/platformOrgPageService');
const { platformOrgLifecycleService } = await import('@/lib/services/platformOrgLifecycleService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { createTestWorkspace } = await import('../fixtures/workspaceFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

async function seedOperator(role: PlatformPrincipal['role']) {
  const user = await createTestUser({ email: `ops+${role}@moooon.net`, name: `Op ${role}` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  currentPrincipal = { userId: user.id, email: user.email, role };
  return user;
}

beforeEach(async () => {
  await adminDb.platformAuditLog.deleteMany();
  await truncateAuthTables();
  currentPrincipal = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('platformOrgPageService.getOperations', () => {
  it('reads the org, its counts and its writes under ONE estate.read naming the org', async () => {
    const { workspace, owner } = await createTestWorkspace({ name: 'Engineering' });
    const orgId = workspace.organizationId;
    await workspacesService.createWorkspace({
      name: 'Design',
      ownerUserId: owner.id,
      organizationId: orgId,
    });
    await seedOperator('support');

    const before = await adminDb.platformAuditLog.count();
    const data = await platformOrgPageService.getOperations(currentPrincipal!, orgId);
    expect(data.organization.id).toBe(orgId);
    expect(data.organization.suspension).toBeNull();
    expect(data.suspendedBy).toBeNull();
    expect(data.memberCount).toBe(1);
    expect(data.workspaceCount).toBe(2);
    expect(data.actions).toEqual([]);

    const rows = await adminDb.platformAuditLog.findMany({ orderBy: { seq: 'asc' } });
    expect(rows.length - before).toBe(1);
    expect(rows.at(-1)).toMatchObject({
      action: 'estate.read',
      targetKind: 'organization',
      targetId: orgId,
      organizationId: orgId,
    });
  });

  it('names who suspended it and carries the org.suspend write', async () => {
    const { workspace } = await createTestWorkspace({ name: 'Acme' });
    const orgId = workspace.organizationId;
    const op = await seedOperator('superadmin');
    await platformOrgLifecycleService.suspend(currentPrincipal!, orgId, 'non-payment since July');

    const data = await platformOrgPageService.getOperations(currentPrincipal!, orgId);
    expect(data.organization.suspended).toBe(true);
    expect(data.organization.suspension?.reason).toBe('non-payment since July');
    expect(data.suspendedBy).toEqual({ userId: op.id, email: op.email, name: 'Op superadmin' });
    expect(data.actions.map((a) => a.action)).toEqual(['org.suspend']);
  });

  it('refuses a non-staff caller and a missing org (no audit row for the miss)', async () => {
    await expect(
      platformOrgPageService.getOperations(null as never, 'nope'),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    await seedOperator('operator');
    const before = await adminDb.platformAuditLog.count();
    await expect(
      platformOrgPageService.getOperations(currentPrincipal!, 'org_does_not_exist'),
    ).rejects.toBeInstanceOf(PlatformOrganizationNotFoundError);
    expect(await adminDb.platformAuditLog.count()).toBe(before);
  });
});

describe('organizationsService.getSuspensionNotice', () => {
  it('names a suspended org only to its member, and offers their other open orgs', async () => {
    const { workspace: acme, owner } = await createTestWorkspace({ name: 'Acme' });
    const other = await organizationsService.createOrganization({
      name: 'Side Project',
      actorUserId: owner.id,
    });
    const { workspace: stranger } = await createTestWorkspace({ name: 'Elsewhere' });
    await seedOperator('superadmin');
    await platformOrgLifecycleService.suspend(currentPrincipal!, acme.organizationId, 'abuse');
    await platformOrgLifecycleService.suspend(currentPrincipal!, stranger.organizationId, 'abuse');

    const notice = await organizationsService.getSuspensionNotice(owner.id, acme.organizationId);
    expect(notice.organization).toMatchObject({ id: acme.organizationId });
    expect(notice.alternatives.map((o) => o.id)).toEqual([other.id]);

    // An org the reader does not belong to is never named, suspended or not.
    const forged = await organizationsService.getSuspensionNotice(
      owner.id,
      stranger.organizationId,
    );
    expect(forged.organization).toBeNull();

    // An org that is NOT suspended is not named as suspended either.
    const open = await organizationsService.getSuspensionNotice(owner.id, other.id);
    expect(open.organization).toBeNull();
    expect(await organizationsService.getSuspensionNotice(owner.id, null)).toMatchObject({
      organization: null,
    });
  });
});
