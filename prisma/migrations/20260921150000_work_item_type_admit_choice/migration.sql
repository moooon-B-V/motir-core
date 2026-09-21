-- Admit `choice` to `work_item_type` (Story MOTIR-4914 · Subtask MOTIR-5890).
--
-- The explicit enum addition the taxonomy ADR reserves as the ONLY legal way to
-- grow this set; the decision is its Amendment 3 (MOTIR-5886): `choice` is a
-- question the planner correctly declined to decide, whose options a person picks
-- among, split out of `decision` (which is now only the decided record a person
-- accepts).
--
-- Purely ADDITIVE: no column changes, no backfill, no existing row's value moves.
--
-- ANCHORED `AFTER 'decision'`, not appended, for the reason
-- `20260810220000_work_item_type_admit_four` records: a bare `ADD VALUE` appends
-- to the end of `pg_enum.enumsortorder`, the datamodel declares `choice` directly
-- after `decision` (ADR Amendment 3 §1e), and the two orders disagreeing is drift
-- the `build` job's `prisma migrate diff` fails on.

-- AlterEnum
ALTER TYPE "work_item_type" ADD VALUE 'choice' AFTER 'decision';
