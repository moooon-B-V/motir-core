-- The acceptance-video gate's switch moves to the PROJECT (MOTIR-4925 · MOTIR-5167,
-- `docs/decisions/acceptance-video.md` §3 as amended).
--
-- Every other work-process setting in this schema is `projectId`-scoped — workflow,
-- board, estimation, fields, components, automation, AI planning. Its predecessor
-- `organization.acceptance_video_enabled` was the single exception, and it was chosen
-- by analogy to its neighbours on that table (billing, identity, security) rather
-- than from what the flag decides. The consequence was that one org admin answered
-- for every project beneath them, so a UI product and a library in one organisation
-- could not disagree.
--
-- This migration is the EXPAND half and changes no behaviour: the organisation column
-- stays, and every reader still reads it until the card that moves them lands.
--
-- ⚠️ THE BACKFILL IS THE POINT, NOT THE COLUMN. `DEFAULT true` alone would switch
-- acceptance video ON for every project under an organisation that had deliberately
-- turned it OFF — a setting flipping itself, which is worse than the wrong tier it
-- replaces, because the wrong tier at least does what the person who set it asked.
-- So each project takes its owning organisation's CURRENT value, in this same
-- migration, before anything can read the new column. Writing the copy-forward here
-- rather than in a script is deliberate: a script is a second thing to remember, and
-- a deploy that applies the migration without it is exactly the silent flip.
--
-- A project whose organisation cannot be resolved keeps the `true` default. That is
-- the safe direction: the entitlement (`hasPaidAiPlan`, still org-resolved) gates
-- publication independently, so a wrongly-`true` project publishes nothing without a
-- paid plan — whereas a wrongly-`false` one would silently stop collecting receipts a
-- team had asked for. The join below cannot in practice miss, because both foreign
-- keys are NOT NULL with `onDelete: Cascade`; it is written to tolerate it anyway.

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "acceptance_video_enabled" BOOLEAN NOT NULL DEFAULT true;

-- Backfill: every project inherits its organisation's answer, via the workspace.
UPDATE "project" AS p
   SET "acceptance_video_enabled" = o."acceptance_video_enabled"
  FROM "workspace" AS w
       JOIN "organization" AS o ON o."id" = w."organizationId"
 WHERE w."id" = p."workspaceId";
