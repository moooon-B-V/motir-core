-- Rename attachment.blob_url -> blob_pathname (Story MOTIR-1665 / Subtask MOTIR-1667):
-- content attachments are now PRIVATE and store the blob PATHNAME (the key), not a
-- public URL. Served through the authenticated content route. No backfill (the prod
-- store has 0 files).
ALTER TABLE "attachment" RENAME COLUMN "blob_url" TO "blob_pathname";
