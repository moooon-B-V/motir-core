-- Down-migration for 20260601074342_add_work_item_rls.
--
-- Prisma's migrate workflow is forward-only and does NOT read this file —
-- `prisma migrate deploy` applies migration.sql only. This file exists to
-- document (and let us verify by hand / in CI) that the migration is fully
-- reversible, per the Subtask acceptance criteria. Run it with
-- `psql "$DATABASE_URL" -f down.sql` to roll back a manual apply.
--
-- Order: drop the policies first (in reverse of creation), then DISABLE RLS
-- on each table. NOFORCE is implied once the table no longer has RLS enabled;
-- DISABLE ROW LEVEL SECURITY also clears the FORCE flag. Dropping the policies
-- explicitly (rather than relying on DISABLE) keeps the reversal legible and
-- leaves no orphaned policy objects behind.

DROP POLICY IF EXISTS "work_item_link_active_workspace" ON "work_item_link";
DROP POLICY IF EXISTS "work_item_project_narrow" ON "work_item";
DROP POLICY IF EXISTS "work_item_active_workspace" ON "work_item";

ALTER TABLE "work_item_link" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "work_item_link" DISABLE ROW LEVEL SECURITY;

ALTER TABLE "work_item" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "work_item" DISABLE ROW LEVEL SECURITY;
