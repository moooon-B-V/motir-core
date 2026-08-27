-- The DELIVERY LINK — one join table between work item and pull request
-- (Story MOTIR-3655 · MOTIR-3657), specified by
-- `docs/decisions/work-item-delivery-links.md`.
--
-- This is the EXPAND step and it drops nothing. `work_item."sessionBranch"` and
-- `github_pull_request."work_item_id"` both keep every reader and writer they have
-- today; each reader is moved to this table by a later card of this story, and the
-- columns themselves are dropped by a follow-up once nothing reads them. A column
-- dropped ahead of its readers leaves no state in which the old ones are correct.
--
-- Workspace-scoped tenant data, so its RLS policy lands in THIS SAME migration
-- (migration-by-concern, PRODECT_FINDINGS #20 — no unguarded window), and
-- `workspace_id` is carried on the ROW because RLS does not traverse foreign keys.
-- Note `github_pull_request` has NO workspace column of its own — it reads tenancy
-- through `github_repo` — which is exactly why this table does not copy that shape.
-- All four FKs are modelled as Prisma `@relation`s (forward + back-relation) with
-- the SAME actions this SQL uses, so `migrate diff` reports no drift.
--
-- The UNIQUE index is the corruption this table must make impossible in the
-- DATABASE rather than "the service checks first":
--
--   * `work_item_delivery_work_item_id_github_pull_request_id_key` — one link per
--     (card, pull request). A repeat `link_pull_request` is a no-op rather than a
--     second row, which is what makes the tool idempotent under redelivery and
--     agent retry, and the arbiter of a lost race.
--
-- `repo_id` is a REAL column and not a join away: the completion gate compares each
-- member's merge against THAT repository's own default branch, and resolving it per
-- member through the pull request would be an N+1 on the delivery path.

-- CreateTable
CREATE TABLE "work_item_delivery" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "github_pull_request_id" TEXT NOT NULL,
    "repo_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "work_item_delivery_work_item_id_github_pull_request_id_key" ON "work_item_delivery"("work_item_id", "github_pull_request_id");

-- CreateIndex
CREATE INDEX "work_item_delivery_workspace_id_idx" ON "work_item_delivery"("workspace_id");

-- CreateIndex
CREATE INDEX "work_item_delivery_github_pull_request_id_idx" ON "work_item_delivery"("github_pull_request_id");

-- CreateIndex
CREATE INDEX "work_item_delivery_repo_id_idx" ON "work_item_delivery"("repo_id");

-- AddForeignKey
ALTER TABLE "work_item_delivery" ADD CONSTRAINT "work_item_delivery_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_delivery" ADD CONSTRAINT "work_item_delivery_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_delivery" ADD CONSTRAINT "work_item_delivery_github_pull_request_id_fkey" FOREIGN KEY ("github_pull_request_id") REFERENCES "github_pull_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_delivery" ADD CONSTRAINT "work_item_delivery_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "github_repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- BACKFILL, in two passes, in this order. Both are guarded so this migration is a
-- no-op on a database with no pull requests, and both are re-runnable: the unique
-- index plus `ON CONFLICT DO NOTHING` make a second application insert nothing.
--
-- Pass 1 — the EXACT one. Every non-null `github_pull_request."work_item_id"` is
-- already a (card, pull request) pair, and the row carries its `repo_id`. One row
-- out per row in, no inference and no ambiguity. This covers every explicitly
-- linked pull request AND every one the title parse ever linked — the parse's
-- output is a stored link like any other, and MOTIR-3674 decides separately whether
-- those rows are grandfathered.
--
-- `workspace_id` is taken from the WORK ITEM, which is the tenant of record for the
-- link. The join to `github_repo` is a GUARD rather than a source: a pull request
-- whose repository belongs to a different workspace than the card it names is
-- corrupt, and this backfill declines to carry that corruption forward.
INSERT INTO "work_item_delivery" ("id", "workspace_id", "work_item_id", "github_pull_request_id", "repo_id")
SELECT gen_random_uuid()::text,
       w."workspaceId",
       w."id",
       pr."id",
       pr."repo_id"
FROM "github_pull_request" pr
JOIN "work_item" w ON w."id" = pr."work_item_id"
JOIN "github_repo" gr ON gr."id" = pr."repo_id" AND gr."workspace_id" = w."workspaceId"
ON CONFLICT ("work_item_id", "github_pull_request_id") DO NOTHING;

-- Pass 2 — the SESSION BRANCH population, which pass 1 cannot see. A `motir auto`
-- pull request carries `work_item_id: null` by construction (its branch deliberately
-- holds no `MOTIR-<n>`), and its cards are joined to it only by
-- `work_item."sessionBranch" = github_pull_request."head_ref"`.
--
-- ⚠️ A branch name matching pull requests in TWO repositories writes TWO rows, and
-- that is the CORRECT answer rather than an ambiguity to collapse: the runbook uses
-- one branch name across every repository a card touches, so both pull requests
-- really do deliver that card. This is the case a branch-KEYED link could not
-- express — `findBySessionBranch` is workspace-scoped, not repository-scoped — and
-- it is the reason the decision keys on the pull-request row instead.
--
-- What this pass CANNOT do is write a link for a `sessionBranch` that matches no
-- pull request row at all — an un-pushed branch, or one opened outside the App's
-- installation. There is nothing to reference, so no row is written and the card
-- simply carries an empty delivery set, which is the same state as a card that
-- never had a branch. The NOTICE below counts that population.
INSERT INTO "work_item_delivery" ("id", "workspace_id", "work_item_id", "github_pull_request_id", "repo_id")
SELECT gen_random_uuid()::text,
       w."workspaceId",
       w."id",
       pr."id",
       pr."repo_id"
FROM "work_item" w
JOIN "github_repo" gr ON gr."workspace_id" = w."workspaceId"
JOIN "github_pull_request" pr ON pr."repo_id" = gr."id" AND pr."head_ref" = w."sessionBranch"
WHERE w."sessionBranch" IS NOT NULL
ON CONFLICT ("work_item_id", "github_pull_request_id") DO NOTHING;

-- REPORT what the two passes wrote and what they could not resolve. A session
-- branch that names no pull request is a FINDING, not a no-op, and this is the one
-- number that says how large that population is. Emitted as a NOTICE so it lands in
-- the `migrate deploy` log of whichever database this runs against, rather than
-- being a number only the author's laptop ever saw.
DO $$
DECLARE
  total_links        integer;
  branch_unresolved  integer;
  multi_pr_cards     integer;
BEGIN
  SELECT count(*) INTO total_links FROM "work_item_delivery";

  SELECT count(*) INTO branch_unresolved
  FROM "work_item" w
  WHERE w."sessionBranch" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "work_item_delivery" d WHERE d."work_item_id" = w."id"
    );

  SELECT count(*) INTO multi_pr_cards
  FROM (
    SELECT "work_item_id" FROM "work_item_delivery" GROUP BY "work_item_id" HAVING count(*) > 1
  ) AS m;

  RAISE NOTICE 'work_item_delivery backfill: % link(s) written; % card(s) whose sessionBranch matched no pull request (empty delivery set); % card(s) now carrying MORE THAN ONE delivery',
    total_links, branch_unresolved, multi_pr_cards;
END
$$;

-- RLS, in the same migration as the table (no unguarded window). FORCE so even the
-- table-owner `prodect` role is subject to it — production and the service writes
-- connect as the non-BYPASSRLS `prodect_app` role.
--
-- The gate is the row's OWN `workspace_id`, not a join through `work_item` or
-- `github_pull_request` — RLS does not traverse foreign keys.
--
-- The workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO prodect_app`
-- auto-grants on every NEW table created by the `prodect` role, so no explicit
-- GRANT is needed (same as work_item_repository / project_repository / sprint).
ALTER TABLE "work_item_delivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "work_item_delivery" FORCE ROW LEVEL SECURITY;

CREATE POLICY "work_item_delivery_active_workspace" ON "work_item_delivery"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
