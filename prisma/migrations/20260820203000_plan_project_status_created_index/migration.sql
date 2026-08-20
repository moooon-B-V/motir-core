-- MOTIR-3235 — the tabbed Plans list reads ONE status at a time, newest first.
--
-- `plan(project_id, status)` was added for the pending-proposal GATE's read
-- (MOTIR-916), which asks only "does this project have an undecided plan?" and
-- never sorts. The status-filtered LIST page also orders by `created_at desc`,
-- which that index cannot serve — it narrows and then sorts the narrowed set in
-- the heap, on a read that now runs on every tab switch and every
-- scroll-to-load page.
--
-- EXTENDED rather than supplemented with a fifth index: `(project_id, status)`
-- is a LEFTMOST PREFIX of `(project_id, status, created_at)`, so the gate's read
-- keeps exactly the index it had today and the table carries one index, not two.
DROP INDEX "plan_project_id_status_idx";

CREATE INDEX "plan_project_id_status_created_at_idx" ON "plan"("project_id", "status", "created_at");
