-- MOTIR-8968: admission picks the account per job.

-- CreateEnum
CREATE TYPE "fleet_shard_pause_reason" AS ENUM ('capacity_refused', 'provider_unavailable');

-- CreateEnum
CREATE TYPE "fleet_shard_move_reason" AS ENUM ('capacity_refused', 'provider_unavailable');

-- AlterTable
ALTER TABLE "ci_runner_provisioning_intent" ADD COLUMN     "fleet_shard_move_reason" "fleet_shard_move_reason",
ADD COLUMN     "shard_capacity_deferred_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "fleet_shard" ADD COLUMN     "admission_ceiling_override" INTEGER,
ADD COLUMN     "admission_paused_reason" "fleet_shard_pause_reason",
ADD COLUMN     "admission_paused_until" TIMESTAMP(3);

-- An override is a ceiling, never zero or negative: NULL means "derived".
ALTER TABLE "fleet_shard" ADD CONSTRAINT "fleet_shard_admission_ceiling_override_positive_check"
  CHECK ("admission_ceiling_override" IS NULL OR "admission_ceiling_override" > 0);
