-- MOTIR-6821 (Story MOTIR-1626, the review agent): the SERVER-WRITTEN event a review
-- run's verdict leaves on the run — the verdict that decided the `agent_review` gate,
-- or a LATE one (a stale version, a superseded or already-decided gate) that decided
-- nothing (`docs/decisions/approval-gates.md` §12.5, `hosted-agent-run.md` §8.4).
-- Additive: a new enum member, no row changes.
ALTER TYPE "dispatch_event_kind" ADD VALUE IF NOT EXISTS 'review_verdict';
