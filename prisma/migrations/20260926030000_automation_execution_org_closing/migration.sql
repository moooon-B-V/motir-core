-- MOTIR-6396 — an automation rule that fires in an organization scheduled for deletion
-- records a PAUSE, not a failure (`docs/decisions/organization-deletion.md` §3: automations
-- are "paused rather than failed" while the org closes). Not `no_actions` (the condition was
-- never evaluated) and not `plan_held` (no plan is involved), so it gets its own value. Like
-- both, it leaves the failure streak untouched and emails nobody.
ALTER TYPE "automation_execution_status" ADD VALUE IF NOT EXISTS 'org_closing';
