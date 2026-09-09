-- Approval gates — one row per decision that holds work up, the human-in-the-
-- loop evidence an agent-driven pipeline owes an auditor (Story MOTIR-4778 ·
-- Subtask MOTIR-4788; ADR docs/decisions/approval-gates.md). In ONE atomic step
-- (enums + table + indexes + FKs + their RLS policies land together —
-- migration-by-concern, PRODECT_FINDINGS #20 — so there is never an unguarded
-- window):
--   1. the `approval_gate_kind` + `approval_gate_state` enums;
--   2. the `approval_gate` table, its indexes and FKs;
--   3. the partial-unique index enforcing ONE `awaiting` gate per
--      (work_item_id, kind, subject_id);
--   4. ENABLE + FORCE row-level security + the pure active-workspace policy.
--
-- RLS shape = a PURE workspace gate, identical to `design_evidence`
-- (20260811145123) and `acceptance_evidence` (20260705222141): every row
-- carries a NON-NULL `workspace_id` and every write happens inside an active
-- workspace context (the publish / link path runs under withWorkspaceContext),
-- so there is no context-less writer and no untenanted row — hence NO
-- `app.system_admin` hatch. `current_setting('app.workspace_id', true)` with
-- missing_ok=true means an unset GUC → NULL → row hidden (safe failure). FORCE
-- subjects even the table owner to the policy; production connects as the
-- non-bypass `motir_app` role.
--
-- `subject_id` is polymorphic (a `DesignEvidence` id, a pull-request delivery
-- id, …) resolved by the registry handler for `kind` — NOT an FK, because the
-- subject's table depends on the kind and a polymorphic FK is worse than none.
--
-- ⚠️ The partial unique index's column list `(work_item_id, kind, subject_id)`
-- is deliberately NOT the column list of any `@@index` on this model: Prisma's
-- differ pairs a DB index to a datamodel index BY COLUMN LIST and cannot
-- express a WHERE clause, so a collision would surface as a permanent spurious
-- RENAME on every `migrate dev` (the partial-index rule in CLAUDE.md,
-- MOTIR-1960). The two `@@index`es are `(workspace_id, state)` and
-- `(work_item_id)` — no pairing.

-- CreateEnum
CREATE TYPE "approval_gate_kind" AS ENUM ('design_result', 'decision_approval', 'pull_request_approval', 'pull_request_merge');

-- CreateEnum
CREATE TYPE "approval_gate_state" AS ENUM ('awaiting', 'approved', 'changes_requested', 'superseded');

-- CreateTable
CREATE TABLE "approval_gate" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "kind" "approval_gate_kind" NOT NULL,
    "subject_id" TEXT NOT NULL,
    "state" "approval_gate_state" NOT NULL DEFAULT 'awaiting',
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "note_md" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_gate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approval_gate_workspace_id_state_idx" ON "approval_gate"("workspace_id", "state");

-- CreateIndex
CREATE INDEX "approval_gate_work_item_id_idx" ON "approval_gate"("work_item_id");

-- AddForeignKey
ALTER TABLE "approval_gate" ADD CONSTRAINT "approval_gate_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_gate" ADD CONSTRAINT "approval_gate_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_gate" ADD CONSTRAINT "approval_gate_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_gate" ADD CONSTRAINT "approval_gate_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The load-bearing invariant: AT MOST ONE `awaiting` gate per
-- (work_item_id, kind, subject_id). A republished design result or a re-linked
-- pull request cannot leave two live gates on one card — the loser hits the
-- unique violation and the repository surfaces a typed domain error (not a raw
-- P2002), which is what the decide-door card branches on. Decided/superseded
-- rows are unconstrained: approvals ACCUMULATE (ADR §6d), so several approved
-- gates for the same subject coexist across a card's reopen lifecycle.
--
-- ⚠️ Its column list is deliberately NOT the column list of any `@@index` on
-- this model (see the header): Prisma's differ pairs a DB index to a datamodel
-- index BY COLUMN LIST and cannot express a WHERE clause, so a collision would
-- surface as a permanent spurious RENAME on every `migrate dev`. The
-- `approval_gate_work_item_id_idx` is `(work_item_id)`, this one is
-- `(work_item_id, kind, subject_id)` — no pairing.
CREATE UNIQUE INDEX "approval_gate_one_awaiting_per_subject"
  ON "approval_gate" ("work_item_id", "kind", "subject_id")
  WHERE "state" = 'awaiting';

-- Row-level security: pure active-workspace gate (USING governs read/update/
-- delete visibility; WITH CHECK blocks writing a row into a foreign workspace).
ALTER TABLE "approval_gate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_gate" FORCE ROW LEVEL SECURITY;

CREATE POLICY "approval_gate_active_workspace" ON "approval_gate"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
