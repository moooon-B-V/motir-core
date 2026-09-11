-- ============================================================
-- Backfill the `approved` default-workflow status (MOTIR-5139).
-- ============================================================
-- MOTIR-5139 adds a NINTH status to the default workflow
-- (lib/workflows/defaultWorkflow.ts): `approved`, in the **in_progress**
-- category, between `in_review` and `done`.
--
-- What is missing without it: a person's YES has nowhere to live. An approved
-- card either sits at `in_review` — which reads as NOBODY HAS LOOKED AT IT — or
-- jumps to `done`, which claims it merged. Both are false, and GitHub models the
-- same split: a pull request is approved, and separately merged.
--
-- The **in_progress** category is load-bearing, and it is the same reasoning
-- `planning` (20260807220000) and `implemented` (20260819090000) used, one rung
-- further along: readiness is derived from the `is_blocked_by` EDGES and the
-- blocker's TERMINALITY, never from the status key —
-- `lib/workItems/blockerReadiness.ts`'s `isOpenBlocker` asks whether the
-- blocker's status is in its project's `category = 'done'` set. So
-- `in_progress` is what keeps an approved card OPEN in every count, keeps
-- `parentStatusRollupService` from completing a container out of it, and keeps
-- its dependents blocked. Only `done` and `cancelled` are terminal.
--
-- New projects get it from `seedDefaultWorkflow`. This migration is what stops
-- every EXISTING project from being left with a loop that cannot express the
-- state the product is about to start writing — three writes per project, each
-- idempotent, each guarded so a CUSTOM workflow is left alone.
--
-- ⚠️ THREE writes, not one — the same shape 20260807220000 and 20260819090000
-- spelled out, and for the same reason: this adds a STATUS, so it must also add
-- the edges that reach it AND a board column to show it in. Without step 3 the
-- status is legal but its cards sit in no column and outside the board total, on
-- every existing project — `boardsService.getBoard` builds columns and totals
-- from MAPPED keys alone and reports the rest only in `unmappedStatuses`.

-- ── 1. The status ───────────────────────────────────────────────────────────
-- Position: `in_review.position || 'F'`, which sorts the new status BETWEEN
-- `in_review` and `done`. DERIVED for BOTH project shapes this has to work on,
-- not copied from the migration above — the two have different neighbours at
-- different keys, which is exactly why 20260819090000 printed its own arithmetic:
--
--   • a project BACKFILLED by 20260807220000 + 20260819090000 has
--       todo=a0  blocked=a1  in_progress=a2  implemented=a2F  planning=a2V
--       in_review=a3  done=a4  cancelled=a5
--     →  'a3' < 'a3F' < 'a4'                                   ✓
--     (read off the live moooon/motir project, which is such a project);
--
--   • a project SEEDED FRESH after 20260819090000 has its eight statuses from
--     `keyForAppend` in declared order:
--       todo=a0  blocked=a1  in_progress=a2  implemented=a3  planning=a4
--       in_review=a5  done=a6  cancelled=a7
--     →  'a5' < 'a5F' < 'a6'                                   ✓
--
-- 'F' is free here: `implemented` spent 'F' and `planning` 'V' on the
-- `in_progress` key, not on `in_review`, so there is no collision to avoid.
--
-- A project seeded fresh AFTER this migration gets nine sequential keys
-- (…in_review=a5  approved=a6  done=a7  cancelled=a8) and is skipped by the
-- NOT EXISTS guard below, as it should be.
--
-- The position is an opaque fractional index and nothing joins on it, so a
-- project whose statuses were reordered still gets a well-ordered row — just not
-- necessarily the same literal key a fresh project would have. That divergence is
-- invisible and deliberate, the same one the two migrations above accepted.
--
-- The `key`-based join leaves CUSTOM workflows untouched: a project that renamed
-- or removed `in_review` does not match, and gets nothing. Idempotent via the
-- NOT EXISTS guard. Ids are fresh uuids (the columns are plain `text`), mirroring
-- the migrations this one is modelled on.
INSERT INTO "workflow_status" (
  "id", "workspace_id", "project_id", "key", "label", "category",
  "position", "is_initial", "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text,
  ir."workspace_id",
  ir."project_id",
  'approved',
  'Approved',
  'in_progress'::"status_category",
  ir."position" || 'F',
  false,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "workflow_status" ir
WHERE ir."key" = 'in_review'
  AND NOT EXISTS (
    SELECT 1 FROM "workflow_status" s
    WHERE s."project_id" = ir."project_id" AND s."key" = 'approved'
  );

-- ── 2. The four edges ───────────────────────────────────────────────────────
-- ONE in (`in_review → approved`) and THREE out (`approved → done` when the
-- merge lands, `approved → in_progress` to pull work back after approval, and
-- `approved → cancelled` by this constant's own convention that cancellation is
-- legal from every non-terminal state).
--
-- ⚠️ `implemented → approved` is deliberately ABSENT — under the `restricted`
-- policy an undeclared hop is a 422, and this is the one that would let CI be
-- skipped. `implemented` means the branch is pushed and nothing has been
-- compiled; CI speaks before a person does, so the only way into `approved` is
-- through `in_review`, which is the status CI itself writes on green.
-- `tests/workflows/approved-status.test.ts` asserts the absence.
--
-- The pairs are enumerated rather than generated so this file states the same
-- graph `DEFAULT_TRANSITIONS` does, and a reader can compare them line for line.
-- A project missing one of the endpoint statuses simply gets fewer edges: the
-- join finds no row and that pair is skipped, which is correct for a workflow
-- somebody customised.
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
  ('in_review', 'approved'),
  ('approved', 'done'),
  ('approved', 'in_progress'),
  ('approved', 'cancelled')
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
-- carries an Approved column for free. An existing board does not, and
-- `boardsService.getBoard` builds its columns and its total from the union of
-- MAPPED status keys alone — so a card moved to `approved` would sit in no
-- column and outside the count, with only the status itself surfacing in
-- `unmappedStatuses`.
--
-- ⚠️ Scoped to boards that still look DEFAULT: exactly one column per status of
-- this project, each mapped to exactly one status. A board an admin has merged
-- or split is deliberately left alone — this migration cannot know where an
-- Approved column belongs in a layout somebody designed, and inventing one would
-- be worse than the status being unmapped there. Such a board keeps working; its
-- owner adds the column when they want it.
INSERT INTO "board_column" (
  "id", "workspace_id", "project_id", "board_id", "name", "position",
  "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text,
  ps."workspace_id",
  ps."project_id",
  b."id",
  'Approved',
  ps."position",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "workflow_status" ps
JOIN "board" b ON b."project_id" = ps."project_id"
WHERE ps."key" = 'approved'
  -- The board is still the 1:1 projection: one column per OTHER status, and no
  -- column mapping more than one status.
  AND (SELECT COUNT(*) FROM "board_column" c WHERE c."board_id" = b."id")
      = (SELECT COUNT(*) FROM "workflow_status" s
         WHERE s."project_id" = ps."project_id" AND s."key" <> 'approved')
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
  ON ps."project_id" = c."project_id" AND ps."key" = 'approved'
WHERE c."name" = 'Approved'
  AND NOT EXISTS (
    SELECT 1 FROM "board_column_status" m WHERE m."column_id" = c."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "board_column_status" m
    WHERE m."board_id" = c."board_id" AND m."status_id" = ps."id"
  );
