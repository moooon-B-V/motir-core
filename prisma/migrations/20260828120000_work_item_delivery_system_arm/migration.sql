-- ===========================================================================
-- RLS: give `work_item_delivery` the `app.system_admin` arm its joined tables
-- already carry (MOTIR-3721 · `docs/decisions/delivery-reader-migration.md` §1).
--
-- The delivery table shipped with ONE policy, keyed on `app.workspace_id` alone
-- (20260827094500). That was right while every reader of it ran inside an
-- already-bound tenant context. This card moves the CONNECTION-tier readers onto
-- it, and one of them runs BEFORE a tenant is bound and exists precisely to
-- resolve which tenant to bind: `repoSetCompletionService.reevaluateItem` opens
-- `withSystemContext`, resolves the workspace off the connection tier, and only
-- then calls `bindWorkspaceContext`. Its own header states the invariant.
--
-- ⚠️ WITHOUT THIS ARM THAT READ IS NOT AN ERROR, IT IS A SILENT ZERO. Under the
-- non-bypass `motir_app` role the workspace predicate compares against an unset
-- GUC, which is NULL, which hides every row — and `workItemDeliveryRepository`'s
-- own header names that failure mode: "a read through the bare singleton does not
-- fail — it returns an EMPTY LIST", which is "by a wide margin the worse of the
-- two failures". `workspaceId` would come back null and `reevaluateItem` would
-- answer `no_linked_change_request` for every card in the product, with nothing
-- in a log. So the arm ships WITH the reader move, never after it.
--
-- DEMONSTRATED rather than argued, on a live cluster as a `NOSUPERUSER
-- NOBYPASSRLS` role (ADR §1): the repointed resolution returned 0 rows and raised
-- nothing; joining through the ARMED `github_repo` did NOT rescue it, because RLS
-- filters the delivery row BEFORE the join; and after this policy the resolution
-- is restored while an ordinary caller bound to the wrong workspace still reads 0
-- and one bound to the right workspace still reads its own row.
--
-- ⚠️ WHY (a) AND NOT (b) OR (c) — the two rejected options, recorded here because
-- (c) is what a later reader reaches for under time pressure:
--   * (b) resolve the tenant through some OTHER armed table. There is no total
--     one: of the 20 tables carrying a `work_item_id` column, exactly five are
--     armed (`attachment`, `automation_rule_execution`, `plan_item`,
--     `plan_target_lock`, `public_request_vote`) and a card need have none of
--     them. The only armed table that answered it did so THROUGH the column being
--     retired.
--   * (c) pass the workspace in from the caller. `reevaluateItem`'s contract is
--     "given only an item id, decide it", and its header calls the
--     connection-tier resolution THE TRUSTED source precisely because request
--     input is not. Its failure mode is a cross-tenant read rather than an empty
--     one. A silent empty is the better failure and we are removing it anyway; a
--     silent WRONG TENANT is not.
--
-- The parity argument, stated rather than assumed: a `withSystemContext` caller
-- can ALREADY read every `github_pull_request` row (`work_item_id` included) and
-- every `github_repo` row, so the (pull request → work item) association is
-- already fully readable under the system flag. `work_item_delivery` holds that
-- same association, denormalised. Arming it preserves the existing tenancy
-- surface across a storage move; it does not widen it. What such a reader GAINS
-- is the ability to enumerate the OTHER cards one pull request delivers in a
-- single read — a strictly larger ANSWER over the same ROWS, admitted
-- deliberately, and every consumer of the arm is an internal service that already
-- holds the pull-request row.
--
-- ALL, not `FOR SELECT`: the delivery WRITE (`link_pull_request` → `add`) runs in
-- the sync's system context too, and a `FOR SELECT`-only arm would leave the
-- insert refused where it is admitted today. Unlike the tenant-ROOT tables, this
-- is not a membership table — the row names its own workspace, so the arm cannot
-- be used to mint one outside a tenant.
--
-- `FORCE ROW LEVEL SECURITY` is already set on the table and is untouched.
-- ===========================================================================

DROP POLICY IF EXISTS "work_item_delivery_active_workspace" ON "work_item_delivery";

CREATE POLICY "work_item_delivery_workspace_or_system" ON "work_item_delivery"
  FOR ALL
  USING (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  )
  WITH CHECK (
    current_setting('app.system_admin', true) = 'true'
    OR "workspace_id" = current_setting('app.workspace_id', true)
  );
