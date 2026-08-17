-- ===========================================================================
-- MOTIR-2956 — the free-tier STORAGE CAP silently never fired under `motir_app`.
--
-- `entitlementsService.assertWithinStorageCap` is the §4.3b total-storage gate
-- (free 2 GB / scaled 100 GB). MOTIR-2846 wrapped its usage read in
-- `withOrgServiceWriteContext`, under a comment asserting that "`attachment`'s
-- policy is org-scoped, so unbound the sum is 0 and the storage cap never
-- fires". The hazard is named exactly; the premise is false.
-- `attachment_workspace_or_system_admin` (20260610160411) carries exactly two
-- arms — `app.workspace_id` and `app.system_admin` — and that helper binds
-- NEITHER. It binds `app.organization_id`, which no policy on that table reads.
--
-- **Binding a GUC no policy reads is indistinguishable from binding nothing.**
-- Every attachment row was filtered, `sumSizeByOrganization` answered 0 for
-- every organization, `current + incomingBytes` never exceeded the cap, and the
-- gate ran on every upload while enforcing nothing. Cloud-only (the method
-- returns early off-cloud) and latent until MOTIR-2515 points the deployed
-- runtime at `motir_app` — which is to say it is a defect the cutover ACTIVATES.
--
-- ── Why TWO arms and not one (`notes.html` #269) ───────────────────────────
-- A read is admitted only if EVERY table it TOUCHES is admitted, not merely the
-- one it targets. `attachmentRepository.sumSizeByOrganization` is
--
--     SELECT COALESCE(SUM(a."size_bytes"), 0) AS total
--       FROM "attachment" a
--       JOIN "workspace" w ON w."id" = a."workspace_id"
--      WHERE w."organizationId" = $1
--
-- so `workspace` is as load-bearing here as `attachment`, and it has no org arm
-- either. An arm on `attachment` ALONE would leave the sum at zero: the fix
-- would read as applied and change nothing — the same failure the comment above
-- it already made once. This is the resolution MOTIR-2856 reached for the public
-- read surface, where `workspace` and `organization` each needed their own arm
-- before `listPublicDirectoryRanked`'s joins could resolve.
--
-- ── Why the arms require an EMPTY `app.user_id` ────────────────────────────
-- Three helpers bind `app.organization_id`, and only one is the userless,
-- trusted, server-to-server path this read runs on:
--
--     withOrgServiceWriteContext(orgId)    org GUC only, NO acting user  ← here
--     withOrgContext({ userId, orgId })    org GUC + the acting user
--     bindOrganizationContext(tx, orgId)   additive, inside either of the above
--
-- An UNGUARDED org arm would fire under `withOrgContext` too, and that widens
-- two shipped surfaces rather than fixing one. `organizationsService.
-- summarizeOrgFootprint` states its posture in its own docstring — "`workspaces`
-- is what the actor can see in the org — the workspace policy admits the
-- workspaces they're a member of" — and `listMembers` enriches every member row
-- from that same list. Both would begin reporting workspaces the actor is not a
-- member of. That is a product decision, not a defect fix, so the guard holds
-- the blast radius to the path that was actually broken.
--
-- `app.user_id` being unset is precisely what "no acting user; the caller is
-- trusted service code" means at the GUC tier. The idiom is the one
-- `workspace_public_project_read` (20260815200000) already uses to scope itself
-- to the anonymous path: `coalesce(current_setting(…), '') = ''`.
--
-- Both arms are FOR SELECT. The org-service context has no business writing an
-- attachment, and neither existing policy is touched — permissive policies
-- OR-combine, so nothing that was admitted before is admitted less now.
--
-- Fails closed on every unbound axis: with no org bound, `current_setting`
-- returns NULL, the comparison is NULL, and the row is refused.
-- ===========================================================================

-- workspace: the org's own workspaces, readable by the userless org-service
-- context. Needed by the JOIN in `sumSizeByOrganization` AND by the EXISTS in
-- the attachment arm below, which is itself subject to this table's RLS.
CREATE POLICY "workspace_org_service_read" ON "workspace"
  FOR SELECT
  USING (
    coalesce(current_setting('app.user_id', true), '') = ''
    AND "organizationId" = current_setting('app.organization_id', true)
  );

-- attachment: every attachment in the bound org, across ALL of its workspaces —
-- which is the shape the §4.3b cap needs and the reason a workspace binding
-- could not have answered it (an org spans workspaces).
CREATE POLICY "attachment_org_service_read" ON "attachment"
  FOR SELECT
  USING (
    coalesce(current_setting('app.user_id', true), '') = ''
    AND EXISTS (
      SELECT 1
      FROM "workspace" w
      WHERE w."id" = "attachment"."workspace_id"
        AND w."organizationId" = current_setting('app.organization_id', true)
    )
  );
