-- MOTIR-6952 · docs/decisions/agent-image-update.md Q6 — moving an agent to a
-- newer sandbox image. Additive only: one new lifecycle value and five nullable
-- columns, so an agent created before this migration reads "no version recorded,
-- no update pending".

-- AlterEnum
ALTER TYPE "agent_instance_state" ADD VALUE 'updating';

-- AlterTable
ALTER TABLE "agent_instance"
  ADD COLUMN "image_version" TEXT,
  ADD COLUMN "target_image_digest" TEXT,
  ADD COLUMN "target_image_version" TEXT,
  ADD COLUMN "update_failure_reason" TEXT,
  ADD COLUMN "update_failed_at" TIMESTAMP(3);
