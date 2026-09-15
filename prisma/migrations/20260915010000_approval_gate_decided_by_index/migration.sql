-- THE APPROVALS ROOM's OWN-RECORDS DECIDED READ (Story MOTIR-5299 · MOTIR-5301).
--
-- `approvalGateRepository.findRecordsDecided` asks, for a reader without
-- `approval:view_any`, `project_id = ? AND decided_by_id = ? AND state IN
-- ('approved', 'changes_requested') ORDER BY decided_at DESC, id DESC LIMIT ?`.
-- None of the three existing indexes serves it. `(project_id, state)` narrows to
-- one project's decided rows and then discards every other person's decisions.
-- Equality on the first two columns plus the sort key third lets the plan walk the
-- index backwards and stop at the LIMIT. Only an incremental sort on the id
-- tie-break remains. Measured on 300k gates: 29 buffers with it, 4,641 without.
-- `project_id` leads, like both sibling indexes on this table.
--
-- Additive, so no expand/contract phasing. Idempotent, so a re-run of
-- `migrate deploy` over a half-applied database is safe.
CREATE INDEX IF NOT EXISTS "approval_gate_project_id_decided_by_id_decided_at_idx"
  ON "approval_gate"("project_id", "decided_by_id", "decided_at");
