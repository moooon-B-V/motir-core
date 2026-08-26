-- An org-scoped SELECT arm on `workspace` (MOTIR-3512).
--
-- ===========================================================================
-- THE DEFECT. "How many workspaces does this ORG have?" is not answerable from
-- a user-bound org transaction. `withOrgContext` binds `app.user_id` +
-- `app.organization_id` and no `app.workspace_id`, and none of `workspace`'s
-- five SELECT policies admits "the bound org's rows, to a member of that org":
--
--   workspace_active               id = app.workspace_id            -- unbound here
--   workspace_membership_visible   the caller's OWN memberships     -- the arm that fires
--   workspace_public_project_read  needs app.workspace_id EMPTY + a public project
--   workspace_system_read          app.system_admin = 'true'
--   workspace_org_service_read     org-keyed, but needs app.user_id EMPTY (userless)
--
-- So `workspaceRepository.listByOrganization` under an org context silently
-- answers with the ACTOR's workspaces. Measured on d32892bd, in an org with two
-- workspaces whose actor belongs to one:
--
--     TRUE org workspace count = 2
--     SEEN under withOrgContext(founder) = 1
--
-- ⚠️ AND THE FAILURE MODE IS THE EXPENSIVE ONE: a denied READ does not error,
-- it NARROWS. The caller gets 1 where the truth is 2, which is indistinguishable
-- from a small org, so a predicate built on that count fires in the wrong
-- direction under a green suite. Two shipped readers already carry the defect:
-- `organizationsService.getOrgFootprint` (whose own comment says "the actor's
-- workspaces in the org") and the cross-workspace member roster, both of which
-- INTEND the org's workspaces.
--
-- WHY IT WAS NEVER FIXED HERE. `githubRepoRepository.ts:285-305` found the same
-- gap from the background path, routed around it via `github_repo`, and recorded
-- why it stopped: widening `workspace`'s RLS "would be a cross-tenant access
-- change, which is not this card's to make." This migration is that change, made
-- deliberately and on its own card rather than as a side effect of a feature.
--
-- WHAT THIS DELIBERATELY WIDENS. Any ORG MEMBER — not only an owner/admin — can
-- now enumerate the `workspace` ROWS of an org they belong to (id, name, slug,
-- timestamps) while that org is bound. It grants NO reach into any workspace's
-- CONTENTS: `project`, `work_item`, `workspace_membership` and every scoped
-- table keep their own policies, all of which still require the workspace GUC or
-- an actual membership. This is the model `organization-tier.md` §4 already
-- states — the org is the root tenancy tier and org membership is the gate
-- beneath which workspaces sit.
--
-- The owner/admin-only variant was considered and rejected: `addMember`'s call
-- site is already `assertOrgAdmin`-gated, so the narrower policy buys nothing
-- there while leaving the two roster surfaces answering the actor's view.
--
-- ⚠️ WHY `FOR SELECT` AND NOTHING ELSE. Reading which workspaces your org
-- contains and being allowed to RENAME or DELETE one are different powers.
-- UPDATE/DELETE stay on `workspace_mutate_active` / `workspace_delete_active`,
-- which key on the ACTIVE-workspace GUC — so org membership does not become a
-- licence to mutate a workspace you are not in.
--
-- ⚠️ THE SUBQUERY IS REACHABLE, which is not automatic — `organization_membership`
-- is itself RLS-enabled, and a policy's USING expression is evaluated with the
-- querying role's own policies applied to any table it reads. It resolves here
-- because `org_membership_visible_active_or_own` (20260613120000) admits
-- `"organizationId" = current_setting('app.organization_id')`, which is exactly
-- what this context binds. The shipped `workspace_membership_visible` policy is
-- the precedent: it reads `workspace_membership` from inside a `workspace`
-- policy and has worked since 20260527134009.
--
-- FAILS CLOSED on every unbound axis, the house pattern: with no org bound,
-- `current_setting(..., true)` returns NULL, the comparison is NULL, and the row
-- is refused. Permissive policies OR-combine, so nothing admitted before this
-- migration is admitted less after it.
-- ===========================================================================

CREATE POLICY "workspace_org_member_read" ON "workspace"
  FOR SELECT
  USING (
    "organizationId" = current_setting('app.organization_id', true)
    AND EXISTS (
      SELECT 1
      FROM "organization_membership" m
      WHERE m."organizationId" = "workspace"."organizationId"
        AND m."userId" = current_setting('app.user_id', true)
    )
  );
