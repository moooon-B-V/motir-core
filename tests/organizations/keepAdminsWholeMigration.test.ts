import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminDb } from '../helpers/adminDb';

// The MOTIR-6308 keep-whole data migration
// (`20260925130000_keep_org_admins_workspace_reach`): every pre-existing org
// Admin gets an `admin` workspace membership in each workspace of their org they
// lacked one in, so narrowing the Admin's reach to membership takes nothing away
// from anyone who had it. The SQL is re-applied here against seeded rows (the
// migrated test database had none when `migrate deploy` ran it).
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));

const { workspacesService } = await import('@/lib/services/workspacesService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { truncateAuthTables } = await import('../helpers/db');

const MIGRATION = readFileSync(
  path.join(
    process.cwd(),
    'prisma/migrations/20260925130000_keep_org_admins_workspace_reach/migration.sql',
  ),
  'utf8',
);

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await adminDb.$disconnect();
});

async function membershipsOf(userId: string) {
  const rows = await adminDb.workspaceMembership.findMany({
    where: { userId },
    select: { workspaceId: true, role: true },
  });
  return new Map(rows.map((r) => [r.workspaceId, r.role]));
}

describe('keep_org_admins_workspace_reach', () => {
  it('gives an Admin in 1 of 3 workspaces an `admin` membership in the other 2, and a re-run creates nothing', async () => {
    const owner = await createTestUser();
    const admin = await createTestUser();
    const member = await createTestUser();
    const { workspace: w1 } = await workspacesService.createWorkspace({
      name: 'One',
      ownerUserId: owner.id,
    });
    const organizationId = (await adminDb.workspace.findUniqueOrThrow({ where: { id: w1.id } }))
      .organizationId;
    const { workspace: w2 } = await workspacesService.createWorkspace({
      name: 'Two',
      ownerUserId: owner.id,
      organizationId,
    });
    const { workspace: w3 } = await workspacesService.createWorkspace({
      name: 'Three',
      ownerUserId: owner.id,
      organizationId,
    });
    await organizationsService.addMember({
      organizationId,
      userId: admin.id,
      role: 'admin',
      actorUserId: owner.id,
    });
    // The Admin is already a plain MEMBER of w1 — that row must be left as it is.
    await workspacesService.addMember({ userId: admin.id, workspaceId: w1.id, role: 'member' });
    // A plain org member in w1 only — not an Admin, so the migration gives them nothing.
    await workspacesService.addMember({ userId: member.id, workspaceId: w1.id, role: 'member' });
    const ownerBefore = await membershipsOf(owner.id);

    await adminDb.$executeRawUnsafe(MIGRATION);

    const adminRows = await membershipsOf(admin.id);
    expect(Object.fromEntries(adminRows)).toEqual({
      [w1.id]: 'member',
      [w2.id]: 'admin',
      [w3.id]: 'admin',
    });
    expect(Object.fromEntries(await membershipsOf(member.id))).toEqual({ [w1.id]: 'member' });
    expect(await membershipsOf(owner.id)).toEqual(ownerBefore);

    // Idempotent: a second run inserts nothing.
    const before = await adminDb.workspaceMembership.count();
    await adminDb.$executeRawUnsafe(MIGRATION);
    expect(await adminDb.workspaceMembership.count()).toBe(before);

    // And the kept rows are what the membership-based gate now reads.
    for (const ws of [w2, w3]) {
      expect(
        (await organizationsService.resolveWorkspaceAccess(admin.id, ws.id))?.effectiveRole,
      ).toBe('admin');
    }
  });
});
