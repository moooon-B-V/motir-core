import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import type { Prisma } from '@/generated/prisma/client';
import { adminDb } from './adminDb';
import { currentWorkerAdminUrl } from './parallelDb';

// The RETIRED role storage, rebuilt for the tests that replay a migration which
// read it (MOTIR-6569).
//
// MOTIR-6569 dropped `workspace_membership.role`, `project_membership.role` /
// `role_definition_id`, the `project_role_definition` table and the `member_role`
// type. A dozen migrations that ran BEFORE the drop read or wrote them — the
// workspace-role mapping and its checks, the access mapping (MOTIR-6542), the
// room-view-key and bug-folder backfills — and their tests replay that SQL, which
// Postgres refuses to even parse once the columns are gone.
//
// So a file that replays one of them calls `ensureLegacyRoleStorage()` first, and
// puts the real schema back in an `afterEach` with `dropLegacyRoleStorage()`,
// which runs MOTIR-6569's own migration — so the next file on this worker gets
// the real schema back even when a test fails, and the drop itself is exercised
// on every restore. The same shape as `relaxWorkspaceRoleNotNull` /
// `restoreWorkspaceRoleNotNull` (tests/migrations/_workspaceRoleTenant.ts).
//
// ⚠️ The rebuild is the pre-drop schema in everything a migration can observe —
// the type, the three columns with their defaults, the table with its indexes,
// FKs and RLS policy, and the Restrict FK from `project_membership`. Only the
// COLUMN ORDER differs (the columns are appended), which no named-column
// statement can see.

export const DROP_LEGACY_ROLE_STORAGE_MIGRATION = '20260929190000_drop_legacy_role_storage';

const REBUILD = `
CREATE TYPE "member_role" AS ENUM ('owner', 'admin', 'member', 'viewer');

ALTER TABLE "workspace_membership" ADD COLUMN "role" "member_role" NOT NULL DEFAULT 'member';
ALTER TABLE "project_membership" ADD COLUMN "role" "member_role" NOT NULL DEFAULT 'member';

CREATE TABLE "project_role_definition" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "project_role_definition_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "project_role_definition_workspace_id_idx" ON "project_role_definition"("workspace_id");
CREATE INDEX "project_role_definition_project_id_idx" ON "project_role_definition"("project_id");
CREATE UNIQUE INDEX "project_role_definition_project_id_name_key" ON "project_role_definition"("project_id", "name");
ALTER TABLE "project_role_definition" ADD CONSTRAINT "project_role_definition_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_role_definition" ADD CONSTRAINT "project_role_definition_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_role_definition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_role_definition" FORCE ROW LEVEL SECURITY;
CREATE POLICY "project_role_definition_active_workspace" ON "project_role_definition"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

ALTER TABLE "project_membership" ADD COLUMN "role_definition_id" TEXT;
CREATE INDEX "project_membership_role_definition_id_idx" ON "project_membership"("role_definition_id");
ALTER TABLE "project_membership" ADD CONSTRAINT "project_membership_role_definition_id_fkey" FOREIGN KEY ("role_definition_id") REFERENCES "project_role_definition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
`;

/** One script, one session — exactly as `prisma migrate deploy` runs a migration. */
async function runScript(sql: string): Promise<void> {
  const client = new Client({ connectionString: currentWorkerAdminUrl() });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function legacyStoragePresent(): Promise<boolean> {
  const rows = await adminDb.$queryRaw<{ present: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'member_role') AS "present"`;
  return rows[0]!.present;
}

/** Put the retired role storage back on this worker's database. A no-op when it is already there. */
export async function ensureLegacyRoleStorage(): Promise<void> {
  if (await legacyStoragePresent()) return;
  await runScript(REBUILD);
}

/** Drop it again by running MOTIR-6569's migration. A no-op when it is already gone. */
export async function dropLegacyRoleStorage(): Promise<void> {
  if (!(await legacyStoragePresent())) return;
  await runScript(
    readFileSync(
      path.join(
        process.cwd(),
        'prisma/migrations',
        DROP_LEGACY_ROLE_STORAGE_MIGRATION,
        'migration.sql',
      ),
      'utf8',
    ),
  );
}

// ── The legacy project custom roles, reached with raw SQL ─────────────────────
// The generated client has no model for the table any more, so the migration
// tests that seed and read it do so here — only while `ensureLegacyRoleStorage`
// holds.

type RawClient = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

export interface LegacyProjectRole {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  permissions: string[];
  createdAt: Date;
  updatedAt: Date;
}

export async function insertLegacyProjectRole(
  client: RawClient,
  data: { workspaceId: string; projectId: string; name: string; permissions: string[] },
): Promise<LegacyProjectRole> {
  const rows = await client.$queryRaw<LegacyProjectRole[]>`
    INSERT INTO "project_role_definition"
      ("id", "workspace_id", "project_id", "name", "permissions", "created_at", "updated_at")
    VALUES (gen_random_uuid()::text, ${data.workspaceId}, ${data.projectId}, ${data.name},
            ${data.permissions}::text[], now(), now())
    RETURNING "id", "workspace_id" AS "workspaceId", "project_id" AS "projectId", "name", "permissions",
              "created_at" AS "createdAt", "updated_at" AS "updatedAt"`;
  return rows[0]!;
}

/** Every legacy project role visible to `client`, ordered by id; `id` narrows to one. */
export function listLegacyProjectRoles(
  client: RawClient,
  where: { id?: string } = {},
): Promise<LegacyProjectRole[]> {
  return where.id === undefined
    ? client.$queryRaw<LegacyProjectRole[]>`
        SELECT "id", "workspace_id" AS "workspaceId", "project_id" AS "projectId", "name", "permissions",
               "created_at" AS "createdAt", "updated_at" AS "updatedAt"
          FROM "project_role_definition" ORDER BY "id"`
    : client.$queryRaw<LegacyProjectRole[]>`
        SELECT "id", "workspace_id" AS "workspaceId", "project_id" AS "projectId", "name", "permissions",
               "created_at" AS "createdAt", "updated_at" AS "updatedAt"
          FROM "project_role_definition" WHERE "id" = ${where.id}`;
}

export async function findLegacyProjectRole(
  client: RawClient,
  id: string,
): Promise<LegacyProjectRole | null> {
  return (await listLegacyProjectRoles(client, { id }))[0] ?? null;
}
