import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from './fixtures/userFixtures';
import { truncateAuthTables } from './helpers/db';

// Repository + model tests for the org tier (Story 6.10 · Subtask 6.10.7 —
// the 6.10.3 model half of the exhaustive matrix). Real Postgres, no mocks
// (the project rule). These lock the DATA layer the 6.10.4 service composes
// over: the org + membership round-trips, the (organizationId, userId)
// uniqueness, the Workspace.organizationId relation in both directions, and
// the required-`tx` write contract (a write is bound to its transaction, so a
// rollback un-does it).
//
// These run as the default `prodect` (superuser) role, which bypasses RLS — the
// RLS-policy enforcement is covered separately in organization-rls.test.ts.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('organizationRepository', () => {
  it('create + findById + findBySlug round-trip an organization', async () => {
    const created = await db.$transaction((tx) =>
      organizationRepository.create({ name: 'Acme Inc', slug: 'acme-inc' }, tx),
    );
    expect(created.id).toBeTruthy();
    expect(created.name).toBe('Acme Inc');
    expect(created.slug).toBe('acme-inc');

    const byId = await organizationRepository.findById(created.id);
    expect(byId).not.toBeNull();
    expect(byId!.slug).toBe('acme-inc');

    const bySlug = await organizationRepository.findBySlug('acme-inc');
    expect(bySlug).not.toBeNull();
    expect(bySlug!.id).toBe(created.id);

    // Misses return null, never throw.
    expect(await organizationRepository.findById('nope')).toBeNull();
    expect(await organizationRepository.findBySlug('nope')).toBeNull();
  });

  it('enforces the unique organization.slug (a second create on the same slug is a P2002)', async () => {
    await db.$transaction((tx) =>
      organizationRepository.create({ name: 'Acme', slug: 'dup-slug' }, tx),
    );
    await expect(
      db.$transaction((tx) =>
        organizationRepository.create({ name: 'Other', slug: 'dup-slug' }, tx),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('update changes the name', async () => {
    const org = await db.$transaction((tx) =>
      organizationRepository.create({ name: 'Before', slug: 'rename-me' }, tx),
    );
    const updated = await db.$transaction((tx) =>
      organizationRepository.update(org.id, { name: 'After' }, tx),
    );
    expect(updated.name).toBe('After');
    expect((await organizationRepository.findById(org.id))!.name).toBe('After');
  });

  it('binds the write to its transaction — a rolled-back create leaves no row', async () => {
    const ROLLBACK = new Error('rollback sentinel');
    let id: string | undefined;
    await expect(
      db.$transaction(async (tx) => {
        const org = await organizationRepository.create({ name: 'Ghost', slug: 'ghost-org' }, tx);
        id = org.id;
        // The row is visible to this transaction…
        expect(await tx.organization.findUnique({ where: { id: org.id } })).not.toBeNull();
        // …then we abort, so it must never have committed.
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);

    expect(id).toBeTruthy();
    expect(await organizationRepository.findById(id!)).toBeNull();
    expect(await organizationRepository.findBySlug('ghost-org')).toBeNull();
  });
});

describe('organizationMembershipRepository', () => {
  it('create + findByOrgAndUser round-trip a membership, and the role defaults are honoured', async () => {
    const user = await createTestUser();
    const org = await db.$transaction((tx) =>
      organizationRepository.create({ name: 'Acme', slug: 'm-roundtrip' }, tx),
    );

    const membership = await db.$transaction((tx) =>
      organizationMembershipRepository.create(
        { organizationId: org.id, userId: user.id, role: 'admin' },
        tx,
      ),
    );
    expect(membership.role).toBe('admin');

    const found = await organizationMembershipRepository.findByOrgAndUser(org.id, user.id);
    expect(found).not.toBeNull();
    expect(found!.role).toBe('admin');

    // A different (org, user) pair is absent.
    expect(await organizationMembershipRepository.findByOrgAndUser(org.id, 'someone')).toBeNull();
  });

  it('enforces the (organizationId, userId) uniqueness (a duplicate membership is a P2002)', async () => {
    const user = await createTestUser();
    const org = await db.$transaction((tx) =>
      organizationRepository.create({ name: 'Acme', slug: 'm-unique' }, tx),
    );
    await db.$transaction((tx) =>
      organizationMembershipRepository.create(
        { organizationId: org.id, userId: user.id, role: 'member' },
        tx,
      ),
    );
    await expect(
      db.$transaction((tx) =>
        organizationMembershipRepository.create(
          { organizationId: org.id, userId: user.id, role: 'owner' },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('updateRole and deleteByOrgAndUser mutate the row; delete of an absent row is a no-op (null)', async () => {
    const user = await createTestUser();
    const org = await db.$transaction((tx) =>
      organizationRepository.create({ name: 'Acme', slug: 'm-mutate' }, tx),
    );
    await db.$transaction((tx) =>
      organizationMembershipRepository.create(
        { organizationId: org.id, userId: user.id, role: 'member' },
        tx,
      ),
    );

    const promoted = await db.$transaction((tx) =>
      organizationMembershipRepository.updateRole(org.id, user.id, 'owner', tx),
    );
    expect(promoted.role).toBe('owner');

    const deleted = await db.$transaction((tx) =>
      organizationMembershipRepository.deleteByOrgAndUser(org.id, user.id, tx),
    );
    expect(deleted).not.toBeNull();
    expect(await organizationMembershipRepository.findByOrgAndUser(org.id, user.id)).toBeNull();

    // Deleting an already-gone row returns null rather than throwing (the
    // remove flow leans on this idempotency).
    const again = await db.$transaction((tx) =>
      organizationMembershipRepository.deleteByOrgAndUser(org.id, user.id, tx),
    );
    expect(again).toBeNull();
  });

  it('findOrganizationsByUser returns the empty array for a user in no org (the empty-input branch)', async () => {
    const user = await createTestUser();
    expect(await organizationMembershipRepository.findOrganizationsByUser(user.id)).toEqual([]);
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
    const wsWithOrg = await db.workspace.findUniqueOrThrow({
      where: { id: workspace.id },
      include: { organization: true },
    });
    expect(wsWithOrg.organizationId).toBeTruthy();
    expect(wsWithOrg.organization.id).toBe(wsWithOrg.organizationId);

    // organization → workspaces (the back-relation)
    const orgWithWs = await db.organization.findUniqueOrThrow({
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
    const orgId = (await db.workspace.findUniqueOrThrow({ where: { id: w1.id } })).organizationId;
    const { workspace: w2 } = await workspacesService.createWorkspace({
      name: 'Beta',
      ownerUserId: owner.id,
      organizationId: orgId,
    });

    const org = await db.organization.findUniqueOrThrow({
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
    const orgId = (await db.workspace.findUniqueOrThrow({ where: { id: workspace.id } }))
      .organizationId;

    // The FK is ON DELETE CASCADE both ways (org → workspace, org → membership).
    await db.$transaction((tx) => tx.organization.delete({ where: { id: orgId } }));

    expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
    expect(await db.organizationMembership.count({ where: { organizationId: orgId } })).toBe(0);
  });
});
