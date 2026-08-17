-- ===========================================================================
-- RLS: give `public_request_vote` a WORKSPACE-MEMBER read arm (MOTIR-2864).
--
-- The mirror image of 20260813210000, and the arm that migration did not add.
-- That one armed the ANONYMOUS reader — the project square, which has no
-- workspace to bind — and it is gated on there being no bound workspace:
--
--     public_request_vote_public_project_read:
--       coalesce(current_setting('app.workspace_id', true), '') = ''
--       AND EXISTS (the vote's item sits on a `public` project)
--
-- So after it the table's two policies between them admitted the vote's OWNER
-- (`user_id = app.user_id`), the system flag, and an anonymous reader — and
-- nobody else. A workspace MEMBER reading their own tenant's votes satisfies
-- none of the three: `withWorkspaceServiceContext` binds `app.workspace_id` and
-- does NOT bind `app.user_id`, so the owner arm's `user_id = NULL` is NULL, and
-- the bound workspace closes the public arm by construction.
--
-- ---------------------------------------------------------------------------
-- WHAT BROKE
-- ---------------------------------------------------------------------------
-- `triageService.getTriageQueue` — the member-facing triage inbox — sorts by
-- DEMAND. `workItemRepository.findTriageQueue` LEFT-JOINs a
-- `GROUP BY work_item_id` aggregate over this table, inside the
-- `withWorkspaceServiceContext` transaction the read runs in. Under `motir_app`
-- no arm admitted a single vote row, so the aggregate returned NOTHING and
-- `COALESCE(vt."votes", 0)` turned every request's tally into 0. The queue does
-- not error; it silently reverts to newest-first and the 6.12.6 sort key stops
-- existing. A zero there is indistinguishable from "nobody has voted yet".
--
-- Found by MOTIR-2857's step-3 sweep: repairing that suite's fixture writes is
-- what let the assertion be REACHED — before it, the file died in setup and the
-- read was never exercised. The whole point of the vacuous-pass class MOTIR-2829
-- names (inheritance point #2): the aggregate does not fail, it returns the
-- number the policy left it.
--
-- ---------------------------------------------------------------------------
-- THE ARM
-- ---------------------------------------------------------------------------
-- Modelled on the `work_item_label` / `work_item_component` / `watcher` member
-- arms (20260610163942) — the house shape for a table that hangs off
-- `work_item` and carries no `workspace_id` column of its own: a CORRELATED
-- `EXISTS` resolving the vote's tenant through `work_item."workspaceId"`.
-- Correlated, not an uncorrelated `id IN (SELECT …)` that Postgres HASHES:
-- measured on MOTIR-2856 (PG 15, 2 000 tenants), the hashed form is ~8x slower
-- because it must materialise the whole qualifying set before returning a row,
-- while the correlated one is a primary-key probe per row it is asked about.
--
-- Two deliberate differences from those three arms, both narrowing:
--
--   * FOR SELECT, NOT FOR ALL. A label or a watcher is workspace-owned data any
--     member may edit; a VOTE is a row about a PERSON's interest, cast by a
--     cross-org account that is not a member of this workspace at all. The
--     owner arm keys the WRITE on `user_id = app.user_id` and that must stand:
--     a member must not be able to cast, retract or re-attribute somebody
--     else's vote. Postgres combines policies as
--     `(permissive_1 OR permissive_2 OR …) AND (restrictive …)` PER COMMAND, so
--     a SELECT-only policy widens reads and only reads; INSERT / UPDATE /
--     DELETE and every `WITH CHECK` are untouched.
--
--   * NO `app.user_id` term. The member reading the inbox is not the voter —
--     that is the whole defect — so the arm cannot key on the actor. It keys on
--     the TENANT, which is what a bound workspace context actually asserts.
--
-- It widens nothing beyond that tenant. The `EXISTS` runs under the querying
-- role, so it resolves through `work_item`'s own policies and bottoms out in
-- `wi."workspaceId" = current_setting('app.workspace_id', true)` — a bare
-- column test, no recursion. An UNBOUND reader gains nothing: the GUC coalesces
-- to NULL, the equality is NULL, and the row is refused (the anonymous path
-- keeps running entirely through the 20260813210000 arm). A reader bound to
-- workspace A gains nothing about workspace B — not even about B's PUBLIC
-- projects, which stay visible only on the genuinely context-less connection.
-- Both directions are asserted, not assumed:
-- `tests/permissions/publicProjectAccess.test.ts`.
--
-- And it is narrower than the alternative the 6.12.3 design contemplated for
-- this exact read. `20260614225729`'s header routes the cross-account COUNT
-- through `withSystemContext` — `app.system_admin`, a CROSS-TENANT flag
-- documented as belonging to the jobs runtime and operator tooling. Claiming it
-- for a member's inbox would hand a web request sight of every workspace's
-- votes to fix one workspace's number; `20260811230000` argues that trade at
-- length and rejects it. A tenant-scoped arm is the honest form.
-- ===========================================================================

CREATE POLICY "public_request_vote_active_workspace_read" ON "public_request_vote"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM "work_item" wi
      WHERE wi."id" = "public_request_vote"."work_item_id"
        AND wi."workspaceId" = current_setting('app.workspace_id', true)
    )
  );
