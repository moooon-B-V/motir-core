-- MOTIR-6921 · agent-instance-storage.md §4: when an org's AI plan lapses, its
-- agents are deleted 30 days later unless the plan is renewed.

-- AlterTable
ALTER TABLE "organization" ADD COLUMN "ai_plan_lapsed_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "agent_instance" ADD COLUMN "scheduled_deletion_at" TIMESTAMP(3),
ADD COLUMN "deletion_noticed_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "agent_instance_scheduled_deletion_at_idx" ON "agent_instance"("scheduled_deletion_at");
