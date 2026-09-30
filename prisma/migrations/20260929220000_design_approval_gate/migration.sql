-- Story MOTIR-693 · MOTIR-697 — a project can switch design approval OFF
-- (`docs/decisions/hosted-design-rerun-and-design-approval-switch.md` §2).
--
-- The column is added with DEFAULT true, which fills every existing row with
-- `true`: nothing changes for any project until someone flips it.
ALTER TABLE "project" ADD COLUMN "design_approval_gate" BOOLEAN NOT NULL DEFAULT true;

-- The two members that mark a SYSTEM approval (§2c). Appended: neither enum's
-- declaration order carries meaning. Neither value is used in this transaction.
ALTER TYPE "approval_gate_decision_source" ADD VALUE IF NOT EXISTS 'system';
ALTER TYPE "approval_gate_authority" ADD VALUE IF NOT EXISTS 'project_setting';
