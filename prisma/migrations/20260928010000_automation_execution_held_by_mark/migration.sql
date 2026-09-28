-- MOTIR-6681 — an automation rule whose `transition` action meets a card carrying an
-- OBSOLESCENCE mark records a HOLD, not a failure (MOTIR-6672: a marked card stays
-- finished, and no system write reopens it). Not `plan_held` (no plan is involved) and
-- not `no_actions` (the condition held and the action ran), so it gets its own value.
-- Like both, it leaves the failure streak untouched and emails nobody.
ALTER TYPE "automation_execution_status" ADD VALUE IF NOT EXISTS 'held_by_mark';
