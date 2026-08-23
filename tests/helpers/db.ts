import { adminDb as db } from './adminDb';

// ⚠️ These reset helpers run through the ADMIN client, never `@/lib/db`
// (MOTIR-2513). `TRUNCATE` requires table OWNERSHIP, which the non-bypass
// runtime role does not have and must never be granted — under
// `TEST_DB_APP_ROLE=1` the singleton is that role, so truncating through it
// would fail. Routing resets to the owner keeps the privilege where it belongs
// and leaves the code under test on the restricted connection. With the flag
// unset both clients point at the same role and this is a no-op change.

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
// `idea_draft` (Subtask 7.22.2 / MOTIR-1458) is an ANONYMOUS table with no FK to
// user/workspace, so a workspace/user CASCADE never reaches it — name it here
// explicitly so its short-lived rows don't leak across tests.
export async function truncateAuthTables(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "organization_membership", "organization", "workspace_membership", "workspace", "session", "account", "github_identity", "import_source_identity", "verification", "email_change_request", "idea_draft", "user" RESTART IDENTITY CASCADE',
  );
}

// job_run / job_run_dlq rows from SYSTEM jobs carry a null workspace_id, so
// they are NOT reached by truncating "workspace" CASCADE. The jobs suite
// truncates both ledger tables directly between tests.
export async function truncateJobRuns(): Promise<void> {
  await db.$executeRawUnsafe('TRUNCATE TABLE "job_run", "job_run_dlq" RESTART IDENTITY CASCADE');
}

// The Postgres job engine's three tables (Story MOTIR-3414 · Subtask MOTIR-3420)
// are the same class as `job_run` above, for the same reason: a SYSTEM job's
// rows carry `workspace_id IS NULL`, so a `TRUNCATE "workspace" CASCADE` never
// reaches them and they leak into the next test.
//
// `job_queue` cascades from `job_event` and `job_step` from `job_queue`, so
// naming the parent would be enough for the tenanted rows — but an untenanted
// event has no parent at all, so all three are named and the CASCADE only has
// to do the work the FKs describe.
//
// ⚠️ Call this in `afterEach` as well as `beforeEach` when a suite writes these
// rows. A table outside the workspace cascade that is only cleared BEFORE each
// test leaves its last test's rows sitting in the worker's database for whatever
// file that worker picks up next — which surfaces as a failure in an unrelated
// suite, nowhere near the diff that caused it.
export async function truncateJobEngine(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "job_event", "job_queue", "job_step" RESTART IDENTITY CASCADE',
  );
}

// `code_graph_offboarding` (MOTIR-2166) carries NO foreign key to workspace or
// project — deliberately, so a pending removal OUTLIVES the workspace-delete
// cascade that makes it necessary (`docs/decisions/code-graph-index-fleet.md`
// §14.5). The consequence for tests is the same one `idea_draft` and `job_run`
// have: a `TRUNCATE "workspace" CASCADE` never reaches it, so a suite that writes
// these rows must clear them explicitly or they leak into the next test.
//
// That leak is worth understanding rather than routing around: it is the table's
// load-bearing property, observed. A row that survived `truncateAuthTables` is a
// row that will survive a customer's workspace delete.
export async function truncateCodeGraphOffboarding(): Promise<void> {
  await db.$executeRawUnsafe('TRUNCATE TABLE "code_graph_offboarding" RESTART IDENTITY CASCADE');
}

// `rate_limit_counter` (Subtask 8.5.9 / MOTIR-1165) is the same class as
// `idea_draft` / `job_run` / `code_graph_offboarding`: it carries NO FK to
// workspace or user — deliberately, because the surfaces it protects (sign-in,
// sign-up, password reset, public writes) are limited BEFORE any tenant is known
// (ADR §7) — so a `TRUNCATE "workspace" CASCADE` never reaches it.
//
// ⚠️ A suite that exercises ANY limited surface must clear it between tests, or
// the counters carry over: the second test's first request arrives with the first
// test's tally already spent, which shows up as a 429 nobody asked for in a case
// that has nothing to do with rate limiting.
export async function truncateRateLimitCounters(): Promise<void> {
  await db.$executeRawUnsafe('TRUNCATE TABLE "rate_limit_counter"');
}
