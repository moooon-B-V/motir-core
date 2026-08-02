-- MOTIR-2007 — retire the supervision memo.
--
-- MOTIR-2002 added these two columns so that the boot's supervision, which had
-- to run OUTSIDE any `ctx.step.run` (it outlived the 300s step ceiling), would
-- still execute once per dispatch rather than once per durable-replay pass.
--
-- The supervision is now a durable poll loop: every phase runs inside a step, so
-- Inngest's own memoization gives once-per-run for free and the columns have no
-- remaining reader. Dropped rather than left behind, so the next person reading
-- the intent table does not find a memo nothing writes.
ALTER TABLE "ci_runner_provisioning_intent" DROP COLUMN IF EXISTS "supervision_key",
DROP COLUMN IF EXISTS "supervision_outcome";
