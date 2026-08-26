import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { organizationsService } from '@/lib/services/organizationsService';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { withOrgContext } from '@/lib/organizations/context';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// `workspace_org_member_read` (MOTIR-3512 · migration 20260826001500) — the
// org-scoped SELECT arm that makes "how many workspaces does this ORG have?"
// answerable from a user-bound org transaction.
//
// ⚠️ WHAT MAKES THESE ASSERTIONS MEAN ANYTHING. The suite's own connection IS
// the non-bypass runtime role: `currentWorkerUrl()` returns
// `withAppRoleCredentials(...)` unconditionally since MOTIR-2734 retired the
// opt-in flag, so every query `@/lib/db` makes has the policies applied. There
// is no role-switch dance to perform here and no mode in which these tests
// silently run as the owner. Fixtures go through `adminDb`, the owner client,
// because seeding across tenants is exactly what the policies forbid.
//
// The BEFORE state is on the record rather than merely described: a probe on
// d32892bd returned `TRUE org workspace count = 2 / SEEN under
// withOrgContext(founder) = 1`. Case 1 below is that probe, inverted.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  orgId: string;
  founderId: string;
  /** An org member who belongs to NEITHER workspace. */
  orgOnlyId: string;
  /** Not a member of the org at all. */
  outsiderId: string;
  wsAId: string;
  wsBId: string;
}

/**
 * An org with TWO workspaces whose actor belongs to exactly ONE — the shape that
 * returned 1 before this policy, and the only shape that can tell a scoped read
 * from an unscoped one. A fixture whose actor is in both workspaces returns 2
 * either way and would pass against the un-patched database.
 */
async function makeFixture(): Promise<Fixture> {
  const founder = await usersService.createUser({
    email: 'founder@example.com',
    password: 'hunter2hunter2',
    name: 'Founder',
  });
  const orgOnly = await usersService.createUser({
    email: 'org-only@example.com',
    password: 'hunter2hunter2',
    name: 'Org Only',
  });
  const outsider = await usersService.createUser({
    email: 'outsider@example.com',
    password: 'hunter2hunter2',
    name: 'Outsider',
  });

  const a = await workspacesService.createWorkspace({ name: 'Alpha', ownerUserId: founder.id });
  const orgId = (await adminDb.workspace.findUniqueOrThrow({ where: { id: a.workspace.id } }))
    .organizationId;

  // A SECOND workspace in the SAME org that the founder is NOT a member of.
  // Seeded through the owner client: creating it through the service would make
  // the caller its owner, which is precisely the fixture we must not have.
  const b = await adminDb.workspace.create({
    data: { name: 'Beta', slug: 'beta-org-read-arm', organizationId: orgId },
  });
  await adminDb.organizationMembership.create({
    data: { organizationId: orgId, userId: orgOnly.id, role: 'member' },
  });

  return {
    orgId,
    founderId: founder.id,
    orgOnlyId: orgOnly.id,
    outsiderId: outsider.id,
    wsAId: a.workspace.id,
    wsBId: b.id,
  };
}

describe('workspace_org_member_read — the org sees its own workspaces', () => {
  it('returns EVERY workspace of the org to a member of only one of them', async () => {
    const f = await makeFixture();

    const trueCount = await adminDb.workspace.count({ where: { organizationId: f.orgId } });
    expect(trueCount).toBe(2);

    const seen = await withOrgContext({ userId: f.founderId, organizationId: f.orgId }, (tx) =>
      workspaceRepository.listByOrganization(f.orgId, tx),
    );

    expect(seen.map((w) => w.id).sort()).toEqual([f.wsAId, f.wsBId].sort());
  });

  it('returns both to an org member who belongs to NEITHER workspace', async () => {
    // The billing-admin shape (§5). Before this arm it read ZERO, which is the
    // same wrong answer as case 1 taken to its limit.
    const f = await makeFixture();

    const seen = await withOrgContext({ userId: f.orgOnlyId, organizationId: f.orgId }, (tx) =>
      workspaceRepository.listByOrganization(f.orgId, tx),
    );

    expect(seen).toHaveLength(2);
  });

  it('makes countByOrganization report the org TRUE count', async () => {
    const f = await makeFixture();

    const count = await withOrgContext({ userId: f.founderId, organizationId: f.orgId }, (tx) =>
      workspaceRepository.countByOrganization(f.orgId, tx),
    );

    expect(count).toBe(2);
  });
});

describe('workspace_org_member_read — what it does NOT admit', () => {
  it('reads ZERO for a user who is not an org member — the EXISTS is load-bearing', async () => {
    // Without the EXISTS clause the policy would key on the bound org alone, and
    // binding an org id you are not in would hand you its workspaces. This is
    // the assertion that tells the two policies apart.
    const f = await makeFixture();

    const seen = await withOrgContext({ userId: f.outsiderId, organizationId: f.orgId }, (tx) =>
      workspaceRepository.listByOrganization(f.orgId, tx),
    );

    expect(seen).toHaveLength(0);
  });

  it('admits nothing when NO org is bound — a workspace context is unchanged', async () => {
    // The fail-closed axis. `withWorkspaceContext` never binds
    // `app.organization_id`, so `current_setting(..., true)` is NULL, the
    // comparison is NULL, and this arm contributes no rows. What comes back is
    // exactly what `workspace_membership_visible` alone admits — the founder's
    // ONE workspace — which is the pre-existing behaviour this migration must
    // not disturb.
    const f = await makeFixture();

    const seen = await withWorkspaceContext({ userId: f.founderId, workspaceId: f.wsAId }, (tx) =>
      tx.workspace.findMany({ where: { organizationId: f.orgId } }),
    );

    expect(seen.map((w) => w.id)).toEqual([f.wsAId]);
  });

  it('is SELECT-only: a workspace reached only through this arm cannot be UPDATED', async () => {
    const f = await makeFixture();

    // Beta is visible to the founder ONLY via the new arm (they are not a
    // member). Renaming it must still be refused — `workspace_mutate_active`
    // keys on the ACTIVE-workspace GUC, which an org context never binds.
    await expect(
      withOrgContext({ userId: f.founderId, organizationId: f.orgId }, (tx) =>
        workspaceRepository.update(f.wsBId, { name: 'Renamed by an org member' }, tx),
      ),
    ).rejects.toThrow();

    const after = await adminDb.workspace.findUniqueOrThrow({ where: { id: f.wsBId } });
    expect(after.name).toBe('Beta');
  });

  it('is SELECT-only: the same workspace cannot be DELETED', async () => {
    const f = await makeFixture();

    await expect(
      withOrgContext({ userId: f.founderId, organizationId: f.orgId }, (tx) =>
        workspaceRepository.delete(f.wsBId, tx),
      ),
    ).rejects.toThrow();

    expect(await adminDb.workspace.count({ where: { id: f.wsBId } })).toBe(1);
  });
});

describe('the shipped readers this silently corrects', () => {
  it('summarizeOrgFootprint now reports the ORG footprint, not the actor slice', async () => {
    // The surface whose own comment used to say "the actor's workspaces in the
    // org" — an accurate description of a wrong answer (AC 8).
    const f = await makeFixture();

    const footprint = await organizationsService.summarizeOrgFootprint({
      userId: f.founderId,
      organizationId: f.orgId,
    });

    expect(footprint.workspaceCount).toBe(2);
  });
});
