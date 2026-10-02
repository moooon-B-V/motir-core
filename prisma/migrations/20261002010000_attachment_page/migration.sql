-- Page images stay with their page (Story MOTIR-5752 · MOTIR-7279).
--
-- An image uploaded into a page is an attachment OWNED by that page from its
-- first moment. Without an owner column the row would sit with work_item_id
-- NULL — exactly what the orphan-GC sweeps after seven days, blob first — so a
-- page image would render for a week and then vanish.
--
-- ON DELETE SET NULL, not CASCADE, for the reason Attachment.workItemId gives:
-- deleting a page must leave the row behind, unowned, so the GC can still find
-- it and delete the BLOB. A cascade would remove the row and strand the blob.

-- AlterTable
ALTER TABLE "attachment" ADD COLUMN "page_id" TEXT;

-- An attachment has at most one owner: a work item OR a page, never both.
ALTER TABLE "attachment"
  ADD CONSTRAINT "attachment_owner_at_most_one" CHECK (num_nonnulls("work_item_id", "page_id") <= 1);

-- CreateIndex
CREATE INDEX "attachment_page_id_created_at_idx" ON "attachment"("page_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "page"("id") ON DELETE SET NULL ON UPDATE CASCADE;
