import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError, PlatformOrganizationNotFoundError } from '@/lib/platform/errors';
import { platformReadService } from '@/lib/services/platformReadService';
import { createTestProject } from '../fixtures/projectFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { createTestWorkspace } from '../fixtures/workspaceFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * `platformReadService` — the audited cross-tenant READ layer (Story MOTIR-727 ·
 * MOTIR-730).
 *
 * Four properties, each tested from the side that can actually fail:
 *
 * 1. **The estate arms exist, are SELECT-only and name only `app.platform_staff`.**
 *    Read from the catalog, because an arm that is missing does not error — the
 *    read returns zero rows and the count reads as a fact.
 * 2. **The reads see the WHOLE estate, not the operator's own tenancy.** The
 *    operator belongs to no workspace at all, so a fixture where the caller's own
 *    view (nothing) and the true population differ is the default here — the
 *    lesson that a scoped count and a true one are the same type and differ only
 *    in value. `@/lib/db` is `motir_app` (MOTIR-2734), so every read below runs
 *    under the non-bypass role and the arms are genuinely exercised.
 * 3. **Each read writes exactly ONE `platform_audit_log` row, and a read that
 *    throws writes none.** Read back from the table, not inferred.
 * 4. **A non-staff principal is refused before anything is read or written.**
 */

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    // The one `vi.mock` `CLAUDE.md` allows, at the platform tier's equivalent of
    // `getSession` — the test environment has no cookies. The stub re-runs the
    // ladder comparison the real gate makes, so the refusal below is the
    // service's own `requirePlatformStaff('support')` call and not the mock.
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        if (!currentPrincipal) throw new NotPlatformStaffError();
        if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
          throw new NotPlatformStaffError();
        }
        return currentPrincipal;
      },
    ),
  };
});

let currentPrincipal: PlatformPrincipal | null = null;

const ESTATE_TABLES = ['organization_membership', 'project', 'workspace', 'workspace_membership'];

async function seedOperator(role: 'support' | 'operator' | 'superadmin' = 'support') {
  const user = await createTestUser({ email: `ops+estate-${role}@moooon.net` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

async function auditRows() {
  return adminDb.platformAuditLog.findMany({ orderBy: { createdAt: 'asc' } });
}

beforeEach(async () => {
  await adminDb.platformAuditLog.deleteMany();
  await truncateAuthTables();
  currentPrincipal = await seedOperator();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the estate `platform_staff` policy arms (MOTIR-730)', () => {
  it('ships ONE permissive SELECT arm per estate table, bound to `app.platform_staff` alone', async () => {
    const rows = await adminDb.$queryRaw<
      { tablename: string; policyname: string; cmd: string; permissive: string; qual: string }[]
    >`
      SELECT "tablename", "policyname", "cmd", "permissive", "qual"
      FROM pg_policies
      WHERE "tablename" IN ('workspace', 'project', 'workspace_membership', 'organization_membership')
        AND ("qual" LIKE '%app.platform_staff%' OR "with_check" LIKE '%app.platform_staff%')
      ORDER BY "tablename"
    `;

    expect(rows.map((r) => r.tablename)).toEqual(ESTATE_TABLES);
    for (const row of rows) {
      expect(row.policyname).toBe(`${row.tablename}_platform_staff_read`);
      // READ-side only (ADR §3a): no tenant table gains a platform write arm.
      expect(row.cmd).toBe('SELECT');
      expect(row.permissive).toBe('PERMISSIVE');
      // No tenant GUC, and never the job runtime's GUC.
      expect(row.qual).not.toContain('app.workspace_id');
      expect(row.qual).not.toContain('app.organization_id');
      expect(row.qual).not.toContain('app.system_admin');
    }
  });
});

describe('platformReadService.getEstateCounts', () => {
  it('counts the WHOLE estate for an operator who belongs to none of it, and writes one estate.read row', async () => {
    const a = await createTestWorkspace({ name: 'Alpha' });
    const b = await createTestWorkspace({ name: 'Bravo' });
    await createTestProject({ workspaceId: a.workspace.id, actorUserId: a.owner.id });
    await createTestProject({
      workspaceId: b.workspace.id,
      actorUserId: b.owner.id,
      identifier: 'BRV',
    });

    const counts = await platformReadService.getEstateCounts(currentPrincipal!);

    // Two first workspaces each mint their own organization; three accounts
    // (two owners and the operator). The operator is a member of nothing, so a
    // tenant-scoped view would have answered zero on every tier.
    expect(counts).toEqual({ organizations: 2, workspaces: 2, projects: 2, users: 3 });
    expect(counts).toEqual({
      organizations: await adminDb.organization.count(),
      workspaces: await adminDb.workspace.count(),
      projects: await adminDb.project.count(),
      users: await adminDb.user.count(),
    });

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: currentPrincipal!.userId,
      actorRole: 'support',
      action: 'estate.read',
      targetKind: 'platform',
      targetId: null,
      reason: null,
    });
  });

  it('refuses a non-staff caller before the read, writing no audit row', async () => {
    const tenant = await createTestWorkspace({ name: 'Tenant' });
    const asTenant = {
      userId: tenant.owner.id,
      email: tenant.owner.email,
      role: 'support',
    } satisfies PlatformPrincipal;
    currentPrincipal = null;

    await expect(platformReadService.getEstateCounts(asTenant)).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('platformReadService.getOrganizationEstate', () => {
  it('reads another tenant’s organization, its workspaces and their counts, auditing the org', async () => {
    const first = await createTestWorkspace({ name: 'Northwind' });
    await createTestProject({ workspaceId: first.workspace.id, actorUserId: first.owner.id });
    await createTestProject({
      workspaceId: first.workspace.id,
      actorUserId: first.owner.id,
      identifier: 'NW2',
      name: 'Second',
    });
    // A second, unrelated tenant — must not leak into the first org's tiers.
    await createTestWorkspace({ name: 'Elsewhere' });
    const orgId = first.workspace.organizationId;

    const estate = await platformReadService.getOrganizationEstate(currentPrincipal!, orgId);

    expect(estate.organization.id).toBe(orgId);
    expect(estate.memberCount).toBe(
      await adminDb.organizationMembership.count({
        where: { organizationId: orgId },
      }),
    );
    expect(estate.workspaces).toEqual([
      expect.objectContaining({
        id: first.workspace.id,
        name: first.workspace.name,
        projectCount: 2,
        memberCount: 1,
      }),
    ]);
    expect(estate.hasMoreWorkspaces).toBe(false);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'estate.read',
      targetKind: 'organization',
      targetId: orgId,
      organizationId: orgId,
      reason: null,
    });
  });

  it('a missing organization throws INSIDE the transaction, so the read leaves no audit row', async () => {
    await expect(
      platformReadService.getOrganizationEstate(currentPrincipal!, 'cmnot-a-real-org'),
    ).rejects.toBeInstanceOf(PlatformOrganizationNotFoundError);
    expect(await auditRows()).toHaveLength(0);
  });

  it('refuses a non-staff caller before the read, writing no audit row', async () => {
    const tenant = await createTestWorkspace({ name: 'Tenant' });
    const asTenant = {
      userId: tenant.owner.id,
      email: tenant.owner.email,
      role: 'support',
    } satisfies PlatformPrincipal;
    currentPrincipal = null;

    await expect(
      platformReadService.getOrganizationEstate(asTenant, tenant.workspace.organizationId),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    expect(await auditRows()).toHaveLength(0);
  });
});
