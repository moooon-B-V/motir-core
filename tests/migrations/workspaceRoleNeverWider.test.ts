import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  BUILTIN_ROLE_PERMISSIONS,
  PUBLIC_PROJECT_PERMISSIONS,
} from '@/lib/permissions/builtinRoles';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { currentWorkerAdminUrl } from '../helpers/parallelDb';
import { makeTenant, runMigrationFile, type Tenant } from './_workspaceRoleTenant';

// The never-wider CHECK (Story MOTIR-6168 · Subtask MOTIR-6461) — the second
// migration, run over the mapping's fixture tenant exactly as `migrate deploy`
// runs it. Two halves:
//
//   * UNIT: the migration's literal sets. The built-ins must EQUAL
//     `BUILTIN_ROLE_PERMISSIONS`; the implicit set must equal a SNAPSHOT of
//     `IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS` committed beside this test
//     (`fixtures/…at-7717433af.json`), because MOTIR-6459 deletes the constant in
//     this same branch and there is nothing left to import. The snapshot was read
//     from `git show 7717433af:lib/permissions/builtinRoles.ts`.
//   * INTEGRATION: the migration passes over the fixture, its NEW key function
//     equals the TypeScript `resolvePermissions` pair by pair (the cross-check
//     that pins the SQL copy of the resolver), a broken mapping makes it raise and
//     name the pair, and narrowed people carry `mapped_narrower` rows.

const MAPPING = '20260926100100_workspace_role_mapping';
const CHECK = '20260926100200_workspace_role_never_wider';
const SQL = readFileSync(
  path.join(process.cwd(), 'prisma/migrations', CHECK, 'migration.sql'),
  'utf8',
);

/** The `@set <name>` literal in the migration, sorted. */
function literal(name: string): string[] {
  const m = new RegExp(
    `-- @set ${name}[^\\n]*\\n\\s*WHEN '${name}' THEN ARRAY\\[([^\\]]*)\\]`,
  ).exec(SQL);
  if (!m) throw new Error(`no @set ${name} literal in the migration`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!).sort();
}

const sorted = (s: Iterable<string>) => [...s].sort();

const implicitSnapshot = JSON.parse(
  readFileSync(
    path.join(__dirname, 'fixtures/implicit-workspace-member-permissions.at-7717433af.json'),
    'utf8',
  ),
) as { keys: string[] };

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the literal sets', () => {
  it('the built-ins equal BUILTIN_ROLE_PERMISSIONS (gated = admin = Manager)', () => {
    expect(literal('gated')).toEqual(sorted(BUILTIN_ROLE_PERMISSIONS.admin));
    expect(literal('member')).toEqual(sorted(BUILTIN_ROLE_PERMISSIONS.member));
    expect(literal('viewer')).toEqual(sorted(BUILTIN_ROLE_PERMISSIONS.viewer));
    expect(literal('public')).toEqual(sorted(PUBLIC_PROJECT_PERMISSIONS));
  });

  it('the implicit set equals the committed snapshot of the retired constant', () => {
    expect(literal('implicit')).toEqual(sorted(implicitSnapshot.keys));
  });
});

/** The fixture tenant with a limited and a private project beside the two open ones. */
async function tenantWithLevels(): Promise<Tenant & { p3: { id: string; identifier: string } }> {
  const t = await makeTenant();
  await adminDb.project.update({ where: { id: t.p2.id }, data: { accessLevel: 'limited' } });
  const p3 = await adminDb.project.create({
    data: {
      name: 'P3',
      slug: `wrm-p3-${t.p1.identifier}`,
      identifier: `${t.p1.identifier}P`,
      workspaceId: t.wsId,
      accessLevel: 'private',
    },
  });
  // Only the plain member is added to the private project.
  await adminDb.projectMembership.create({
    data: { workspaceId: t.wsId, projectId: p3.id, userId: t.people.member!, role: 'member' },
  });
  return { ...t, p3: { id: p3.id, identifier: p3.identifier } };
}

async function runCheck(): Promise<void> {
  await runMigrationFile(CHECK);
}

/** The error the check raises, or null if it passed. */
async function checkError(): Promise<string | null> {
  try {
    await runCheck();
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

describe('the check, over the mapping fixture', () => {
  it('PASSES, and NEW equals the TypeScript resolver for every (person, project) pair', async () => {
    const t = await tenantWithLevels();
    await runMigrationFile(MAPPING);
    expect(await checkError()).toBeNull();

    // Re-create the key functions WITHOUT the migration's closing DROPs, in one
    // session, and read the SQL copy of the new rule pair by pair.
    const withoutDrops = SQL.replace(/\nDO \$\$[\s\S]*$/, '\n');
    const client = new Client({ connectionString: currentWorkerAdminUrl() });
    await client.connect();
    try {
      await client.query(withoutDrops);
      const projects = [t.p1.id, t.p2.id, t.p3.id];
      for (const [label, userId] of Object.entries(t.people)) {
        for (const projectId of projects) {
          const { rows } = await client.query<{ keys: string[] }>(
            'SELECT pg_temp.nw_new_keys($1, $2) AS keys',
            [userId, projectId],
          );
          const ts = await projectAccessService.getPermissions(projectId, {
            userId,
            workspaceId: t.wsId,
          });
          expect(sorted(rows[0]!.keys), `${label} in ${projectId}`).toEqual(sorted(ts));
        }
      }
    } finally {
      await client.end();
    }
  });

  it('writes mapped_narrower for every narrowed person with no report row yet, and no other row', async () => {
    const t = await tenantWithLevels();
    await runMigrationFile(MAPPING);
    const before = await adminDb.roleMigrationReport.count();
    await runCheck();
    const rows = await adminDb.roleMigrationReport.findMany({
      where: { reason: 'mapped_narrower' },
    });
    // The plain Viewer loses the implicit set's edit / comment / attach in the
    // open projects, and had no report row from the mapping. Everyone else who
    // narrowed (narrower, wider, custom, merged, sameName) already had one.
    expect(rows.map((r) => r.userId)).toEqual([t.people.viewer]);
    expect(await adminDb.roleMigrationReport.count()).toBe(before + 1);
    const lost = (rows[0]!.beforeJson as { narrowedIn: { projectKey: string; lost: string[] }[] })
      .narrowedIn;
    expect(lost.find((p) => p.projectKey === t.p1.identifier)?.lost).toContain('work_item:edit');
  });

  it('a Member never added to an OPEN project who gains sprint:manage there passes — the allowed class', async () => {
    const t = await tenantWithLevels();
    await runMigrationFile(MAPPING);
    const client = new Client({ connectionString: currentWorkerAdminUrl() });
    await client.connect();
    try {
      await client.query(SQL.replace(/\nDO \$\$[\s\S]*$/, '\n'));
      const old = await client.query<{ k: string[] }>('SELECT pg_temp.nw_old_keys($1, $2) AS k', [
        t.people.member,
        t.p1.id,
      ]);
      const now = await client.query<{ k: string[] }>('SELECT pg_temp.nw_new_keys($1, $2) AS k', [
        t.people.member,
        t.p1.id,
      ]);
      expect(old.rows[0]!.k).not.toContain('sprint:manage');
      expect(now.rows[0]!.k).toContain('sprint:manage');
    } finally {
      await client.end();
    }
    expect(await checkError()).toBeNull();
  });

  it('is idempotent — a re-run over a checked database writes nothing', async () => {
    await tenantWithLevels();
    await runMigrationFile(MAPPING);
    await runCheck();
    const count = await adminDb.roleMigrationReport.count();
    await runCheck();
    expect(await adminDb.roleMigrationReport.count()).toBe(count);
  });
});

describe('the check refuses a broken mapping — and names the pair', () => {
  it('a former workspace Viewer written as Member makes it raise, naming the user, the project and a gained key', async () => {
    const t = await tenantWithLevels();
    await runMigrationFile(MAPPING);
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: t.people.viewer!, workspaceId: t.wsId } },
      data: { workspaceRole: 'member' },
    });
    const message = await checkError();
    expect(message).toMatch(/MOTIR-6461/);
    expect(message).toContain(t.people.viewer!);
    expect(message).toContain(t.p1.identifier);
    expect(message).toMatch(/sprint:manage|work_item:triage|ai:plan/);
  });

  it('someone ADDED as a project viewer, written as Member (the narrowest step skipped), makes it raise', async () => {
    const t = await tenantWithLevels();
    await runMigrationFile(MAPPING);
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: t.people.narrower!, workspaceId: t.wsId } },
      data: { workspaceRole: 'member' },
    });
    const message = await checkError();
    expect(message).toContain(t.people.narrower!);
    expect(message).toContain(t.p1.identifier);
  });
});
