-- Story MOTIR-6012 · Subtask MOTIR-6039 (ADR `approval-gates.md` §11.9, amended
-- 2026-09-23): RAISE the plan-approval gate for every plan that was already
-- `planned` before the plan gate shipped. A plan closing to `planned` from now on
-- gets its gate from `planGateService.raise` (MOTIR-6036); these plans closed
-- before that existed. Without this they are missing from To approve and answer
-- "not decidable yet" at every approve door (MOTIR-6038), so the backfill runs WITH
-- the deploy rather than as an operator step after it (the requester's decision).
--
-- ⚠️ A SECOND COPY OF TWO RULES, FROZEN AT THIS DEPLOY — kept identical on purpose:
--   · the POPULATION is `planGateService`'s asked-subject predicate: the plan is
--     `planned`, holds at least one proposal, and has no `awaiting`
--     `plan_approval` gate;
--   · the ROUTING is `resolvePlanGateRoute`: the plan's requester
--     (`created_by_id`), else the workspace's EARLIEST `owner` membership (by
--     `createdAt`, as `workspaceMembershipRepository.findOwnerByWorkspace` orders
--     it), else nobody (§11.6).
-- A migration runs once, so it has to match the rules as they stand at this deploy
-- and no later. `pnpm db:backfill:plan-gates --dry-run`, which goes through the
-- shipped raise, is the check that it did: after the deploy it reports 0 to raise.
--
-- `subject_version` is left NULL. The raise records §11.3's digest, which SQL cannot
-- reproduce byte for byte (jsonb orders keys by length, not by code unit), and it is
-- not load-bearing: the decide door stamps a `plan_approval` gate against the LIVE
-- digest (`stampsLiveVersion`) and records the version at decision time.
--
-- Idempotent: `NOT EXISTS` skips a plan already asked, and the partial unique index
-- `approval_gate_one_awaiting_per_cardless_subject` backs it. It runs as the
-- migration owner, so it reads across every tenant with no RLS context.
INSERT INTO "approval_gate" (
  "id", "workspace_id", "project_id", "work_item_id", "kind", "subject_id",
  "state", "routed_to_id", "subject_version", "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text,
  p."workspace_id",
  p."project_id",
  NULL,
  'plan_approval'::"approval_gate_kind",
  p."id",
  'awaiting'::"approval_gate_state",
  COALESCE(
    p."created_by_id",
    (
      SELECT wm."userId"
      FROM "workspace_membership" wm
      WHERE wm."workspaceId" = p."workspace_id" AND wm."role" = 'owner'::"member_role"
      ORDER BY wm."createdAt" ASC
      LIMIT 1
    )
  ),
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "plan" p
WHERE p."status" = 'planned'::"plan_status"
  AND EXISTS (SELECT 1 FROM "plan_item" pi WHERE pi."plan_id" = p."id")
  AND NOT EXISTS (
    SELECT 1
    FROM "approval_gate" g
    WHERE g."kind" = 'plan_approval'::"approval_gate_kind"
      AND g."subject_id" = p."id"
      AND g."state" = 'awaiting'::"approval_gate_state"
  );
