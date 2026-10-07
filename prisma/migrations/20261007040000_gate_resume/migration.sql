-- Story MOTIR-7701 · MOTIR-7710 — what each approval did about resuming the hosted run
-- it released. One row per approved gate a `gated` hosted run held, keyed on the gate.

CREATE TYPE "gate_resume_outcome" AS ENUM ('started', 'skipped');

CREATE TYPE "gate_resume_skip_reason" AS ENUM (
  'dispatcher_gone',
  'no_project_access',
  'ci_credits_exhausted',
  'out_of_credits',
  'credits_unavailable',
  'model_not_offered',
  'models_unavailable',
  'repository_not_writable',
  'card_not_ready',
  'already_resumed',
  'not_resumable'
);

CREATE TABLE "gate_resume" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "gate_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "resumed_run_id" TEXT,
    "outcome" "gate_resume_outcome" NOT NULL,
    "skip_reason" "gate_resume_skip_reason",
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gate_resume_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gate_resume_gate_id_key" ON "gate_resume"("gate_id");
CREATE INDEX "gate_resume_run_id_created_at_idx" ON "gate_resume"("run_id", "created_at");
CREATE INDEX "gate_resume_resumed_run_id_idx" ON "gate_resume"("resumed_run_id");

ALTER TABLE "gate_resume" ADD CONSTRAINT "gate_resume_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gate_resume" ADD CONSTRAINT "gate_resume_gate_id_fkey" FOREIGN KEY ("gate_id") REFERENCES "approval_gate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gate_resume" ADD CONSTRAINT "gate_resume_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "dispatch_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gate_resume" ADD CONSTRAINT "gate_resume_resumed_run_id_fkey" FOREIGN KEY ("resumed_run_id") REFERENCES "dispatch_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ⚠️ `outcome` and `skip_reason` agree: a reason exactly when nothing started.
ALTER TABLE "gate_resume" ADD CONSTRAINT "gate_resume_reason_matches_outcome"
  CHECK (("outcome" = 'skipped') = ("skip_reason" IS NOT NULL));

-- Row-level security: pure active-workspace gate.
ALTER TABLE "gate_resume" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gate_resume" FORCE ROW LEVEL SECURITY;

CREATE POLICY "gate_resume_active_workspace" ON "gate_resume"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
