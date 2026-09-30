-- MOTIR-6818 (Story MOTIR-1626, 9.8 — the review agent). Storage and enum values only; no
-- behaviour reads them yet (`docs/decisions/approval-gates.md` §12, `hosted-agent-run.md` §8).
--
-- Enum values are ADDED only — none is renamed or removed — so every existing row keeps its
-- meaning. `IF NOT EXISTS` keeps a re-applied migration from failing on a value it already added.
ALTER TYPE "approval_gate_kind" ADD VALUE IF NOT EXISTS 'agent_review';
ALTER TYPE "approval_gate_authority" ADD VALUE IF NOT EXISTS 'review_agent';
ALTER TYPE "dispatch_command" ADD VALUE IF NOT EXISTS 'review';
ALTER TYPE "approval_gate_supersede_cause" ADD VALUE IF NOT EXISTS 'review_agent_disabled';

-- The project's switch. OFF for every existing project, and nothing is backfilled: a review
-- is a hosted run paid from the organisation's AI credits, so nobody starts paying for one by
-- migration.
ALTER TABLE "project" ADD COLUMN "review_agent_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Why an awaiting `agent_review` gate's review could not run (§12.6). Null on every other kind.
ALTER TABLE "approval_gate" ADD COLUMN "review_unavailable_reason" TEXT;
