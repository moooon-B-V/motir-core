-- CreateEnum
CREATE TYPE "saved_filter_subscription_schedule" AS ENUM ('daily', 'weekdays', 'weekly');

-- CreateTable
CREATE TABLE "saved_filter_subscription" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "saved_filter_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "schedule" "saved_filter_subscription_schedule" NOT NULL,
    "weekday" INTEGER,
    "hour" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_filter_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saved_filter_subscription_hour_idx" ON "saved_filter_subscription"("hour");

-- CreateIndex
CREATE INDEX "saved_filter_subscription_saved_filter_id_idx" ON "saved_filter_subscription"("saved_filter_id");

-- CreateIndex
CREATE INDEX "saved_filter_subscription_workspace_id_idx" ON "saved_filter_subscription"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "saved_filter_subscription_saved_filter_id_user_id_key" ON "saved_filter_subscription"("saved_filter_id", "user_id");

-- AddForeignKey
ALTER TABLE "saved_filter_subscription" ADD CONSTRAINT "saved_filter_subscription_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_filter_subscription" ADD CONSTRAINT "saved_filter_subscription_saved_filter_id_fkey" FOREIGN KEY ("saved_filter_id") REFERENCES "saved_filter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_filter_subscription" ADD CONSTRAINT "saved_filter_subscription_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- RLS (Story 6.2 · Subtask 6.2.5). The saved-filter RLS pattern, EXTENDED with
-- the job-ledger system-admin branch:
--   * the WORKSPACE branch scopes in-app reads/writes (subscribe / unsubscribe /
--     dependents count) to the active workspace, tested on the row's
--     DENORMALIZED workspace_id (immutable — see the schema comment) so the
--     policy needs no join.
--   * the SYSTEM-ADMIN branch admits every row when `app.system_admin` is set,
--     so the cross-workspace hourly delivery cron can scan due rows under
--     withSystemContext (the attachment-GC precedent). The parent saved_filter
--     policy has NO system branch, which is exactly why the tick reads the
--     denormalized workspace_id here and resolves the filter LATER, as the
--     subscriber, in that workspace's context.
-- ENABLE + FORCE so the table-owner role is subject too. Grants ride the
-- workspace-RLS migration's ALTER DEFAULT PRIVILEGES (auto-granted on new
-- owner-created tables, like saved_filter / star).
-- ===========================================================================
ALTER TABLE "saved_filter_subscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "saved_filter_subscription" FORCE ROW LEVEL SECURITY;

CREATE POLICY "saved_filter_subscription_access" ON "saved_filter_subscription"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );
