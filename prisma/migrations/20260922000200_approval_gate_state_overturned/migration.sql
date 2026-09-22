-- Story MOTIR-5871 · Subtask MOTIR-5956: `overturned` joins the approval-gate STATE
-- enum (ADR `approval-gates.md` §1's MOTIR-5952 amendment, point 6). A person
-- refused the direction a `decision_confirmation` gate asked them to confirm. It is
-- a new value rather than an overloaded `changes_requested`, which every kind
-- treats as non-terminal. Expand-only.
--
-- ⚠️ ALONE IN ITS MIGRATION: Postgres refuses to USE a new enum value in the
-- transaction that added it, and the next migration's trigger names it.
ALTER TYPE "approval_gate_state" ADD VALUE IF NOT EXISTS 'overturned';
