import type { Prisma, ProjectAccessLevel } from '@/generated/prisma/client';

// The RETIRED project access level, reached with raw SQL (MOTIR-6692).
//
// `Project.accessLevel` is `@ignore`d, so the generated client neither selects
// nor writes it — which is the point of phase 2: nothing in the application may
// name the column. The COLUMN and its `project_access_level` type stay in the
// database until the phase-3 drop (MOTIR-6694), and the tests that still own
// them — the column's default and value set, and the migrations that mapped a
// stored level to a mode — seed and read it through here. Delete this file with
// the drop.

type RawClient = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;

/** The stored legacy level of project `projectId`. Throws if there is no such project. */
export async function readLegacyAccessLevel(
  client: RawClient,
  projectId: string,
): Promise<ProjectAccessLevel> {
  const rows = await client.$queryRaw<{ accessLevel: ProjectAccessLevel }[]>`
    SELECT "accessLevel"::text AS "accessLevel" FROM "project" WHERE "id" = ${projectId}`;
  if (rows.length === 0) throw new Error(`no project ${projectId}`);
  return rows[0]!.accessLevel;
}

/**
 * Write a legacy level onto project `projectId` — and ONLY the level. A test
 * that needs this is testing the column itself or a migration that read it; a
 * test that wants a project's ACCESS uses `tests/helpers/projectAccess.ts`.
 */
export async function writeLegacyAccessLevel(
  client: RawClient,
  projectId: string,
  level: ProjectAccessLevel,
): Promise<void> {
  await client.$executeRaw`
    UPDATE "project" SET "accessLevel" = ${level}::"project_access_level" WHERE "id" = ${projectId}`;
}
