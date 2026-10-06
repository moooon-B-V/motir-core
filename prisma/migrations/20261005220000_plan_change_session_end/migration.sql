-- MOTIR-7636 — a planning session ENDS (story MOTIR-7630; `agent-authored-plans.md`
-- AMENDMENT 23 §1 and §6). A session is OPEN exactly while `ended_at IS NULL`.
--
-- The columns are added NULLABLE, so every existing read is unchanged until it
-- asks for the end. Only the one end operation writes them afterwards; this
-- migration's BACKFILL is the only other writer, and it runs once.

-- CreateEnum
CREATE TYPE "plan_session_end_reason" AS ENUM ('failed', 'idle', 'restarted', 'declined', 'approved');

-- AlterTable
ALTER TABLE "plan_change_session" ADD COLUMN     "copied_from_session_id" TEXT,
ADD COLUMN     "end_reason" "plan_session_end_reason",
ADD COLUMN     "ended_at" TIMESTAMP(3),
ADD COLUMN     "ended_by_id" TEXT;

-- AddForeignKey
ALTER TABLE "plan_change_session" ADD CONSTRAINT "plan_change_session_ended_by_id_fkey" FOREIGN KEY ("ended_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_change_session" ADD CONSTRAINT "plan_change_session_copied_from_session_id_fkey" FOREIGN KEY ("copied_from_session_id") REFERENCES "plan_change_session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The OPEN-session read (AMENDMENT 23 §3: "your own OPEN session for the
-- scope"). PARTIAL, so it is hand-written and invisible to the datamodel — and
-- its column list is deliberately NOT the `@@index([projectId, scopeKey,
-- createdById, lastActivityAt])` one, because Prisma's differ pairs indexes by
-- column list and would otherwise report a permanent spurious rename
-- (`motir-core/CLAUDE.md`, the partial-index migration rule).
CREATE INDEX "plan_change_session_open_scope_member_idx"
  ON "plan_change_session" ("project_id", "scope_key", "created_by_id")
  WHERE "ended_at" IS NULL;

-- ── BACKFILL (AMENDMENT 23 §1) ────────────────────────────────────────────────
-- Every existing session is classified from its LATEST plan (newest
-- `created_at`, `id` breaking a tie — the same row the Plans list reads), in the
-- order the decision fixes. Each statement touches only sessions still OPEN, so
-- the four run in order without overlapping and a second run of the file changes
-- nothing. A `guide` conversation submits no plan and is never ended here.

-- 1. latest plan `approved` ⇒ ended `approved`, by its approver.
UPDATE "plan_change_session" s
SET "ended_at" = COALESCE(lp."decided_at", s."last_activity_at"),
    "end_reason" = 'approved',
    "ended_by_id" = lp."decided_by_id"
FROM (
  SELECT DISTINCT ON (p."session_id") p."session_id", p."status", p."decided_at", p."decided_by_id"
  FROM "plan" p
  WHERE p."session_id" IS NOT NULL
  ORDER BY p."session_id", p."created_at" DESC, p."id" DESC
) lp
WHERE lp."session_id" = s."id"
  AND s."ended_at" IS NULL
  AND s."origin" <> 'guide'
  AND lp."status" = 'approved';

-- 2. latest plan `declined` BY A PERSON ⇒ ended `declined`, by that person.
UPDATE "plan_change_session" s
SET "ended_at" = COALESCE(lp."decided_at", s."last_activity_at"),
    "end_reason" = 'declined',
    "ended_by_id" = lp."decided_by_id"
FROM (
  SELECT DISTINCT ON (p."session_id") p."session_id", p."status", p."decided_at", p."decided_by_id", p."decision_reason"
  FROM "plan" p
  WHERE p."session_id" IS NOT NULL
  ORDER BY p."session_id", p."created_at" DESC, p."id" DESC
) lp
WHERE lp."session_id" = s."id"
  AND s."ended_at" IS NULL
  AND s."origin" <> 'guide'
  AND lp."status" = 'declined'
  AND lp."decided_by_id" IS NOT NULL
  AND lp."decision_reason" IS DISTINCT FROM 'abandoned';

-- 3. latest plan `declined` by NOBODY — swept as `abandoned`, or closed with no
--    decider ⇒ ended `failed`, by Motir (reads Closed).
UPDATE "plan_change_session" s
SET "ended_at" = COALESCE(lp."decided_at", s."last_activity_at"),
    "end_reason" = 'failed',
    "ended_by_id" = NULL
FROM (
  SELECT DISTINCT ON (p."session_id") p."session_id", p."status", p."decided_at"
  FROM "plan" p
  WHERE p."session_id" IS NOT NULL
  ORDER BY p."session_id", p."created_at" DESC, p."id" DESC
) lp
WHERE lp."session_id" = s."id"
  AND s."ended_at" IS NULL
  AND s."origin" <> 'guide'
  AND lp."status" = 'declined';

-- 4. NO undecided plan and idle past the session lease (30 minutes,
--    `PLAN_TARGET_LOCK_LEASE_MS`) ⇒ ended `idle`, by Motir, at the moment the
--    lease ran out. A session whose plan waits for a decision stays open.
UPDATE "plan_change_session" s
SET "ended_at" = s."last_activity_at" + INTERVAL '30 minutes',
    "end_reason" = 'idle',
    "ended_by_id" = NULL
WHERE s."ended_at" IS NULL
  AND s."origin" <> 'guide'
  AND s."last_activity_at" < now() - INTERVAL '30 minutes'
  AND NOT EXISTS (
    SELECT 1 FROM "plan" p
    WHERE p."session_id" = s."id"
      AND p."status" IN ('generating', 'planned', 'stale')
  );

-- 5. Everything else stays OPEN.
