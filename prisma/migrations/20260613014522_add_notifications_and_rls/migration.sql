-- In-app notification data model (Story 5.7 · Subtask 5.7.2). Ships, in one
-- atomic step (migration-by-concern, PRODECT_FINDINGS #20 — a table lands WITH
-- its RLS policy so there is never an unguarded window):
--   1. the `notification_category` enum (the Direct/Watching drawer split —
--      Jira's closed two-tab set; `type` stays a plain TEXT discriminator so
--      Stories 5.4/6.6 fan in new event types with no migration);
--   2. the `notification` table — the persistence behind the header bell +
--      unread feed (written by the 5.7.3 fan-in job, read by 5.7.4), its
--      indexes + FKs;
--   3. a PARTIAL index backing the cheap unread-count aggregate;
--   4. ENABLE + FORCE row-level security + the tenancy policy.
--
-- Delete semantics: `recipient_user_id` CASCADE (a notification is per-user
-- notification substrate — it dies with the user, the watcher / comment_mention
-- precedent, NOT the reporter Restrict); `work_item_id` CASCADE (a deleted
-- issue's deep-link target would 404, so its notifications go with it);
-- `actor_id` SET NULL (a departed actor leaves the row intact + unattributed,
-- the assignee semantics); `workspace_id` CASCADE (tenant teardown).
--
-- Idempotency: the UNIQUE on (`dedupe_key`, `recipient_user_id`) makes the
-- 5.7.3 fan-in `createMany(skipDuplicates: true)` turn a replayed/retried
-- event into a no-op. `dedupe_key` carries the SOURCE identity (`comment:<id>`
-- / `mentioned:<revisionId>`), mirroring the SHIPPED 5.1.6 email idempotency
-- key (keyed on the stable source id, not the per-delivery event id).
--
-- The unread-count index is a PARTIAL index (`WHERE read_at IS NULL`): the
-- badge aggregate is `COUNT(*) WHERE recipient_user_id = ? AND read_at IS NULL`,
-- which an index over only the unread rows serves as an index-only scan,
-- never a sequential scan over a table that grows unbounded per active user
-- (finding #57). Prisma's schema DSL cannot express a WHERE-filtered index, so
-- it lives here as raw SQL — exactly like `workflow_status_one_initial_per_
-- project` / `board_one_default_per_project`; `migrate dev` does not drift on
-- it. The unread rows are the hot set (read rows accumulate but are rarely
-- counted), so the partial index stays small even as the table grows.
--
-- RLS: pure workspace gate (NON-NULL `workspace_id`), the SAME single
-- PERMISSIVE FOR ALL policy as `comment` / `board` / `sprint`: USING +
-- WITH CHECK against `current_setting('app.workspace_id', true)` (`true` =
-- missing_ok, so an unset GUC yields NULL → predicate NULL → row hidden, the
-- safe failure). ENABLE + FORCE so even the table-owner `prodect` role is
-- subject to it (production connects as the non-BYPASSRLS `prodect_app` role,
-- PRODECT_FINDINGS #5). The PER-USER boundary (a user reads only their OWN
-- rows) is the 5.7.4 service's concern (`recipient_user_id = session user`),
-- NOT RLS — RLS is the tenant gate, not the per-recipient gate. Grants: the
-- workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO prodect_app`
-- auto-grants on every NEW table created by the `prodect` role, so no explicit
-- GRANT is needed (same as comment / board / sprint).

-- CreateEnum
CREATE TYPE "notification_category" AS ENUM ('direct', 'watching');

-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "recipient_user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "category" "notification_category" NOT NULL,
    "work_item_id" TEXT,
    "actor_id" TEXT,
    "data" JSONB NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_recipient_user_id_created_at_idx" ON "notification"("recipient_user_id", "created_at");

-- CreateIndex
CREATE INDEX "notification_workspace_id_idx" ON "notification"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_dedupe_key_recipient_user_id_key" ON "notification"("dedupe_key", "recipient_user_id");

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Partial index — the cheap unread-count aggregate (the bell badge poll)
-- ===========================================================================
-- Only the UNREAD rows participate, so `countUnreadByRecipient`
-- (`COUNT(*) WHERE recipient_user_id = ? AND read_at IS NULL`) is an index-only
-- scan over a small hot set, never a seq scan as the table grows (finding #57).
-- Prisma's schema DSL cannot express a WHERE-filtered index, so it lives here
-- as raw SQL (the workflow_status_one_initial_per_project precedent); migrate
-- dev does not drift on it.
CREATE INDEX "notification_unread_idx"
  ON "notification"("recipient_user_id")
  WHERE "read_at" IS NULL;

-- ===========================================================================
-- Row-level security — notification (pure workspace gate, no escape hatch)
-- ===========================================================================
ALTER TABLE "notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification" FORCE ROW LEVEL SECURITY;

CREATE POLICY "notification_active_workspace" ON "notification"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
