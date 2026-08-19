-- ============================================================
-- Backfill the `implemented` default-workflow status (MOTIR-3003).
-- ============================================================
-- MOTIR-3003 adds an EIGHTH status to the default workflow
-- (lib/workflows/defaultWorkflow.ts): `implemented`, in the **in_progress**
-- category. Today an agent's process exits 0 and the card jumps straight to In
-- Review — a status that claims a human should look at it — while nothing has
-- been compiled, linted or tested. `implemented` is the state between "the
-- agent stopped" and "a human should look at this", and the move out of it is a
-- fact about CI rather than about a process exit code.
--
-- The **in_progress** category is load-bearing, and it is the same reasoning
-- `planning` used (20260807220000): readiness is derived from the
-- `is_blocked_by` EDGES and never from the status, so what takes a card out of
-- the pickable set is its CATEGORY. A card whose pull request is open must not
-- be handed to the next run, and nothing special-cases it.
--
-- New projects get it from `seedDefaultWorkflow`. This migration is what stops
-- every EXISTING project from being left with a loop that cannot express the
-- state its own agents are told to report — three writes per project, each
-- idempotent, each guarded so a CUSTOM workflow is left alone.
--
-- ⚠️ THREE writes, not one — the same shape 20260807220000 spelled out, and for
-- the same reason: this adds a STATUS, so it must also add the edges that reach
-- it AND a board column to show it in. An unmapped status is legal — a column
-- owns a SET of status keys, a status MAY be unmapped, and `boardsService`
-- reports one in `unmappedStatuses` rather than dropping it — but the board's
-- COLUMNS and its total are built from the MAPPED keys alone. Without step 3 the
-- status would show up in a "not on this board" list while every card at it sat
-- in no column and outside the count, on every existing project.

-- ── 1. The status ───────────────────────────────────────────────────────────
-- Position: `in_progress.position || 'F'`, which sorts the new status BETWEEN
-- `in_progress` and whatever follows it, on BOTH project shapes this has to
-- work on:
--
--   • a project backfilled by 20260807220000 has `in_progress` at 'a2' and
--     `planning` at 'a2V'  →  'a2' < 'a2F' < 'a2V';
--   • a project seeded fresh after that migration has `planning` at 'a3'
--                          →  'a2' < 'a2F' < 'a3'.
--
-- 'F' rather than 'V' precisely because `planning` already took 'V': the two
-- suffixes are what keep the pair ordered, and `implemented` goes FIRST. That
-- ordering is a MEASURED decision, not a preference — a board column is 288px in
-- a 16px-gap row beside a 240px rail, so slot 4 is the last column a laptop
-- shows in full and slot 5 is off-screen at every laptop width measured
-- (`design/boards/implemented-column.mock.html`, panel 1). The path every card
-- walks takes the visible slot.
--
-- It is an opaque fractional index and nothing joins on it, so a project whose
-- statuses were reordered still gets a well-ordered row — just not necessarily
-- the same literal key a fresh project would have. That divergence is invisible
-- and deliberate; renumbering existing rows would be a much larger write for no
-- observable gain.
--
-- The `key`-based join leaves CUSTOM workflows untouched: a project that renamed
-- or removed `in_progress` does not match, and gets nothing. Idempotent via the
-- NOT EXISTS guard. Ids are fresh uuids (the columns are plain `text`; mixing
-- uuids with the app's cuids is fine — they are unique PKs), mirroring the
-- migration this one is modelled on.
INSERT INTO "workflow_status" (
  "id", "workspace_id", "project_id", "key", "label", "category",
  "position", "is_initial", "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text,
  ip."workspace_id",
  ip."project_id",
  'implemented',
  'Implemented',
  'in_progress'::"status_category",
  ip."position" || 'F',
  false,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "workflow_status" ip
WHERE ip."key" = 'in_progress'
  AND NOT EXISTS (
    SELECT 1 FROM "workflow_status" s
    WHERE s."project_id" = ip."project_id" AND s."key" = 'implemented'
  );

-- ── 2. The seven edges ──────────────────────────────────────────────────────
-- Two IN (`in_progress → implemented`, `blocked → implemented`) and five OUT
-- (`implemented → in_review` — what CI green does — plus rework, block, cancel
-- and the no-review-gate close). The pairs are enumerated rather than generated
-- so this file states the same graph `DEFAULT_TRANSITIONS` does, and a reader
-- can compare them line for line.
--
-- A project missing one of the endpoint statuses simply gets fewer edges: the
-- join finds no row and that pair is skipped, which is the correct behaviour for
-- a workflow somebody customised.
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
  ('in_progress', 'implemented'),
  ('blocked', 'implemented'),
  ('implemented', 'in_review'),
  ('implemented', 'in_progress'),
  ('implemented', 'blocked'),
  ('implemented', 'cancelled'),
  ('implemented', 'done')
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
-- carries an Implemented column for free. An existing board does not, and
-- `boardsService.getBoard` builds its columns and its total from the union of
-- MAPPED status keys alone — so a card moved to `implemented` would sit in no
-- column and outside the count, with only the status itself surfacing in
-- `unmappedStatuses`.
--
-- ⚠️ Scoped to boards that still look DEFAULT: exactly one column per status of
-- this project, each mapped to exactly one status. A board an admin has merged
-- or split is deliberately left alone — this migration cannot know where an
-- Implemented column belongs in a layout somebody designed, and inventing one
-- would be worse than the status being unmapped there. Such a board keeps
-- working; its owner adds the column when they want it.
INSERT INTO "board_column" (
  "id", "workspace_id", "project_id", "board_id", "name", "position",
  "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text,
  ps."workspace_id",
  ps."project_id",
  b."id",
  'Implemented',
  ps."position",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "workflow_status" ps
JOIN "board" b ON b."project_id" = ps."project_id"
WHERE ps."key" = 'implemented'
  -- The board is still the 1:1 projection: one column per OTHER status, and no
  -- column mapping more than one status.
  AND (SELECT COUNT(*) FROM "board_column" c WHERE c."board_id" = b."id")
      = (SELECT COUNT(*) FROM "workflow_status" s
         WHERE s."project_id" = ps."project_id" AND s."key" <> 'implemented')
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
  ON ps."project_id" = c."project_id" AND ps."key" = 'implemented'
WHERE c."name" = 'Implemented'
  AND NOT EXISTS (
    SELECT 1 FROM "board_column_status" m WHERE m."column_id" = c."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "board_column_status" m
    WHERE m."board_id" = c."board_id" AND m."status_id" = ps."id"
  );
