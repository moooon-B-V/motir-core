import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import {
  classifyRepoDelivery,
  hasRepoSetShortfall,
  repoSetShortfall,
  EMPTY_SHORTFALL,
  type RepoSetShortfall,
} from '@/lib/workItems/repoDelivery';
import { workflowsService } from './workflowsService';
import { workItemsService } from './workItemsService';
import { IllegalTransitionError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';

// RE-EVALUATION of the repository-SET completion gate, WITHOUT a delivery event
// (MOTIR-3034).
//
// THE DEFECT THIS EXISTS FOR. `changeRequestStatusSync` is the only caller of the
// gate, and it runs on a change-request delivery. That is the right trigger for
// deciding a delivery — and it is the ONLY trigger, which makes the gate's
// fail-closed state a one-way door: a repository whose work merged BEFORE
// `github_pull_request.base_ref` existed has a null base, `classifyRepoDelivery`
// reads null as UNKNOWN (correctly — see that module's doctrine), and no further
// event is ever coming for a merge that already happened. The item is held
// forever by a row that will never be updated. MOTIR-2725 — the story that built
// the gate — was held by it on the day it shipped.
//
// The classifier is not relaxed by any of this, and must not be. This module is
// the SECOND CHANCE: it asks the same question, of the same shared rule, at a
// moment the answer may have changed — after a base-ref backfill, after an item's
// repository set is edited, after a repository's default branch is renamed.
//
// ⚠️ IT OWNS NO COPY OF THE RULE. The decision comes from
// `lib/workItems/repoDelivery.ts` (the module that exists precisely so the gate
// and the surface can never disagree) and the write goes through
// `workItemsService.updateStatus` (the shipped write authority). What is new here
// is only WHEN the question is asked and, below, which gate stands in for
// MOTIR-1604's when there is no delivering change request to exclude.

/** What one re-evaluation concluded.
 *
 *  The three `held_*` / `abstained_*` outcomes are all "the item stays where it
 *  is", split so an operator report says WHY — a hold that reads as a silent
 *  no-op is the failure mode MOTIR-1873 already paid for. */
export type RepoSetReevaluationOutcome =
  /** Every repository delivered; the item moved to the project's done status. */
  | 'transitioned'
  /** Every repository delivered and the item was already there. */
  | 'noop'
  /** No such work item. */
  | 'no_work_item'
  /** The item has no linked change request at all, so no tenant can be resolved
   *  from the connection tier and there is nothing for the gate to read. */
  | 'no_linked_change_request'
  /** The item names no repository. The gate ABSTAINS on an empty set — exactly as
   *  it does on a delivery — so re-evaluation must not complete it either. */
  | 'abstained_no_repo_set'
  /** Some repository the item carries is `awaiting` or `unknown`. */
  | 'held_incomplete_repo_set'
  /** A linked change request is still OPEN (the MOTIR-1604 rule, event-free). */
  | 'held_open_change_request'
  /** The project's workflow has no status in the done category. */
  | 'no_matching_status'
  /** The item's current status has no legal edge to done (e.g. it is still To Do). */
  | 'illegal_transition'
  /** No workspace owner to author the move, or the write was refused. */
  | 'access_denied';

export interface RepoSetReevaluationResult {
  workItemId: string;
  outcome: RepoSetReevaluationOutcome;
  /** The repositories that do NOT satisfy the gate, split by which question a
   *  reader has to answer. Empty for every outcome but `held_incomplete_repo_set`. */
  shortfall: RepoSetShortfall;
  /** The status the item was moved to (`transitioned` / `noop` only). */
  toStatus?: string;
}

/** Options a caller may pass; `dryRun` decides and reports without writing. */
export interface RepoSetReevaluationOptions {
  dryRun: boolean;
}

export const repoSetCompletionService = {
  /**
   * Re-run the repository-SET completion gate for ONE work item and complete it
   * when every repository it carries has delivered.
   *
   * The shape mirrors `syncChangeRequestStatus`'s resolve phase deliberately:
   * a system transaction reaches the CONNECTION tier, binds the tenant the
   * moment a trusted row names it, reads the item and the completion facts under
   * that binding, and then applies the transition OUTSIDE the read transaction
   * through the shipped authority.
   *
   * ⚠️ THE TENANT BINDING IS LOAD-BEARING AND ITS FAILURE IS SILENT (MOTIR-2880).
   * `work_item` and `workspace_membership` carry no `system_admin` policy arm, so
   * a read of either inside a bare `withSystemContext` returns ZERO ROWS and
   * raises nothing — which would present here as "no such work item" for an item
   * that plainly exists. The workspace is therefore resolved FIRST, off the
   * connection tier (`github_pull_request` → `github_repo`, both armed), and
   * `bindWorkspaceContext` is called before the first tenant-table statement.
   */
  async reevaluateItem(
    workItemId: string,
    opts: RepoSetReevaluationOptions = { dryRun: false },
  ): Promise<RepoSetReevaluationResult> {
    const resolved = await withSystemContext(async (tx) => {
      // CONNECTION TIER — armed for the system flag. This is also the only
      // trusted source of the tenant for a caller holding just an item id: the
      // repo row carries the workspace (MOTIR-1931), never request input.
      const workspaceId = await githubPullRequestRepository.findWorkspaceIdByWorkItem(
        workItemId,
        tx,
      );
      if (!workspaceId) return { kind: 'no_linked_change_request' as const };

      // ⚠️ BIND THE TENANT NOW — every statement below reads a table with no
      // `system_admin` arm.
      await bindWorkspaceContext(tx, workspaceId);

      const item = await workItemRepository.findById(workItemId, tx);
      if (!item) return { kind: 'no_work_item' as const };

      // The gate ABSTAINS on an empty set, on a delivery and here alike. An item
      // that names no repository is decided by the other two gates, and there is
      // no delivery for them to decide — so re-evaluation of such an item must
      // change nothing. Completing it would turn a repair into a bulk status
      // rewrite over every card in the product.
      if (item.targetRepos.length === 0)
        return { kind: 'abstained_no_repo_set' as const, workspaceId };

      // MOTIR-1604's rule, restated for a caller with no delivering change
      // request: the sync excludes the row it is deciding, because that row has
      // just closed. Nothing is closing here, so EVERY open linked change request
      // counts — which is the conservative reading, and the only one that cannot
      // complete a card whose sibling pull request is still in review.
      const openChangeRequests = await githubPullRequestRepository.countOpenByWorkItem(
        workItemId,
        tx,
      );

      const shortfall =
        openChangeRequests > 0
          ? EMPTY_SHORTFALL
          : repoSetShortfall(
              classifyRepoDelivery(
                item.targetRepos,
                await githubPullRequestRepository.listCompletionFactsByWorkItem(workItemId, tx),
              ),
            );

      const owner = await workspaceMembershipRepository.findOwnerByWorkspace(workspaceId, tx);
      return {
        kind: 'resolved' as const,
        workspaceId,
        projectId: item.projectId,
        currentStatus: item.status,
        openChangeRequests,
        shortfall,
        ownerUserId: owner?.userId ?? null,
      };
    });

    if (resolved.kind === 'no_linked_change_request')
      return { workItemId, outcome: 'no_linked_change_request', shortfall: EMPTY_SHORTFALL };
    if (resolved.kind === 'no_work_item')
      return { workItemId, outcome: 'no_work_item', shortfall: EMPTY_SHORTFALL };
    if (resolved.kind === 'abstained_no_repo_set')
      return { workItemId, outcome: 'abstained_no_repo_set', shortfall: EMPTY_SHORTFALL };

    if (resolved.openChangeRequests > 0)
      return { workItemId, outcome: 'held_open_change_request', shortfall: EMPTY_SHORTFALL };

    if (hasRepoSetShortfall(resolved.shortfall))
      return {
        workItemId,
        outcome: 'held_incomplete_repo_set',
        shortfall: resolved.shortfall,
      };

    // Resolve the concrete done status BY CATEGORY against the project's live
    // workflow — never a hard-coded key, exactly as the sync does, so a renamed
    // status still completes.
    const targetKey = await workflowsService.resolveStatusKey(
      resolved.projectId,
      resolved.workspaceId,
      { key: 'done', category: 'done' },
    );
    if (!targetKey)
      return { workItemId, outcome: 'no_matching_status', shortfall: EMPTY_SHORTFALL };

    if (resolved.currentStatus === targetKey)
      return { workItemId, outcome: 'noop', shortfall: EMPTY_SHORTFALL, toStatus: targetKey };

    // Checked BEFORE the dry-run short-circuit on purpose: a rehearsal that
    // reports "would complete" for an item no one can author the move on is a
    // rehearsal of the wrong run.
    if (!resolved.ownerUserId)
      return { workItemId, outcome: 'access_denied', shortfall: EMPTY_SHORTFALL };

    if (opts.dryRun)
      return {
        workItemId,
        outcome: 'transitioned',
        shortfall: EMPTY_SHORTFALL,
        toStatus: targetKey,
      };

    try {
      // Attributed to the WORKSPACE OWNER. The sync prefers the change request's
      // author and falls back to the owner; there is no author here — nobody
      // delivered anything — so the fallback is the whole answer, and it is the
      // same automation-engine precedent.
      await workItemsService.updateStatus(workItemId, targetKey, {
        userId: resolved.ownerUserId,
        workspaceId: resolved.workspaceId,
      });
    } catch (err) {
      // The same two classifications the sync makes, and NOT a third: an
      // `UnknownStatusError` cannot occur on this path, because `targetKey` was
      // resolved from THIS project's own workflow one screen above rather than
      // handed in. Anything genuinely unexpected re-throws — an operator sweep
      // that swallowed a real fault would report a repair it did not make.
      if (err instanceof IllegalTransitionError)
        return {
          workItemId,
          outcome: 'illegal_transition',
          shortfall: EMPTY_SHORTFALL,
          toStatus: targetKey,
        };
      if (err instanceof ProjectAccessDeniedError || err instanceof ProjectNotFoundError)
        return { workItemId, outcome: 'access_denied', shortfall: EMPTY_SHORTFALL };
      throw err;
    }

    return {
      workItemId,
      outcome: 'transitioned',
      shortfall: EMPTY_SHORTFALL,
      toStatus: targetKey,
    };
  },

  /**
   * Re-evaluate a LIST of work items, in order, and return every verdict.
   *
   * Each item is its own transaction and its own outcome, so one item that
   * cannot be resolved does not cost the others their repair — the same
   * per-unit resumability the historical sweep uses.
   */
  async reevaluateItems(
    workItemIds: readonly string[],
    opts: RepoSetReevaluationOptions = { dryRun: false },
  ): Promise<RepoSetReevaluationResult[]> {
    const results: RepoSetReevaluationResult[] = [];
    for (const id of workItemIds) {
      results.push(await repoSetCompletionService.reevaluateItem(id, opts));
    }
    return results;
  },
};
