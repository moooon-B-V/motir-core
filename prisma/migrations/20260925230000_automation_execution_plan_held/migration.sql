-- MOTIR-6340 — an automation rule whose `transition` action meets a card an undecided plan
-- holds at `planning` records a NO-OP, not a failure (`docs/decisions/agent-authored-plans.md`
-- AMENDMENT 21 §5(b)). `no_actions` means the rule's CONDITION gated it, which is not what
-- happened — the condition held and the action was refused — so the outcome gets its own value
-- rather than borrowing that one. Like `no_actions`, it leaves the failure streak untouched.
ALTER TYPE "automation_execution_status" ADD VALUE IF NOT EXISTS 'plan_held';
