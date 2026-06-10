-- Comments + mentions data model (Story 5.1 · Subtask 5.1.1). This migration
-- ships, in one atomic step (migration-by-concern, PRODECT_FINDINGS #20 — a
-- table lands WITH its RLS policy so there is never an unguarded window):
--   1. the `comment` table (threaded ONE level deep via the nullable
--      `parent_comment_id` self-FK — the Jira-verified decision recorded in
--      scripts/plan-seed/data/story-5.1.ts; depth >1 is rejected in the
--      SERVICE, 5.1.2), its indexes + FKs;
--   2. the `comment_mention` table (the queryable "mentions me" substrate —
--      one row per validated mention, unique per comment × user);
--   3. ENABLE + FORCE row-level security on both + their tenancy policies.
--
-- Delete semantics (the Jira-faithful hard delete): a root comment's delete
-- CASCADES its replies (`parent_comment_id` self-FK) and every mention row
-- (`comment_mention.comment_id`); a work-item hard delete cascades its whole
-- thread. `author_id` is RESTRICT, mirroring `work_item.reporterId` — a user
-- with comments on record cannot be hard-deleted silently. The mention's
-- `mentioned_user_id` is CASCADE (a mention row is notification substrate,
-- not audit — it goes with the user, mirroring project_membership).
--
-- RLS policy shapes:
--   * `comment` — pure workspace gate (NON-NULL `workspace_id`, every write
--     happens inside an active workspace context), the same single PERMISSIVE
--     FOR ALL policy as `attachment` / `board` / `sprint`: USING + WITH CHECK
--     against `current_setting('app.workspace_id', true)` (`true` = missing_ok,
--     so an unset GUC yields NULL → predicate NULL → row hidden — safe failure).
--     ENABLE + FORCE so even the table-owner `prodect` role is subject to it
--     (production connects as the non-BYPASSRLS `prodect_app` role,
--     PRODECT_FINDINGS #5). No system-admin escape hatch — every comment is
--     tenanted (the hatch exists only on the untenanted `job_run*` tables).
--   * `comment_mention` — NO `workspace_id` column by design (denormalizing
--     tenancy onto a child row would let it lie about its workspace), so the
--     policy JOINS through the parent `comment` and tests THAT row's
--     `workspace_id` — structurally the `work_item_revision` pattern. The
--     EXISTS resolves via `comment_pkey` (one index lookup per row touched).
--     WITH CHECK closes the "insert a mention pointing at someone else's
--     comment" hole. NOTE the parent policy composes: the inner `comment`
--     read is itself RLS-gated for non-bypass roles, which is exactly the
--     same-workspace predicate this policy wants.
-- Grants: the workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO
-- prodect_app` auto-grants on every NEW table created by the `prodect` role,
-- so neither table needs an explicit GRANT (same as board / sprint).

-- CreateTable
CREATE TABLE "comment" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "parent_comment_id" TEXT,
    "body_md" TEXT NOT NULL,
    "edited_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment_mention" (
    "id" TEXT NOT NULL,
    "comment_id" TEXT NOT NULL,
    "mentioned_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_mention_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "comment_work_item_id_created_at_idx" ON "comment"("work_item_id", "created_at");

-- CreateIndex
CREATE INDEX "comment_parent_comment_id_idx" ON "comment"("parent_comment_id");

-- CreateIndex
CREATE INDEX "comment_workspace_id_idx" ON "comment"("workspace_id");

-- CreateIndex
CREATE INDEX "comment_mention_mentioned_user_id_idx" ON "comment_mention"("mentioned_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "comment_mention_comment_id_mentioned_user_id_key" ON "comment_mention"("comment_id", "mentioned_user_id");

-- AddForeignKey
ALTER TABLE "comment" ADD CONSTRAINT "comment_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment" ADD CONSTRAINT "comment_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment" ADD CONSTRAINT "comment_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment" ADD CONSTRAINT "comment_parent_comment_id_fkey" FOREIGN KEY ("parent_comment_id") REFERENCES "comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_mention" ADD CONSTRAINT "comment_mention_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_mention" ADD CONSTRAINT "comment_mention_mentioned_user_id_fkey" FOREIGN KEY ("mentioned_user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — comment (pure workspace gate, no escape hatch)
-- ===========================================================================
ALTER TABLE "comment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "comment" FORCE ROW LEVEL SECURITY;

CREATE POLICY "comment_active_workspace" ON "comment"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

-- ===========================================================================
-- Row-level security — comment_mention (joins through the parent comment,
-- the work_item_revision pattern — see the header comment)
-- ===========================================================================
ALTER TABLE "comment_mention" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "comment_mention" FORCE ROW LEVEL SECURITY;

CREATE POLICY "comment_mention_active_workspace" ON "comment_mention"
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM "comment" c
      WHERE c."id" = "comment_mention"."comment_id"
        AND c."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "comment" c
      WHERE c."id" = "comment_mention"."comment_id"
        AND c."workspace_id" = current_setting('app.workspace_id', true)
    )
  );
