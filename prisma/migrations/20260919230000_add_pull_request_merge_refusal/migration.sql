-- ============================================================
-- A merge the HOST refused, recorded on the pull request (MOTIR-5833).
-- ============================================================
-- `docs/decisions/approval-gates.md` §4 FOURTH AMENDMENT, point 5. One approval
-- authorizes ONE merge or enqueue action, so an attempt that did not land has to
-- be a FACT: the code the host gave, the head it refused, and when. Before this
-- the refusal lived only in the press's HTTP response, and a reload showed a card
-- reading Approved with nothing anywhere saying the merge had been refused.
--
-- ⚠️ THE SIBLING OF `github_pull_request_queue_exit` (20260916190000), for the
-- other way a merge fails to land. Same shape, same tenancy, same standing rule:
-- a row stops standing when a later press at that head succeeds (`superseded_at`)
-- or when a PUSH moves the head so the row no longer names it.
--
-- ⚠️ ROWS ACCUMULATE. A person may change the setting and press again, and be
-- refused again; the pull request's CURRENT refusal is its latest row — hence the
-- (pull_request_id, refused_at) index.
--
-- ⚠️ `code` IS TEXT, NOT AN ENUM. The values are the git seam's own
-- (`MergeRefusalCode`), and a second host may name a refusal this deployment has
-- never seen; a text column records it rather than refusing the write. The class
-- map (`lib/mergeQueue/queueExit.ts`) is what must stay total, and it is.
--
-- The FK is modelled as a Prisma `@relation` on both sides with the same
-- `ON DELETE CASCADE`, so `migrate diff` reports no drift.

-- CreateTable
CREATE TABLE "github_pull_request_merge_refusal" (
    "id" TEXT NOT NULL,
    "pull_request_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "head_sha" TEXT NOT NULL,
    "approval_gate_id" TEXT,
    "permission" TEXT,
    "refused_at" TIMESTAMP(3) NOT NULL,
    "superseded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_pull_request_merge_refusal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "github_pull_request_merge_refusal_pull_request_id_refused_a_idx" ON "github_pull_request_merge_refusal"("pull_request_id", "refused_at");

-- AddForeignKey
ALTER TABLE "github_pull_request_merge_refusal" ADD CONSTRAINT "github_pull_request_merge_refusal_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "github_pull_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS, in the same migration as the table (no unguarded window). FORCE so even the
-- table-owner role is subject to it. The policy is `github_pull_request_queue_exit`'s,
-- for its reason: this row hangs off a pull request and has no tenant column of its
-- own, and RLS does not traverse foreign keys, so it joins through
-- `github_pull_request → github_repo` explicitly. The `system_admin` arm admits the
-- paths that resolve a connection tier before any workspace is bound.
ALTER TABLE "github_pull_request_merge_refusal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "github_pull_request_merge_refusal" FORCE ROW LEVEL SECURITY;

CREATE POLICY "github_pull_request_merge_refusal_workspace_or_system" ON "github_pull_request_merge_refusal"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "github_pull_request" p
      JOIN "github_repo" r ON r."id" = p."repo_id"
      WHERE p."id" = "github_pull_request_merge_refusal"."pull_request_id"
        AND r."workspace_id" = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR EXISTS (
      SELECT 1 FROM "github_pull_request" p
      JOIN "github_repo" r ON r."id" = p."repo_id"
      WHERE p."id" = "github_pull_request_merge_refusal"."pull_request_id"
        AND r."workspace_id" = current_setting('app.workspace_id', true)
    )
  );
