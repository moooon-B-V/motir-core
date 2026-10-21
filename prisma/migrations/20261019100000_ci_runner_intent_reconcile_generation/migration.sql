-- AlterTable
ALTER TABLE "ci_runner_provisioning_intent" ADD COLUMN     "reconcile_generation" INTEGER NOT NULL DEFAULT 0;

-- DropIndex
DROP INDEX "ci_runner_provisioning_intent_run_id_run_attempt_job_id_key";

-- CreateIndex
CREATE UNIQUE INDEX "ci_runner_provisioning_intent_run_id_run_attempt_job_id_rec_key" ON "ci_runner_provisioning_intent"("run_id", "run_attempt", "job_id", "reconcile_generation");
