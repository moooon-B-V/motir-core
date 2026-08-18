-- A work item's repositories become REFERENCES to the project's repository rows
-- (Story MOTIR-2732 · MOTIR-3039), specified by
-- `docs/decisions/work-item-repository-set.md` "Amendment 2026-08-18" §A2 / §A7.
--
-- This is §A7's EXPAND step. It ADDS the join table and BACKFILLS it, and it drops
-- nothing: `work_item.targetRepos` / `targetRepoRole` still have readers and writers
-- in sibling cards of this story, and a column dropped ahead of them would not
-- compile. The CONTRACT step is MOTIR-3040, after MOTIR-3041 moves the reads and
-- MOTIR-3033 moves the last writer.
--
-- Workspace-scoped tenant data, so its RLS policy lands in THIS SAME migration
-- (migration-by-concern, PRODECT_FINDINGS #20 — no unguarded window), and
-- `workspace_id` is carried on the ROW because RLS does not traverse foreign keys.
-- All three FKs are modelled as Prisma `@relation`s (forward + back-relation) with
-- the SAME actions this SQL uses, so `migrate diff` reports no drift (the
-- FK-`@relation` rule).
--
-- The two UNIQUE indexes are the two corruptions this table must make impossible,
-- in the DATABASE and not merely "the service checks first":
--
--   * `work_item_repository_work_item_id_project_repo_id_key` — one reference per
--     repository per item. The write path already collapses duplicates keeping the
--     first occurrence (the same rule `matchAuthoredTargetRepos` applies to names);
--     this index is that rule's backstop and the arbiter of a lost race.
--   * `work_item_repository_work_item_id_position_key` — the ordering is a FACT,
--     so a gap or a collision is a database error rather than something a reader
--     has to interpret. Element 0 is the PRIMARY the dispatch routes to (ADR §2).
--
-- `project_repo_id` is CASCADE on delete, deliberately: removing a row from the
-- project's set removes the cards' references to it, because the project no longer
-- has that repository. `Restrict` would make the set uneditable the moment any card
-- pinned a row, which `docs/decisions/project-repository-set.md` §4.4 forbids. A
-- pin's survival across a repository being DISCONNECTED is a DIFFERENT edge, and is
-- preserved by `project_repository.github_repo_id`'s existing SET NULL — which is
-- also the reason §1.1's rejection of a foreign key (to `github_repo`) does not
-- carry over to this one (amendment §A1).

-- CreateTable
CREATE TABLE "work_item_repository" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "project_repo_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_repository_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "work_item_repository_work_item_id_project_repo_id_key" ON "work_item_repository"("work_item_id", "project_repo_id");

-- CreateIndex
CREATE UNIQUE INDEX "work_item_repository_work_item_id_position_key" ON "work_item_repository"("work_item_id", "position");

-- CreateIndex
CREATE INDEX "work_item_repository_workspace_id_idx" ON "work_item_repository"("workspace_id");

-- CreateIndex
CREATE INDEX "work_item_repository_project_repo_id_idx" ON "work_item_repository"("project_repo_id");

-- AddForeignKey
ALTER TABLE "work_item_repository" ADD CONSTRAINT "work_item_repository_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_repository" ADD CONSTRAINT "work_item_repository_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_repository" ADD CONSTRAINT "work_item_repository_project_repo_id_fkey" FOREIGN KEY ("project_repo_id") REFERENCES "project_repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- BACKFILL, in the two passes amendment §A7 step 1 prescribes, in this order.
--
-- Pass 1 — NAMES. Each element of `targetRepos` (or the scalar `targetRepo` when
-- the array is empty) resolves to the `project_repository` row of that item's OWN
-- project, matching case-insensitively against the row's RESOLVED name — the
-- realized repository's own `name` when the row is realized, else the row's
-- authored `name`. That is exactly `lib/projectRepos/names.ts`'s
-- `toProjectRepoPinNames` rule, and agreeing with it is what makes the backfilled
-- reference the same one the write path would produce today. Order is preserved;
-- two pins resolving to ONE row collapse keeping the earlier element, exactly as
-- `matchAuthoredTargetRepos` collapses duplicate names.
--
-- Never guessed across projects (the join is on `project_id`) and never matched on
-- a substring. A pin that resolves to no row of its project — which is every pin in
-- a project that has NO repository set, the compatibility rung
-- `docs/decisions/target-repo-attribution.md` installs — writes NO reference and
-- keeps its `work_item.targetRepo` value, unchanged and still authoritative for it.
WITH repo_names AS (
    SELECT pr."id"         AS project_repo_id,
           pr."project_id" AS project_id,
           lower(COALESCE(gr."name", pr."name")) AS lname
    FROM "project_repository" pr
    LEFT JOIN "github_repo" gr ON gr."id" = pr."github_repo_id"
), pins AS (
    SELECT w."id"          AS work_item_id,
           w."workspaceId" AS workspace_id,
           w."projectId"   AS project_id,
           p.pin           AS pin,
           p.ord           AS ord
    FROM "work_item" w
    CROSS JOIN LATERAL unnest(
        CASE
            WHEN COALESCE(array_length(w."targetRepos", 1), 0) > 0 THEN w."targetRepos"
            WHEN w."targetRepo" IS NOT NULL THEN ARRAY[w."targetRepo"]
            ELSE ARRAY[]::text[]
        END
    ) WITH ORDINALITY AS p(pin, ord)
), matched AS (
    SELECT pins.work_item_id,
           pins.workspace_id,
           rn.project_repo_id,
           min(pins.ord) AS ord
    FROM pins
    JOIN repo_names rn
      ON rn.project_id = pins.project_id
     AND rn.lname = lower(pins.pin)
    GROUP BY pins.work_item_id, pins.workspace_id, rn.project_repo_id
)
INSERT INTO "work_item_repository" ("id", "workspace_id", "work_item_id", "project_repo_id", "position")
SELECT gen_random_uuid()::text,
       matched.workspace_id,
       matched.work_item_id,
       matched.project_repo_id,
       (row_number() OVER (PARTITION BY matched.work_item_id ORDER BY matched.ord))::int - 1
FROM matched;

-- Pass 2 — the ROLE, for an item that pass 1 left with no reference at all.
--
-- `work_item.targetRepoRole` is the PORTABLE pin a plan records when the
-- repositories do not exist yet, and `docs/decisions/project-repository-set.md`
-- §5.3 resolves it by counting rows carrying that role in ANY state: exactly one →
-- that row; zero or more than one → nothing, never an arbitrary pick. Counting over
-- all states rather than the established ones is §5.3's own correction, and it is
-- what makes the verdict a property of the SET rather than of run order.
--
-- Referencing an UNESTABLISHED row is legal under the reference model (§A3), which
-- is why this pass recovers items the name model could only leave unrouted until a
-- background pass ran. Restricted to items with no reference so it can never
-- disagree with a name the author actually wrote.
WITH role_rows AS (
    SELECT pr."project_id" AS project_id,
           pr."role"       AS role,
           min(pr."id")    AS project_repo_id,
           count(*)        AS row_count
    FROM "project_repository" pr
    GROUP BY pr."project_id", pr."role"
)
INSERT INTO "work_item_repository" ("id", "workspace_id", "work_item_id", "project_repo_id", "position")
SELECT gen_random_uuid()::text,
       w."workspaceId",
       w."id",
       role_rows.project_repo_id,
       0
FROM "work_item" w
JOIN role_rows
  ON role_rows.project_id = w."projectId"
 AND role_rows.role = w."targetRepoRole"
 AND role_rows.row_count = 1
WHERE w."targetRepoRole" IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM "work_item_repository" wir WHERE wir."work_item_id" = w."id"
  );

-- REPORT the pins that resolved to nothing. A string that names no row of its
-- project is a FINDING, not a no-op — it is the compatibility-rung population the
-- amendment's §A7 names, and the ONE number that says how large it is. Emitted as
-- a NOTICE so it lands in the `migrate deploy` log of whichever database this runs
-- against, rather than being a number only the author's laptop ever saw.
DO $$
DECLARE
  unresolved_names integer;
  unresolved_roles integer;
  resolved_refs    integer;
BEGIN
  SELECT count(*) INTO resolved_refs FROM "work_item_repository";

  SELECT count(DISTINCT w."id") INTO unresolved_names
  FROM "work_item" w
  WHERE (COALESCE(array_length(w."targetRepos", 1), 0) > 0 OR w."targetRepo" IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM "work_item_repository" r WHERE r."work_item_id" = w."id");

  SELECT count(*) INTO unresolved_roles
  FROM "work_item" w
  WHERE w."targetRepoRole" IS NOT NULL
    AND COALESCE(array_length(w."targetRepos", 1), 0) = 0
    AND w."targetRepo" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "work_item_repository" r WHERE r."work_item_id" = w."id");

  RAISE NOTICE 'work_item_repository backfill: % reference(s) written; % item(s) with a NAME pin that resolved to no row of their project (kept in work_item.targetRepo); % item(s) with a ROLE pin that matched zero or more than one row',
    resolved_refs, unresolved_names, unresolved_roles;
END
$$;

-- RLS, in the same migration as the table (no unguarded window). FORCE so even the
-- table-owner `prodect` role is subject to it — production and the service writes
-- connect as the non-BYPASSRLS `prodect_app` role.
--
-- No system-admin escape: every write to this table comes from a REQUEST path with
-- an active workspace (the work-item write path, the plan materializer, the
-- container rollup), never from a webhook with no tenant. The gate is the row's OWN
-- `workspace_id`, not a join through `work_item` — RLS does not traverse foreign
-- keys.
--
-- The workspace RLS migration's `ALTER DEFAULT PRIVILEGES … TO prodect_app`
-- auto-grants on every NEW table created by the `prodect` role, so no explicit
-- GRANT is needed (same as project_repository / sprint / comment).
ALTER TABLE "work_item_repository" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "work_item_repository" FORCE ROW LEVEL SECURITY;

CREATE POLICY "work_item_repository_active_workspace" ON "work_item_repository"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
