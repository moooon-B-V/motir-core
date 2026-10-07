-- Story MOTIR-7701 · MOTIR-7703 — the approval gates a run stopped at when it closed
-- `gated` (`docs/decisions/dispatch-run-record.md` AMENDMENT 2026-10-07). Derived by the
-- close itself, one row per awaiting holding gate on the run's scope cards.

-- CreateTable
CREATE TABLE "dispatch_run_held_gate" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "dispatch_run_id" TEXT NOT NULL,
    "gate_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "kind" "approval_gate_kind" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_run_held_gate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dispatch_run_held_gate_gate_id_idx" ON "dispatch_run_held_gate"("gate_id");

-- CreateIndex
CREATE INDEX "dispatch_run_held_gate_work_item_id_idx" ON "dispatch_run_held_gate"("work_item_id");

-- CreateIndex
CREATE INDEX "dispatch_run_held_gate_workspace_id_idx" ON "dispatch_run_held_gate"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "dispatch_run_held_gate_dispatch_run_id_gate_id_key" ON "dispatch_run_held_gate"("dispatch_run_id", "gate_id");

-- AddForeignKey
ALTER TABLE "dispatch_run_held_gate" ADD CONSTRAINT "dispatch_run_held_gate_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_run_held_gate" ADD CONSTRAINT "dispatch_run_held_gate_dispatch_run_id_fkey" FOREIGN KEY ("dispatch_run_id") REFERENCES "dispatch_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_run_held_gate" ADD CONSTRAINT "dispatch_run_held_gate_gate_id_fkey" FOREIGN KEY ("gate_id") REFERENCES "approval_gate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_run_held_gate" ADD CONSTRAINT "dispatch_run_held_gate_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security: pure active-workspace gate.
ALTER TABLE "dispatch_run_held_gate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dispatch_run_held_gate" FORCE ROW LEVEL SECURITY;

CREATE POLICY "dispatch_run_held_gate_active_workspace" ON "dispatch_run_held_gate"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
