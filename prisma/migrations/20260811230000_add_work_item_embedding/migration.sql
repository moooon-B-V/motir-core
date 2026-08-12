-- The plan-tree SEMANTIC-SEARCH sidecar (Story MOTIR-2694 · Subtask MOTIR-2696,
-- per `docs/decisions/plan-tree-embeddings.md` §4/§5). Ships in ONE atomic step
-- (migration-by-concern, PRODECT_FINDINGS #20 — a table lands WITH its RLS
-- policy so there is never an unguarded window):
--   1. the `vector` EXTENSION — new to THIS database (it has been carrying live
--      traffic in `motir-ai` since 20260624000000_enable_pgvector);
--   2. the `work_item_embedding` table — one row per work item, holding the
--      vector derived from that item's `title` + `descriptionMd`;
--   3. its indexes + FKs;
--   4. ENABLE + FORCE row-level security + the tenancy policy;
--   5. the HNSW ANN index over the `vector` column.
--
-- WHY: GATE 1 of the planning rules asks "does work like this already exist?"
-- and its only search is the 6.1.1 substring `contains` predicate, so a query
-- for "persist UI preferences" cannot see a card titled "Board columns remember
-- their collapsed state" — and the gate reports "nothing matches", honestly and
-- wrongly. This table is where the meaning lives.
--
-- HAND-WRITTEN, for the same reason `motir-ai`'s pgvector + lessons-store
-- migrations are: Prisma models neither extensions (the `postgresqlExtensions`
-- preview is deliberately NOT enabled on this generator) nor an index over an
-- `Unsupported` column, and Prisma 7's `migrate dev` is interactive and refuses
-- to emit a migration non-interactively. This is the SQL Prisma would generate
-- for the typed columns, PLUS the extension, the RLS block and the HNSW index by
-- hand. Applied with `prisma migrate deploy` (the path CI and production use).
--
-- ⚠️ THE POSTGRES IMAGE MUST CARRY pgvector, AND THIS PR MOVES IT.
-- `docker-compose.yml` and `.github/actions/postgres/action.yml` both ran
-- `postgres:16-alpine`, which has no pgvector — `CREATE EXTENSION vector` fails
-- on it. Both now run `pgvector/pgvector:pg16`, as `motir-ai` already does.
-- Production is Neon, where the extension is available and `motir-ai` has been
-- using it since June.
--
-- Delete semantics: `work_item_id` CASCADE (the derivation dies with the row it
-- describes — and the PK IS the FK, so there is exactly one embedding per item);
-- `workspace_id` CASCADE (tenant teardown); `project_id` CASCADE. All three are
-- modelled as Prisma `@relation`s (forward field + back-relation) with these
-- same actions, so `migrate dev` reports "No difference detected" (the FK-drift
-- rule, bug-attachment-fk-migration-drift).
--
-- ABSENCE IS THE SEMANTICS (ADR §4): a work item with no row here is simply not
-- a search candidate. That is never an error, never a failed write, and never
-- user-visible — it surfaces only as the `coverage` figure MOTIR-2697 returns.
-- The `embedding` column is nullable ONLY because Prisma cannot create a
-- required `Unsupported` column (the same call `motir-ai`'s `Lesson.embedding`
-- makes); the writer upserts the row AND its vector in one statement, so a row
-- without a vector is never created, and the ranking read still guards
-- `embedding IS NOT NULL`.

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "work_item_embedding" (
    "work_item_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "embedded_at" TIMESTAMPTZ(3) NOT NULL,
    "embedding" vector(1536),

    CONSTRAINT "work_item_embedding_pkey" PRIMARY KEY ("work_item_id")
);

-- CreateIndex
CREATE INDEX "work_item_embedding_workspace_id_idx" ON "work_item_embedding"("workspace_id");

-- CreateIndex
CREATE INDEX "work_item_embedding_project_id_model_idx" ON "work_item_embedding"("project_id", "model");

-- AddForeignKey
ALTER TABLE "work_item_embedding" ADD CONSTRAINT "work_item_embedding_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_embedding" ADD CONSTRAINT "work_item_embedding_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_embedding" ADD CONSTRAINT "work_item_embedding_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Row-level security — work_item_embedding (pure workspace gate, no escape hatch)
-- ===========================================================================
-- The SAME single PERMISSIVE FOR ALL policy as `sprint` / `sprint_report_entry`
-- / `comment` / `notification`: USING + WITH CHECK against
-- `current_setting('app.workspace_id', true)` (`true` = missing_ok, so an unset
-- GUC yields NULL → predicate NULL → row hidden, the safe failure). ENABLE +
-- FORCE so even the table-owner `prodect` role is subject to it; production and
-- the write path connect as the non-BYPASSRLS `motir_app` role (renamed from
-- `prodect_app` by 20260810000000_rename_app_role_to_motir_app).
--
-- Deliberately NOT the `work_item` policy's project-narrowing shape: the write
-- path is a background job that has a workspace but no active project, and the
-- ranking read narrows on `project_id` in the QUERY, from the token's project —
-- so the extra GUC would gate the writer without adding a guarantee the query
-- does not already make. There is no third option to weigh: the repo's RLS
-- totality guard (`tests/tenant-root-creation-rls.test.ts`) fails a new table
-- that neither ships a policy nor joins `DELIBERATELY_UNGUARDED`, and derived
-- customer plan data is not a candidate for that map.
--
-- Grants: the workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO
-- prodect_app` auto-grants on every NEW table created by the `prodect` role, so
-- no explicit GRANT is needed (same as sprint / sprint_report_entry).
ALTER TABLE "work_item_embedding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "work_item_embedding" FORCE ROW LEVEL SECURITY;

CREATE POLICY "work_item_embedding_active_workspace" ON "work_item_embedding"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));

-- CreateIndex (HAND-WRITTEN — Prisma cannot emit an index over the `Unsupported`
-- vector column, so it is invisible to the datamodel and to `migrate diff`).
-- HNSW ANN index with cosine ops, matching the `<=>` operator the ranking read
-- orders by; without it that ORDER BY is a brute-force scan (the reference
-- implementation, `motir-ai`'s `Lesson_embedding_idx`, says so in its own
-- comment). `IF NOT EXISTS` keeps it idempotent on an environment where the
-- index was created out-of-band.
--
-- ⚠️ This index UNDER-RETURNS under a pre-filter, and that is handled in the
-- repository rather than here: an approximate scan collects its candidates
-- BEFORE `project_id` is applied, so a small project inside a large table can
-- come back with fewer than `limit` rows. `workItemEmbeddingRepository` widens
-- `hnsw.ef_search` and, when the approximate pass returns fewer rows than the
-- project actually has, re-runs the SAME ranking with the ordered index path
-- disabled — an exact scan. See that file's header for why the guarantee is
-- pinned there (it holds on every pgvector version) rather than on
-- `hnsw.iterative_scan`, which needs 0.8+ and would fail a self-hoster's
-- migration on an older build.
CREATE INDEX IF NOT EXISTS "work_item_embedding_embedding_idx"
  ON "work_item_embedding" USING hnsw ("embedding" vector_cosine_ops);
