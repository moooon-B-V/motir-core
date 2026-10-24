-- THE MOTIR-OWNED GITHUB ORG A TENANT IS HOSTED IN (Story MOTIR-8953 · MOTIR-8966).
--
-- Assigned once, when the organisation's first hosted repository is about to be
-- created: the GitHub org with the most headroom among the active fleet accounts
-- (`fleetGithubOrgAssignmentService`). NULL = never assigned, so the
-- organisation's repositories are created in `GITHUB_FALLBACK_ORG` exactly as
-- before. Additive and nullable: no existing row changes.
--
-- The index serves the per-org tenant count the assignment takes, under the
-- account rows' lock, on every first establish.

ALTER TABLE "organization"
  ADD COLUMN "hosted_github_org" TEXT,
  ADD COLUMN "hosted_github_org_assigned_at" TIMESTAMP(3);

CREATE INDEX "organization_hosted_github_org_idx" ON "organization"("hosted_github_org");
