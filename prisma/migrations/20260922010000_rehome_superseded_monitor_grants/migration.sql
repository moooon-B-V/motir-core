-- MOTIR-6005 — RE-HOME the bindings of a SUPERSEDED monitor grant onto the
-- organisation's newest grant, then delete each superseded grant left with no
-- binding. The same rule `monitorConnectionService.completeGrant` now applies on
-- every connect, run once over the rows that were stranded before it existed.
-- ===========================================================================
-- A Sentry integration cannot be re-authorised while installed, so the only
-- recovery from a dead credential is uninstall -> reinstall, and a reinstall
-- comes back under a NEW provider installation id. Connect stored that as a
-- second `monitor_installation` row and left every `monitor_connection` on the
-- dead one. Production holds one such organisation (Motir's own, 2026-09-22).
--
-- THE KEY: a group is (workspace_id, provider, metadata->>'orgSlug') with more
-- than one grant; the SURVIVOR is its newest grant (created_at, then id). A grant
-- with no recorded orgSlug belongs to no group and is never touched.
--
-- IT MOVES, IT NEVER RE-CREATES: a binding keeps its id, so its `monitor_issue`
-- links, watermark, minimum level and sync switches come with it. A binding the
-- survivor already holds for the same (project_id, external_project_id) stays
-- where it is (the unique index would refuse the move), and its grant is then
-- kept, because step 2 deletes only a grant with NO binding left.
--
-- IDEMPOTENT, and a no-op on any database where no group has two grants: after
-- one run every group has a single grant, and step 1 finds nothing to move.
-- `tests/integration/migrations/rehome-superseded-monitor-grants.test.ts` seeds
-- the production shape and runs it twice.

-- 1) Move each superseded grant's bindings onto its group's survivor.
WITH ranked AS (
  SELECT mi."id",
         first_value(mi."id") OVER (
           PARTITION BY mi."workspace_id", mi."provider", mi."metadata"->>'orgSlug'
           ORDER BY mi."created_at" DESC, mi."id" DESC
         ) AS survivor
  FROM "monitor_installation" mi
  WHERE mi."metadata"->>'orgSlug' IS NOT NULL
),
superseded AS (
  SELECT r."id", r.survivor FROM ranked r WHERE r."id" <> r.survivor
)
UPDATE "monitor_connection" mc
SET "installation_id" = s.survivor, "updated_at" = CURRENT_TIMESTAMP
FROM superseded s
WHERE mc."installation_id" = s."id"
  AND NOT EXISTS (
    SELECT 1 FROM "monitor_connection" held
    WHERE held."installation_id" = s.survivor
      AND held."project_id" = mc."project_id"
      AND held."external_project_id" = mc."external_project_id"
  );

-- 2) Delete each superseded grant that is left with no binding.
WITH ranked AS (
  SELECT mi."id",
         first_value(mi."id") OVER (
           PARTITION BY mi."workspace_id", mi."provider", mi."metadata"->>'orgSlug'
           ORDER BY mi."created_at" DESC, mi."id" DESC
         ) AS survivor
  FROM "monitor_installation" mi
  WHERE mi."metadata"->>'orgSlug' IS NOT NULL
)
DELETE FROM "monitor_installation" mi
USING ranked r
WHERE mi."id" = r."id"
  AND r."id" <> r.survivor
  AND NOT EXISTS (
    SELECT 1 FROM "monitor_connection" mc WHERE mc."installation_id" = mi."id"
  );
