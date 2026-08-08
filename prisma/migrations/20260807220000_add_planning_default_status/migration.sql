-- ============================================================
-- Backfill the `planning` default-workflow status (MOTIR-2425).
-- ============================================================
-- MOTIR-2425 adds a SEVENTH status to the default workflow
-- (lib/workflows/defaultWorkflow.ts): `planning`, in the **in_progress**
-- category. When an agent finds a card it cannot implement it submits a
-- re-plan, and the card must stop being handed out until a human has acted on
-- that plan. `blocked` cannot do that job — readiness is derived from the
-- `is_blocked_by` EDGES, never from the status, so a card at `blocked` is still
-- ready and gets re-dispatched on the next run. A card in the in_progress
-- CATEGORY leaves the pickable set structurally, with nothing special-casing it.
--
-- New projects get it from `seedDefaultWorkflow`. This migration is what stops
-- every EXISTING project from being left with a loop that cannot express the
-- state — three writes per project, each idempotent, each guarded so a CUSTOM
-- workflow is left alone.
--
-- ⚠️ THREE writes, not one. The two earlier backfills of this shape
-- (20260615005304, 20260804010000) each added a single EDGE between statuses
-- that already existed. This one adds a status, so it must also add the edges
-- that reach it AND a board column to show it in. An unmapped status is legal —
-- a column owns a SET of status keys, a status MAY be unmapped, and
-- `boardsService` reports one in `unmappedStatuses` rather than dropping it —
-- but the board's COLUMNS and its total are built from the MAPPED keys alone.
-- So without step 3 the status would show up in a "not on this board" list while
-- every card at it sat in no column and outside the count, on every existing
-- project. Shipping the status without somewhere to put its cards is worse than
-- not shipping it.

-- ── 1. The status ───────────────────────────────────────────────────────────
-- Position: `in_progress.position || 'V'`, which is exactly what
-- `keyBetween(in_progress, in_review)` produces for adjacent siblings
-- ('a2' → 'a2V'), so `planning` sorts between them the same way it does in the
-- seed. It is an opaque fractional index and nothing joins on it, so a project
-- whose statuses were reordered still gets a well-ordered row — just not
-- necessarily the same literal key a fresh project would have. That divergence
-- is invisible and deliberate; renumbering existing rows would be a much larger
-- write for no observable gain.
--
-- The `key`-based join leaves CUSTOM workflows untouched: a project that
-- renamed or removed `in_progress` does not match, and gets nothing. Idempotent
-- via the NOT EXISTS guard. Ids are fresh uuids (the columns are plain `text`;
-- mixing uuids with the app's cuids is fine — they are unique PKs), mirroring
-- the two migrations named above.
INSERT INTO "workflow_status" (
  "id", "workspace_id", "project_id", "key", "label", "category",
  "position", "is_initial", "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text,
  ip."workspace_id",
  ip."project_id",
  'planning',
  'Planning',
  'in_progress'::"status_category",
  ip."position" || 'V',
  false,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "workflow_status" ip
WHERE ip."key" = 'in_progress'
  AND NOT EXISTS (
    SELECT 1 FROM "workflow_status" s
    WHERE s."project_id" = ip."project_id" AND s."key" = 'planning'
  );

-- ── 2. The five edges ───────────────────────────────────────────────────────
-- Two IN (`todo → planning`, `in_progress → planning`) and three OUT
-- (`planning → todo`, `planning → in_progress`, `planning → cancelled`). The
-- pairs are enumerated rather than generated so this file states the same graph
-- `DEFAULT_TRANSITIONS` does, and a reader can compare them line for line.
INSERT INTO "workflow_transition" (
  "id", "workspace_id", "project_id", "from_status_id", "to_status_id", "created_at"
)
SELECT
  gen_random_uuid()::text,
  fs."workspace_id",
  fs."project_id",
  fs."id",
  ts."id",
  CURRENT_TIMESTAMP
FROM (VALUES
  ('todo', 'planning'),
  ('in_progress', 'planning'),
  ('planning', 'todo'),
  ('planning', 'in_progress'),
  ('planning', 'cancelled')
) AS edge(from_key, to_key)
JOIN "workflow_status" fs ON fs."key" = edge.from_key
JOIN "workflow_status" ts ON ts."project_id" = fs."project_id" AND ts."key" = edge.to_key
WHERE NOT EXISTS (
  SELECT 1 FROM "workflow_transition" t
  WHERE t."project_id" = fs."project_id"
    AND t."from_status_id" = fs."id"
    AND t."to_status_id" = ts."id"
);

-- ── 3. A board column, on every board that mirrors the default 1:1 ──────────
-- `buildDefaultBoard` projects one column per status, so a NEW project's board
-- carries a Planning column for free. An existing board does not, and
-- `boardsService.getBoard` builds its columns and its total from the union of
-- MAPPED status keys alone — so a card moved to `planning` would sit in no
-- column and outside the count, with only the status itself surfacing in
-- `unmappedStatuses`.
--
-- ⚠️ Scoped to boards that still look DEFAULT: exactly one column per status of
-- this project, each mapped to exactly one status. A board an admin has merged
-- or split is deliberately left alone — this migration cannot know where a
-- Planning column belongs in a layout somebody designed, and inventing one would
-- be worse than the status being unmapped there. Such a board keeps working;
-- its owner adds the column when they want it.
INSERT INTO "board_column" (
  "id", "workspace_id", "project_id", "board_id", "name", "position",
  "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text,
  ps."workspace_id",
  ps."project_id",
  b."id",
  'Planning',
  ps."position",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "workflow_status" ps
JOIN "board" b ON b."project_id" = ps."project_id"
WHERE ps."key" = 'planning'
  -- The board is still the 1:1 projection: one column per OTHER status, and no
  -- column mapping more than one status.
  AND (SELECT COUNT(*) FROM "board_column" c WHERE c."board_id" = b."id")
      = (SELECT COUNT(*) FROM "workflow_status" s
         WHERE s."project_id" = ps."project_id" AND s."key" <> 'planning')
  AND NOT EXISTS (
    SELECT 1 FROM "board_column" c
    WHERE c."board_id" = b."id"
      AND (SELECT COUNT(*) FROM "board_column_status" m WHERE m."column_id" = c."id") <> 1
  )
  -- Idempotent: nothing to do once this status is mapped on this board.
  AND NOT EXISTS (
    SELECT 1 FROM "board_column_status" m
    WHERE m."board_id" = b."id" AND m."status_id" = ps."id"
  );

INSERT INTO "board_column_status" (
  "id", "workspace_id", "project_id", "board_id", "column_id", "status_id", "created_at"
)
SELECT
  gen_random_uuid()::text,
  c."workspace_id",
  c."project_id",
  c."board_id",
  c."id",
  ps."id",
  CURRENT_TIMESTAMP
FROM "board_column" c
JOIN "workflow_status" ps
  ON ps."project_id" = c."project_id" AND ps."key" = 'planning'
WHERE c."name" = 'Planning'
  AND NOT EXISTS (
    SELECT 1 FROM "board_column_status" m WHERE m."column_id" = c."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "board_column_status" m
    WHERE m."board_id" = c."board_id" AND m."status_id" = ps."id"
  );
