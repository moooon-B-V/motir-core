import { db } from '@/lib/db';

// Truncate every table the test suite touches, restarting identity counters
// and cascading FK rows. Cheaper than `migrate reset` and idempotent — each
// test's beforeEach calls this so test ordering doesn't matter. The CASCADE
// + the FK chain means we only need to name the roots; child rows go with
// them. workspace_membership FKs against both user and workspace, so listing
// user + workspace + the three auth-token tables is sufficient.
export async function truncateAuthTables(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "workspace_membership", "workspace", "session", "account", "verification", "user" RESTART IDENTITY CASCADE',
  );
}
