-- MOTIR-7503 — back-fill `dispatch_run_card.model` for every leg written before
-- the writer (MOTIR-7502) was live, from the model its agent already reported
-- inside the `agent_exited` event's `data`.
--
-- ⚠️ THE VALIDITY RULE MIRRORS `normalizeReportedModel`
-- (`lib/dispatchRuns/reportedModel.ts`), AND THE TWO MUST AGREE: a JSON string,
-- trimmed, non-blank, at most 200 characters, else no model. `btrim` is given the
-- whitespace set JavaScript's `trim()` strips in practice (space, tab, the line
-- breaks, form feed, vertical tab, NBSP, BOM), because the default `btrim` strips
-- spaces only. `tests/dispatchRunLegModelBackfill.test.ts` runs this file's own
-- statement against the cases the writer's tests pin.
--
-- Per leg, the value is the one from the LATEST (`seq` highest) `agent_exited`
-- event whose model passes the rule — the same answer the writer gives, which
-- never lets a later exit with no report erase an earlier one. A leg with no
-- such event stays null: nothing is inferred from `dispatch_run.model`, the agent
-- name or anything else.
--
-- IDEMPOTENT BY CONSTRUCTION: only legs whose `model IS NULL` are touched, so a
-- leg the writer already filled is never overwritten, and a second run finds
-- nothing it can fill.
--
-- ONE SET-BASED `UPDATE … FROM`, not a batched `DO` block. The events it reads
-- are filtered to `kind = 'agent_exited'` (at most a few per leg, and runs are
-- capped at `DISPATCH_RUN_EVENT_LIMIT` events), and the UPDATE takes row locks on
-- `dispatch_run_card` only — `dispatch_run_event` is read under MVCC, so no
-- reporter's append is blocked behind it. The table holds one row per leg a run
-- has ever worked, which is a single-pass size.
UPDATE "dispatch_run_card" AS leg
SET "model" = latest.model
FROM (
  SELECT DISTINCT ON (e."dispatch_run_card_id")
    e."dispatch_run_card_id" AS leg_id,
    btrim(e."data" ->> 'model', E' \t\n\r\f\v' || U&'\00A0\FEFF') AS model
  FROM "dispatch_run_event" AS e
  WHERE e."kind" = 'agent_exited'
    AND e."dispatch_run_card_id" IS NOT NULL
    AND jsonb_typeof(e."data" -> 'model') = 'string'
    AND char_length(btrim(e."data" ->> 'model', E' \t\n\r\f\v' || U&'\00A0\FEFF')) BETWEEN 1 AND 200
  ORDER BY e."dispatch_run_card_id", e."seq" DESC
) AS latest
WHERE leg."id" = latest.leg_id
  AND leg."model" IS NULL;
