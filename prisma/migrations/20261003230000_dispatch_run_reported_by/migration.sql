-- MOTIR-7450 (Story MOTIR-7446, `docs/decisions/agent-reported-runs.md`): an agent may
-- report its OWN run over the MCP, and the record says who reported what.
--
--   1. `dispatch_run_reporter` — `cli` · `agent`.
--   2. `dispatch_run.reported_by` — who reports the run (§1). Every existing row is a
--      run a runner observed, so the default `cli` is the true value for all of them.
--   3. `dispatch_run_event.reported_by` — who wrote the event (§3), same default.
--   4. `dispatch_event_kind.agent_action` — one step the agent is about to take (§3).
--
-- Additive: a new type, two defaulted columns and a new enum member; no row is rewritten
-- beyond the default fill.
CREATE TYPE "dispatch_run_reporter" AS ENUM ('cli', 'agent');

ALTER TABLE "dispatch_run"
  ADD COLUMN "reported_by" "dispatch_run_reporter" NOT NULL DEFAULT 'cli';

ALTER TABLE "dispatch_run_event"
  ADD COLUMN "reported_by" "dispatch_run_reporter" NOT NULL DEFAULT 'cli';

ALTER TYPE "dispatch_event_kind" ADD VALUE IF NOT EXISTS 'agent_action';
