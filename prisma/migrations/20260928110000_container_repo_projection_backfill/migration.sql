-- MOTIR-6751 — re-sync the stored repository NAMES of every container with the
-- repository REFERENCES it holds.
--
-- `work_item.targetRepos` (and `targetRepo`, its element 0) is a stored
-- projection of the `work_item_repository` references. The approve path's
-- container re-derivation (`plansService.recomputeContainersForTouched`) rewrote
-- the references and never the names, so every container an approved plan
-- re-derived kept the names it had before — `[]` for a story created by a plan,
-- or the repositories a re-plan had just moved its work out of (MOTIR-6706 read
-- back `motir-marketing` over one `motir-skills` reference). The code fix writes
-- both halves from now on; this repairs the rows written before it.
--
-- Scope, and why each clause is there:
--   * CONTAINERS only — an item with a live child. A container never authors its
--     set; its references are the rollup's, so they are the truth to copy from.
--     A leaf's names and references are written together by its own write path.
--   * Only in a project that HAS a repository set. A project with none still
--     pins by name alone (the ADR §5 compatibility rung), and there the names
--     are the only record — an empty reference list says nothing about them.
--   * Only where the names DISAGREE, so an agreeing row is not rewritten.
--
-- Names resolve by the one rule every reader uses (`toWorkItemRepositoryDtos`):
-- the realized repository's own name, else the row's authored name; in
-- reference order, position 0 being the primary.
WITH containers AS (
  SELECT w."id"
  FROM "work_item" w
  WHERE EXISTS (
          SELECT 1 FROM "work_item" c
          WHERE c."parentId" = w."id" AND c."archivedAt" IS NULL
        )
    AND EXISTS (
          SELECT 1 FROM "project_repository" pr WHERE pr."project_id" = w."projectId"
        )
), resolved AS (
  SELECT c."id",
         COALESCE(
           array_agg(COALESCE(gr."name", pr."name") ORDER BY wir."position")
             FILTER (WHERE wir."id" IS NOT NULL),
           ARRAY[]::text[]
         ) AS names
  FROM containers c
  LEFT JOIN "work_item_repository" wir ON wir."work_item_id" = c."id"
  LEFT JOIN "project_repository" pr ON pr."id" = wir."project_repo_id"
  LEFT JOIN "github_repo" gr ON gr."id" = pr."github_repo_id"
  GROUP BY c."id"
)
UPDATE "work_item" w
SET "targetRepos" = r.names,
    "targetRepo" = r.names[1]
FROM resolved r
WHERE w."id" = r."id"
  AND (w."targetRepos" IS DISTINCT FROM r.names
       OR w."targetRepo" IS DISTINCT FROM r.names[1]);
