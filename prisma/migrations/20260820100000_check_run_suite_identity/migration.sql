-- ============================================================
-- A check row records the RUN it came from, and the key says so (MOTIR-3209).
-- ============================================================
-- `github_check_run` was keyed `(pull_request_id, commit_sha, check_name)` — a
-- key that assumes ONE workflow run per commit. `cancel-in-progress`
-- (MOTIR-3106) made two runs at one commit ordinary and deliberate: a label
-- added seconds after `gh pr create` fires a second run and the first is
-- cancelled. The two runs do not use the same check NAMES, so under a name-keyed
-- table the loser's rows outlived the winner's exactly where the names differ:
--
--   * a matrix job cancelled BEFORE expansion reports the literal template as
--     its name (`Vitest (${{ matrix.shard }}/${{ matrix.total }})`), which the
--     winner's `Vitest (1/3)` can never overwrite — a different key;
--   * `Deploy to Fly` is the same trap from the other side: `cancelled` maps to
--     `failure` in the loser and `skipped` maps to `neutral` in the winner, and
--     a neutral records nothing, so nothing ever clears the failure.
--
-- Both derivations then read a `failure` at the head sha forever: the feedback
-- comment says "CI failed", naming checks GitHub shows green, and the CI-green
-- promotion (MOTIR-3006) never runs, so the card is stranded at `implemented`.
-- Observed on motir-core PR #2192 / MOTIR-3206, for six hours.
--
-- `check_suite_id` is that run's identity — GitHub creates ONE check suite per
-- workflow run, which is why CI and CodeQL sit in different suites at one sha.
--
-- ⚠️ NOT NULL with an EMPTY-STRING default, not a nullable column. Postgres
-- treats NULLs in a unique index as DISTINCT, so a nullable member would stop
-- the upsert converging and insert a fresh row per delivery. `''` means "no run
-- identity": every row written before this column existed takes it, as does
-- every provider that reports none (a legacy commit-`status` event). Those rows
-- form one degraded group that supersedes nothing and is superseded by nothing
-- — precisely the behaviour they had before this migration, which is what the
-- derivation's back-compat case asserts.
ALTER TABLE "github_check_run"
  ADD COLUMN "check_suite_id" TEXT NOT NULL DEFAULT '';

DROP INDEX IF EXISTS "github_check_run_pull_request_id_commit_sha_check_name_key";

CREATE UNIQUE INDEX "github_check_run_pull_request_id_commit_sha_check_name_chec_key"
  ON "github_check_run" ("pull_request_id", "commit_sha", "check_name", "check_suite_id");
