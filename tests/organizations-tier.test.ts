import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { organizationsService } from '@/lib/services/organizationsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { AlreadyOrgMemberError, LastOrgOwnerError } from '@/lib/organizations/errors';
import { createTestUser } from './fixtures/userFixtures';
import { truncateAuthTables } from './helpers/db';

// The exhaustive org-tier matrix (Story 6.10 · Subtask 6.10.7). Picks up the
// gating + membership-direction + concurrency + backfill cases the 6.10.4 suite
// (organizations-service.test.ts) deliberately left to this subtask. Real
// Postgres, no mocks. The model round-trips live in
// organizations-repository.test.ts; the RLS-policy assertions in
// organization-rls.test.ts.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function orgIdOfWorkspace(workspaceId: string): Promise<string> {
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  return ws.organizationId;
}

// Count workspaces with a NULL organizationId via raw SQL — the Prisma client
// types the column as non-nullable (its at-rest shape), so `{ organizationId:
// null }` is rejected at the validation layer even when the backfill test has
// transiently dropped the NOT NULL.
async function nullOrgWorkspaceCount(client: {
  $queryRawUnsafe: (sql: string) => Promise<{ count: number }[]>;
}): Promise<number> {
  const rows = await client.$queryRawUnsafe(
    'SELECT count(*)::int AS count FROM "workspace" WHERE "organizationId" IS NULL',
  );
  return rows[0]?.count ?? 0;
}

describe('access gating — the membership-direction asymmetry (6.10.2 §5)', () => {
  it('removing a user from the ORG revokes access to EVERY workspace under it', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const { workspace: w1 } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(w1.id);
    const { workspace: w2 } = await workspacesService.createWorkspace({
      name: 'Beta',
      ownerUserId: owner.id,
      organizationId: orgId,
    });
    // member joins BOTH workspaces (each upward-auto-joins them to the org).
    await workspacesService.addMember({ userId: member.id, workspaceId: w1.id });
    await workspacesService.addMember({ userId: member.id, workspaceId: w2.id });
    // Sanity: they can reach both before the org-removal.
    expect(await organizationsService.resolveWorkspaceAccess(member.id, w1.id)).not.toBeNull();
    expect(await organizationsService.resolveWorkspaceAccess(member.id, w2.id)).not.toBeNull();

    await organizationsService.removeMember({
      organizationId: orgId,
      userId: member.id,
      actorUserId: owner.id,
    });

    // Org membership gates workspace access → BOTH workspaces are now denied,
    // even though the workspace_membership rows remain.
    expect(await organizationsService.resolveWorkspaceAccess(member.id, w1.id)).toBeNull();
    expect(await organizationsService.resolveWorkspaceAccess(member.id, w2.id)).toBeNull();
    expect(
      await workspaceMembershipRepository.findByUserAndWorkspace(member.id, w1.id),
    ).not.toBeNull();
    expect(
      await workspaceMembershipRepository.findByUserAndWorkspace(member.id, w2.id),
    ).not.toBeNull();
  });

  it('removing a user from a WORKSPACE leaves their org membership (and other-workspace access) intact', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const { workspace: w1 } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(w1.id);
    const { workspace: w2 } = await workspacesService.createWorkspace({
      name: 'Beta',
      ownerUserId: owner.id,
      organizationId: orgId,
    });
    await workspacesService.addMember({ userId: member.id, workspaceId: w1.id });
    await workspacesService.addMember({ userId: member.id, workspaceId: w2.id });

    // Leave w1 (w1 still has the owner, so this isn't the last-member case).
    await workspacesService.removeMember({ userId: member.id, workspaceId: w1.id });

    // The org membership is untouched (leaving a workspace ≠ leaving the org).
    expect(
      await organizationMembershipRepository.findByOrgAndUser(orgId, member.id),
    ).not.toBeNull();
    // w1 is now denied (no workspace membership, plain org member), but w2 still works.
    expect(await organizationsService.resolveWorkspaceAccess(member.id, w1.id)).toBeNull();
    expect(await organizationsService.resolveWorkspaceAccess(member.id, w2.id)).not.toBeNull();
  });
});

describe('membership management — idempotency + the upward auto-join', () => {
  it('removeMember on a non-member is an idempotent no-op (no throw)', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(workspace.id);

    // stranger was never a member — removing them must not throw.
    await expect(
      organizationsService.removeMember({
        organizationId: orgId,
        userId: stranger.id,
        actorUserId: owner.id,
      }),
    ).resolves.toBeUndefined();
  });

  it('a plain member can remove THEMSELVES (self-leave) without being an admin', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(workspace.id);
    await organizationsService.addMember({
      organizationId: orgId,
      userId: member.id,
      role: 'member',
      actorUserId: owner.id,
    });

    await organizationsService.removeMember({
      organizationId: orgId,
      userId: member.id,
      actorUserId: member.id, // self-leave
    });
    expect(await organizationMembershipRepository.findByOrgAndUser(orgId, member.id)).toBeNull();
  });

  it('changeMemberRole promotes a member to admin (the happy path)', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(workspace.id);
    await organizationsService.addMember({
      organizationId: orgId,
      userId: member.id,
      role: 'member',
      actorUserId: owner.id,
    });

    await organizationsService.changeMemberRole({
      organizationId: orgId,
      userId: member.id,
      role: 'admin',
      actorUserId: owner.id,
    });
    expect((await organizationMembershipRepository.findByOrgAndUser(orgId, member.id))!.role).toBe(
      'admin',
    );
  });

  it('ensureOrgMembership is a no-op when the user is already a member (does NOT downgrade their role)', async () => {
    const owner = await createTestUser();
    const admin = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(workspace.id);
    await organizationsService.addMember({
      organizationId: orgId,
      userId: admin.id,
      role: 'admin',
      actorUserId: owner.id,
    });

    // The upward auto-join must not clobber the existing 'admin' to 'member'.
    await db.$transaction((tx) => organizationsService.ensureOrgMembership(admin.id, orgId, tx));
    const m = await organizationMembershipRepository.findByOrgAndUser(orgId, admin.id);
    expect(m!.role).toBe('admin');
    expect(
      await db.organizationMembership.count({ where: { organizationId: orgId, userId: admin.id } }),
    ).toBe(1);
  });
});

describe('cross-workspace roster — at-scale + org-only members', () => {
  it('an org-only member (in zero workspaces) appears in the roster with an empty workspaces[]', async () => {
    const owner = await createTestUser();
    const billing = await createTestUser({ name: 'Billing Admin' });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(workspace.id);
    await organizationsService.addMember({
      organizationId: orgId,
      userId: billing.id,
      role: 'admin',
      actorUserId: owner.id,
    });

    const page = await organizationsService.listMembers({
      organizationId: orgId,
      actorUserId: owner.id,
    });
    const row = page.members.find((m) => m.userId === billing.id);
    expect(row).toBeDefined();
    expect(row!.role).toBe('admin');
    expect(row!.workspaces).toEqual([]); // org-only, no workspace memberships
    // The owner, by contrast, carries their workspace.
    const ownerRow = page.members.find((m) => m.userId === owner.id);
    expect(ownerRow!.workspaces.map((w) => w.name)).toContain('Acme');
  });

  it('clamps the page limit to the at-scale ceiling (an over-large limit cannot defeat pagination)', async () => {
    const owner = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(workspace.id);

    // limit 9999 is clamped to ROSTER_MAX_LIMIT (100); with one member there's
    // no next page — the point is the call succeeds + returns a single page.
    const page = await organizationsService.listMembers({
      organizationId: orgId,
      actorUserId: owner.id,
      limit: 9999,
    });
    expect(page.total).toBe(1);
    expect(page.nextCursor).toBeNull();
  });
});

// NOTE on the last-owner guard under TRUE concurrency: writing this suite
// surfaced a pre-existing race in the shipped 6.10.4 service. `removeMember` /
// `changeMemberRole` guard the last owner by reading `countOwnersByOrg` (a plain
// COUNT, no SELECT ... FOR UPDATE) inside a default-isolation (READ COMMITTED)
// `withOrgContext`. Two concurrent removals of the TWO owners of a 2-owner org
// both observe count = 2, both pass the guard, and both delete → the org drops
// to ZERO owners (reproduced deterministically once the connection pool is
// warm: owners = 0). That is a real lost-update bug, NOT something this
// test-only subtask should fix or assert as a flaky red — it is logged as a bug
// work item in the seed and called out in the PR body (the pre-existing-bug
// protocol, CLAUDE.md § "A failed test … is DEBUGGED"). The deterministic,
// genuinely-protected concurrency guarantees (the unique-constraint races) are
// locked below; the last-owner concurrency case lands a regression test with
// its fix.
describe('concurrency — unique-constraint races (the deterministic guarantees)', () => {
  it('two concurrent identical addMember calls yield exactly one membership + one AlreadyOrgMemberError', async () => {
    const owner = await createTestUser();
    const u = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(workspace.id);

    const results = await Promise.allSettled([
      organizationsService.addMember({
        organizationId: orgId,
        userId: u.id,
        role: 'member',
        actorUserId: owner.id,
      }),
      organizationsService.addMember({
        organizationId: orgId,
        userId: u.id,
        role: 'member',
        actorUserId: owner.id,
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(AlreadyOrgMemberError);
    // The unique (organizationId, userId) index left exactly one row.
    expect(
      await db.organizationMembership.count({ where: { organizationId: orgId, userId: u.id } }),
    ).toBe(1);
  });

  it('concurrent ensureOrgMembership calls leave exactly one row (the upward-auto-join race is swallowed)', async () => {
    const owner = await createTestUser();
    const u = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(workspace.id);

    // Two independent transactions both racing to auto-join the same user.
    const results = await Promise.allSettled([
      db.$transaction((tx) => organizationsService.ensureOrgMembership(u.id, orgId, tx)),
      db.$transaction((tx) => organizationsService.ensureOrgMembership(u.id, orgId, tx)),
    ]);
    // Neither rejects (the duplicate-insert race is swallowed to a no-op).
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(
      await db.organizationMembership.count({ where: { organizationId: orgId, userId: u.id } }),
    ).toBe(1);
  });

  it('the last-owner guard holds against a SEQUENTIAL second removal (the single-actor path)', async () => {
    // The sequential guard works (the concurrent two-owner case is the logged
    // bug — see the note above this describe). After one owner is removed, the
    // remaining sole owner cannot be removed.
    const a = await createTestUser();
    const b = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: a.id,
    });
    const orgId = await orgIdOfWorkspace(workspace.id);
    await organizationsService.addMember({
      organizationId: orgId,
      userId: b.id,
      role: 'owner',
      actorUserId: a.id,
    });

    await organizationsService.removeMember({
      organizationId: orgId,
      userId: a.id,
      actorUserId: a.id,
    });
    await expect(
      organizationsService.removeMember({ organizationId: orgId, userId: b.id, actorUserId: b.id }),
    ).rejects.toBeInstanceOf(LastOrgOwnerError);
    expect(
      await db.organizationMembership.count({ where: { organizationId: orgId, role: 'owner' } }),
    ).toBe(1);
  });
});

// ── The migration's data BACKFILL (6.10.3) ──────────────────────────────────
//
// The final schema makes workspace.organizationId NON-nullable, so legacy
// "pre-org" workspaces can't exist at rest. To exercise the migration's
// backfill we reconstruct that legacy state and run the backfill's exact SQL
// inside ONE transaction that we ROLL BACK — the DROP NOT NULL and every row
// change revert when the sentinel throws, so the shared dev schema is left
// pristine even if an assertion fails. This is the standard way to test a
// data-migration step against the live, already-migrated schema.

const BACKFILL_SQL: string[] = [
  // 1 — one default org per still-unassigned workspace, reusing its unique slug.
  `INSERT INTO "organization" ("id", "name", "slug", "createdAt", "updatedAt")
   SELECT gen_random_uuid()::text, w."name", w."slug", w."createdAt", CURRENT_TIMESTAMP
   FROM "workspace" w WHERE w."organizationId" IS NULL`,
  // 2 — point each workspace at its new org (matched on the shared unique slug).
  `UPDATE "workspace" w SET "organizationId" = o."id"
   FROM "organization" o WHERE o."slug" = w."slug" AND w."organizationId" IS NULL`,
  // 3 — upward invariant: every workspace member becomes an org member
  // (owner→owner, else member). ON CONFLICT DO NOTHING makes it idempotent.
  `INSERT INTO "organization_membership" ("id", "organizationId", "userId", "role", "createdAt", "updatedAt")
   SELECT gen_random_uuid()::text, w."organizationId", wm."userId",
          (CASE WHEN wm."role" = 'owner' THEN 'owner' ELSE 'member' END)::"organization_role",
          wm."createdAt", CURRENT_TIMESTAMP
   FROM "workspace_membership" wm
   JOIN "workspace" w ON w."id" = wm."workspaceId"
   WHERE w."organizationId" IS NOT NULL
   ON CONFLICT ("organizationId", "userId") DO NOTHING`,
  // 4 — guarantee every org has an owner (promote the earliest member if none).
  `UPDATE "organization_membership" om SET "role" = 'owner'
   WHERE om."id" IN (
     SELECT DISTINCT ON (m."organizationId") m."id" FROM "organization_membership" m
     WHERE NOT EXISTS (
       SELECT 1 FROM "organization_membership" owner_m
       WHERE owner_m."organizationId" = m."organizationId" AND owner_m."role" = 'owner')
     ORDER BY m."organizationId", m."createdAt" ASC, m."id" ASC)`,
];

class RollbackSignal extends Error {}

describe('migration backfill (6.10.3) — one default org per workspace, idempotent', () => {
  it('backfills pre-org workspaces into one owner-having org each, then is a no-op on re-run', async () => {
    // Seed two workspaces (in two orgs) via the service, with an extra member
    // in the first — the rows the backfill will be made to "forget" their orgs.
    const owner1 = await createTestUser({ name: 'Owner One' });
    const owner2 = await createTestUser({ name: 'Owner Two' });
    const member = await createTestUser({ name: 'Member' });
    const { workspace: w1 } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner1.id,
    });
    // A second workspace/org so the backfill must mint one per workspace.
    await workspacesService.createWorkspace({ name: 'Beta', ownerUserId: owner2.id });
    await workspacesService.addMember({ userId: member.id, workspaceId: w1.id });

    const w1Slug = (await db.workspace.findUniqueOrThrow({ where: { id: w1.id } })).slug;

    try {
      await db.$transaction(
        async (tx) => {
          // Reconstruct the legacy pre-org state: drop the NOT NULL, null every
          // workspace's org, then delete the orgs (org_membership cascades).
          await tx.$executeRawUnsafe(
            'ALTER TABLE "workspace" ALTER COLUMN "organizationId" DROP NOT NULL',
          );
          await tx.$executeRawUnsafe('UPDATE "workspace" SET "organizationId" = NULL');
          await tx.$executeRawUnsafe('DELETE FROM "organization"');
          expect(await tx.organization.count()).toBe(0);
          expect(await tx.organizationMembership.count()).toBe(0);

          // Run the backfill.
          for (const sql of BACKFILL_SQL) await tx.$executeRawUnsafe(sql);

          // Exactly one org per workspace, every workspace pointed at one.
          const wsCount = await tx.workspace.count();
          expect(await tx.organization.count()).toBe(wsCount);
          expect(await nullOrgWorkspaceCount(tx)).toBe(0);

          // w1's org reuses w1's slug + name; its members are backfilled
          // owner→owner, member→member.
          const org1 = await tx.organization.findUniqueOrThrow({ where: { slug: w1Slug } });
          expect(org1.name).toBe('Acme');
          const m1 = await tx.organizationMembership.findMany({
            where: { organizationId: org1.id },
          });
          const roleByUser = new Map(m1.map((r) => [r.userId, r.role]));
          expect(roleByUser.get(owner1.id)).toBe('owner');
          expect(roleByUser.get(member.id)).toBe('member');

          // Every org has exactly one owner (step 4 invariant).
          const orgs = await tx.organization.findMany();
          for (const o of orgs) {
            const owners = await tx.organizationMembership.count({
              where: { organizationId: o.id, role: 'owner' },
            });
            expect(owners).toBe(1);
          }

          // Idempotency: re-running the backfill creates no new orgs/memberships.
          const orgsBefore = await tx.organization.count();
          const membersBefore = await tx.organizationMembership.count();
          for (const sql of BACKFILL_SQL) await tx.$executeRawUnsafe(sql);
          expect(await tx.organization.count()).toBe(orgsBefore);
          expect(await tx.organizationMembership.count()).toBe(membersBefore);

          throw new RollbackSignal();
        },
        { timeout: 20000 },
      );
    } catch (err) {
      if (!(err instanceof RollbackSignal)) throw err;
    }

    // After rollback the original service-created orgs are back and the NOT NULL
    // is restored (the schema is pristine for sibling tests).
    expect(await nullOrgWorkspaceCount(db)).toBe(0);
    expect(
      await organizationMembershipRepository.findByOrgAndUser(
        await orgIdOfWorkspace(w1.id),
        owner1.id,
      ),
    ).not.toBeNull();
  });
});
