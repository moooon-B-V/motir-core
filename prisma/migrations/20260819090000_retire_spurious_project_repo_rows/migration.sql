-- ===========================================================================
-- Retire the repository-set rows the proposer wrote for projects that ALREADY
-- had code (MOTIR-3078 — the data half of MOTIR-3073)
-- ===========================================================================
-- WHY THIS EXISTS. `projectRepoProposalService.proposeRepositorySet` had one
-- idempotence gate — "does this project's own `project_repository` set have any
-- row?" — which answers a different question from "does this project have a
-- codebase?". They read identically for a project born in Motir and diverge
-- completely for one that ARRIVED with its code: the migrate onboarding path
-- records the connected repository on its own run row (`connected_repo_ref`) and
-- never writes this table, so such a project reads as set-less forever and its
-- first plan approval proposed a starter repo it does not need. MOTIR-3073
-- shipped the `project_has_code` gate that stops any NEW row being written. This
-- clears the rows the ungated proposer already wrote.
--
-- The damage is not cosmetic. A project's repository SET is its repo-pin domain:
-- on the live MOTIR project one spurious `motir-projects/motir` row made every
-- real repository (`moooon-B-V/motir-{ai,core,gateway,meta}`) unnameable, so
-- `targetRepo: "motir-core"` was rejected on every card, through the MCP, the UI
-- and a plan alike. Until the row is gone the fix is inert.
--
-- WHY A MIGRATION AND NOT A CONSOLE SESSION. Deleting the one row by cuid would
-- repair the box the defect was found on and leave the CLASS: any tenant that
-- approved a plan on a project with existing code has one too, and nothing about
-- that is specific to moooon. A migration states the footprint as a predicate,
-- is reviewable before it executes, runs everywhere the schema runs, and
-- self-applies through the `prisma migrate deploy` every release already runs
-- (.github/workflows + the Vercel build step) — the shape mistake #100/#101 in
-- motir-meta/notes.html prescribes for deployed-data repair. Same precedent as
-- `20260805150000_clear_cancelled_manual_provenance`.
--
-- THE PREDICATE IS THE GUARD — four parts, ALL required, and it is deliberately
-- the exact COMPLEMENT of the gate MOTIR-3073 added: it deletes what that gate
-- would have refused to create, so the two can be read against each other.
--
--   1. `proposal_signal` is one of the PROPOSER'S OWN signals — the ADR §0.1
--      ladder rungs in `lib/projectRepos/vocabulary.ts`
--      (`PROJECT_REPO_PROPOSAL_SIGNALS`): 'plan-item-role', 'preplan-platform',
--      'default-web'. This is what separates a row Motir INFERRED from a row a
--      PERSON added: `projectRepoSetService.addRow` leaves the column NULL for a
--      user's own row, and the proposer is the only writer that ever sets it.
--      NULL is therefore excluded automatically (`NULL IN (...)` is UNKNOWN, not
--      TRUE) — which is the correct answer and is asserted in the suite rather
--      than left to be re-derived.
--      ⚠️ SQL cannot import the TypeScript constant, so these three literals are
--      a COPY. `tests/integration/migrations/retire-spurious-project-repo-rows.test.ts`
--      parses this file and asserts the set here equals
--      `PROJECT_REPO_PROPOSAL_SIGNALS` exactly — so a rung added to the ladder
--      fails that guard instead of silently narrowing this predicate.
--
--   2. `seed_source` is a STARTER SEED, not a connection to something that
--      already existed — ADR §2's two values, also from `vocabulary.ts`
--      (`SEED_SOURCE_PLATFORM_STARTER` / `SEED_SOURCE_INITIALISED`). Guarded by
--      the same test for the same reason. When MOTIR-709's starter registry makes
--      this column a registry key, no row written before this migration can carry
--      one of those keys, so the closed list is right for the population this
--      migration can ever see.
--
--   3. `state` — see the six-way disposition below.
--
--   4. The project has a `migrate_onboarding` run with a NON-NULL
--      `connected_repo_ref`. This is the SAME project-scoped fact
--      `projectHasItsOwnCode` reads, and it must be: `github_repo` and the
--      code-index ledger are WORKSPACE-scoped, so a predicate keyed on "the
--      installation has repositories" or "something is indexed" would match every
--      project after the first in any workspace that has ever connected code —
--      and the second project in a workspace genuinely does need a repository.
--      Keyed on the FIELD rather than on `kind = 'migrate'`, so any future
--      onboarding path that connects an existing repository is covered without an
--      edit here (the same choice the gate made).
--
-- STATE — EVERY value of `project_repo_state` dispositioned, because this is the
-- part where a too-broad predicate destroys a real human decision:
--
--   * `proposed`  DELETE — nothing exists anywhere. A pure spurious proposal.
--   * `creating`  DELETE — an establish that was in flight for a repository this
--                 project should never have been offered. Same class as
--                 `created` below, caught mid-saga. It is the one value with a
--                 race (a concurrent establish landing during the deploy would
--                 find its row gone and fail its own write); the exposure is the
--                 seconds of a release, the failure is a background job error
--                 rather than data loss, and the alternative — leaving it — parks
--                 a spurious row in a TRANSIENT state that then resolves to
--                 `created` or `failed` and survives this migration forever,
--                 still holding the project's whole pin domain.
--   * `created`   DELETE — Motir really made this repository, and deleting the
--                 row drops the association while the repo lives on. That is
--                 nonetheless correct here: the repository it made is the
--                 spurious one, and the row is what governs Motir's behaviour.
--                 Disposing of the GitHub repository is a person's decision and
--                 is deliberately NOT part of this migration (see below).
--   * `failed`    DELETE — the establish failed, so no repository exists and no
--                 human decided anything. Pure cleanup.
--   * `connected` KEEP   — points at a repository somebody DELIBERATELY attached
--                 (`attachRealizedRepoRow` reaches `connected` only from a state
--                 that is not `creating`, i.e. a human connect). Never delete one.
--   * `skipped`   KEEP   — ADR §4.3: a deliberate statement that this project
--                 wants NO repository for that role. Deleting it would erase a
--                 decision and re-open a question its author closed.
--
-- NOT TENANT-GUARDED, deliberately. Unlike `20260701130000_ensure_planner_bug_home`
-- (which INSERTS moooon-specific rows and so must key on the meta tenant), this
-- INVENTS nothing and is not about one tenant: it removes rows the shipped
-- proposer should never have written, on any deployment that ran the ungated
-- lane — including a self-hosted one. On a fresh / CI / preview database the
-- predicate matches zero rows and the statement is a no-op.
--
-- IDEMPOTENT BY CONSTRUCTION. The rows are DELETED, so they cannot match a second
-- apply. (`migrate deploy` runs a migration exactly once per database anyway;
-- this holds regardless, and is what the suite asserts.)
--
-- `project_repo_collaborator_permission` cascades on this row's delete (its FK is
-- `onDelete: Cascade`); `github_repo` does NOT — the workspace-scoped
-- installation mirror is untouched, and the row's `github_repo_id` reference
-- simply goes away with the row.
--
-- Reports the blast radius as a NOTICE so the release log carries the number
-- rather than an assumption — a data migration that silently matches nothing and
-- one that silently matches four hundred rows look identical in a green pipeline.
-- Covered by tests/integration/migrations/retire-spurious-project-repo-rows.test.ts.
-- ===========================================================================
DO $$
DECLARE
  deleted_rows bigint;
BEGIN
  DELETE FROM "project_repository" AS pr
   WHERE pr."proposal_signal" IN ('plan-item-role', 'preplan-platform', 'default-web')
     AND pr."seed_source" IN ('nextjs-prisma-vercel-starter', 'initialised')
     AND pr."state" IN ('proposed', 'creating', 'created', 'failed')
     AND EXISTS (
       SELECT 1
         FROM "migrate_onboarding" mo
        WHERE mo."project_id" = pr."project_id"
          AND mo."connected_repo_ref" IS NOT NULL
     );

  GET DIAGNOSTICS deleted_rows = ROW_COUNT;
  RAISE NOTICE 'MOTIR-3078: retired % spuriously auto-proposed project_repository row(s) from projects that already had code', deleted_rows;
END
$$;
