-- MOTIR-3255 · attribution when ONE handle serves MANY repos.
--
-- `ci_container_usage` is one row per container carrying one project and one
-- repo, which was exact while every container served exactly one repo. The warm
-- sync worker (`code-graph-index-fleet.md` §16) is one machine, one ORG, many
-- repos over its life — so the handle row keeps the LIFETIME and a new slice
-- table carries what those seconds were spent on.

-- The handle row may now decline to name a repo. NULL is a statement — "this
-- handle served an org, not a repo" — and it is only ever written by a workload
-- that genuinely spans repos; the writer still requires the value for every
-- one-container-one-repo workload.
ALTER TABLE "ci_container_usage" ALTER COLUMN "repo_full_name" DROP NOT NULL;

CREATE TABLE "ci_container_usage_slice" (
    "id" TEXT NOT NULL,
    "container_provider" TEXT NOT NULL,
    "handle_id" TEXT NOT NULL,
    "slice_ref" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "project_id" TEXT,
    "repo_full_name" TEXT,
    "seconds" INTEGER NOT NULL,
    "usd_per_second" DECIMAL(20,12) NOT NULL,
    "cost_usd" DECIMAL(20,12) NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ci_container_usage_slice_pkey" PRIMARY KEY ("id")
);

-- The idempotency key: supervision replays, so every slice write is an upsert on
-- (provider, handle, ref) and a replayed checkpoint costs nothing.
-- ⚠️ THE NAME IS PINNED SHORT ON PURPOSE. The derived name for these three
-- columns is 67 characters, over Postgres's 63-byte identifier limit — and the
-- database and Prisma truncate it to DIFFERENT strings, so `migrate diff` reports
-- a rename that no re-apply can ever settle. Both sides are given the same short
-- literal instead (`@@unique(map:)` in the schema).
CREATE UNIQUE INDEX "ci_container_usage_slice_handle_ref_key"
    ON "ci_container_usage_slice"("container_provider", "handle_id", "slice_ref");
-- The reconciliation read: every slice of one handle.
CREATE INDEX "ci_container_usage_slice_container_provider_handle_id_idx"
    ON "ci_container_usage_slice"("container_provider", "handle_id");
-- The attribution reads: what one org, or one project, cost in a period.
CREATE INDEX "ci_container_usage_slice_organization_id_period_start_idx"
    ON "ci_container_usage_slice"("organization_id", "period_start");
CREATE INDEX "ci_container_usage_slice_project_id_period_start_idx"
    ON "ci_container_usage_slice"("project_id", "period_start");

ALTER TABLE "ci_container_usage_slice" ADD CONSTRAINT "ci_container_usage_slice_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ci_container_usage_slice" ADD CONSTRAINT "ci_container_usage_slice_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL, not CASCADE: a deleted project must not erase the record that Motir
-- paid for this compute — the same posture the parent row takes.
ALTER TABLE "ci_container_usage_slice" ADD CONSTRAINT "ci_container_usage_slice_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS, on the same terms as the parent row's (`add_ci_container_usage`). A slice
-- is workspace-scoped tenant data and is written under the system context the
-- fleet runs in; without this it would be the one fleet table a workspace session
-- could read across tenants.
--
-- The workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO prodect_app`
-- auto-grants on every NEW table created by the `prodect` role, so no explicit
-- GRANT is needed.
ALTER TABLE "ci_container_usage_slice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ci_container_usage_slice" FORCE ROW LEVEL SECURITY;

CREATE POLICY "ci_container_usage_slice_workspace_or_system" ON "ci_container_usage_slice"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );
