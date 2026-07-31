-- MOTIR-711 — the TAKE-IT-OVER saga on `project_repository`.
--
-- Story MOTIR-1775 creates every new project's repositories under MOTIR'S OWN
-- GitHub org and states the promise plainly: "it's yours — move it to your own
-- GitHub whenever you want." This is the state that makes the promise true, and
-- the honest SECOND answer when an org's CI credits run out (the first is to add
-- credits; an option that leads nowhere is not an option).
--
-- WHY DURABLE STATES AND NOT AN INFERENCE FROM THE MIRROR. Two of the five states
-- are WAITS ON A HUMAN doing something on github.com — the new owner ACCEPTING a
-- transfer (required for a personal-account target), and someone INSTALLING the
-- Motir App on the new account — and neither has a bounded duration. The mirror
-- can say where a repository IS; it can never say whether anyone still intends to
-- finish moving it. A wait nobody recorded is a wedged repository, so each one is
-- a row state a later visit can re-prompt from:
--
--   requested ──▶ transfer_pending ──▶ awaiting_reinstall ──▶ done
--       │                 │                     │
--       └──────── failed ◀┴─────────────────────┘   (failed ──retry──▶ requested)
--
-- WHY `done` REQUIRES AN INSTALLATION, NOT JUST A COMPLETED TRANSFER. A GitHub App
-- installation is ACCOUNT-SCOPED, so moving the repository out of Motir's org takes
-- it out of Motir's install scope. Without a fresh installation under the new owner
-- dispatch and the code-graph feed silently stop — a broken loop dressed up as a
-- finished handoff. `takeover_completed_at` is therefore stamped only when an
-- installation is actually observed. (The Lovable "transfer-while-connected breaks
-- sync" lesson, recorded on the card.)
--
-- WHY THE STATE COLUMN IS NULLABLE RATHER THAN DEFAULTED. NULL means "no takeover
-- has ever been requested", which is the state of almost every row that will ever
-- exist. It is deliberately NOT a member of the enum: a default would assert that
-- every repository is mid-handoff, and the surface would then have to hide an
-- "idle" chip on every row.
--
-- NOTHING IS BACKFILLED, and that is correct: no repository has been handed over
-- yet, so NULL is the true value for every existing row.
--
-- NO NEW RLS POLICY. These are columns on `project_repository`, whose FOR ALL
-- policy already predicates on `app.workspace_id` — a new column inherits it, and
-- adding a second policy would only create a place for the two to drift.

-- CreateEnum
CREATE TYPE "project_repo_takeover_state" AS ENUM (
  'requested',
  'transfer_pending',
  'awaiting_reinstall',
  'done',
  'failed'
);

-- AlterTable
ALTER TABLE "project_repository"
  ADD COLUMN "takeover_state"          "project_repo_takeover_state",
  ADD COLUMN "takeover_target_owner"   TEXT,
  ADD COLUMN "takeover_requested_at"   TIMESTAMP(3),
  ADD COLUMN "takeover_transferred_at" TIMESTAMP(3),
  ADD COLUMN "takeover_completed_at"   TIMESTAMP(3),
  ADD COLUMN "takeover_failure_reason" TEXT;

-- A PARTIAL index on the IN-FLIGHT states only.
--
-- The set this serves — "which handoffs are unfinished?" — is empty almost always
-- and tiny otherwise, while the table holds every repository row of every project.
-- A full index would be almost entirely NULLs and `done`, i.e. pages of entries
-- for the rows no reader of this predicate ever wants. Excluding `failed` is
-- deliberate too: a failed takeover is resumed only when the USER asks again, so
-- it is not work any sweep should be enumerating.
CREATE INDEX "project_repository_takeover_in_flight_idx"
  ON "project_repository" ("workspace_id", "takeover_state")
  WHERE "takeover_state" IN ('requested', 'transfer_pending', 'awaiting_reinstall');
