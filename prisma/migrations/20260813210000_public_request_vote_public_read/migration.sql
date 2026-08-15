-- ===========================================================================
-- RLS: give `public_request_vote` a PUBLIC read arm (MOTIR-2811).
--
-- The third and last table on the anonymous read path, and the one MOTIR-2684
-- missed. `project_public_read` and `work_item_public_project_read` (both
-- 20260811230000) let a logged-out visitor resolve a public project and see its
-- items; the project SQUARE then renders each project's DEMAND — how many people
-- upvoted its requests — through
-- `publicRequestVoteRepository.sumUpvotesByProjects`, and that read hits a table
-- whose only policy is
--
--     public_request_vote_owner_or_system:
--       current_setting('app.system_admin', true) = 'true'
--       OR user_id = current_setting('app.user_id', true)
--
-- An anonymous square reader binds NEITHER. So under `motir_app` the sum returns
-- zero for every project and the square shows a product nobody wants.
--
-- ⚠️ THIS IS THE ONE READ IN MOTIR-2796 THAT A BINDING CANNOT FIX. The square is
-- cross-project and cross-TENANT by construction — it lists public projects
-- belonging to many different workspaces to a reader who belongs to none — so
-- there is no single `app.workspace_id` to bind, and inventing one would presume
-- the very answer the page is computing. Every other card in that story adds a
-- `tx`; this one has nothing honest to pass.
--
-- NOT `withSystemContext`, for the reason 20260811230000 argues at length:
-- `app.system_admin` is a cross-table, cross-tenant flag documented as belonging
-- to the jobs runtime and operator tooling. Claiming it for an anonymous web
-- reader trades a visible bug for an invisible hole.
--
-- ---------------------------------------------------------------------------
-- THE ARM, AND WHY IT WIDENS NOTHING
-- ---------------------------------------------------------------------------
-- Modelled on `work_item_public_project_read`, including its two load-bearing
-- properties:
--
--   * FOR SELECT ONLY. Postgres combines policies as
--     (permissive_1 OR permissive_2) AND (restrictive ...) PER COMMAND, so a
--     separate SELECT policy widens reads and only reads. The existing FOR-ALL
--     policy still governs INSERT / UPDATE / DELETE unchanged — an unbound caller
--     still cannot cast, change or delete a vote, and `WITH CHECK` is untouched.
--
--   * GATED ON THERE BEING NO BOUND WORKSPACE. The arm fires only on the
--     genuinely context-less connection, which is precisely and only the public
--     path. A tenant session therefore does not gain sight of another
--     workspace's votes; it keeps exactly the visible set it had.
--
-- Publicness is inherited twice over here — a vote belongs to a work item, which
-- belongs to a project, and only the project carries `accessLevel`. The EXISTS
-- walks that chain. Being a subquery inside a policy it runs under the querying
-- role, so it resolves through `work_item_public_project_read` and
-- `project_public_read` above: a vote is visible unbound exactly when the item it
-- is cast on is, which is exactly when that item's project is public. The three
-- policies cannot drift apart, because the two below it are the ones doing the
-- deciding.
--
-- A vote on a NON-public project stays invisible to an unbound reader — the
-- EXISTS finds no row. That is asserted, not assumed:
-- `tests/permissions/publicProjectAccess.test.ts`.
--
-- Cost: the same shape 20260811230000 measured. The GUC test is row-independent,
-- so a bound session short-circuits the AND and never enters the join; an unbound
-- one runs the subplan once per QUERY (Postgres hashes it), not once per row.
-- This table is also two orders of magnitude smaller than `work_item`.
-- ===========================================================================

CREATE POLICY "public_request_vote_public_project_read" ON "public_request_vote"
  FOR SELECT
  USING (
    coalesce(current_setting('app.workspace_id', true), '') = ''
    AND EXISTS (
      SELECT 1
      FROM "work_item" wi
      JOIN "project" p ON p."id" = wi."projectId"
      WHERE wi."id" = "public_request_vote"."work_item_id"
        AND p."accessLevel" = 'public'
    )
  );
