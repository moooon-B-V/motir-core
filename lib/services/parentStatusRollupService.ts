import { withSystemContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { workflowsService } from './workflowsService';
import { workItemsService } from './workItemsService';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { IllegalTransitionError, UnknownStatusError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import type { StatusCategoryDto } from '@/lib/dto/workflows';

// The UPWARD half of bidirectional status derivation (Story MOTIR-1615 · Subtask
// MOTIR-1620; `docs/decisions/status-derivation.md` §3): a child transitioned, so
// its DIRECT parent follows the children's aggregate up a three-rung ladder.
//
// Direct parent only. The grandparent rolls up when the parent's OWN transition
// re-emits `work-item/transitioned` and the derivation job (MOTIR-1621) re-fires
// — recursion by re-emission, with no ancestor walk and no loop guard, because a
// level that does not change emits nothing. The downward mirror is
// `childStatusCascadeService` (MOTIR-1647).
//
// Runs under a system context: there is no acting user on a background job, so
// the move is attributed to the WORKSPACE OWNER, the same fallback the
// change-request status sync uses.

/** The ladder, highest rung first — the FIRST match wins. Each rung names the
 *  intent it wants; the concrete status key is resolved against the project's own
 *  workflow by `workflowsService.resolveStatusKey`, so a renamed workflow still
 *  derives. */
const LADDER: ReadonlyArray<{
  rung: 'done' | 'in_review' | 'in_progress';
  target: { key: string; category: StatusCategoryDto };
}> = [
  { rung: 'done', target: { key: 'done', category: 'done' } },
  { rung: 'in_review', target: { key: 'in_review', category: 'in_progress' } },
  { rung: 'in_progress', target: { key: 'in_progress', category: 'in_progress' } },
];

/** What a rollup pass did, for the caller's log. Every outcome is a NORMAL
 *  result — the rollup never throws on a shape it cannot act on, because it runs
 *  behind a status change the user already made successfully and must not turn
 *  that into a failed job. */
export type RollupOutcome =
  | { outcome: 'rolled_up'; parentId: string; toStatus: string }
  | { outcome: 'no_parent' }
  | { outcome: 'toggle_off'; parentId: string }
  | { outcome: 'no_rung'; parentId: string }
  | { outcome: 'already_there'; parentId: string; toStatus: string }
  | { outcome: 'not_forward'; parentId: string; toStatus: string }
  | { outcome: 'no_matching_status'; parentId: string }
  | { outcome: 'illegal_transition'; parentId: string; toStatus: string }
  | { outcome: 'access_denied'; parentId: string }
  | { outcome: 'unresolvable' };

export const parentStatusRollupService = {
  /**
   * Roll the transitioned child's DIRECT parent up the ladder, if a rung applies.
   *
   * The rungs, evaluated against the parent's direct non-archived, non-triaged
   * children:
   *   * **done** — every child is in a done-category status;
   *   * **in_review** — every child is in review or done, and at least one is in
   *     review;
   *   * **in_progress** — at least one child is in an in-progress-category status.
   *
   * Three properties this deliberately holds:
   *
   *   * **Forward-only.** The target must rank strictly AHEAD of the parent's
   *     current status, so reopening a child never drags the parent backwards and
   *     a done parent is never un-done.
   *   * **Legality-gated.** The move goes through the ordinary
   *     `applyStatusTransition` — NO system bypass — so the rollup only ever walks
   *     the team's real workflow. A project whose graph cannot take the move gets
   *     a logged no-op, which is the conservative reading of "the derivation
   *     respects your workflow". (This is the asymmetry with the downward cascade,
   *     which DOES bypass: see the ADR.)
   *   * **Lock BEFORE aggregate.** The parent row is locked FOR UPDATE before its
   *     children are counted. Two children finishing concurrently produce two
   *     rollup passes over the same parent; if each read the aggregate before
   *     locking, both could observe "not all done" and the parent would never roll.
   *     Locking first serializes them, and the loser re-reads an aggregate that
   *     includes the winner's commit. `applyStatusTransition` takes its own lock,
   *     but that is too late — the derivation INPUT is read before it.
   *
   * Never throws for a business reason; returns a typed outcome instead.
   */
  async rollUpForChild(childId: string): Promise<RollupOutcome> {
    // Phase 1 — resolve the neighbourhood. No acting user yet, so a system
    // context (the change-request-sync precedent).
    const resolved = await withSystemContext(async (tx) => {
      const child = await workItemRepository.findById(childId, tx);
      if (!child?.parentId) return null;
      const parent = await workItemRepository.findById(child.parentId, tx);
      if (!parent) return null;
      const settings = await projectRepository.findStatusAutomation(parent.projectId, tx);
      const owner = await workspaceMembershipRepository.findOwnerByWorkspace(
        parent.workspaceId,
        tx,
      );
      return {
        parentId: parent.id,
        projectId: parent.projectId,
        workspaceId: parent.workspaceId,
        enabled: settings?.autoRollupParentStatus ?? false,
        ownerUserId: owner?.userId ?? null,
      };
    });

    if (!resolved) return { outcome: 'no_parent' };
    if (!resolved.enabled) return { outcome: 'toggle_off', parentId: resolved.parentId };
    // No workspace owner ⇒ nobody can author the move. Not an error: a workspace
    // in that state has bigger problems than a missing rollup.
    if (!resolved.ownerUserId) return { outcome: 'unresolvable' };

    const { parentId, projectId, workspaceId, ownerUserId } = resolved;
    const ctx = { userId: ownerUserId, workspaceId };

    // Resolve the ladder's candidate keys ONCE, outside the locked transaction —
    // they depend only on the project's workflow, not on the children.
    const reviewKey = await workflowsService.resolveStatusKey(projectId, workspaceId, {
      key: 'in_review',
      category: 'in_progress',
    });

    /** The transaction returns its outcome AND, when it really moved the parent,
     *  the transition metadata the post-commit emit needs. */
    type Applied = {
      outcome: RollupOutcome;
      emit: { fromStatusKey: string; toStatusKey: string; revisionId: string } | null;
    };

    const { outcome, emit } = await withWorkspaceContext(ctx, async (tx): Promise<Applied> => {
      // ⚠️ Lock the PARENT first, then read the aggregate — see the doc comment.
      const locked = await workItemRepository.lockById(parentId, tx);
      if (!locked) return { outcome: { outcome: 'unresolvable' }, emit: null };
      const parent = await workItemRepository.findById(parentId, tx);
      if (!parent) return { outcome: { outcome: 'unresolvable' }, emit: null };

      const agg = await workItemRepository.aggregateChildrenStatus(parentId, reviewKey, tx);
      const rungs = matchingRungs(agg);
      if (rungs.length === 0) return { outcome: { outcome: 'no_rung', parentId }, emit: null };

      // Resolve the matching rungs, highest first, and take the highest one that
      // is BOTH forward and LEGAL in this project's workflow.
      //
      // The fallback matters (MOTIR-1623 surfaced it). Taking only the highest
      // rung strands a parent whose workflow cannot make that particular jump:
      // a `todo` parent whose single child goes straight to review matches the
      // in-review rung, `todo → in_review` is not an edge, and the parent then
      // sits in `todo` forever — no later event changes the aggregate, so it
      // never gets another chance. Falling to the next rung keeps the derivation
      // CONVERGENT while still only ever walking real workflow edges: the parent
      // advances as far as the team's graph actually permits, rather than not at
      // all.
      const currentRank = await rankOfStatus(projectId, workspaceId, parent.status, reviewKey);
      let attempted: string | null = null;
      // The highest rung that RESOLVED to a real status — what the ladder wanted,
      // reported in the outcome when no rung turns out to be legal so the log says
      // which move the workflow refused rather than just "something".
      let wanted: string | null = null;
      for (const rung of rungs) {
        const key = await workflowsService.resolveStatusKey(projectId, workspaceId, rung.target);
        if (!key) continue;
        wanted ??= key;
        // Already in this rung's target: the parent is exactly where the ladder
        // wants it, so stop — a LOWER rung would be a step backwards.
        if (parent.status === key) {
          return { outcome: { outcome: 'already_there', parentId, toStatus: key }, emit: null };
        }
        // Forward-only: rank the target on the same scale as the current status
        // and refuse anything that is not strictly a step forward.
        const targetRank = await rankOfStatus(projectId, workspaceId, key, reviewKey);
        if (targetRank <= currentRank) {
          return { outcome: { outcome: 'not_forward', parentId, toStatus: key }, emit: null };
        }
        attempted = key;
        if (await workflowsService.canTransition(projectId, parent.status, key, workspaceId)) break;
        attempted = null;
      }
      if (!attempted) {
        // Either no rung resolved to a real status in this workflow, or none of
        // the ones that did is legal from where the parent stands. Both are
        // logged no-ops, never throws — see the catch below.
        return {
          outcome: wanted
            ? { outcome: 'illegal_transition', parentId, toStatus: wanted }
            : { outcome: 'no_matching_status', parentId },
          emit: null,
        };
      }
      const toStatusKey = attempted;

      try {
        const { transition } = await workItemsService.applyStatusTransition(
          parentId,
          toStatusKey,
          ctx,
          tx,
        );
        // A null transition here would mean the status matched after all; the
        // equality check above already returned, so this is belt-and-braces.
        /* istanbul ignore next -- unreachable: the already-there check above returns first */
        if (!transition) {
          return {
            outcome: { outcome: 'already_there', parentId, toStatus: toStatusKey },
            emit: null,
          };
        }
        return {
          outcome: { outcome: 'rolled_up', parentId, toStatus: toStatusKey },
          emit: transition,
        };
      } catch (err) {
        // A workflow that cannot take the move, or a project the owner somehow
        // cannot edit, is a logged no-op — never a failed job behind a status
        // change the user already made successfully. Anything else is a real
        // fault and rethrows.
        if (err instanceof IllegalTransitionError) {
          return {
            outcome: { outcome: 'illegal_transition', parentId, toStatus: toStatusKey },
            emit: null,
          };
        }
        if (err instanceof UnknownStatusError) {
          return { outcome: { outcome: 'no_matching_status', parentId }, emit: null };
        }
        if (err instanceof ProjectAccessDeniedError || err instanceof ProjectNotFoundError) {
          return { outcome: { outcome: 'access_denied', parentId }, emit: null };
        }
        throw err;
      }
    });

    // Post-commit, never inside the transaction — a rollback must not have
    // notified, and this same event is what carries the derivation to the NEXT
    // level up (and to the automation engine / watchers, exactly as a board move
    // would).
    if (emit) {
      await sendEvent('work-item/transitioned', {
        workspaceId,
        workItemId: parentId,
        actorId: ownerUserId,
        fromStatusKey: emit.fromStatusKey,
        toStatusKey: emit.toStatusKey,
        revisionId: emit.revisionId,
      });
    }

    return outcome;
  },
};

/**
 * EVERY rung the children aggregate matches, highest first. The caller takes the
 * highest one that is both forward and legal, so a workflow that cannot make the
 * top jump still advances the parent as far as its graph allows (see the
 * fallback note at the call site) instead of stranding it.
 *
 * A parent with NO children matches nothing — "every child is done" must not be
 * vacuously true, or creating a story would instantly complete it.
 */
function matchingRungs(agg: {
  total: number;
  todo: number;
  inProgress: number;
  inReview: number;
  done: number;
}): Array<(typeof LADDER)[number]> {
  if (agg.total === 0) return [];
  const out: Array<(typeof LADDER)[number]> = [];
  if (agg.done === agg.total) out.push(LADDER[0]!); // done
  if (agg.inReview > 0 && agg.done + agg.inReview === agg.total) out.push(LADDER[1]!); // in_review
  if (agg.inProgress > 0 || agg.inReview > 0) out.push(LADDER[2]!); // in_progress
  return out;
}

/**
 * Where a status sits on the forward-only scale. Ranked by CATEGORY — so it
 * follows a project's own workflow — with review pulled out of the `in_progress`
 * category as its own, later rung, matching the ladder. An unknown key ranks
 * lowest, which makes a rollup out of it possible rather than stuck.
 */
async function rankOfStatus(
  projectId: string,
  workspaceId: string,
  statusKey: string,
  reviewKey: string | null,
): Promise<number> {
  if (reviewKey && statusKey === reviewKey) return 2;
  const status = await workflowsService.getStatusByKey(projectId, statusKey, workspaceId);
  if (!status) return 0;
  if (status.category === 'done') return 3;
  if (status.category === 'in_progress') return 1;
  return 0;
}
