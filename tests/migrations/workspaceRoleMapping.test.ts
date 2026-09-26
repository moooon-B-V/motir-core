import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { BUILTIN_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { adminDb } from '../helpers/adminDb';
import { makeTenant, runMigrationFile, type Tenant } from './_workspaceRoleTenant';
import { truncateAuthTables } from '../helpers/db';

// The role migration's MAPPING (Story MOTIR-6168 · Subtask MOTIR-6458) — run
// against the real database over a fixture tenant holding every case the card
// names, exactly as `prisma migrate deploy` runs it: the whole file, one script,
// on one connection (its `pg_temp` functions and temp tables are session-scoped).
//
// Two halves:
//   * a UNIT test that the migration's literal built-in key sets EQUAL
//     `BUILTIN_ROLE_PERMISSIONS` — a migration is a point in time and cannot
//     import the application, so this is what stops a key added to a role before
//     it merges from being silently migrated as a stale set;
//   * an INTEGRATION test of the outcome per person, idempotence, the custom-role
//     re-creation rules, the org-Admin grant, and that no legacy column is written.
//
// NOT here: whether anyone ends WIDER than before. That is the next migration's
// claim (MOTIR-6461), deliberately a separate card so it can fail the deploy even
// when this one has a bug.

const MIGRATION = path.join(
  process.cwd(),
  'prisma/migrations/20260926100100_workspace_role_mapping/migration.sql',
);
const SQL = readFileSync(MIGRATION, 'utf8');

/** The `@builtin <role>` literal array in the migration, as a sorted list. */
function literalSet(sql: string, role: 'admin' | 'member' | 'viewer'): string[] {
  const match = new RegExp(
    `-- @builtin ${role}\\n\\s*${role}_set text\\[\\] := ARRAY\\[([^\\]]*)\\]`,
  ).exec(sql);
  if (!match) throw new Error(`no @builtin ${role} literal in the migration`);
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
}

const sorted = (s: Iterable<string>) => [...s].sort();

async function runMigration(): Promise<void> {
  await runMigrationFile('20260926100100_workspace_role_mapping');
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the literal key sets are a snapshot of BUILTIN_ROLE_PERMISSIONS', () => {
  it.each(['admin', 'member', 'viewer'] as const)(
    '%s — the literal EQUALS the constant',
    (role) => {
      expect(literalSet(SQL, role)).toEqual(sorted(BUILTIN_ROLE_PERMISSIONS[role]));
    },
  );

  it('turns red when a key is added to the member constant (negative control)', () => {
    const widened = new Set([...BUILTIN_ROLE_PERMISSIONS.member, 'comment:moderate']);
    expect(literalSet(SQL, 'member')).not.toEqual(sorted(widened));
  });
});

async function membership(t: Tenant, label: string) {
  return adminDb.workspaceMembership.findUniqueOrThrow({
    where: { userId_workspaceId: { userId: t.people[label]!, workspaceId: t.wsId } },
    include: { roleDefinition: true },
  });
}

async function reportsFor(t: Tenant, label: string) {
  return adminDb.roleMigrationReport.findMany({
    where: { workspaceId: t.wsId, userId: t.people[label]! },
    orderBy: { reason: 'asc' },
  });
}

/** A digest of every row the migration may write, to prove a re-run writes none. */
async function digest(): Promise<string> {
  const [wm, wrd, rmr, om] = await Promise.all([
    adminDb.workspaceMembership.findMany({ orderBy: { id: 'asc' } }),
    adminDb.workspaceRoleDefinition.findMany({ orderBy: { id: 'asc' } }),
    adminDb.roleMigrationReport.findMany({ orderBy: { id: 'asc' } }),
    adminDb.organizationMembership.findMany({ orderBy: { id: 'asc' } }),
  ]);
  return JSON.stringify({ wm, wrd, rmr, om });
}

/** The legacy columns, which must be byte-identical before and after. */
async function legacy(): Promise<string> {
  const [pm, prd, wm] = await Promise.all([
    adminDb.projectMembership.findMany({ orderBy: { id: 'asc' } }),
    adminDb.projectRoleDefinition.findMany({ orderBy: { id: 'asc' } }),
    adminDb.workspaceMembership.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, role: true },
    }),
  ]);
  return JSON.stringify({ pm, prd, wm });
}

describe('the mapping, over a fixture tenant holding every case', () => {
  it('gives every membership exactly the role its case names', async () => {
    const t = await makeTenant();
    await runMigration();

    const expected: Record<string, ['manager' | 'member' | 'viewer', string | null]> = {
      orgOwner: ['manager', null],
      owner: ['manager', null],
      admin: ['manager', null],
      member: ['member', null],
      viewer: ['viewer', null],
      narrower: ['viewer', null],
      wider: ['member', null],
      custom: ['member', 'Contractor'],
      merged: ['member', 'Reviewer ∩ Triage'],
      sameName: ['member', `Contractor (${t.p2.identifier})`],
    };
    for (const [label, [role, customName]] of Object.entries(expected)) {
      const m = await membership(t, label);
      expect([label, m.workspaceRole, m.roleDefinition?.name ?? null]).toEqual([
        label,
        role,
        customName,
      ]);
    }
    const nulls = await adminDb.workspaceMembership.count({ where: { workspaceRole: null } });
    expect(nulls).toBe(0);
  });

  it('writes one report row per person per reason, and none for the plain mapping', async () => {
    const t = await makeTenant();
    await runMigration();

    const reasons = async (label: string) => (await reportsFor(t, label)).map((r) => r.reason);
    expect(await reasons('orgOwner')).toEqual([]);
    expect(await reasons('owner')).toEqual(['org_admin_granted']);
    expect(await reasons('admin')).toEqual([]);
    expect(await reasons('member')).toEqual([]);
    expect(await reasons('viewer')).toEqual([]);
    expect(await reasons('narrower')).toEqual(['narrowest_kept']);
    expect(await reasons('wider')).toEqual(['project_role_dropped']);
    expect(await reasons('custom')).toEqual(['custom_role_recreated']);
    expect(await reasons('merged')).toEqual(['custom_role_merged']);
    expect(await reasons('sameName')).toEqual(['custom_role_recreated']);

    // `before_json` records the legacy workspace role and every project role held.
    const [narrowest] = await reportsFor(t, 'narrower');
    expect(narrowest!.beforeJson).toEqual({
      workspaceRole: 'member',
      projects: [
        { projectKey: t.p1.identifier, role: 'viewer', customRoleName: null },
        { projectKey: t.p2.identifier, role: 'member', customRoleName: null },
      ],
    });
    expect(narrowest!.afterRole).toBe('viewer');
    const [merged] = await reportsFor(t, 'merged');
    expect(merged!.afterRoleDefinitionId).not.toBeNull();
  });

  it('re-creates custom roles once per key set, and suffixes a same-named role with a different set', async () => {
    const t = await makeTenant();
    await runMigration();
    const roles = await adminDb.workspaceRoleDefinition.findMany({
      where: { workspaceId: t.wsId },
      orderBy: { name: 'asc' },
    });
    // Contractor-P1 and Commenter share a key set → ONE row (the first by
    // creation keeps its name). Contractor-P2 has a different set → suffixed.
    expect(roles.map((r) => r.name)).toEqual([
      'Contractor',
      `Contractor (${t.p2.identifier})`,
      'Reviewer',
      'Reviewer ∩ Triage',
      'Triage',
    ]);
  });

  it('the intersection role holds EXACTLY the keys both incomparable roles hold', async () => {
    const t = await makeTenant();
    await runMigration();
    const m = await membership(t, 'merged');
    expect(sorted(m.roleDefinition!.permissions)).toEqual(['project:browse', 'report:view']);
  });

  it('makes the workspace owner who was an org member an org Admin, and leaves the Owner alone', async () => {
    const t = await makeTenant();
    await runMigration();
    const orgRole = async (label: string) =>
      (
        await adminDb.organizationMembership.findUniqueOrThrow({
          where: { organizationId_userId: { organizationId: t.orgId, userId: t.people[label]! } },
        })
      ).role;
    expect(await orgRole('owner')).toBe('admin');
    expect(await orgRole('orgOwner')).toBe('owner');
    expect(await orgRole('member')).toBe('member');
  });

  it('a workspace owner with NO org membership row is given one, as an Admin', async () => {
    const t = await makeTenant();
    await adminDb.organizationMembership.delete({
      where: { organizationId_userId: { organizationId: t.orgId, userId: t.people.owner! } },
    });
    await runMigration();
    const row = await adminDb.organizationMembership.findUnique({
      where: { organizationId_userId: { organizationId: t.orgId, userId: t.people.owner! } },
    });
    expect(row?.role).toBe('admin');
    expect((await reportsFor(t, 'owner')).map((r) => r.reason)).toEqual(['org_admin_granted']);
  });

  it('is IDEMPOTENT — a re-run over the migrated database changes no row', async () => {
    await makeTenant();
    await runMigration();
    const first = await digest();
    await runMigration();
    expect(await digest()).toBe(first);
  });

  it('writes NO legacy column — project_membership, project_role_definition and workspace_membership.role are byte-identical', async () => {
    await makeTenant();
    const before = await legacy();
    await runMigration();
    expect(await legacy()).toBe(before);
  });

  it('an intersection whose key set a workspace role already has REUSES that role — deduped by key set', async () => {
    const t = await makeTenant();
    const existing = await adminDb.workspaceRoleDefinition.create({
      data: {
        workspaceId: t.wsId,
        name: 'Readers',
        permissions: ['report:view', 'project:browse'],
      },
    });
    await runMigration();
    const m = await membership(t, 'merged');
    expect(m.roleDefinitionId).toBe(existing.id);
    expect(
      await adminDb.workspaceRoleDefinition.count({
        where: { workspaceId: t.wsId, name: 'Reviewer ∩ Triage' },
      }),
    ).toBe(0);
  });

  it('a membership already carrying a workspace role is left exactly as it is', async () => {
    const t = await makeTenant();
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: t.people.wider!, workspaceId: t.wsId } },
      data: { workspaceRole: 'viewer' },
    });
    await runMigration();
    expect((await membership(t, 'wider')).workspaceRole).toBe('viewer');
    expect(await reportsFor(t, 'wider')).toEqual([]);
  });
});
