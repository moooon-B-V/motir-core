-- Org-wide story-acceptance-video switch (Story MOTIR-1627 · Subtask
-- MOTIR-1630). Default TRUE: an eligible (paid-AI) org opted into the bounded
-- cost by paying, and a non-eligible org's flag is moot (the entitlement gate
-- blocks generation regardless), so ON never leaks cost. Org-admin writable via
-- PATCH /api/organizations/[orgId]; read by acceptanceVideoEligibilityService.

-- AlterTable
ALTER TABLE "organization" ADD COLUMN     "acceptance_video_enabled" BOOLEAN NOT NULL DEFAULT true;