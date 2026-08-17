-- ===========================================================================
-- `plan_target_lock` — the LEASE behind the `planning` status lock
-- (Story MOTIR-2786 · MOTIR-2787).
--
-- ---------------------------------------------------------------------------
-- WHY A TABLE AND NOT JUST THE STATUS
-- ---------------------------------------------------------------------------
-- The exclusion the story asks for is "two planning sessions must not take the
-- same target", and it is enforced by `work_item_id` being UNIQUE here — one
-- holder per ITEM, whatever scope named it. That is precisely the hole
-- `plan_change_session.scope_key` cannot close: `[MOTIR-9]` and
-- `[MOTIR-9, MOTIR-4]` are two different scope keys addressing one common item.
--
-- The `planning` STATUS remains the user-visible face of the lock — a board
-- showing an epic as Planning tells a second person not to start — but it CANNOT
-- be the authority, for two reasons that are both already true on `main`:
--
--   1. `planning` is set by hand today. MOTIR-2425 shipped the status for a
--      different purpose (an agent parks a card it cannot implement until a
--      human acts on the re-plan) and `lib/workflows/defaultWorkflow.ts` is
--      explicit that nothing may auto-return such a card to `todo`. A recovery
--      sweep keyed on "status = planning" would undo exactly that, and put a
--      card known to be defective back in the pickable set.
--   2. Only `todo` and `in_progress` have a legal edge to `planning`. An item in
--      `in_review` can still be planned, and must still be exclusively held —
--      the row does that; the status move is skipped and recorded as
--      `status_held = false`.
--
-- So: the row is the lock, the status is the affordance, and release/recovery
-- touch only items that have a row here.
--
-- ---------------------------------------------------------------------------
-- THE LEASE
-- ---------------------------------------------------------------------------
-- `expires_at` is what makes a crashed planner recoverable WITHOUT a database
-- edit — which the story names as the single most important property, and which
-- nothing else in the system can supply: a plan whose job dies stays
-- `generating` forever (there is no `failed` member of `plan_status`), so no
-- product event ever fires to release the item. The holding session extends the
-- lease on each turn; past it, the sweep — and a competing acquire — may take
-- the item back.
-- ===========================================================================

-- CreateTable
CREATE TABLE "plan_target_lock" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "held_by_id" TEXT,
    "prior_status" TEXT NOT NULL,
    "status_held" BOOLEAN NOT NULL DEFAULT false,
    "acquired_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_target_lock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plan_target_lock_work_item_id_key" ON "plan_target_lock"("work_item_id");

-- CreateIndex
CREATE INDEX "plan_target_lock_session_id_idx" ON "plan_target_lock"("session_id");

-- CreateIndex
CREATE INDEX "plan_target_lock_expires_at_idx" ON "plan_target_lock"("expires_at");

-- CreateIndex
CREATE INDEX "plan_target_lock_workspace_id_idx" ON "plan_target_lock"("workspace_id");

-- AddForeignKey
ALTER TABLE "plan_target_lock" ADD CONSTRAINT "plan_target_lock_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_target_lock" ADD CONSTRAINT "plan_target_lock_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_target_lock" ADD CONSTRAINT "plan_target_lock_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_target_lock" ADD CONSTRAINT "plan_target_lock_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "plan_change_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_target_lock" ADD CONSTRAINT "plan_target_lock_held_by_id_fkey" FOREIGN KEY ("held_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- RLS — the workspace policy ships in the SAME migration (PRODECT_FINDINGS #20:
-- no unguarded window), plus ONE `FOR SELECT` arm for `app.system_admin`.
--
-- The arm is the narrow, deliberate case the disposition rule admits: the expiry
-- sweep (`system.plan-target-lock-sweep`) is cross-tenant BY DESIGN — it looks
-- for every lease in the product that has run out, and has no single workspace to
-- bind. Without an arm that read returns ZERO ROWS and raises nothing, which for
-- a sweep is indistinguishable from "nothing has expired" — the vacuous pass.
--
-- `FOR SELECT` only. The sweep DISCOVERS under the system context and then
-- re-binds `app.workspace_id` to each row's own workspace before releasing it, so
-- every write still runs tenanted and the write refusal stays load-bearing.
-- ===========================================================================
ALTER TABLE "plan_target_lock" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "plan_target_lock" FORCE ROW LEVEL SECURITY;

CREATE POLICY "plan_target_lock_active_workspace" ON "plan_target_lock"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

CREATE POLICY "plan_target_lock_system_read" ON "plan_target_lock"
  FOR SELECT
  USING (current_setting('app.system_admin', true) = 'true');
