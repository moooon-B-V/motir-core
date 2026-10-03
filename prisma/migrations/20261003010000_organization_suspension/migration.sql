-- Organization SUSPENSION (Story 10.3 · MOTIR-748).
--
-- The enforced state of a platform `superadmin`'s suspend: the timestamp the
-- access gate reads, the live reason, and who did it. The history of every
-- suspend / reactivate is the hash-chained `platform_audit_log`
-- (`org.suspend` / `org.reactivate`), written in the same transaction.
--
-- No new policy: the platform tier's `organization_platform_staff_read` and
-- `organization_platform_staff_update` arms (20260905120000) already admit the
-- console's read and its UPDATE of these columns, and every tenant read of the
-- org row is unchanged.

-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "suspended_at" TIMESTAMP(3),
ADD COLUMN     "suspended_by_user_id" TEXT,
ADD COLUMN     "suspended_reason" TEXT;

-- AddForeignKey
ALTER TABLE "organization" ADD CONSTRAINT "organization_suspended_by_user_id_fkey" FOREIGN KEY ("suspended_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
