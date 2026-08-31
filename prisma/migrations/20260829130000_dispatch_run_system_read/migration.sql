-- A SYSTEM READ ARM on the three dispatch-run tables (Story MOTIR-1789 ·
-- MOTIR-1792), for the retention sweep and the abandoned-run reap that
-- `docs/decisions/dispatch-run-record.md` Q4.2 assigns to this card.
--
-- ⚠️ WHY A SECOND MIGRATION AND NOT AN EDIT TO THE FIRST. MOTIR-1791's migration
-- creates the tables with their workspace policy in the same statement batch —
-- no unguarded window — and that property is worth keeping literally true of the
-- migration that creates them. This arm belongs to the SWEEP, which is this
-- card's, so it lands with the card that needs it.
--
-- ⚠️ AND IT IS `FOR SELECT` ONLY. That restriction is the whole design, and it
-- is the same shape `job_run`'s family carries:
--
--   * the sweep's DISCOVERY read genuinely spans tenants — a run abandoned on
--     one workspace's laptop and a body expiring in another's are one job's
--     work, and the workspace is not known until the first row comes back, so no
--     wrapper could have bound it up front;
--   * every WRITE that follows re-binds to THAT ROW'S OWN workspace
--     (`withWorkspaceContext`), so nothing is ever written untenanted. Arming an
--     `INSERT`/`UPDATE`/`DELETE` policy on `app.system_admin` would let a future
--     job write across tenants by accident, which is precisely the blast radius
--     the read-only arm refuses.
--
-- `app.system_admin` is bound ONLY by `withSystemContext`, which binds a
-- CONSTANT and is never fed request input, so no tenant request path can reach
-- this arm.
--
-- PERMISSIVE, so it is OR-ed with the workspace policy rather than narrowing it:
-- a tenant read is unaffected, and a system read sees rows a bound workspace
-- would not.

CREATE POLICY "dispatch_run_system_read" ON "dispatch_run"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');

CREATE POLICY "dispatch_run_card_system_read" ON "dispatch_run_card"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');

CREATE POLICY "dispatch_run_event_system_read" ON "dispatch_run_event"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');
