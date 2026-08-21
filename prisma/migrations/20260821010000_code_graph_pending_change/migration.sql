-- MOTIR-3358 · hold each push's changed paths until a refresh indexes them.
--
-- The list cannot ride the `system.code-graph-refresh` event: that job debounces
-- 2 minutes per (installation, owner, repo), and a debounce delivers exactly ONE
-- event — the last. A run standing for four pushes would carry one push's paths
-- and leave three pushes' files stale in a graph nothing can tell is wrong.
--
-- So each push appends a row and the run drains every row for its repo. The drain
-- is a CLAIM: a run that fails must release its rows rather than consume them.

CREATE TABLE "code_graph_pending_change" (
    "id" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "repo_owner" TEXT NOT NULL,
    "repo_name" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "head_sha" TEXT,
    -- `added` ∪ `modified` ∪ `removed`. EMPTY means "unknown", not "nothing
    -- changed", and it makes the whole union undeliverable on purpose.
    "paths" TEXT[] NOT NULL,
    "claimed_by_ref" TEXT,
    "claimed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_graph_pending_change_pkey" PRIMARY KEY ("id")
);

-- The drain read: everything pending for one repo.
CREATE INDEX "code_graph_pending_change_installation_id_repo_owner_repo_n_idx"
    ON "code_graph_pending_change"("installation_id", "repo_owner", "repo_name");
-- The settle read: everything one run is holding.
CREATE INDEX "code_graph_pending_change_claimed_by_ref_idx"
    ON "code_graph_pending_change"("claimed_by_ref");
CREATE INDEX "code_graph_pending_change_workspace_id_idx"
    ON "code_graph_pending_change"("workspace_id");

ALTER TABLE "code_graph_pending_change" ADD CONSTRAINT "code_graph_pending_change_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS on the same terms as every other workspace-scoped table. The webhook and the
-- refresh job both run under the system context; without this a workspace session
-- could read another tenant's file paths.
ALTER TABLE "code_graph_pending_change" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "code_graph_pending_change" FORCE ROW LEVEL SECURITY;

CREATE POLICY "code_graph_pending_change_workspace_or_system" ON "code_graph_pending_change"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );
