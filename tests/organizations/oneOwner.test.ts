import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminDb } from '../helpers/adminDb';

// MOTIR-6307 — exactly one Owner per organization (`docs/decisions/role-model.md`
// §1). Four layers, each pinned here against the real database:
//   1. the data migration that consolidates today's owners, and the partial
//      unique index it creates;
//   2. the service refusals — no member path makes, demotes or removes the Owner;
//   3. the PATCH route's validation;
//   4. the race the index exists for — two writers promoting different members
//      in one organization at once.
//
// The one boundary mock is the post-commit seat-sync ENQUEUE that org-membership
// writes fire (as in every org-membership suite); the compliance gate is stubbed
// for the route cases because a route test has no cookie jar.
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));
const { requireCompliantSession } = vi.hoisted(() => ({ requireCompliantSession: vi.fn() }));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantSession }));

const { db } = await import('@/lib/db');
const { organizationsService, writeMembershipRole } =
  await import('@/lib/services/organizationsService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { withOrgContext } = await import('@/lib/organizations/context');
const { createTestUser } = await import('../fixtures/userFixtures');
const { truncateAuthTables } = await import('../helpers/db');
const { OwnerMembershipLockedError, OwnerOnlyByTransferError } =
  await import('@/lib/organizations/errors');
const { PATCH } = await import('@/app/api/organizations/[orgId]/members/[userId]/route');

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'prisma/migrations/20260925120000_one_org_owner/migration.sql'),
  'utf8',
);
const INDEX_NAME = 'organization_membership_one_owner_key';

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
  return { organizationId, owner, admin, member };
}

async function roleOf(organizationId: string, userId: string) {
  const row = await adminDb.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  return row?.role ?? null;
}

async function ownerCount(organizationId: string) {
  return adminDb.organizationMembership.count({ where: { organizationId, role: 'owner' } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the migration — consolidates owners, then holds "at most one" with an index', () => {
  it('leaves exactly one owner in every organization: three owners → the earliest, none → the earliest member, one → untouched; and it is idempotent', async () => {
    // Reconstruct the pre-migration world: the index is what forbids two owners,
    // so it has to be absent while the fixture is seeded. Restored in `finally`
    // whatever happens, so no sibling file in this worker database sees it gone.
    await adminDb.$executeRawUnsafe(`DROP INDEX IF EXISTS "${INDEX_NAME}"`);
    try {
      // Org 1 — three owners. The founder (earliest membership) must be kept.
      const three = await makeOrgWithRoles();
      await adminDb.organizationMembership.updateMany({
        where: {
          organizationId: three.organizationId,
          userId: { in: [three.admin.id, three.member.id] },
        },
        data: { role: 'owner' },
      });
      expect(await ownerCount(three.organizationId)).toBe(3);

      // Org 2 — members but no owner. The earliest member becomes owner.
      const none = await makeOrgWithRoles();
      await adminDb.organizationMembership.update({
        where: {
          organizationId_userId: { organizationId: none.organizationId, userId: none.owner.id },
        },
        data: { role: 'admin' },
      });
      expect(await ownerCount(none.organizationId)).toBe(0);

      // Org 3 — already correct. Nothing may change.
      const right = await makeOrgWithRoles();
      const before = await adminDb.organizationMembership.findMany({
        where: { organizationId: right.organizationId },
        orderBy: { id: 'asc' },
      });

      await adminDb.$executeRawUnsafe(MIGRATION_SQL);

      const offenders = await adminDb.$queryRawUnsafe<Array<{ organizationId: string }>>(
        `SELECT "organizationId" FROM "organization_membership"
          GROUP BY 1 HAVING count(*) FILTER (WHERE "role" = 'owner') <> 1`,
      );
      expect(offenders).toEqual([]);

      expect(await roleOf(three.organizationId, three.owner.id)).toBe('owner');
      expect(await roleOf(three.organizationId, three.admin.id)).toBe('admin');
      expect(await roleOf(three.organizationId, three.member.id)).toBe('admin');
      expect(await roleOf(none.organizationId, none.owner.id)).toBe('owner');
      expect(
        await adminDb.organizationMembership.findMany({
          where: { organizationId: right.organizationId },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(before);

      const index = await adminDb.$queryRawUnsafe<Array<{ indexdef: string }>>(
        `SELECT indexdef FROM pg_indexes WHERE indexname = '${INDEX_NAME}'`,
      );
      expect(index).toHaveLength(1);
      expect(index[0]!.indexdef).toMatch(/UNIQUE INDEX/);
      expect(index[0]!.indexdef).toMatch(/\("organizationId", role\)/);
      expect(index[0]!.indexdef).toMatch(/WHERE \(role = 'owner'/);

      // Idempotent: a second run changes nothing and raises nothing.
      const snapshot = await adminDb.organizationMembership.findMany({ orderBy: { id: 'asc' } });
      await adminDb.$executeRawUnsafe(MIGRATION_SQL);
      expect(await adminDb.organizationMembership.findMany({ orderBy: { id: 'asc' } })).toEqual(
        snapshot,
      );
    } finally {
      await adminDb.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${INDEX_NAME}" ON "organization_membership" ("organizationId", "role") WHERE "role" = 'owner'`,
      );
    }
  });

  it('the index refuses a second owner row outright', async () => {
    const { organizationId, admin } = await makeOrgWithRoles();
    await expect(
      adminDb.organizationMembership.update({
        where: { organizationId_userId: { organizationId, userId: admin.id } },
        data: { role: 'owner' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await ownerCount(organizationId)).toBe(1);
  });
});

describe('no member path makes someone the Owner — OwnerOnlyByTransferError (409)', () => {
  for (const actorRole of ['owner', 'admin'] as const) {
    it(`addMember with role owner, the ${actorRole} acting`, async () => {
      const org = await makeOrgWithRoles();
      const newcomer = await createTestUser();
      await expect(
        organizationsService.addMember({
          organizationId: org.organizationId,
          userId: newcomer.id,
          role: 'owner',
          actorUserId: org[actorRole].id,
        }),
      ).rejects.toBeInstanceOf(OwnerOnlyByTransferError);
      expect(await roleOf(org.organizationId, newcomer.id)).toBeNull();
      expect(await ownerCount(org.organizationId)).toBe(1);
    });

    it(`addMemberByEmail with role owner, the ${actorRole} acting`, async () => {
      const org = await makeOrgWithRoles();
      const newcomer = await createTestUser();
      await expect(
        organizationsService.addMemberByEmail({
          organizationId: org.organizationId,
          email: newcomer.email,
          role: 'owner',
          actorUserId: org[actorRole].id,
        }),
      ).rejects.toBeInstanceOf(OwnerOnlyByTransferError);
      expect(await roleOf(org.organizationId, newcomer.id)).toBeNull();
    });

    it(`changeMemberRole to owner, the ${actorRole} acting`, async () => {
      const org = await makeOrgWithRoles();
      await expect(
        organizationsService.changeMemberRole({
          organizationId: org.organizationId,
          userId: org.member.id,
          role: 'owner',
          actorUserId: org[actorRole].id,
        }),
      ).rejects.toBeInstanceOf(OwnerOnlyByTransferError);
      expect(await roleOf(org.organizationId, org.member.id)).toBe('member');
      expect(await ownerCount(org.organizationId)).toBe(1);
    });
  }
});

describe("the Owner's membership is locked — OwnerMembershipLockedError (409)", () => {
  for (const actorRole of ['owner', 'admin'] as const) {
    it(`refuses demoting the Owner, the ${actorRole} acting`, async () => {
      const org = await makeOrgWithRoles();
      for (const role of ['admin', 'member'] as const) {
        await expect(
          organizationsService.changeMemberRole({
            organizationId: org.organizationId,
            userId: org.owner.id,
            role,
            actorUserId: org[actorRole].id,
          }),
        ).rejects.toBeInstanceOf(OwnerMembershipLockedError);
      }
      expect(await roleOf(org.organizationId, org.owner.id)).toBe('owner');
    });

    it(`refuses removing the Owner, the ${actorRole} acting`, async () => {
      const org = await makeOrgWithRoles();
      await expect(
        organizationsService.removeMember({
          organizationId: org.organizationId,
          userId: org.owner.id,
          actorUserId: org[actorRole].id,
        }),
      ).rejects.toBeInstanceOf(OwnerMembershipLockedError);
      expect(await roleOf(org.organizationId, org.owner.id)).toBe('owner');
    });
  }

  it('still lets an Admin move others between Admin and Member, and remove them', async () => {
    const org = await makeOrgWithRoles();
    await organizationsService.changeMemberRole({
      organizationId: org.organizationId,
      userId: org.member.id,
      role: 'admin',
      actorUserId: org.admin.id,
    });
    expect(await roleOf(org.organizationId, org.member.id)).toBe('admin');
    await organizationsService.removeMember({
      organizationId: org.organizationId,
      userId: org.member.id,
      actorUserId: org.admin.id,
    });
    expect(await roleOf(org.organizationId, org.member.id)).toBeNull();
  });

  it('still lets a non-Owner leave on their own', async () => {
    const org = await makeOrgWithRoles();
    await organizationsService.removeMember({
      organizationId: org.organizationId,
      userId: org.admin.id,
      actorUserId: org.admin.id,
    });
    expect(await roleOf(org.organizationId, org.admin.id)).toBeNull();
  });
});

describe('PATCH /api/organizations/[orgId]/members/[userId]', () => {
  function signInAs(user: { id: string; email: string }) {
    requireCompliantSession.mockResolvedValue({
      ok: true,
      session: { user: { id: user.id, email: user.email } },
    });
  }
  function patch(orgId: string, userId: string, body: unknown) {
    return PATCH(
      new Request(`http://localhost:3000/api/organizations/${orgId}/members/${userId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ orgId, userId }) },
    );
  }

  it('rejects role owner at validation (400) — the service is never asked', async () => {
    const org = await makeOrgWithRoles();
    signInAs(org.owner);
    const res = await patch(org.organizationId, org.member.id, { role: 'owner' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
    expect(await roleOf(org.organizationId, org.member.id)).toBe('member');
  });

  it("maps a change to the Owner's row to 409 ORG_OWNER_MEMBERSHIP_LOCKED", async () => {
    const org = await makeOrgWithRoles();
    signInAs(org.admin);
    const res = await patch(org.organizationId, org.owner.id, { role: 'member' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ORG_OWNER_MEMBERSHIP_LOCKED' });
  });

  it('still changes a member between Admin and Member', async () => {
    const org = await makeOrgWithRoles();
    signInAs(org.admin);
    const res = await patch(org.organizationId, org.member.id, { role: 'admin' });
    expect(res.status).toBe(200);
    expect(await roleOf(org.organizationId, org.member.id)).toBe('admin');
  });
});

describe('concurrency — two writers race for the one owner row', () => {
  // Warm the pool so the two transactions really run on two connections and
  // overlap; a cold pool can serialize them and hide the race.
  async function warmPool(n = 6): Promise<void> {
    await Promise.all(Array.from({ length: n }, () => db.$queryRaw`SELECT 1`));
  }

  it('exactly one promotion commits; the loser gets the typed 409, never a 500 and never two owners', async () => {
    const org = await makeOrgWithRoles();
    // Free the owner slot the way no member path can (the index guards "at most
    // one"; "at least one" is the services'), so both writers target an empty slot
    // and ONLY the index stands between them and two owners.
    await adminDb.organizationMembership.update({
      where: {
        organizationId_userId: { organizationId: org.organizationId, userId: org.owner.id },
      },
      data: { role: 'admin' },
    });
    await warmPool();

    const promote = (userId: string) =>
      withOrgContext({ userId, organizationId: org.organizationId }, async (tx) => {
        await writeMembershipRole(org.organizationId, userId, 'owner', tx);
        // Hold the transaction open so the other writer's UPDATE reaches the
        // unique index while this one is uncommitted — it then blocks on it,
        // and fails when this commits.
        await tx.$executeRawUnsafe('SELECT pg_sleep(0.3)');
      });

    const results = await Promise.allSettled([promote(org.admin.id), promote(org.member.id)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(OwnerOnlyByTransferError);
    expect(await ownerCount(org.organizationId)).toBe(1);
  });
});
