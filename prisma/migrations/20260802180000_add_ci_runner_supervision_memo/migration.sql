-- AlterTable
ALTER TABLE "ci_runner_provisioning_intent" ADD COLUMN     "supervision_key" TEXT,
ADD COLUMN     "supervision_outcome" JSONB;
