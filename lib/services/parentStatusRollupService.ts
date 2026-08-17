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
// MOTIR-1620, AMENDED by Story MOTIR-2888 · Subtask MOTIR-2891;
// `docs/decisions/status-derivation.md` §3 + §3a): a parent's child set changed,
// so its status is RECOMPUTED from that set.
//
// A RECOMPUTE, NOT A RATCHET (the 2026-08-17 amendment, settling MOTIR-2885).
// The parent's status is a pure function of its children's CURRENT statuses over
// a FOUR-rung ladder, and the result is applied whether it lands ahead of or
// behind where the parent stands. Reopening a child brings its parent back with
// it; a `done` parent given a fresh `todo` child returns to `todo`. The fourth
// (`todo`) rung is what lets the ladder say "there is open, unstarted work down
// here" at all — adding it without dropping the forward-only filter would have
// changed nothing, and dropping the filter without it would have had nowhere to
// land. No work item is exempt: there is no per-item or per-kind carve-out.
//
// THE DIRECTION DECIDES THE AUTHORITY (ADR §3). The rank comparison still
// happens — it just picks the CALL instead of vetoing the move:
//   * FORWARD  — the ordinary `applyStatusTransition`, legality-gated, with the
//                highest-legal-rung fallback. "You configure your workflow, the
//                derivation respects it" is a promise about ADVANCEMENT and is
//                kept intact.
//   * BACKWARD — a privileged `{ system: true }` set (the shipped MOTIR-941
//                bypass the downward cascade already uses), with no
//                `canTransition` probe and no fallback: `done → todo` and
//                `in_review → todo` are not edges in the default workflow and
//                must NOT be added as `workflow_transition` rows, because those
//                are user-draggable board edges. A derived backward move is a
//                CLAIM ABOUT THE CHILDREN, not a user's workflow step.
//
// Direct parent only. The grandparent recomputes when the parent's OWN transition
// re-emits `work-item/transitioned` and the derivation job (MOTIR-1621) re-fires
// — recursion by re-emission, with no ancestor walk and no loop guard, because a
// level that does not change emits nothing (`already_there`). That no-op is now
// the whole of the termination argument, which no longer appeals to forward-only:
// a pass over an unchanged child set computes the same target and finds the
// parent already in it. The downward mirror is `childStatusCascadeService`
// (MOTIR-1647), which fires only on ENTRY into a done-category status — which is
// what stops a parent that has just come back to `todo` from force-closing the
// child that brought it there.
//
// Runs under a system context: there is no acting user on a background job, so
// the move is attributed to the WORKSPACE OWNER, the same fallback the
// change-request status sync uses.

/** The ladder, highest rung first — the FIRST match wins. Each rung names the
 *  intent it wants; the concrete status key is resolved against the project's own
 *  workflow by `workflowsService.resolveStatusKey`, so a renamed workflow still
 *  derives.
 *
 *  The fourth (`todo`) rung is the amendment's (MOTIR-2891): it matches when NO
 *  rung above it does, i.e. there is open work under the parent and none of it has
 *  started. It is last precisely so "first match wins" reads it as the fallthrough. */
const LADDER: ReadonlyArray<{
  rung: 'done' | 'in_review' | 'in_progress' | 'todo';
  target: { key: string; category: StatusCategoryDto };
}> = [
  { rung: 'done', target: { key: 'done', category: 'done' } },
  { rung: 'in_review', target: { key: 'in_review', category: 'in_progress' } },
  { rung: 'in_progress', target: { key: 'in_progress', category: 'in_progress' } },
  { rung: 'todo', target: { key: 'todo', category: 'todo' } },
];

/** What a rollup pass did, for the caller's log. Every outcome is a NORMAL
 *  result — the rollup never throws on a shape it cannot act on, because it runs
 *  behind a status change the user already made successfully and must not turn
 *  that into a failed job. */
export type RollupOutcome =
  /** The parent ADVANCED — a forward move, through the legality-gated path. */
  | { outcome: 'rolled_up'; parentId: string; toStatus: string }
  /** The parent CAME BACK — a backward move, through the privileged system set.
   *  A distinct variant rather than a flag on `rolled_up`, because the two took
   *  different authority to perform and a run log that cannot tell them apart
   *  cannot answer "did a derivation bypass a workflow gate?" (MOTIR-2891). */
  | { outcome: 'rolled_back'; parentId: string; toStatus: string }
  | { outcome: 'no_parent' }
  | { outcome: 'toggle_off'; parentId: string }
  | { outcome: 'no_rung'; parentId: string }
  | { outcome: 'already_there'; parentId: string; toStatus: string }
  /** The recompute's target sits at the SAME rung as the parent's current status
   *  under a different key — the reachable case being a `blocked` parent whose
   *  children are all todo. Neither forward nor backward, so nothing moves and a
   *  human's `blocked` marker survives the next child event (MOTIR-2891). */
  | { outcome: 'same_rung'; parentId: string; toStatus: string }
  | { outcome: 'no_matching_status'; parentId: string }
  | { outcome: 'illegal_transition'; parentId: string; toStatus: string }
  | { outcome: 'access_denied'; parentId: string }
  | { outcome: 'unresolvable' };

export const parentStatusRollupService = {
  /**
   * RECOMPUTE the given child's DIRECT parent from its current child set.
   *
   * The rungs, evaluated against the parent's direct non-archived, non-triaged
   * children — first match wins:
   *   * **done** — every child is in a done-category status;
   *   * **in_review** — every child is in review or done, and at least one is in
   *     review;
   *   * **in_progress** — at least one child is in an in-progress-category status;
   *   * **todo** — none of the above matched, i.e. there is open work under the
   *     parent and none of it has started.
   *
   * Three properties this deliberately holds:
   *
   *   * **Both directions.** The highest matching rung is applied whether it
   *     ranks ahead of or behind the parent's current status. A `done` parent
   *     given a fresh `todo` child returns to `todo`; a reopened child brings its
   *     parent back with it. (This REPLACED the forward-only filter — MOTIR-2891.)
   *   * **The direction decides the authority.** Forward goes through the
   *     ordinary `applyStatusTransition` — NO system bypass — so an advance only
   *     ever walks the team's real workflow, and a graph that cannot take the move
   *     gets a logged no-op after falling to the next legal rung. Backward is a
   *     `{ system: true }` set with no `canTransition` probe and no fallback,
   *     because the backward edges it needs (`done → todo`, `in_review → todo`)
   *     are absent from the default workflow and must not be added as
   *     user-draggable rows. See the file header and ADR §3.
   *   * **Lock BEFORE aggregate.** The parent row is locked FOR UPDATE before its
   *     children are counted. Two children finishing concurrently produce two
   *     passes over the same parent; if each read the aggregate before locking,
   *     both could observe "not all done" and the parent would never roll.
   *     Locking first serializes them, and the loser re-reads an aggregate that
   *     includes the winner's commit. `applyStatusTransition` takes its own lock,
   *     but that is too late — the derivation INPUT is read before it.
   *
   * Never throws for a business reason; returns a typed outcome instead.
   */
  async rollUpForChild(childId: string): Promise<RollupOutcome> {
    // Resolve the child's parent, then hand off. The child is only ever an
    // ADDRESS for its parent — every rung reads the parent's whole child set —
    // so the two entry points share one implementation (MOTIR-2892: the
    // child-set triggers know a PARENT, not a child, and must not fork the
    // ladder). No acting user yet, so a system context (the change-request-sync
    // precedent).
    const parentId = await withSystemContext(async (tx) => {
      const child = await workItemRepository.findById(childId, tx);
      return child?.parentId ?? null;
    });
    if (!parentId) return { outcome: 'no_parent' };
    return parentStatusRollupService.recomputeParent(parentId);
  },

  /**
   * RECOMPUTE one parent from its current child set — the PARENT-keyed entry
   * point (Story MOTIR-2888 · Subtask MOTIR-2892).
   *
   * Identical in every respect to {@link rollUpForChild}, which is a thin
   * resolver in front of it; see that method's doc comment for the rungs and the
   * three properties. It exists because the child-set triggers — a re-parent's
   * PREVIOUS parent, a delete whose child row no longer exists — have a parent id
   * and no child to address it through, and handing them "any surviving child"
   * would be a lie in exactly the cases that matter (the last child left).
   *
   * `no_parent` is not reachable from here: the caller already has the parent.
   */
  async recomputeParent(parentIdIn: string): Promise<RollupOutcome> {
    const resolved = await withSystemContext(async (tx) => {
      const parent = await workItemRepository.findById(parentIdIn, tx);
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

    // The parent row is gone (deleted in the window between the emit and this
    // run). Nothing to recompute, and not an error.
    if (!resolved) return { outcome: 'unresolvable' };
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
      // With the fourth rung in place this is reachable ONLY for a parent with no
      // LIVE children — none at all, or every one archived / triaged. An empty
      // aggregate must not satisfy "every child is done" vacuously, and must not
      // fall through to the todo rung either: there is nothing to derive FROM.
      if (rungs.length === 0) return { outcome: { outcome: 'no_rung', parentId }, emit: null };

      // Resolve every matching rung ONCE, highest first, dropping the ones this
      // project's workflow has no status for and de-duplicating (two rungs can
      // resolve to the same key when a project has renamed a status away).
      const candidates: Array<{ key: string; rank: number }> = [];
      for (const rung of rungs) {
        const key = await workflowsService.resolveStatusKey(projectId, workspaceId, rung.target);
        if (!key || candidates.some((c) => c.key === key)) continue;
        candidates.push({
          key,
          rank: await rankOfStatus(projectId, workspaceId, key, reviewKey),
        });
      }
      const wanted = candidates[0];
      if (!wanted) return { outcome: { outcome: 'no_matching_status', parentId }, emit: null };

      // The HIGHEST matching rung is what the recompute says the parent IS. Where
      // it sits relative to the parent's current status decides only WHICH CALL
      // performs the move — never whether the move happens (ADR §3, MOTIR-2891).
      const currentRank = await rankOfStatus(projectId, workspaceId, parent.status, reviewKey);

      // Already exactly there: the no-op that emits nothing, and therefore the
      // fixed point the whole termination argument rests on.
      if (parent.status === wanted.key) {
        return {
          outcome: { outcome: 'already_there', parentId, toStatus: wanted.key },
          emit: null,
        };
      }

      let toStatusKey: string;
      let system = false;
      if (wanted.rank < currentRank) {
        // BACKWARD — a privileged system set. ONE call: no `canTransition` probe
        // and no rung fallback, because a backward derivation must not depend on
        // a board edge existing (`done → todo` is not one in the default
        // workflow, and must NOT be added — those rows are user-draggable).
        toStatusKey = wanted.key;
        system = true;
      } else if (wanted.rank === currentRank) {
        // Same rung, different key — the parent already sits at the level the
        // children imply, under a status the derivation did not choose. The
        // reachable case is a `blocked` parent (a todo-category status a user set
        // deliberately) whose children are all todo: the todo rung "wants" To Do,
        // `blocked → todo` is a legal edge, and taking it would silently clear a
        // human's blocked marker on the next child event. Neither forward nor
        // backward: leave it alone.
        return { outcome: { outcome: 'same_rung', parentId, toStatus: wanted.key }, emit: null };
      } else {
        // FORWARD — unchanged: legality-gated, with the fallback to the next
        // matching rung that this project's graph can actually reach.
        //
        // The fallback matters (MOTIR-1623 surfaced it). Taking only the highest
        // rung strands a parent whose workflow cannot make that particular jump:
        // a `todo` parent whose single child goes straight to review matches the
        // in-review rung, `todo → in_review` is not an edge, and the parent then
        // sits in `todo` forever — no later event changes the aggregate, so it
        // never gets another chance. Falling to the next rung keeps the derivation
        // CONVERGENT while still only ever walking real workflow edges: the parent
        // advances as far as the team's graph actually permits, rather than not at
        // all. The fallback never walks BACKWARDS — a lower rung that is not
        // itself forward ends the search rather than becoming a system set, since
        // the recompute already decided the direction from the highest rung.
        let attempted: string | null = null;
        for (const candidate of candidates) {
          if (candidate.rank <= currentRank) {
            if (parent.status === candidate.key) {
              return {
                outcome: { outcome: 'already_there', parentId, toStatus: candidate.key },
                emit: null,
              };
            }
            break;
          }
          attempted = candidate.key;
          if (
            await workflowsService.canTransition(
              projectId,
              parent.status,
              candidate.key,
              workspaceId,
            )
          ) {
            break;
          }
          attempted = null;
        }
        if (!attempted) {
          // None of the forward rungs is legal from where the parent stands. A
          // logged no-op naming the one it WANTED, never a throw — see the catch
          // below.
          return {
            outcome: { outcome: 'illegal_transition', parentId, toStatus: wanted.key },
            emit: null,
          };
        }
        toStatusKey = attempted;
      }

      try {
        // `system: true` ONLY on the backward arm — it skips `canTransition` and
        // nothing else, keeping the row lock, the tenant gate, the project-access
        // gate, the target-exists check, the `done ⇒ sessionBranch = null`
        // invariant and the revision (MOTIR-941's shipped bypass, the same one
        // the downward cascade uses).
        const { transition } = await workItemsService.applyStatusTransition(
          parentId,
          toStatusKey,
          ctx,
          tx,
          system ? { system: true } : {},
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
          outcome: {
            outcome: system ? 'rolled_back' : 'rolled_up',
            parentId,
            toStatus: toStatusKey,
          },
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
 * highest one as the recompute's answer, and — on the forward arm only — falls to
 * the next legal one, so a workflow that cannot make the top jump still advances
 * the parent as far as its graph allows (see the fallback note at the call site)
 * instead of stranding it.
 *
 * The `todo` rung (MOTIR-2891) is the FALLTHROUGH: it matches exactly when the
 * parent has live children and no rung above it matched — i.e. there is open work
 * down there and none of it has started. It is what lets the ladder express the
 * state a `done` parent enters when a fresh `todo` child is added to it.
 *
 * A parent with NO live children matches nothing — "every child is done" must not
 * be vacuously true (or creating a story would instantly complete it), and the
 * todo rung must not fire on an empty set either (or creating a story would
 * instantly un-complete its epic). Both are the same guard: derive from a child
 * set, or do not derive.
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
  if (out.length === 0) out.push(LADDER[3]!); // todo — the fallthrough
  return out;
}

/**
 * Where a status sits on the ladder's scale. Ranked by CATEGORY — so it follows a
 * project's own workflow — with review pulled out of the `in_progress` category
 * as its own, later rung, matching the ladder. An unknown key ranks lowest.
 *
 * The rank no longer VETOES a move (it did, under forward-only); it chooses which
 * call performs it — the ordinary legality-gated transition when the target ranks
 * ahead, the privileged system set when it ranks behind, and no move at all on a
 * tie. See the direction-decides-the-authority block at the call site.
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
