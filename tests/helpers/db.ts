import { db } from '@/lib/db';

// Truncate every table the test suite touches, restarting identity counters
// and cascading FK rows. Cheaper than `migrate reset` and idempotent — each
// test's beforeEach calls this so test ordering doesn't matter. The CASCADE
// + the FK chain means we only need to name the roots; child rows go with
// them. workspace_membership FKs against both user and workspace, so listing
// user + workspace + the three auth-token tables is sufficient.
//
// Story 6.10: `organization` is now the tenant ROOT *above* workspace
// (workspace.organizationId → organization). Truncating workspace does NOT
// cascade UP to its parent org, so the org must be named explicitly — otherwise
// org rows (one per workspace, minted by createWorkspace) leak across tests and
// collide on the globally-unique `organization.slug`, suffixing slugs that
// should be clean. organization_membership cascades from both organization and
// user; it is named too for clarity.
export async function truncateAuthTables(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "organization_membership", "organization", "workspace_membership", "workspace", "session", "account", "verification", "user" RESTART IDENTITY CASCADE',
  );
}

// job_run / job_run_dlq rows from SYSTEM jobs carry a null workspace_id, so
// they are NOT reached by truncating "workspace" CASCADE. The jobs suite
// truncates both ledger tables directly between tests.
export async function truncateJobRuns(): Promise<void> {
  await db.$executeRawUnsafe('TRUNCATE TABLE "job_run", "job_run_dlq" RESTART IDENTITY CASCADE');
}
