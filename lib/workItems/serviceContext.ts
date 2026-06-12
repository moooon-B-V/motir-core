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

export interface ServiceContext {
  userId: string;
  workspaceId: string;
  /**
   * Automation provenance (Story 6.6 · Subtask 6.6.2). When a write is
   * performed by the automation engine running a rule's action, this carries
   * that rule's id. The post-commit `work-item/*` events the write emits stamp
   * it as `viaAutomationRuleId`, and the engine NEVER fires a rule off a
   * provenance-carrying event — the verified Jira loop-prevention default
   * (rules don't trigger rules). Absent on every ordinary user-driven write.
   */
  viaAutomationRuleId?: string;
}
