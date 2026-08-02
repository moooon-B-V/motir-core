-- AlterTable
ALTER TABLE "ci_runner_provisioning_intent" ADD COLUMN     "boot_latency_ms" INTEGER,
ADD COLUMN     "booted_at" TIMESTAMP(3),
ADD COLUMN     "container_id" TEXT,
ADD COLUMN     "container_provider" TEXT,
ADD COLUMN     "container_region" TEXT,
ADD COLUMN     "failure_detail" TEXT,
ADD COLUMN     "github_runner_id" INTEGER,
ADD COLUMN     "runner_name" TEXT,
ADD COLUMN     "settled_at" TIMESTAMP(3),
ADD COLUMN     "started_at" TIMESTAMP(3),
ADD COLUMN     "teardown_reason" TEXT;

-- CreateIndex
CREATE INDEX "ci_runner_provisioning_intent_status_booted_at_idx" ON "ci_runner_provisioning_intent"("status", "booted_at");
