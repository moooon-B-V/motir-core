-- MOTIR-7638 — the IDLE CLOSE reads open sessions across every workspace
-- (story MOTIR-7630; `agent-authored-plans.md` AMENDMENT 23 §2).
--
-- Every 5 minutes the lock sweep ends each open, non-`guide` session with no
-- undecided plan whose last activity is older than the session lease. That read
-- is cross-tenant BY DESIGN — it looks for every idle session in the product and
-- has no single workspace to bind — so it earns the same narrow arm
-- `plan_target_lock_system_read` gave the expiry sweep. Without it the read
-- returns ZERO ROWS and raises nothing, which for a sweep is indistinguishable
-- from "nothing is idle".
--
-- `FOR SELECT` only. The sweep DISCOVERS under the system context and then
-- re-binds `app.workspace_id` to each session's own workspace before ending it,
-- so every write still runs tenanted.
CREATE POLICY "plan_change_session_system_read" ON "plan_change_session"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');
