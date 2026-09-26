// The per-request context every workItemsService method takes (Subtask
// 1.4.4). Mirrors the { userId, workspaceId } shape the workspaces /
// projects services thread through `withWorkspaceContext` (see
// lib/workspaces/context.ts's WorkspaceContext), kept in the work-items
// domain so service callers import it without reaching into the workspaces
// module.
//
// `userId`      — the authenticated actor. Becomes the reporter on create,
//                 the changedById on every revision, the createdById on
//                 links.
// `workspaceId` — the active workspace. The middleware that binds the
//                 `app.workspace_id` GUC (the RLS scope) has ALREADY run
//                 before any service method is invoked, so service methods
//                 NEVER re-set the GUC — they trust the context. (Work-item
//                 RLS itself lands in 1.4.5; this contract is fixed now so
//                 the service surface doesn't change when it does.)

import type { PermissionKey } from '@/lib/permissions/catalog';

export interface ServiceContext {
  userId: string;
  workspaceId: string;
  /**
   * The PROJECT the acting API token is bound to (MOTIR-2607), when the actor is
   * a bearer token that names one. Absent for every cookie-session caller and
   * for a device credential (`motir login`), whose binding is deliberately NULL.
   *
   * ⚠️ It NARROWS WHERE, not WHAT — the grant narrows what. When it is set,
   * `projectAccessService` refuses any gate on a DIFFERENT project as a
   * `ProjectNotFoundError`, so the two seams inherit the check without either
   * one re-implementing it, and a narrowed credential cannot be used to
   * enumerate the workspace (the 404-not-403 contract; ADR Amendment 1 §A.6).
   */
  tokenProjectId?: string;
  /**
   * The acting API token's GRANT (MOTIR-6330), when the actor is a bearer token.
   * Absent for every cookie-session caller.
   *
   * ⚠️ The dispatch seam already checks the ONE key an operation declares (its
   * floor). This carries the rest of the grant for the few reads that consult a
   * FINER, record-level key AFTER the door — the rooms' view-any keys
   * (`RECORD_VIEW_PERMISSIONS`, `lib/tokens/grant.ts`). Without it such a read
   * decides from the owner's ROLE alone, so a token deliberately minted without
   * the key would still see every record: the narrowing would not narrow.
   * Read it through `projectAccessService.holdsRecordView`, never directly.
   */
  tokenGrant?: readonly PermissionKey[];
  /**
   * The DISPATCH RUN the acting token is bound to (MOTIR-688), when the actor is
   * a hosted run's own credential. Absent for every other caller.
   *
   * ⚠️ It narrows to ONE RUN and ONE CARD. Only the three `/api/v1` routes that
   * opt in (`acceptsRunToken`) ever put it here; the services behind them —
   * `dispatchRunService.appendEvents` / `close` and
   * `dispatchPromptService.getDispatchPrompt` — refuse any other run
   * (`DISPATCH_RUN_TOKEN_OUT_OF_SCOPE`, 403) or card (`WORK_ITEM_NOT_FOUND`, 404).
   */
  tokenDispatchRunId?: string;
  /**
   * Automation provenance (Story 6.6 · Subtask 6.6.2). When a write is
   * performed by the automation engine running a rule's action, this carries
   * that rule's id. The post-commit `work-item/*` events the write emits stamp
   * it as `viaAutomationRuleId`, and the engine NEVER fires a rule off a
   * provenance-carrying event — the verified Jira loop-prevention default
   * (rules don't trigger rules). Absent on every ordinary user-driven write.
   */
  viaAutomationRuleId?: string;
  /**
   * Monitor provenance (Story MOTIR-4930 · Subtask MOTIR-5849). When a `bug` is
   * CREATED by the monitor reconciler, this carries the id of the binding that
   * filed it, and the create's post-commit `work-item/created` event stamps it as
   * `viaMonitorConnectionId`.
   *
   * ⚠️ IT EXISTS TO CLOSE A RACE, not to label a card. The reconciler's create
   * commits its OWN transaction — and so emits its event — before the OUTER
   * transaction that points the `monitor_issue` row at the new bug commits. A
   * consumer that asks "does a link point at this item?" can therefore observe a
   * committed bug with no link yet. The stamp says the link IS coming, so that
   * consumer retries instead of concluding "not a monitor bug" for good. Absent on
   * every other write.
   */
  viaMonitorConnectionId?: string;
}
