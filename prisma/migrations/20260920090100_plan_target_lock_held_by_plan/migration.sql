-- ============================================================
-- A PLAN can hold a target lock (MOTIR-5645, bug MOTIR-5640).
-- ============================================================
-- `docs/decisions/agent-authored-plans.md` AMENDMENT 16 D1 and D5: every plan
-- parks every committed target it names, at the ONE choke point every authoring
-- door passes through (`plansService.addProposals`) — and the lock that holds it
-- is the PLAN's, not a planning conversation's.
--
-- Before this, `plan_target_lock.session_id` was REQUIRED, so the only thing
-- that could hold a card was a `PlanChangeSession`. That is why `create_plan` /
-- `add_plan_items`, `expand_item` and generation parked nothing at all: they
-- have no session to hold with.
--
-- ⚠️ ONE HOLDER PER ROW, and the CHECK is what says so. The two holders coexist
-- in ONE table rather than in two, because the exclusion this whole mechanism
-- provides is `work_item_id UNIQUE` — split across two tables, there is nothing
-- for that constraint to be unique ACROSS, and a session and a plan could each
-- take the same card.
--
-- Existing rows are untouched: every one carries a `session_id`, so every one
-- satisfies `num_nonnulls(session_id, plan_id) = 1` the moment the constraint is
-- added. No backfill, and the ALTER is therefore safe to run against a live
-- table.

-- ── 1. The new holder ───────────────────────────────────────────────────────
ALTER TABLE "plan_target_lock"
  ADD COLUMN IF NOT EXISTS "plan_id" TEXT;

-- ── 2. The old holder becomes optional ──────────────────────────────────────
ALTER TABLE "plan_target_lock"
  ALTER COLUMN "session_id" DROP NOT NULL;

-- ── 3. EXACTLY ONE of the two, enforced by the database ─────────────────────
-- Not "at least one": a row naming both would make the release path ambiguous
-- about who it is releasing for, and both release paths key on their own holder.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plan_target_lock_one_holder'
  ) THEN
    ALTER TABLE "plan_target_lock"
      ADD CONSTRAINT "plan_target_lock_one_holder"
      CHECK (num_nonnulls("session_id", "plan_id") = 1);
  END IF;
END $$;

-- ── 4. The FK, cascading like the session's ─────────────────────────────────
-- A deleted plan cannot keep holding anything. The RESTORE on a decision is the
-- release path's job (MOTIR-5646) — this cascade is only about not leaving a row
-- pointing at a plan that is gone.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plan_target_lock_plan_id_fkey'
  ) THEN
    ALTER TABLE "plan_target_lock"
      ADD CONSTRAINT "plan_target_lock_plan_id_fkey"
      FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ── 5. The release read ─────────────────────────────────────────────────────
-- Approve, decline and the abandoned-plan sweep each list one plan's locks.
CREATE INDEX IF NOT EXISTS "plan_target_lock_plan_id_idx"
  ON "plan_target_lock"("plan_id");
