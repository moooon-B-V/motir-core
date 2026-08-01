-- The PER-PROJECT RUNNER GROUP (Story MOTIR-1916 · MOTIR-1972) —
-- `docs/decisions/ci-runner-fleet.md` §7.3: "No org-wide runner group. One
-- runner group PER MOTIR PROJECT, access-listed to exactly that project's
-- repositories", created programmatically at repository establishment.
--
-- ⚠️ THESE COLUMNS ARE LOAD-BEARING FOR CORRECTNESS, not isolation hygiene.
-- `runs-on` resolves to a STATIC label (`vars.MOTIR_RUNNER`), so every fleet
-- runner visible to a queued fleet job matches it. With one org-wide group a
-- runner Motir booted for project X is picked up by project Y's queued job —
-- including a job MOTIR-1922's admission gate DECLINED. That makes the gate
-- advisory: a tenant at its cap still gets CI, paid for by another tenant's
-- provisioning decision and metered to the wrong org. The group's
-- `selected_repository_ids` is what makes the label unambiguous, so
-- `runner_group_id` is the precondition of the gate meaning anything.
--
-- MOTIR-1921 mints its JIT config against `runner_group_id` and REFUSES to
-- provision when it is NULL, rather than falling back to the `Default` group
-- (id 1, `visibility: all`) — which would silently restore the very failure
-- these columns exist to prevent.
--
-- NULL / FALSE backfills are correct for every existing row: a project that
-- predates the fleet has no group, and a self-hosted deployment never
-- provisions a repository at all, so the whole path is unreachable there.
-- No data step, no index — the columns are read by project id, which is the
-- primary key.

ALTER TABLE "project"
  ADD COLUMN "runner_group_id" INTEGER,
  ADD COLUMN "runner_group_name" TEXT,
  ADD COLUMN "runner_group_synced_at" TIMESTAMP(3),
  ADD COLUMN "runner_group_sync_pending" BOOLEAN NOT NULL DEFAULT false;
