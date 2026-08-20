import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
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
//
// ⚠️ AND IT IS HONEST FOR EVERY CHILD KIND EXCEPT ONE (Bug MOTIR-3229). A `bug`
// under a story is not a decomposition of that story — it is a defect RECORD,
// parented where it was FOUND. Completing the story says nothing true about it,
// and sweeping it destroys the finding: MOTIR-1343's merge closed the two bug
// reports its own run had filed, mid-investigation. `isCascadeExempt` at the foot
// of this file carries the rule, its measurement, and the cost of the exemption.

/**
 * The TRANSITION that woke the cascade — the `fromStatusKey` / `toStatusKey` the
 * `work-item/transitioned` event already carries (MOTIR-2957).
 *
 * ⚠️ THE TRIGGER IS THIS, NOT THE ROW. §4's trigger is *"an item **transitions
 * into** a done-category status"* — a property of the MOVE. This service used to
 * test it by re-reading the item and asking whether it *is* done now, which is a
 * different predicate and differs in exactly one case: a concurrent derivation has
 * moved the item since. Rung 4 (MOTIR-2888) made that case common and load-bearing
 * — a `work-item/created` recompute for a child created moments BEFORE the parent
 * was set Done pulls the parent back to `todo`, and the row read then cancelled the
 * cascade that would have completed that very child. Measured on `origin/main`
 * @ `a09c21ee`: **7 of 20** parents settled at `todo` with every child still
 * `todo` — the user's Done discarded, permanently, because the child set never
 * changes again.
 */
export interface CascadeTrigger {
  /** The status the item left. A move BETWEEN two done-category statuses is not an entry. */
  readonly fromStatusKey: string;
  /** The status the item reached. Its category is what makes this an entry into done. */
  readonly toStatusKey: string;
}

/** What a cascade pass did, for the caller's log. Like the rollup, every outcome
 *  is a NORMAL result: this runs behind a status change the user already made
 *  successfully and must not turn that into a failed job. */
export type CascadeOutcome =
  /** `exemptIds` names the open children the cascade DECLINED to complete — the
   *  bugs (see `isCascadeExempt`). Present only when there were any, so an
   *  ordinary cascade's shape is unchanged; when it IS present, the run log can
   *  answer "what did this merge leave open?", which is the question MOTIR-3229
   *  had to reconstruct from the Inngest REST API after the fact. */
  | {
      outcome: 'cascaded';
      itemId: string;
      childIds: string[];
      toStatus: string;
      exemptIds?: string[];
    }
  | { outcome: 'not_done' }
  | { outcome: 'toggle_off'; itemId: string }
  | { outcome: 'no_open_children'; itemId: string }
  /** Every open child was EXEMPT — the parent completed and its only remaining
   *  children are defect reports, which stay open (MOTIR-3229). Its own variant
   *  rather than `no_open_children`, for the reason `rolled_back` is one on the
   *  upward side: a log that cannot distinguish "nothing to do" from "declined
   *  to do it" cannot answer why a done parent still has open children. */
  | { outcome: 'exempt_only'; itemId: string; exemptIds: string[] }
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
  async cascadeToChildren(
    itemId: string,
    workspaceId: string,
    trigger: CascadeTrigger,
  ): Promise<CascadeOutcome> {
    // Phase 1 — resolve the neighbourhood. No acting USER on a background job, but
    // there IS a tenant: `work-item/transitioned` carries `workspaceId`, so this
    // binds the WORKSPACE tier.
    //
    // ⚠️ THIS USED TO BE `withSystemContext`, AND IT WAS DEAD (MOTIR-2880) — the
    // exact mirror of the rollup's phase 1. `work_item` and `workspace_membership`
    // carry no `system_admin` arm, so `findById(itemId)` returned NULL under
    // `motir_app`, `resolved` was null, and every cascade answered
    // `{ outcome: 'unresolvable' }` without raising.
    const resolved = await withWorkspaceServiceContext(workspaceId, async (tx) => {
      const item = await workItemRepository.findById(itemId, tx);
      if (!item) return null;
      const settings = await projectRepository.findStatusAutomation(item.projectId, tx);
      const owner = await workspaceMembershipRepository.findOwnerByWorkspace(item.workspaceId, tx);
      const children = await workItemRepository.findChildren(itemId, tx);
      return {
        projectId: item.projectId,
        // The item's CURRENT status is deliberately NOT read here any more — the
        // trigger is the transition (`CascadeTrigger`). The `findById` stays: it is
        // what resolves the project, proves the item exists in this tenant, and
        // answers `unresolvable` when it does not.
        enabled: settings?.autoCompleteChildrenOnParentDone ?? false,
        ownerUserId: owner?.userId ?? null,
        children: children.map((c) => ({ id: c.id, status: c.status, kind: c.kind })),
      };
    });

    if (!resolved) return { outcome: 'unresolvable' };

    // `workspaceId` is the caller's — phase 1 was RLS-scoped to it, so the item it
    // resolved is that workspace's by construction.
    const { projectId, ownerUserId } = resolved;

    // The trigger is ENTRY INTO a done-category status, read off the TRANSITION —
    // see `CascadeTrigger` for why this must not be a re-read of the row. Any other
    // move is a clean no-op, which is also half of why the two directions cannot
    // loop: a parent LEAVING done (`toStatusKey` outside the category) cascades
    // nothing, so the one motion rung 4 introduced starts no downward wave.
    const [from, to] = await Promise.all([
      workflowsService.getStatusByKey(projectId, trigger.fromStatusKey, workspaceId),
      workflowsService.getStatusByKey(projectId, trigger.toStatusKey, workspaceId),
    ]);
    // An unknown key answers `not_done` rather than throwing — same shape as every
    // other business outcome here, and the honest answer when the workflow has
    // since dropped the status the event named.
    if (to?.category !== 'done') return { outcome: 'not_done' };
    // A shuffle WITHIN the done category (`done → cancelled`) is not an entry, and
    // re-cascading on it would re-touch children a previous pass already settled.
    if (from?.category === 'done') return { outcome: 'not_done' };

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
    const notDone = await filterNotDone(projectId, workspaceId, resolved.children);
    if (notDone.length === 0) return { outcome: 'no_open_children', itemId };

    // ⚠️ THE DEFECT-REPORT EXEMPTION (Bug MOTIR-3229) — see `isCascadeExempt`.
    const openChildren = notDone.filter((c) => !isCascadeExempt(c.kind));
    const exemptIds = notDone.filter((c) => isCascadeExempt(c.kind)).map((c) => c.id);
    if (openChildren.length === 0) return { outcome: 'exempt_only', itemId, exemptIds };

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

    if (applied.length === 0) {
      return exemptIds.length > 0
        ? { outcome: 'exempt_only', itemId, exemptIds }
        : { outcome: 'no_open_children', itemId };
    }
    return {
      outcome: 'cascaded',
      itemId,
      childIds: applied.map((a) => a.childId),
      toStatus: doneKey,
      ...(exemptIds.length > 0 ? { exemptIds } : {}),
    };
  },
};

/**
 * Is this child kind EXEMPT from the downward cascade?
 *
 * ⚠️ A `bug` IS — and this is the highest-value clause on MOTIR-3229, because it
 * was MEASURED rather than predicted. Pulled from the Inngest REST API for
 * MOTIR-1343's `in_review → done` event:
 *
 *   "cascade": { "outcome": "cascaded", "itemId": "<MOTIR-1343>",
 *                "childIds": ["<MOTIR-3218>", "<MOTIR-3219>"], "toStatus": "done" }
 *
 * Both of those were defect reports the run itself had filed under the story
 * while shipping it, and both were closed by the merge of that story's own pull
 * request — while a session was three minutes into investigating them.
 *
 * WHY KIND IS THE RIGHT DISCRIMINATOR. §4's promise is *"the parent is done, so
 * its children are done"*, and it is honest for every kind that DECOMPOSES its
 * parent: a `subtask` or a `task` under a story is part of the story's scope, so
 * completing the story really does complete it. A `bug` is not a decomposition —
 * it is a defect RECORD, parented where it was FOUND rather than where its work
 * belongs (`docs/decisions/run-findings-protocol.md` Q3, which this card
 * deliberately leaves standing). Sweeping it destroys the finding, and the loop
 * that files defects while shipping is the loop that produces them: a story
 * closing itself silently closes the defects found while shipping it.
 *
 * AND WHY NOT "a child created DURING the run", which the card also offers. The
 * cascade has no notion of a run and no instant to date one from; the nearest
 * proxy — the child's `createdAt` against the parent's status history — would
 * exempt an ordinary subtask added late and sweep a bug filed early, i.e. answer
 * a different question badly. Kind is a stable, readable property that is right
 * on both sides.
 *
 * THE COST, stated rather than hidden: a bug that genuinely WAS fixed by the
 * parent's pull request now stays open and is closed by hand. That is the
 * recoverable direction — an open card is visible and one click from closed,
 * whereas a swept defect report leaves no trace at all, which is exactly how
 * MOTIR-3218 and MOTIR-3219 had to be reconstructed from a job log.
 */
function isCascadeExempt(kind: string): boolean {
  return kind === 'bug';
}

/**
 * Keep only the children NOT already in a done-category status. Resolved through
 * the project's own workflow, so a team's custom terminal status counts as done
 * and is left alone.
 */
async function filterNotDone<T extends { status: string }>(
  projectId: string,
  workspaceId: string,
  children: ReadonlyArray<T>,
): Promise<T[]> {
  const statuses = await workflowsService.listStatusesByProject(projectId, workspaceId);
  const doneKeys = new Set(statuses.filter((s) => s.category === 'done').map((s) => s.key));
  return children.filter((c) => !doneKeys.has(c.status));
}
