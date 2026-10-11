-- MOTIR-7913 — the REPLY-WAIT PASS reads a session's LAST TURN across every workspace
-- (story MOTIR-7905; `approval-gates.md` §1's MOTIR-7906 amendment).
--
-- Every 5 minutes the lock sweep looks for open conversations whose last turn is the
-- planner's, with no question, quiet past `AWAITING_REPLY_AFTER_MS`. That discovery is
-- cross-tenant BY DESIGN, and "the last turn" is a read of `plan_change_turn`, which —
-- unlike `plan_change_session` (`…_plan_change_session_system_read`, MOTIR-7638) and
-- `plan` (MOTIR-3064) — has no system arm. Without it the subquery sees ZERO ROWS and
-- raises nothing, which for a sweep is indistinguishable from "nobody left".
--
-- `FOR SELECT` only. The pass DISCOVERS under the system context and then re-binds
-- `app.workspace_id` to each session's own workspace and re-checks before raising, so
-- every write still runs tenanted.
CREATE POLICY "plan_change_turn_system_read" ON "plan_change_turn"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');
