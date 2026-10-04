-- The platform RUN-MODEL LIST (Story MOTIR-7521 · MOTIR-7525;
-- `docs/decisions/hosted-agent-run.md` §7, amended by MOTIR-7522).
--
-- Which models a hosted run MAY use: the platform's SELECTION only. Whether a
-- model is servable and rated stays motir-ai's (`GET /v1/agent-models`, read
-- live), so the offer is listed ∩ offered. ADDITIVE: no existing row changes,
-- and nothing is seeded here — the list is initialised with motir-ai's offer on
-- the first console read after deploy, under the `platform_run_model_list`
-- marker, so this migration needs no call to motir-ai and no project loses its
-- model on deploy.
--
-- ── ROW-LEVEL SECURITY ─────────────────────────────────────────────────────
-- No TENANT arm, by design: no tenant owns or edits these rows.
--   · READ is unconditional. The list is platform reference data with nothing
--     in a row to protect (a model id, a timestamp, an operator id), and every
--     tenant's Run hosted picker and start path must see it — a tenancy
--     predicate here would hide the whole list from exactly the callers that
--     narrow their offer by it, the silent-zero failure
--     `public_hostname_reservation` describes.
--   · WRITE is `app.platform_staff` only: every write runs inside
--     `withPlatformRead`, which appends the audit row in the same transaction.
-- ONE `FOR ALL` write arm per table, so UPDATE/DELETE have a permissive policy
-- (`tests/tenant-root-creation-rls.test.ts`). Grants: the add_workspace_rls
-- migration's ALTER DEFAULT PRIVILEGES covers every new table.

-- CreateTable
CREATE TABLE "platform_run_model" (
    "id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "added_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_run_model_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_run_model_list" (
    "id" TEXT NOT NULL,
    "initialized_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_run_model_list_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_run_model_model_key" ON "platform_run_model"("model");

-- CreateIndex
CREATE INDEX "platform_run_model_added_by_id_idx" ON "platform_run_model"("added_by_id");

-- AddForeignKey
ALTER TABLE "platform_run_model" ADD CONSTRAINT "platform_run_model_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- Row-level security — platform_run_model
-- ===========================================================================
ALTER TABLE "platform_run_model" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_run_model" FORCE ROW LEVEL SECURITY;

CREATE POLICY "platform_run_model_read" ON "platform_run_model"
  FOR SELECT
  USING (true);

CREATE POLICY "platform_run_model_platform_staff" ON "platform_run_model"
  FOR ALL
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.platform_staff', true), '') = 'true');

-- ===========================================================================
-- Row-level security — platform_run_model_list
-- ===========================================================================
ALTER TABLE "platform_run_model_list" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_run_model_list" FORCE ROW LEVEL SECURITY;

CREATE POLICY "platform_run_model_list_read" ON "platform_run_model_list"
  FOR SELECT
  USING (true);

CREATE POLICY "platform_run_model_list_platform_staff" ON "platform_run_model_list"
  FOR ALL
  USING (coalesce(current_setting('app.platform_staff', true), '') = 'true')
  WITH CHECK (coalesce(current_setting('app.platform_staff', true), '') = 'true');
