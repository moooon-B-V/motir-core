-- THE CI FEEDBACK COMMENT, PER DELIVERED CARD (MOTIR-3770), specified by
-- `docs/decisions/ci-feedback-comment-per-card.md`.
--
-- The comment's KEY does not move. MOTIR-2946 settled it as one comment per
-- `(change request, head commit)` carrying the AGGREGATE over that commit's whole
-- check set, after a per-check key put ~34 comments on one work item. What this
-- table adds is the third coordinate that key always implied and nothing could
-- store: WHICH CARD the comment sits on. A pull request delivering N cards is N
-- rows.
--
-- It supersedes `github_check_run.feedback_comment_id`, which is a nullable scalar
-- on a table whose grain is one row PER CHECK: one id, replicated across every
-- check row at the commit, however many cards the delivery reached. So a second
-- delivered card carried a `ciState` (per card since MOTIR-3721) and no comment at
-- all — a reader sees "CI has not spoken" exactly when it has.
--
-- ⚠️ THIS IS THE EXPAND STEP AND IT DROPS NOTHING. `feedback_comment_id` keeps its
-- column, its FK and its `ON DELETE SET NULL`, and the service keeps WRITING it as
-- a mirror of the FIRST delivered card's comment. Two reasons, and the second is
-- the one a reader will not guess: the rollback stays a code revert, AND an
-- instance still running the previous build during a deploy window reads that
-- column, finds the comment this build opened, and EDITS it instead of opening a
-- second one. The column retires in its own card once nothing reads it — the same
-- sequence `work_item_delivery` follows (`docs/decisions/delivery-reader-migration.md`).
--
-- ⚠️ `comment_id` CASCADES, and that is the whole argument against the array column
-- this decision rejected. The id handed to the edit path must be LIVE: a person
-- deleting a feedback comment takes this row with it, so the next terminal
-- conclusion at that commit finds nothing recorded and posts a fresh comment. A
-- `text[]` of ids nothing keeps live would instead throw inside the delivery's
-- transaction, and a webhook the host then retries for ever is a worse failure
-- than any duplicate comment.
--
-- Tenancy is `github_check_run`'s policy one table over — the `system_admin` arm,
-- else a join through `github_pull_request → github_repo` — because this row hangs
-- off the same pull request and has no tenant discriminator of its own. It ships in
-- THIS migration (migration-by-concern, PRODECT_FINDINGS #20 — no unguarded
-- window). All three FKs are modelled as Prisma `@relation`s on both sides with the
-- SAME actions this SQL uses, so `migrate diff` reports no drift.

-- CreateTable
CREATE TABLE "github_ci_feedback_comment" (
    "id" TEXT NOT NULL,
    "pull_request_id" TEXT NOT NULL,
    "commit_sha" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "comment_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_ci_feedback_comment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "github_ci_feedback_comment_work_item_id_idx" ON "github_ci_feedback_comment"("work_item_id");

-- CreateIndex
CREATE INDEX "github_ci_feedback_comment_comment_id_idx" ON "github_ci_feedback_comment"("comment_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_ci_feedback_comment_pull_request_id_commit_sha_work__key" ON "github_ci_feedback_comment"("pull_request_id", "commit_sha", "work_item_id");

-- AddForeignKey
ALTER TABLE "github_ci_feedback_comment" ADD CONSTRAINT "github_ci_feedback_comment_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "github_pull_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_ci_feedback_comment" ADD CONSTRAINT "github_ci_feedback_comment_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_ci_feedback_comment" ADD CONSTRAINT "github_ci_feedback_comment_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- BACKFILL. Every comment the scalar currently names becomes its own row, so no
-- pull request in flight opens a SECOND comment on the card it already commented
-- on the moment this deploys — which is the one way an EXPAND of this shape can
-- regress MOTIR-2946.
--
-- The card is read off the COMMENT (`comment.work_item_id`), not off the pull
-- request's link column: the comment row is where it was actually posted, and the
-- link column has since MOVED on any pull request that delivered more than one
-- card (`link_pull_request` moves the scalar and adds a delivery row). Reading the
-- link would therefore re-point historical comments at whichever card was linked
-- LAST.
--
-- `DISTINCT ON` because the scalar is replicated across every check row at the
-- commit — N check rows, one comment, one row out. Guarded and re-runnable: the
-- unique index plus `ON CONFLICT DO NOTHING` make a second application a no-op, and
-- a database with no CI history inserts nothing.
INSERT INTO "github_ci_feedback_comment" ("id", "pull_request_id", "commit_sha", "work_item_id", "comment_id", "created_at", "updated_at")
SELECT DISTINCT ON (cr."pull_request_id", cr."commit_sha", c."work_item_id")
       gen_random_uuid()::text,
       cr."pull_request_id",
       cr."commit_sha",
       c."work_item_id",
       c."id",
       c."created_at",
       CURRENT_TIMESTAMP
FROM "github_check_run" cr
JOIN "comment" c ON c."id" = cr."feedback_comment_id"
WHERE cr."feedback_comment_id" IS NOT NULL
ORDER BY cr."pull_request_id", cr."commit_sha", c."work_item_id", cr."created_at"
ON CONFLICT ("pull_request_id", "commit_sha", "work_item_id") DO NOTHING;

-- REPORT what the backfill wrote, and — the number that actually matters — how
-- many (pull request, commit) pairs reached MORE cards than they commented on.
-- That is the defect's own population, and it is a count nobody has ever had:
-- every one of those cards has a `ciState` and no comment explaining it. Emitted as
-- a NOTICE so it lands in the `migrate deploy` log of whichever database this runs
-- against rather than being a number only the author's laptop saw.
DO $$
DECLARE
  rows_written      integer;
  uncommented_cards integer;
BEGIN
  SELECT count(*) INTO rows_written FROM "github_ci_feedback_comment";

  SELECT count(*) INTO uncommented_cards
  FROM (
    SELECT DISTINCT cr."pull_request_id", cr."commit_sha", d."work_item_id"
    FROM "github_check_run" cr
    JOIN "work_item_delivery" d ON d."github_pull_request_id" = cr."pull_request_id"
    WHERE cr."feedback_comment_id" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM "github_ci_feedback_comment" f
        WHERE f."pull_request_id" = cr."pull_request_id"
          AND f."commit_sha" = cr."commit_sha"
          AND f."work_item_id" = d."work_item_id"
      )
  ) AS m;

  RAISE NOTICE 'github_ci_feedback_comment backfill: % row(s) written; % (pull request, commit, card) triple(s) that were DELIVERED and never commented on — the population MOTIR-3770 fixes going forward (history is not back-posted)',
    rows_written, uncommented_cards;
END
$$;

-- RLS, in the same migration as the table (no unguarded window). FORCE so even the
-- table-owner role is subject to it — production and the service writes connect as
-- the non-BYPASSRLS runtime role.
--
-- The gate is `github_check_run`'s, one table over and for the same reason: this
-- row's tenant is the pull request's repository, and RLS does not traverse foreign
-- keys, so the policy joins it explicitly. The `system_admin` arm is what admits
-- the webhook path, which resolves the connection tier before any workspace is
-- bound.
--
-- The workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO motir_app`
-- auto-grants on every NEW table created by the owner role, so no explicit GRANT is
-- needed (same as work_item_delivery / project_repository / sprint).
ALTER TABLE "github_ci_feedback_comment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "github_ci_feedback_comment" FORCE ROW LEVEL SECURITY;

CREATE POLICY "github_ci_feedback_comment_workspace_or_system" ON "github_ci_feedback_comment"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "github_pull_request" p
      JOIN "github_repo" r ON r."id" = p."repo_id"
      WHERE p."id" = "github_ci_feedback_comment"."pull_request_id"
        AND r."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "github_pull_request" p
      JOIN "github_repo" r ON r."id" = p."repo_id"
      WHERE p."id" = "github_ci_feedback_comment"."pull_request_id"
        AND r."workspace_id" = current_setting('app.workspace_id', true)
    )
  );
