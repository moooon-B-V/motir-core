-- Story MOTIR-693 · MOTIR-700 — what each design Revise did about an automatic hosted
-- re-run (`docs/decisions/hosted-design-rerun-and-design-approval-switch.md` §1).
-- One row per refusal, keyed on the deciding gate.

CREATE TYPE "design_auto_rerun_outcome" AS ENUM ('started', 'skipped');

CREATE TYPE "design_auto_rerun_skip_reason" AS ENUM (
  'cap_reached',
  'dispatcher_gone',
  'no_project_access',
  'ci_credits_exhausted',
  'model_not_offered',
  'models_unavailable',
  'out_of_credits',
  'credits_unavailable',
  'repository_not_writable',
  'card_not_ready'
);

CREATE TABLE "design_auto_rerun" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "gate_id" TEXT NOT NULL,
    "outcome" "design_auto_rerun_outcome" NOT NULL,
    "skip_reason" "design_auto_rerun_skip_reason",
    "dispatch_run_id" TEXT,
    "ordinal" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "design_auto_rerun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "design_auto_rerun_gate_id_key" ON "design_auto_rerun"("gate_id");
CREATE INDEX "design_auto_rerun_work_item_id_created_at_idx" ON "design_auto_rerun"("work_item_id", "created_at");

ALTER TABLE "design_auto_rerun" ADD CONSTRAINT "design_auto_rerun_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "design_auto_rerun" ADD CONSTRAINT "design_auto_rerun_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "design_auto_rerun" ADD CONSTRAINT "design_auto_rerun_gate_id_fkey" FOREIGN KEY ("gate_id") REFERENCES "approval_gate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "design_auto_rerun" ADD CONSTRAINT "design_auto_rerun_dispatch_run_id_fkey" FOREIGN KEY ("dispatch_run_id") REFERENCES "dispatch_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ⚠️ `outcome` and `skip_reason` agree: a reason exactly when nothing started.
ALTER TABLE "design_auto_rerun" ADD CONSTRAINT "design_auto_rerun_reason_matches_outcome"
  CHECK (("outcome" = 'skipped') = ("skip_reason" IS NOT NULL));

-- Row-level security: pure active-workspace gate.
ALTER TABLE "design_auto_rerun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "design_auto_rerun" FORCE ROW LEVEL SECURITY;

CREATE POLICY "design_auto_rerun_active_workspace" ON "design_auto_rerun"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
