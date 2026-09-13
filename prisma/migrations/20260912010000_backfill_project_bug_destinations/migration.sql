-- MOTIR-4936 — BACKFILL every existing project's bug destination.
-- ===========================================================================
-- Story MOTIR-4927. MOTIR-4935 gives every NEW project a container at creation;
-- this is the other half — the projects that already existed. Together they turn
-- `ensure_planner_bug_home`'s ONE-SHOT backfill into a standing invariant, which
-- is the whole point: that migration's own header says "a migration runs EXACTLY
-- ONCE per database: it is a one-shot backfill, not a standing guarantee", and
-- every project created after it ran has had no home at all.
--
-- ---------------------------------------------------------------------------
-- TWO POPULATIONS, TOLD APART BY A READ AND NOT BY A DATE
-- ---------------------------------------------------------------------------
--   1. a project that ALREADY has a planner-bug home  -> POINT AT IT.
--   2. a project with no home                          -> seed a container.
--
-- ⚠️ The discriminator is a READ, deliberately. A cutoff date would be a proxy
-- for the 2026-07-01 migration's reach, and that fact is about ONE database —
-- wrong for any database restored, branched, or seeded differently. Asking each
-- project what it has costs the same and is true everywhere.
--
-- Population 1 is NOT given a second container and its existing home is not
-- renamed, re-kinded or moved: it stays a `story` titled
-- `PLANNER_BUG_HOME_STORY_TITLE`, so the legacy resolver keeps resolving for the
-- meta tenant exactly as before. The `task` kind is a decision about NEW
-- containers, not a migration of old ones.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS A MIGRATION AND NOT ONLY A SCRIPT
-- ---------------------------------------------------------------------------
-- `pnpm db:backfill:bug-destinations` exists too and shares MOTIR-4935's seed
-- code, which is the better path for an operator re-run. But a script only fixes
-- the databases somebody remembers to run it against, and this card's criterion
-- is that the backfill is *applied by `migrate deploy`* — so the guarantee has to
-- live here, where every environment gets it without being asked. The cost is
-- that the INSERT below restates the container's shape in SQL; it is bounded (one
-- row per project), and a migration is frozen once shipped, so it cannot drift
-- afterwards — it can only be superseded.
--
-- ---------------------------------------------------------------------------
-- ARCHIVED PROJECTS ARE INCLUDED, EXPLICITLY
-- ---------------------------------------------------------------------------
-- An archive is a SOFT remove and is reversible, so an archived project that is
-- later restored must not come back as the one project with no destination —
-- which is precisely the *undecided* state this card exists to eliminate. They
-- cost one row each. (Archived WORK ITEMS are excluded as destination candidates
-- below: pointing at one would resolve straight to the root.)
--
-- ⚠️ `NULL` IS A VALUE and this migration must never overwrite one somebody
-- CHOSE. Today it cannot: MOTIR-4938's picker has not shipped, so nothing can
-- select the root yet and a null pointer can only mean "not configured". That
-- ordering is why the backfill runs now rather than later, and it is why the
-- WHERE clauses below are `bug_destination_id IS NULL` and nothing more.

-- 1. ADOPT an existing planner-bug home ---------------------------------------
--    Matched on the same literal `lib/ai/plannerBugHome.ts` and the
--    `ensure_planner_bug_home` migration share. Archived homes are skipped so a
--    pointer is never aimed at a row the resolver would fall back from, and the
--    lowest `key` wins so the result is deterministic if a stray duplicate
--    exists.
UPDATE "project" p
   SET "bug_destination_id" = (
     SELECT wi."id"
       FROM "work_item" wi
      WHERE wi."projectId" = p."id"
        AND wi."kind" = 'story'
        AND wi."title" = 'Captured planning-mistake bugs'
        AND wi."archivedAt" IS NULL
      ORDER BY wi."key" ASC
      LIMIT 1
   )
 WHERE p."bug_destination_id" IS NULL
   AND EXISTS (
     SELECT 1 FROM "work_item" wi
      WHERE wi."projectId" = p."id"
        AND wi."kind" = 'story'
        AND wi."title" = 'Captured planning-mistake bugs'
        AND wi."archivedAt" IS NULL
   );

-- 2. SEED a container for everything still undecided ---------------------------
--    One row per project, with the key allocated off the project's own counter
--    (never guessed), the identifier built from the project's current prefix, and
--    the status read from the project's OWN initial workflow status rather than
--    hardcoded — a project whose workflow was customised must still get a legal
--    row.
--
-- ⚠️ THE POINTER IS SET BY A THIRD STATEMENT, AND THAT SPLIT IS LOAD-BEARING.
-- It is tempting to finish this one with `UPDATE project SET bug_destination_id
-- = <the inserted id>`, but the `alloc` CTE below ALREADY updates `project` (to
-- burn the key) — and in Postgres, when two data-modifying sub-statements touch
-- the same row, the second has NO EFFECT. Written as one statement it inserts
-- every container and silently leaves every pointer null, which looks exactly
-- like a migration that did nothing.
WITH needs AS (
  SELECT p."id" AS pid, p."workspaceId" AS wid, p."identifier" AS prefix
    FROM "project" p
   WHERE p."bug_destination_id" IS NULL
),
-- The workspace OWNER is the reporter, falling back to any member: `reporterId`
-- is NOT NULL with ON DELETE RESTRICT, and there is no system principal in a
-- customer tenant to stand in. A workspace with no members at all is skipped by
-- the JOIN below rather than failing the migration.
reporters AS (
  SELECT n.pid,
         (SELECT wm."userId"
            FROM "workspace_membership" wm
           WHERE wm."workspaceId" = n.wid
           ORDER BY (wm."role" = 'owner') DESC, wm."createdAt" ASC
           LIMIT 1) AS uid
    FROM needs n
),
statuses AS (
  SELECT n.pid,
         (SELECT ws."key" FROM "workflow_status" ws
           WHERE ws."project_id" = n.pid AND ws."is_initial" = true
           LIMIT 1) AS status_key
    FROM needs n
),
positions AS (
  SELECT n.pid,
         COALESCE((SELECT MAX(wi."position") FROM "work_item" wi WHERE wi."projectId" = n.pid), 'a0')
           AS maxpos
    FROM needs n
),
ready AS (
  SELECT n.pid, n.wid, n.prefix, r.uid, s.status_key, po.maxpos
    FROM needs n
    JOIN reporters r  ON r.pid  = n.pid
    JOIN statuses s   ON s.pid  = n.pid
    JOIN positions po ON po.pid = n.pid
   WHERE r.uid IS NOT NULL
     AND s.status_key IS NOT NULL
),
alloc AS (
  UPDATE "project" p
     SET "lastWorkItemNumber" = p."lastWorkItemNumber" + 1
    FROM ready rd
   WHERE p."id" = rd.pid
  RETURNING p."id" AS pid, p."lastWorkItemNumber" AS n
)
INSERT INTO "work_item" (
  "id", "workspaceId", "projectId", "parentId", "kind", "key", "identifier",
  "title", "descriptionMd", "status", "priority", "reporterId", "position",
  "backlogRank", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text, rd.wid, rd.pid, NULL, 'task'::"work_item_kind",
  a.n, rd.prefix || '-' || a.n,
  'Bugs',
  'Filed bugs land here.' || chr(10) || chr(10) ||
    'This container was created with the project. You can rename it, move it, file' || chr(10) ||
    'into it by hand, or point this project somewhere else entirely — including at' || chr(10) ||
    'the project root, so incoming bugs are top-level and impossible to miss.' || chr(10) ||
    'Project settings → Bugs is where that choice lives.',
  rd.status_key, 'medium'::"work_item_priority", rd.uid,
  rd.maxpos || 'V', rd.maxpos || 'V', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM ready rd JOIN alloc a ON a.pid = rd.pid;

-- 3. POINT each project at the container statement 2 just created ---------------
--    Matched on the KEY, not on the title: statement 2 allocated that key by
--    incrementing the project's counter, so the container is exactly the row
--    holding `lastWorkItemNumber`. Resolving it by title here would reintroduce
--    the title lookup this whole story exists to remove.
UPDATE "project" p
   SET "bug_destination_id" = (
     SELECT wi."id" FROM "work_item" wi
      WHERE wi."projectId" = p."id" AND wi."key" = p."lastWorkItemNumber"
      LIMIT 1
   )
 WHERE p."bug_destination_id" IS NULL
   AND EXISTS (
     SELECT 1 FROM "work_item" wi
      WHERE wi."projectId" = p."id" AND wi."key" = p."lastWorkItemNumber"
   );
