-- The notification budget's read (MOTIR-5873).
--
-- `emailService` now counts the notification-class messages the provider
-- accepted in the last 24 hours before every notification send, so the quota
-- a burst of watcher mail used to spend (277 dead letters, 2026-09-14..15)
-- stays available to password-reset and invite mail. The count spans every
-- workspace, so neither existing index — `(workspace_id, created_at)` leads on
-- the tenant — serves it; without this the table, which is never pruned, is
-- scanned whole on every notification.
--
-- A plain index on one column, modelled as `@@index([createdAt])`, so
-- `migrate diff` pairs it and reports no drift.

-- CreateIndex
CREATE INDEX "email_delivery_created_at_idx" ON "email_delivery"("created_at");
