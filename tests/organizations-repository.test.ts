import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from './fixtures/userFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// Repository + model tests for the org tier (Story 6.10 · Subtask 6.10.7 —
// the 6.10.3 model half of the exhaustive matrix). Real Postgres, no mocks
// (the project rule). These lock the DATA layer the 6.10.4 service composes
// over: the org + membership round-trips, the (organizationId, userId)
// uniqueness, the Workspace.organizationId relation in both directions, and
// the required-`tx` write contract (a write is bound to its transaction, so a
// rollback un-does it).
//
// The subject here is the DATA layer, not visibility: column round-trips, the
// (organizationId, userId) uniqueness, the required-`tx` write contract, the
// Workspace.organizationId relation and the FK cascades. Every one of those
// holds identically under either Postgres role, so the transactions these
// repository methods are handed come from the ADMIN client — an RLS denial there
// would replace the signal with noise (a uniqueness test that fails with a
// policy error proves nothing about uniqueness). RLS-policy enforcement is
// covered separately, and under the non-bypass role, in organization-rls.test.ts.
//
// ⚠️ The three SINGLETON-read variants this file also exercises —
// organizationRepository.findById / findBySlug and
// organizationMembershipRepository.findByOrgAndUser — are hardwired to
// `@/lib/db` and take no `tx`, so they cannot be handed the admin transaction.
// Under TEST_DB_APP_ROLE=1 they return null by documented design (see
// findByIdInTx's docstring). They are left on `db` rather than bent: the
// residual is a real finding, not a fixture defect, and is filed as its own
// card. All three have ZERO production callers — every production read moved to
// the `…InTx` variant in MOTIR-2527 / MOTIR-2569.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('organizationRepository', () => {
  it('create + findById + findBySlug round-trip an organization', async () => {
    const created = await adminDb.$transaction((tx) =>
      organizationRepository.create({ name: 'Acme Inc', slug: 'acme-inc' }, tx),
    );
    expect(created.id).toBeTruthy();
    expect(created.name).toBe('Acme Inc');
    expect(created.slug).toBe('acme-inc');

    const byId = await adminDb.$transaction((tx) =>
      organizationRepository.findByIdInTx(created.id, tx),
    );
    expect(byId).not.toBeNull();
    expect(byId!.slug).toBe('acme-inc');

    // No `findBySlugInTx` exists and nothing consumes one (MOTIR-2775), so the slug
    // round-trip is asserted directly — the claim is that the row landed under that
    // slug, which an unfiltered read states exactly.
    const bySlug = await adminDb.organization.findUnique({ where: { slug: 'acme-inc' } });
    expect(bySlug).not.toBeNull();
    expect(bySlug!.id).toBe(created.id);

    // Misses return null, never throw.
    const missingById = await adminDb.$transaction((tx) =>
      organizationRepository.findByIdInTx('nope', tx),
    );
    expect(missingById).toBeNull();
    const missingBySlug = await adminDb.organization.findUnique({ where: { slug: 'nope' } });
    expect(missingBySlug).toBeNull();
  });

  it('enforces the unique organization.slug (a second create on the same slug is a P2002)', async () => {
    await adminDb.$transaction((tx) =>
      organizationRepository.create({ name: 'Acme', slug: 'dup-slug' }, tx),
    );
    const duplicateSlug = adminDb.$transaction((tx) =>
      organizationRepository.create({ name: 'Other', slug: 'dup-slug' }, tx),
    );
    await expect(duplicateSlug).rejects.toMatchObject({ code: 'P2002' });
  });

  it('update changes the name', async () => {
    const org = await adminDb.$transaction((tx) =>
      organizationRepository.create({ name: 'Before', slug: 'rename-me' }, tx),
    );
    const updated = await adminDb.$transaction((tx) =>
      organizationRepository.update(org.id, { name: 'After' }, tx),
    );
    expect(updated.name).toBe('After');
    const reread = await adminDb.$transaction((tx) =>
      organizationRepository.findByIdInTx(org.id, tx),
    );
    expect(reread!.name).toBe('After');
  });

  it('binds the write to its transaction — a rolled-back create leaves no row', async () => {
    const ROLLBACK = new Error('rollback sentinel');
    let id: string | undefined;
    const rolledBack = adminDb.$transaction(async (tx) => {
      const org = await organizationRepository.create({ name: 'Ghost', slug: 'ghost-org' }, tx);
      id = org.id;
      // The row is visible to this transaction…
      const insideTx = await tx.organization.findUnique({ where: { id: org.id } });
      expect(insideTx).not.toBeNull();
      // …then we abort, so it must never have committed.
      throw ROLLBACK;
    });
    await expect(rolledBack).rejects.toBe(ROLLBACK);

    expect(id).toBeTruthy();
    // Read back through the ADMIN client: "the row never committed" is a claim
    // about storage, and a policy-filtered read cannot tell absent from hidden.
    const ghostById = await adminDb.organization.findUnique({ where: { id: id! } });
    expect(ghostById).toBeNull();
    const ghostBySlug = await adminDb.organization.findUnique({ where: { slug: 'ghost-org' } });
    expect(ghostBySlug).toBeNull();
  });
});

describe('organizationMembershipRepository', () => {
  it('create + findByOrgAndUser round-trip a membership, and the role defaults are honoured', async () => {
    const user = await createTestUser();
    const org = await adminDb.$transaction((tx) =>
      organizationRepository.create({ name: 'Acme', slug: 'm-roundtrip' }, tx),
    );

    const membership = await adminDb.$transaction((tx) =>
      organizationMembershipRepository.create(
        { organizationId: org.id, userId: user.id, role: 'admin' },
        tx,
      ),
    );
    expect(membership.role).toBe('admin');

    const found = await adminDb.$transaction((tx) =>
      organizationMembershipRepository.findByOrgAndUserInTx(org.id, user.id, tx),
    );
    expect(found).not.toBeNull();
    expect(found!.role).toBe('admin');

    // A different (org, user) pair is absent.
    const otherPair = await adminDb.$transaction((tx) =>
      organizationMembershipRepository.findByOrgAndUserInTx(org.id, 'someone', tx),
    );
    expect(otherPair).toBeNull();
  });

  it('enforces the (organizationId, userId) uniqueness (a duplicate membership is a P2002)', async () => {
    const user = await createTestUser();
    const org = await adminDb.$transaction((tx) =>
      organizationRepository.create({ name: 'Acme', slug: 'm-unique' }, tx),
    );
    await adminDb.$transaction((tx) =>
      organizationMembershipRepository.create(
        { organizationId: org.id, userId: user.id, role: 'member' },
        tx,
      ),
    );
    const duplicateMembership = adminDb.$transaction((tx) =>
      organizationMembershipRepository.create(
        { organizationId: org.id, userId: user.id, role: 'owner' },
        tx,
      ),
    );
    await expect(duplicateMembership).rejects.toMatchObject({ code: 'P2002' });
  });

  it('updateRole and deleteByOrgAndUser mutate the row; delete of an absent row is a no-op (null)', async () => {
    const user = await createTestUser();
    const org = await adminDb.$transaction((tx) =>
      organizationRepository.create({ name: 'Acme', slug: 'm-mutate' }, tx),
    );
    await adminDb.$transaction((tx) =>
      organizationMembershipRepository.create(
        { organizationId: org.id, userId: user.id, role: 'member' },
        tx,
      ),
    );

    const promoted = await adminDb.$transaction((tx) =>
      organizationMembershipRepository.updateRole(org.id, user.id, 'owner', tx),
    );
    expect(promoted.role).toBe('owner');

    const deleted = await adminDb.$transaction((tx) =>
      organizationMembershipRepository.deleteByOrgAndUser(org.id, user.id, tx),
    );
    expect(deleted).not.toBeNull();
    const removed = await adminDb.$transaction((tx) =>
      organizationMembershipRepository.findByOrgAndUserInTx(org.id, user.id, tx),
    );
    expect(removed).toBeNull();

    // Deleting an already-gone row returns null rather than throwing (the
    // remove flow leans on this idempotency).
    const again = await adminDb.$transaction((tx) =>
      organizationMembershipRepository.deleteByOrgAndUser(org.id, user.id, tx),
    );
    expect(again).toBeNull();
  });

  it('findOrganizationsByUser returns the empty array for a user in no org (the empty-input branch)', async () => {
    const user = await createTestUser();
    // MOTIR-2774 made the `tx` required — the empty-set branch is asserted through a
    // transaction now, exactly as `withUserContext` supplies one in production.
    const orgs = await adminDb.$transaction((tx) =>
      organizationMembershipRepository.findOrganizationsByUser(user.id, tx),
    );
    expect(orgs).toEqual([]);
  });
});

describe('Workspace.organizationId relation', () => {
  it('resolves both ways — organization.workspaces includes the workspace, and workspace.organization is the org', async () => {
    const owner = await createTestUser();
    // createWorkspace mints the workspace under a freshly-created default org.
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });

    // workspace → organization
    const wsWithOrg = await adminDb.workspace.findUniqueOrThrow({
      where: { id: workspace.id },
      include: { organization: true },
    });
    expect(wsWithOrg.organizationId).toBeTruthy();
    expect(wsWithOrg.organization.id).toBe(wsWithOrg.organizationId);

    // organization → workspaces (the back-relation)
    const orgWithWs = await adminDb.organization.findUniqueOrThrow({
      where: { id: wsWithOrg.organizationId },
      include: { workspaces: true },
    });
    expect(orgWithWs.workspaces.map((w) => w.id)).toContain(workspace.id);
  });

  it('a second workspace created under the same org nests under it (organization.workspaces lists both)', async () => {
    const owner = await createTestUser();
    const { workspace: w1 } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = (await adminDb.workspace.findUniqueOrThrow({ where: { id: w1.id } }))
      .organizationId;
    const { workspace: w2 } = await workspacesService.createWorkspace({
      name: 'Beta',
      ownerUserId: owner.id,
      organizationId: orgId,
    });

    const org = await adminDb.organization.findUniqueOrThrow({
      where: { id: orgId },
      include: { workspaces: true },
    });
    expect(org.workspaces.map((w) => w.id).sort()).toEqual([w1.id, w2.id].sort());
  });

  it('deleting the organization cascades to its workspaces (onDelete: Cascade)', async () => {
    const owner = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = (await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } }))
      .organizationId;

    // The FK is ON DELETE CASCADE both ways (org → workspace, org → membership).
    await adminDb.$transaction((tx) => tx.organization.delete({ where: { id: orgId } }));

    const cascadedWorkspace = await adminDb.workspace.findUnique({ where: { id: workspace.id } });
    expect(cascadedWorkspace).toBeNull();
    const cascadedMemberships = await adminDb.organizationMembership.count({
      where: { organizationId: orgId },
    });
    expect(cascadedMemberships).toBe(0);
  });
});
