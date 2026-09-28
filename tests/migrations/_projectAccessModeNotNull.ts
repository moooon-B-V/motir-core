import { adminDb } from '../helpers/adminDb';
import { runMigrationFile } from './_workspaceRoleTenant';

// The pre-contract schema of `project.access_mode` (Story MOTIR-6554 · MOTIR-6686).
//
// The access migrations before MOTIR-6686 ran over projects whose `access_mode`
// was NULL, with no default — and since MOTIR-6686 the column is NOT NULL with
// DEFAULT `workspace`, so that state cannot be built directly any more. A file
// that replays one of them calls `relaxProjectAccessModeNotNull` first, and
// restores the real schema in an `afterEach` with
// `restoreProjectAccessModeNotNull`, which runs MOTIR-6686's own migration
// (default, agreement check, backfill, SET NOT NULL) — so the next file on this
// worker gets the real schema back even when a test fails, and the contract
// migration is exercised on every restore. The same shape as MOTIR-6561's
// `relaxWorkspaceRoleNotNull` for the role column.
//
// ⚠️ The restore REFUSES rows whose two columns disagree — that is the migration's
// own agreement check. A file that seeds such a row on purpose truncates before
// it restores.
export const ACCESS_MODE_NOT_NULL_MIGRATION = '20260928000000_project_access_mode_not_null';

/** Drop MOTIR-6686's NOT NULL and DEFAULT on this worker's database, so NULL-mode rows can be written. */
export async function relaxProjectAccessModeNotNull(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'ALTER TABLE "project" ALTER COLUMN "access_mode" DROP NOT NULL, ALTER COLUMN "access_mode" DROP DEFAULT',
  );
}

/**
 * Put a project back to the pre-contract NULL mode. Through raw SQL, because the
 * generated client fills the schema's `@default(workspace)` into every insert
 * itself — dropping the database default alone does not reach a Prisma write.
 */
export async function nullAccessMode(projectId: string): Promise<void> {
  await adminDb.$executeRaw`UPDATE "project" SET "access_mode" = NULL WHERE "id" = ${projectId}`;
}

/** Put MOTIR-6686's DEFAULT and NOT NULL back by running its migration. */
export async function restoreProjectAccessModeNotNull(): Promise<void> {
  await runMigrationFile(ACCESS_MODE_NOT_NULL_MIGRATION);
}
