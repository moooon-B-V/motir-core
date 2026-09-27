import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  relaxWorkspaceRoleNotNull,
  restoreWorkspaceRoleNotNull,
  runMigrationFile,
  user,
} from './_workspaceRoleTenant';

// MOTIR-6561's migration (Story MOTIR-6469, Release A): any row still NULL is
// backfilled from the legacy `role` by the DECISION's table, and then the
// column is NOT NULL. Run exactly as `prisma migrate deploy` runs it.

const NOT_NULL = '20260927090000_workspace_role_not_null';

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(restoreWorkspaceRoleNotNull);

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function workspace() {
  const n = Math.random().toString(36).slice(2, 8);
  const org = await adminDb.organization.create({
    data: { name: `Org nn${n}`, slug: `nn-org-${n}` },
  });
  return adminDb.workspace.create({
    data: { name: `WS nn${n}`, slug: `nn-ws-${n}`, organizationId: org.id },
  });
}

async function isNullable(): Promise<boolean> {
  const [row] = await adminDb.$queryRaw<{ is_nullable: string }[]>`
    SELECT is_nullable FROM information_schema.columns
     WHERE table_name = 'workspace_membership' AND column_name = 'workspace_role'`;
  return row!.is_nullable === 'YES';
}

describe('20260927090000_workspace_role_not_null', () => {
  it('backfills a NULL row of every legacy role by the decision table, then sets NOT NULL', async () => {
    const ws = await workspace();
    await relaxWorkspaceRoleNotNull();
    const expected = { owner: 'manager', admin: 'manager', member: 'member', viewer: 'viewer' };
    const ids: Record<string, string> = {};
    for (const legacy of Object.keys(expected)) {
      ids[legacy] = (await user(`nn-${legacy}`)).id;
      await adminDb.$executeRaw`
        INSERT INTO "workspace_membership" ("id", "userId", "workspaceId", "role", "updatedAt")
        VALUES (gen_random_uuid()::text, ${ids[legacy]}, ${ws.id}, ${legacy}::"member_role", now())`;
    }
    expect(await isNullable()).toBe(true);

    await runMigrationFile(NOT_NULL);

    expect(await isNullable()).toBe(false);
    for (const [legacy, mapped] of Object.entries(expected)) {
      const row = await adminDb.workspaceMembership.findUniqueOrThrow({
        where: { userId_workspaceId: { userId: ids[legacy]!, workspaceId: ws.id } },
      });
      expect(row.workspaceRole, legacy).toBe(mapped);
      expect(row.roleDefinitionId, legacy).toBeNull();
    }
  });

  it('leaves an already-set workspace role alone — it never re-derives from the legacy column', async () => {
    const ws = await workspace();
    const u = await user('nn-set');
    await adminDb.workspaceMembership.create({
      data: { userId: u.id, workspaceId: ws.id, workspaceRole: 'viewer' },
    });
    // A legacy value that maps WIDER, written raw (nothing in the app writes it).
    await adminDb.$executeRaw`
      UPDATE "workspace_membership" SET "role" = 'owner' WHERE "userId" = ${u.id}`;
    await relaxWorkspaceRoleNotNull();

    await runMigrationFile(NOT_NULL);

    const row = await adminDb.workspaceMembership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: u.id, workspaceId: ws.id } },
    });
    expect(row.workspaceRole).toBe('viewer');
  });

  it('replays as a no-op over a table with no NULL row', async () => {
    await runMigrationFile(NOT_NULL);
    expect(await isNullable()).toBe(false);
  });

  it('refuses a NULL write once applied', async () => {
    const ws = await workspace();
    const u = await user('nn-refuse');
    await expect(
      adminDb.$executeRaw`
        INSERT INTO "workspace_membership" ("id", "userId", "workspaceId", "role", "updatedAt")
        VALUES (gen_random_uuid()::text, ${u.id}, ${ws.id}, 'member'::"member_role", now())`,
    ).rejects.toThrow(/null value in column "workspace_role"/);
  });
});
