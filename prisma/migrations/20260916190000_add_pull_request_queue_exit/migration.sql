-- ============================================================
-- A merge-queue EXIT, recorded on the pull request (MOTIR-5632).
-- ============================================================
-- `docs/decisions/approval-gates.md` §4 THIRD AMENDMENT, decisions 3 and 9. When a
-- merge queue removes a pull request without merging it, Motir writes ONE row
-- here: the host's raw reason, what it means (`failure` | `neutral`), the head it
-- left at, when, and the delivery GUID. A `landed` removal writes nothing — the
-- merge webhook owns `done`.
--
-- ⚠️ ROWS ACCUMULATE. MOTIR-5627's capture measured one head ejected four times
-- (pull request #2877 at `1a74b77`), each by a different merge group, so the pull
-- request's CURRENT exit is its latest row — hence the (pull_request_id,
-- exited_at) index.
--
-- ⚠️ `delivery_id` IS THE IDEMPOTENCY KEY, UNIQUE. A hand REDELIVERY repeats the
-- `X-GitHub-Delivery` GUID with a new delivery id (measured, MOTIR-5627), so a
-- replayed exit is refused by this index and writes nothing, while a genuine second
-- exit — a new event — carries a new GUID and is recorded. A `(head, reason)` key
-- was rejected on the record: it would collapse genuine repeats.
--
-- ⚠️ NOT `github_check_run`. That table is the pull request's OWN CI state at its
-- head (`derivePrCiState`); a queue failure written there would turn a green pull
-- request red and stop a push from re-arming the card's approval.
--
-- The FK is modelled as a Prisma `@relation` on both sides with the same
-- `ON DELETE CASCADE`, so `migrate diff` reports no drift.

-- CreateEnum
CREATE TYPE "queue_exit_disposition" AS ENUM ('failure', 'neutral');

-- CreateTable
CREATE TABLE "github_pull_request_queue_exit" (
    "id" TEXT NOT NULL,
    "pull_request_id" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "raw_reason" TEXT NOT NULL,
    "disposition" "queue_exit_disposition" NOT NULL,
    "head_sha" TEXT NOT NULL,
    "exited_at" TIMESTAMP(3) NOT NULL,
    "requeued_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_pull_request_queue_exit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_pull_request_queue_exit_delivery_id_key" ON "github_pull_request_queue_exit"("delivery_id");

-- CreateIndex
CREATE INDEX "github_pull_request_queue_exit_pull_request_id_exited_at_idx" ON "github_pull_request_queue_exit"("pull_request_id", "exited_at");

-- AddForeignKey
ALTER TABLE "github_pull_request_queue_exit" ADD CONSTRAINT "github_pull_request_queue_exit_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "github_pull_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS, in the same migration as the table (no unguarded window). FORCE so even the
-- table-owner role is subject to it. The gate is `github_ci_feedback_comment`'s
-- (20260828190000), for the same reason: this row hangs off a pull request and has
-- no tenant column of its own, and RLS does not traverse foreign keys, so the policy
-- joins through `github_pull_request → github_repo` explicitly. The `system_admin`
-- arm admits the webhook path, which resolves the connection tier before any
-- workspace is bound. The owner role's default privileges already grant `motir_app`
-- on every new table.
ALTER TABLE "github_pull_request_queue_exit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "github_pull_request_queue_exit" FORCE ROW LEVEL SECURITY;

CREATE POLICY "github_pull_request_queue_exit_workspace_or_system" ON "github_pull_request_queue_exit"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "github_pull_request" p
      JOIN "github_repo" r ON r."id" = p."repo_id"
      WHERE p."id" = "github_pull_request_queue_exit"."pull_request_id"
        AND r."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "github_pull_request" p
      JOIN "github_repo" r ON r."id" = p."repo_id"
      WHERE p."id" = "github_pull_request_queue_exit"."pull_request_id"
        AND r."workspace_id" = current_setting('app.workspace_id', true)
    )
  );
