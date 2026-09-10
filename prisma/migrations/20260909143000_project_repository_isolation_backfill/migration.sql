-- MOTIR-4955 — establish project_repository links before retiring the workspace
-- fallback. `github_repo.workspace_id` remains untouched: it records which
-- workspace connected the organisation asset, not which projects may read it.
--
-- Evidence of existing project use comes from the two durable project-scoped
-- sources that predate the link table: work-item repository pins and the migrate
-- onboarding source ref. Match within the project's ORGANISATION, so a repo
-- connected by a sibling workspace can be materialised without changing owner.
WITH evidence AS (
  SELECT w."projectId" AS project_id,
         p."workspaceId" AS workspace_id,
         pin.value AS repo_ref
  FROM "work_item" w
  JOIN "project" p ON p."id" = w."projectId"
  CROSS JOIN LATERAL unnest(
    CASE
      WHEN COALESCE(array_length(w."targetRepos", 1), 0) > 0 THEN w."targetRepos"
      WHEN w."targetRepo" IS NOT NULL THEN ARRAY[w."targetRepo"]
      ELSE ARRAY[]::text[]
    END
  ) AS pin(value)
  UNION
  SELECT mo."project_id", p."workspaceId", mo."connected_repo_ref"
  FROM "migrate_onboarding" mo
  JOIN "project" p ON p."id" = mo."project_id"
  WHERE mo."connected_repo_ref" IS NOT NULL
), candidates AS (
  SELECT DISTINCT e.project_id, e.workspace_id, gr."id" AS github_repo_id, gr."name"
  FROM evidence e
  JOIN "workspace" pw ON pw."id" = e.workspace_id
  JOIN "github_repo" gr ON gr."organization_id" = pw."organizationId"
   AND (
     (gr."workspace_id" = e.workspace_id AND lower(e.repo_ref) = lower(gr."name")) OR
     lower(e.repo_ref) = lower(gr."owner" || '/' || gr."name")
   )
)
UPDATE "project_repository" pr
SET "github_repo_id" = c.github_repo_id,
    "state" = 'connected',
    "seed_source" = 'organization',
    "updated_at" = CURRENT_TIMESTAMP
FROM candidates c
WHERE pr."project_id" = c.project_id
  AND lower(pr."name") = lower(c."name")
  AND pr."github_repo_id" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "project_repository" claimed
    WHERE claimed."project_id" = c.project_id
      AND claimed."github_repo_id" = c.github_repo_id
  );

WITH evidence AS (
  SELECT w."projectId" AS project_id,
         p."workspaceId" AS workspace_id,
         pin.value AS repo_ref
  FROM "work_item" w
  JOIN "project" p ON p."id" = w."projectId"
  CROSS JOIN LATERAL unnest(
    CASE
      WHEN COALESCE(array_length(w."targetRepos", 1), 0) > 0 THEN w."targetRepos"
      WHEN w."targetRepo" IS NOT NULL THEN ARRAY[w."targetRepo"]
      ELSE ARRAY[]::text[]
    END
  ) AS pin(value)
  UNION
  SELECT mo."project_id", p."workspaceId", mo."connected_repo_ref"
  FROM "migrate_onboarding" mo
  JOIN "project" p ON p."id" = mo."project_id"
  WHERE mo."connected_repo_ref" IS NOT NULL
), candidates AS (
  SELECT DISTINCT e.project_id, e.workspace_id, gr."id" AS github_repo_id, gr."name"
  FROM evidence e
  JOIN "workspace" pw ON pw."id" = e.workspace_id
  JOIN "github_repo" gr ON gr."organization_id" = pw."organizationId"
   AND (
     (gr."workspace_id" = e.workspace_id AND lower(e.repo_ref) = lower(gr."name")) OR
     lower(e.repo_ref) = lower(gr."owner" || '/' || gr."name")
   )
)
INSERT INTO "project_repository" (
  "id", "workspace_id", "project_id", "role", "name", "seed_source",
  "state", "github_repo_id", "position", "created_at", "updated_at"
)
SELECT gen_random_uuid()::text, c.workspace_id, c.project_id, 'other', c."name",
       'organization', 'connected', c.github_repo_id,
       'z' || substr(md5(c.github_repo_id), 1, 24), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM candidates c
WHERE NOT EXISTS (
  SELECT 1 FROM "project_repository" pr
  WHERE pr."project_id" = c.project_id
    AND (pr."github_repo_id" = c.github_repo_id OR lower(pr."name") = lower(c."name"))
);

DO $$
DECLARE unresolved integer;
BEGIN
  SELECT count(*) INTO unresolved
  FROM "work_item" w
  CROSS JOIN LATERAL unnest(
    CASE
      WHEN COALESCE(array_length(w."targetRepos", 1), 0) > 0 THEN w."targetRepos"
      WHEN w."targetRepo" IS NOT NULL THEN ARRAY[w."targetRepo"]
      ELSE ARRAY[]::text[]
    END
  ) AS pin(value)
  WHERE NOT EXISTS (
    SELECT 1 FROM "project_repository" pr
    LEFT JOIN "github_repo" gr ON gr."id" = pr."github_repo_id"
    WHERE pr."project_id" = w."projectId"
      AND (lower(pr."name") = lower(pin.value)
        OR lower(gr."owner" || '/' || gr."name") = lower(pin.value))
  );
  RAISE NOTICE 'MOTIR-4955: % existing work-item repository pin(s) remain unresolved; dispatch will refuse them', unresolved;
END $$;
