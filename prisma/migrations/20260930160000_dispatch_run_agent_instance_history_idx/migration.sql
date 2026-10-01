-- MOTIR-7029: an agent's run history, newest first — the My agents panel's
-- "Last run" line reads each agent's latest run in one DISTINCT ON query.
-- Two columns, so it is never paired with the partial unique index
-- `dispatch_run_agent_instance_running_key` on `(agent_instance_id)`.

-- CreateIndex
CREATE INDEX "dispatch_run_agent_instance_id_started_at_idx" ON "dispatch_run"("agent_instance_id", "started_at" DESC);
