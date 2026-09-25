import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// MOTIR-6329 (Story MOTIR-6179) — nobody loses a room they have today. Every
// CUSTOM project role that browses reaches `/plans` and `/runs` on
// `project:browse` alone, so the migration appends the two rooms' view keys to
// it before any read asserts them.
//
// ⚠️ THIS FILE EXECUTES THE MIGRATION'S OWN SQL, READ FROM THE MIGRATION (the
// precedent is `project-pr-merge-mode-backfill.test.ts`): a retyped UPDATE would
// stay green while the shipped statement drifted.

const MIGRATION = path.join(
  process.cwd(),
  'prisma/migrations/20260925170000_room_view_keys_for_custom_roles/migration.sql',
);

const SQL = readFileSync(MIGRATION, 'utf8');

/** The migration's statements, comments stripped, in file order. */
function statements(): string[] {
  return SQL.split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runMigration() {
  for (const statement of statements()) await adminDb.$executeRawUnsafe(statement);
}

let seq = 0;

async function seedProject() {
  const n = seq++;
  const org = await adminDb.organization.create({
    data: { name: `Org rv${n}`, slug: `rv-org-${n}` },
  });
  const workspace = await adminDb.workspace.create({
    data: { name: `WS rv${n}`, slug: `rv-ws-${n}`, organizationId: org.id },
  });
  return adminDb.project.create({
    data: {
      name: `Project rv${n}`,
      slug: `rv-p-${n}`,
      identifier: `RV${n}`,
      workspaceId: workspace.id,
    },
  });
}

async function role(
  project: { id: string; workspaceId: string },
  name: string,
  permissions: string[],
) {
  return adminDb.projectRoleDefinition.create({
    data: { workspaceId: project.workspaceId, projectId: project.id, name, permissions },
  });
}

async function permissionsOf(id: string): Promise<string[]> {
  const row = await adminDb.projectRoleDefinition.findUniqueOrThrow({
    where: { id },
    select: { permissions: true },
  });
  return row.permissions;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('20260925170000_room_view_keys_for_custom_roles', () => {
  it('appends both keys to a browsing role, leaves a non-browsing one alone, and never duplicates', async () => {
    const project = await seedProject();
    const browsing = await role(project, 'Reviewer', ['project:browse', 'comment:add']);
    const nonBrowsing = await role(project, 'Nothing', ['comment:add']);
    const already = await role(project, 'Planner', ['project:browse', 'plan:view_any']);

    await runMigration();

    expect(await permissionsOf(browsing.id)).toEqual([
      'project:browse',
      'comment:add',
      'plan:view_any',
      'run:view_any',
    ]);
    expect(await permissionsOf(nonBrowsing.id)).toEqual(['comment:add']);
    expect(await permissionsOf(already.id)).toEqual([
      'project:browse',
      'plan:view_any',
      'run:view_any',
    ]);
  });

  it('never grants approval:view_any — no custom role held it implicitly', async () => {
    const project = await seedProject();
    const browsing = await role(project, 'Reviewer', ['project:browse']);
    await runMigration();
    expect(await permissionsOf(browsing.id)).not.toContain('approval:view_any');
  });

  it('is idempotent — running it twice leaves the table as running it once', async () => {
    const project = await seedProject();
    const a = await role(project, 'A', ['project:browse']);
    const b = await role(project, 'B', ['project:browse', 'run:view_any']);
    await runMigration();
    const once = [await permissionsOf(a.id), await permissionsOf(b.id)];
    await runMigration();
    expect([await permissionsOf(a.id), await permissionsOf(b.id)]).toEqual(once);
  });

  it('never touches a credential row — no statement names api_token', () => {
    expect(statements().join('\n')).not.toMatch(/api_token/i);
    for (const statement of statements()) {
      expect(statement).toMatch(/^UPDATE "project_role_definition"/);
    }
  });
});
