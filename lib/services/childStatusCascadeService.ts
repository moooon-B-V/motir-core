import { withSystemContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { workflowsService } from './workflowsService';
import { workItemsService } from './workItemsService';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { UnknownStatusError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';

// The DOWNWARD half of bidirectional status derivation (Story MOTIR-1615 ·
// Subtask MOTIR-1647; `docs/decisions/status-derivation.md` §4): an item reached a
// done-category status, so its not-done DIRECT children are completed too — a
// parent marked done, by a user or by CI on PR merge, never leaves nine open
// subtasks behind it.
//
// Direct children only. Grandchildren follow when each child's OWN transition
// re-emits `work-item/transitioned` and the derivation job (MOTIR-1621) re-fires
// — the same recursion-by-re-emission the upward `parentStatusRollupService`
// uses, terminating because an already-done child produces no transition and so
// no event.
//
// ⚠️ THE PRIVILEGED SYSTEM SET. Forcing an unstarted `todo` / `blocked` child to
// `done` is not a legal USER transition — the default workflow has no such edge,
// and under `restricted` `applyStatusTransition` throws `IllegalTransitionError`.
// The fix is emphatically NOT to add `todo → done` transition rows: those are
// user-draggable edges, and they would let anyone skip the entire workflow on the
// board. Instead this service passes `{ system: true }`, the bypass already
// shipped for the issue importer (MOTIR-941), which skips ONLY the legality check
// and keeps the row lock, the tenant and project-access gates, the
// target-status-exists check, the `done ⇒ sessionBranch = null` invariant and the
// revision row. It is reachable only from this job context, never from a route.
//
// It deliberately does NOT route through `workItemsService.setImportedStatus`,
// the other `system` caller: that one emits NO event (a bulk import must not fan
// out one notification per issue), and the cascade NEEDS the event to reach
// grandchildren.
//
// This asymmetry with the upward direction is the point. Upward advances a parent
// along the team's real workflow — conservative, respecting their stages.
// Downward performs a system completion no legal user path allows, which is the
// honest shape of "the parent is done, so its children are done".

/** What a cascade pass did, for the caller's log. Like the rollup, every outcome
 *  is a NORMAL result: this runs behind a status change the user already made
 *  successfully and must not turn that into a failed job. */
export type CascadeOutcome =
  | { outcome: 'cascaded'; itemId: string; childIds: string[]; toStatus: string }
  | { outcome: 'not_done' }
  | { outcome: 'toggle_off'; itemId: string }
  | { outcome: 'no_open_children'; itemId: string }
  | { outcome: 'no_matching_status'; itemId: string }
  | { outcome: 'access_denied'; itemId: string }
  | { outcome: 'unresolvable' };

export const childStatusCascadeService = {
  /**
   * Complete the item's not-done DIRECT children, if the item has just entered a
   * done-category status.
   *
   * Ordering note, and why it differs from the rollup: the cascade needs no
   * lock-before-read discipline. Its action is an UNCONDITIONAL force-to-done, so
   * a stale "this child is not done" read is harmless — `applyStatusTransition`
   * no-ops if the child got to done first, and a child that moved to some OTHER
   * status in the window is one the cascade should complete anyway. The rollup's
   * derivation, by contrast, is a function OF the children's aggregate, which is
   * exactly why that one must lock first.
   *
   * Never throws for a business reason; returns a typed outcome instead.
   */
  async cascadeToChildren(itemId: string): Promise<CascadeOutcome> {
    // Phase 1 — resolve the neighbourhood under a system context (no acting user
    // on a background job; the change-request-sync precedent).
    const resolved = await withSystemContext(async (tx) => {
      const item = await workItemRepository.findById(itemId, tx);
      if (!item) return null;
      const settings = await projectRepository.findStatusAutomation(item.projectId, tx);
      const owner = await workspaceMembershipRepository.findOwnerByWorkspace(item.workspaceId, tx);
      const children = await workItemRepository.findChildren(itemId, tx);
      return {
        projectId: item.projectId,
        workspaceId: item.workspaceId,
        status: item.status,
        enabled: settings?.autoCompleteChildrenOnParentDone ?? false,
        ownerUserId: owner?.userId ?? null,
        children: children.map((c) => ({ id: c.id, status: c.status })),
      };
    });

    if (!resolved) return { outcome: 'unresolvable' };

    const { projectId, workspaceId, ownerUserId } = resolved;

    // The trigger is ENTRY INTO a done-category status. Any other transition is a
    // clean no-op — which is also half of why the two directions cannot loop.
    const current = await workflowsService.getStatusByKey(projectId, resolved.status, workspaceId);
    if (current?.category !== 'done') return { outcome: 'not_done' };

    if (!resolved.enabled) return { outcome: 'toggle_off', itemId };
    if (!ownerUserId) return { outcome: 'unresolvable' };

    // The concrete `done` key for THIS project — resolved through the shared
    // prefer-key-then-category resolver, never hardcoded.
    const doneKey = await workflowsService.resolveStatusKey(projectId, workspaceId, {
      key: 'done',
      category: 'done',
    });
    if (!doneKey) return { outcome: 'no_matching_status', itemId };

    // Forward-only: an already-done child is never re-touched (and a cancelled
    // child is already terminal, so it is left in the status its team chose
    // rather than being rewritten to `done`).
    const openChildren = await filterNotDone(projectId, workspaceId, resolved.children);
    if (openChildren.length === 0) return { outcome: 'no_open_children', itemId };

    const ctx = { userId: ownerUserId, workspaceId };
    const applied: Array<{
      childId: string;
      fromStatusKey: string;
      toStatusKey: string;
      revisionId: string;
    }> = [];

    try {
      await withWorkspaceContext(ctx, async (tx) => {
        for (const child of openChildren) {
          const { transition } = await workItemsService.applyStatusTransition(
            child.id,
            doneKey,
            ctx,
            tx,
            // ⚠️ The privileged system set — see the module header.
            { system: true },
          );
          // Null when the child reached `done` between the read and the write;
          // that is the outcome we wanted, so there is simply nothing to emit.
          if (transition) applied.push({ childId: child.id, ...transition });
        }
      });
    } catch (err) {
      if (err instanceof UnknownStatusError) return { outcome: 'no_matching_status', itemId };
      if (err instanceof ProjectAccessDeniedError || err instanceof ProjectNotFoundError) {
        return { outcome: 'access_denied', itemId };
      }
      throw err;
    }

    // Post-commit, never inside the transaction — a rollback must not have
    // notified. ONE event per child that really moved; each is what carries the
    // cascade to that child's OWN children.
    for (const a of applied) {
      await sendEvent('work-item/transitioned', {
        workspaceId,
        workItemId: a.childId,
        actorId: ownerUserId,
        fromStatusKey: a.fromStatusKey,
        toStatusKey: a.toStatusKey,
        revisionId: a.revisionId,
      });
    }

    if (applied.length === 0) return { outcome: 'no_open_children', itemId };
    return {
      outcome: 'cascaded',
      itemId,
      childIds: applied.map((a) => a.childId),
      toStatus: doneKey,
    };
  },
};

/**
 * Keep only the children NOT already in a done-category status. Resolved through
 * the project's own workflow, so a team's custom terminal status counts as done
 * and is left alone.
 */
async function filterNotDone(
  projectId: string,
  workspaceId: string,
  children: ReadonlyArray<{ id: string; status: string }>,
): Promise<Array<{ id: string; status: string }>> {
  const statuses = await workflowsService.listStatusesByProject(projectId, workspaceId);
  const doneKeys = new Set(statuses.filter((s) => s.category === 'done').map((s) => s.key));
  return children.filter((c) => !doneKeys.has(c.status));
}
