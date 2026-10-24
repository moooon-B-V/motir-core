-- AlterTable
ALTER TABLE "ci_runner_provisioning_intent" ADD COLUMN     "fleet_shard_id" TEXT;

-- CreateIndex
CREATE INDEX "ci_runner_provisioning_intent_fleet_shard_id_idx" ON "ci_runner_provisioning_intent"("fleet_shard_id");

-- AddForeignKey
ALTER TABLE "ci_runner_provisioning_intent" ADD CONSTRAINT "ci_runner_provisioning_intent_fleet_shard_id_fkey" FOREIGN KEY ("fleet_shard_id") REFERENCES "fleet_shard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

