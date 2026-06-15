-- Production drift repair (hotfix).
--
-- The 20260613221114_add_work_item_triage_marker migration (6.11.3) adds
-- `work_item.externalSubmitterName` / `externalSubmitterEmail` / `triagedAt` /
-- `snoozedUntil` + the (projectId, triagedAt) index. On production that
-- migration was recorded APPLIED without its ALTER actually running (a
-- `migrate resolve --applied` workaround taken during a shared-dev-DB drift), so
-- production's `work_item` table is MISSING those columns — while schema.prisma
-- and the generated Prisma client SELECT them on every `work_item.findUnique`.
-- Result: every full-row work-item read 500s with `P2022 ColumnNotFound`
-- (the epic rollup `GET /api/work-items/[id]/rollup` is the reported symptom;
-- `findById` selects all scalars).
--
-- This forward-only migration re-creates exactly those objects IDEMPOTENTLY:
-- on production it adds the missing columns/index; on any DB that already has
-- them (dev, CI, a correctly-migrated environment) every statement is a no-op.
-- No data change, no column drop — schema.prisma is unchanged, so `migrate dev`
-- reports no drift.

ALTER TABLE "work_item" ADD COLUMN IF NOT EXISTS "externalSubmitterEmail" TEXT;
ALTER TABLE "work_item" ADD COLUMN IF NOT EXISTS "externalSubmitterName" TEXT;
ALTER TABLE "work_item" ADD COLUMN IF NOT EXISTS "snoozedUntil" TIMESTAMP(3);
ALTER TABLE "work_item" ADD COLUMN IF NOT EXISTS "triagedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "work_item_projectId_triagedAt_idx" ON "work_item"("projectId", "triagedAt");
