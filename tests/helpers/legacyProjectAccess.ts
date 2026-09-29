import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import type { Prisma } from '@/generated/prisma/client';
import { adminDb } from './adminDb';
import type { LegacyAccessLevel } from './projectAccess';
import { currentWorkerAdminUrl } from './parallelDb';

// The RETIRED project access level, rebuilt for the tests that replay a
// migration which read it (MOTIR-6694).
//
// MOTIR-6694 dropped `project."accessLevel"` and its `project_access_level` type.
// Three migrations that ran BEFORE the drop read the column — the access mapping
// (MOTIR-6542), the `access_mode` NOT NULL contract (MOTIR-6686) and the
// workspace-role never-wider check (MOTIR-6461) — and their tests replay that SQL,
// which Postgres refuses once the column is gone.
//
// So a file that replays one of them calls `ensureLegacyAccessLevel()` first, and
// puts the real schema back in an `afterEach` with `dropLegacyAccessLevel()`,
// which runs MOTIR-6694's own migration — so the next file on this worker gets
// the real schema back even when a test fails, and the drop itself (its guard
// block included) is exercised on every restore. Both are wired into the two
// fixtures those files already share, `relaxProjectAccessModeNotNull` /
// `restoreProjectAccessModeNotNull` and `makeTenant` / `restoreWorkspaceRoleNotNull`.
//
// ⚠️ The rebuild is the pre-drop schema in everything a migration can observe —
// the type with its four values and the NOT NULL column with its `open` default.
// Only the COLUMN ORDER differs (it is appended), which no named-column statement
// can see.
//
// Nothing else in `tests/` may name the column: `tests/projects/accessFixtureGuard.test.ts`
// allows a write only here.

export const DROP_PROJECT_ACCESS_LEVEL_MIGRATION = '20260929210000_drop_project_access_level';

const REBUILD = `
CREATE TYPE "project_access_level" AS ENUM ('open', 'limited', 'private', 'public');
ALTER TABLE "project" ADD COLUMN "accessLevel" "project_access_level" NOT NULL DEFAULT 'open';
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

async function legacyLevelPresent(): Promise<boolean> {
  const rows = await adminDb.$queryRaw<{ present: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'project_access_level') AS "present"`;
  return rows[0]!.present;
}

/** Put the retired column and its type back on this worker's database. A no-op when they are already there. */
export async function ensureLegacyAccessLevel(): Promise<void> {
  if (await legacyLevelPresent()) return;
  await runScript(REBUILD);
}

/** Drop them again by running MOTIR-6694's migration. A no-op when they are already gone. */
export async function dropLegacyAccessLevel(): Promise<void> {
  if (!(await legacyLevelPresent())) return;
  await runScript(
    readFileSync(
      path.join(
        process.cwd(),
        'prisma/migrations',
        DROP_PROJECT_ACCESS_LEVEL_MIGRATION,
        'migration.sql',
      ),
      'utf8',
    ),
  );
}

// ── The legacy level, reached with raw SQL ────────────────────────────────────
// The generated client has no field for the column any more, so the migration
// tests that seed and read it do so here — only while `ensureLegacyAccessLevel`
// holds.

type RawClient = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

/** The stored legacy level of project `projectId`. Throws if there is no such project. */
export async function readLegacyAccessLevel(
  client: RawClient,
  projectId: string,
): Promise<LegacyAccessLevel> {
  const rows = await client.$queryRaw<{ accessLevel: LegacyAccessLevel }[]>`
    SELECT "accessLevel"::text AS "accessLevel" FROM "project" WHERE "id" = ${projectId}`;
  if (rows.length === 0) throw new Error(`no project ${projectId}`);
  return rows[0]!.accessLevel;
}

/** Write a legacy level onto project `projectId` — and ONLY the level — for a migration that read it. */
export async function writeLegacyAccessLevel(
  client: RawClient,
  projectId: string,
  level: LegacyAccessLevel,
): Promise<void> {
  await client.$executeRaw`
    UPDATE "project" SET "accessLevel" = ${level}::"project_access_level" WHERE "id" = ${projectId}`;
}
