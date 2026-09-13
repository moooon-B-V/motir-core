-- Error-monitor connections — the GRANT a workspace installs and the SET of
-- monitored external projects it binds to its Motir projects (Story MOTIR-4926 ·
-- Subtask MOTIR-5258). In ONE atomic step (tables + indexes + FKs + their RLS
-- policies land together — migration-by-concern, PRODECT_FINDINGS #20 — so there
-- is never an unguarded window):
--   1. `monitor_installation`, its unique + indexes and its workspace FK;
--   2. `monitor_connection`, its unique + indexes and its three FKs;
--   3. ENABLE + FORCE row-level security + a workspace-or-system policy on each.
--
-- ── TWO TABLES, mirroring `github_installation` ↔ `github_repo` ──────────────
-- A provider authorises at the ORGANISATION tier (Sentry's permissions are
-- scoped to the org), so ONE grant covers every project in that org. The grant
-- row is therefore the only one holding a secret, and the binding row holds
-- none. `monitor_connection` is what makes a project's monitored projects a SET
-- whose degenerate case is one — never a column on `project`.
--
-- ── RLS shape = workspace-or-system, modelled on
-- `github_installation_workspace_or_system` (20260703120000) ─────────────────
-- NOT the pure `*_active_workspace` gate `approval_gate` / `design_evidence`
-- carry, and the difference is a real writer rather than a preference: the
-- credential-lifecycle card's eight-hourly REFRESH is an unattended sweep that
-- must enumerate every workspace's due grants before it knows whose they are, so
-- it opens a system transaction and binds the workspace once the row has told it
-- which (the `bindWorkspaceContext` contract in `lib/workspaces/context.ts`).
-- With a pure workspace arm that sweep reads ZERO ROWS AND RAISES NOTHING, which
-- is precisely the silent-stop failure MOTIR-4918 recorded one tier up.
--
-- ⚠️ AND THE BINDING'S POLICY READS ITS OWN `workspace_id`, NOT A JOIN THROUGH
-- THE GRANT. RLS does not traverse a foreign key, so a policy written as a
-- correlated `EXISTS` over the parent is evaluated once per candidate row on
-- every read by every caller: `github_repo` was migrated off exactly that shape
-- (20260731160000), and an org-read arm built the same way measured 8.3s → 23.4s
-- on ONE unrelated test file. The child carrying its own tenancy column is what
-- lets both policies be a column comparison.
--
-- `current_setting('app.workspace_id', true)` with missing_ok=true means an
-- unset GUC → NULL → row hidden (safe failure). FORCE subjects even the table
-- owner to the policy; production connects as the non-bypass `motir_app` role.
-- No explicit GRANT is needed: the workspace-RLS migration's
-- `ALTER DEFAULT PRIVILEGES … TO motir_app` auto-grants on every new table
-- created by the owner role (same as dispatch_run / approval_gate).
--
-- ⚠️ `monitor_connection`'s unique column list `(project_id, installation_id,
-- external_project_id)` is deliberately NOT the column list of any `@@index` on
-- the model — the three indexes are `(workspace_id)`, `(installation_id)` and
-- `(project_id)` — so Prisma's by-column-list index pairing has nothing to pair
-- it against (the partial/unique-index rule in CLAUDE.md, MOTIR-1960). It is a
-- PLAIN unique index, and it is the constraint the concurrent-bind refusal rests
-- on: binding is a check-then-write, two authorisation returns can land at once,
-- and a count-then-write guard with no constraint behind it only fails under a
-- warm pool.

-- CreateTable
CREATE TABLE "monitor_installation" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'sentry',
    "installation_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "access_token_encrypted" TEXT NOT NULL,
    "refresh_token_encrypted" TEXT NOT NULL,
    "token_expires_at" TIMESTAMP(3) NOT NULL,
    "health" TEXT NOT NULL DEFAULT 'connected',
    "health_reason" TEXT,
    "health_checked_at" TIMESTAMP(3),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monitor_installation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "monitor_connection" (
    "id" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "external_project_id" TEXT NOT NULL,
    "external_project_slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monitor_connection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "monitor_installation_provider_installation_id_key" ON "monitor_installation"("provider", "installation_id");

-- CreateIndex
CREATE INDEX "monitor_installation_workspace_id_idx" ON "monitor_installation"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "monitor_connection_project_id_installation_id_external_proj_key" ON "monitor_connection"("project_id", "installation_id", "external_project_id");

-- CreateIndex
CREATE INDEX "monitor_connection_workspace_id_idx" ON "monitor_connection"("workspace_id");

-- CreateIndex
CREATE INDEX "monitor_connection_installation_id_idx" ON "monitor_connection"("installation_id");

-- CreateIndex
CREATE INDEX "monitor_connection_project_id_idx" ON "monitor_connection"("project_id");

-- AddForeignKey
ALTER TABLE "monitor_installation" ADD CONSTRAINT "monitor_installation_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_connection" ADD CONSTRAINT "monitor_connection_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "monitor_installation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_connection" ADD CONSTRAINT "monitor_connection_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitor_connection" ADD CONSTRAINT "monitor_connection_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — monitor_installation (workspace gate + system escape)
-- ===========================================================================
ALTER TABLE "monitor_installation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "monitor_installation" FORCE ROW LEVEL SECURITY;

CREATE POLICY "monitor_installation_workspace_or_system" ON "monitor_installation"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );

-- ===========================================================================
-- Row-level security — monitor_connection (its OWN workspace_id, no join)
-- ===========================================================================
ALTER TABLE "monitor_connection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "monitor_connection" FORCE ROW LEVEL SECURITY;

CREATE POLICY "monitor_connection_workspace_or_system" ON "monitor_connection"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );
