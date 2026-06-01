-- Down-migration for 20260601092140_add_work_item_revisions.
--
-- Prisma's migrate workflow is forward-only and does NOT read this file —
-- `prisma migrate deploy` applies migration.sql only. This file exists to
-- document (and let us verify by hand / in CI) that the migration is fully
-- reversible, per the Subtask acceptance criteria. Run it with
-- `prisma db execute --file down.sql` (or `psql -f down.sql`) to roll back a
-- manual apply.
--
-- Order: drop the policy first, then DISABLE RLS (NO FORCE then DISABLE, which
-- also clears the FORCE flag), then drop the table. Dropping the policy
-- explicitly rather than relying on DROP TABLE's cascade keeps the reversal
-- legible and leaves no orphaned policy objects behind. The table's indexes +
-- FK constraints go with the DROP TABLE.

DROP POLICY IF EXISTS "work_item_revision_active_workspace" ON "work_item_revision";

ALTER TABLE "work_item_revision" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "work_item_revision" DISABLE ROW LEVEL SECURITY;

DROP TABLE IF EXISTS "work_item_revision";
