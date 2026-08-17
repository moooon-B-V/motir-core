import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
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
//   * FORWARD  — the ordinary `applyStatusTransition`, legality-gated, WALKING
//                the ladder one legal edge at a time (MOTIR-2901). "You configure
//                your workflow, the derivation respects it" is a promise about
//                ADVANCEMENT and is kept intact: every hop is a real edge of the
//                team's own graph, and every status stood on is a LADDER RUNG the
//                derivation could have chosen outright for some child set.
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
// parent already in it. The forward WALK is inside one pass and cannot disturb
// that: it only ever steps to a STRICTLY higher rung on a four-point scale, so it
// takes at most three hops and lands on the target it computed before it started.
// The downward mirror is `childStatusCascadeService`
// (MOTIR-1647), which fires only on ENTRY into a done-category status — which is
// what stops a parent that has just come back to `todo` from force-closing the
// child that brought it there.
//
// Runs WITHOUT an acting user — it is a background job — so the move is
// attributed to the WORKSPACE OWNER, the same fallback the change-request status
// sync uses. It is NOT userless in the tenant sense: the triggering event carries
// `workspaceId`, so both phases bind a workspace context (MOTIR-2880 — phase 1
// used to open a system context, which no `work_item` policy admits).

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
  /** The parent ADVANCED — a forward move, through the legality-gated path.
   *  `via` lists the INTERMEDIATE rungs a multi-hop walk stood on, and is present
   *  only when there were any (MOTIR-2901). A run log that cannot say "this
   *  derivation passed through In Review on its way to Done" cannot answer the
   *  question an operator actually has when a status appears in the feed that
   *  nobody set — the same reason `rolled_back` is its own variant. */
  | { outcome: 'rolled_up'; parentId: string; toStatus: string; via?: string[] }
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
   *     ever walks the team's real workflow, hop by hop, and a graph with no path
   *     to the target at all gets a logged no-op. Backward is a
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
  async rollUpForChild(childId: string, workspaceId: string): Promise<RollupOutcome> {
    // Resolve the child's parent, then hand off. The child is only ever an
    // ADDRESS for its parent — every rung reads the parent's whole child set — so
    // the two entry points share one implementation (MOTIR-2892: the child-set
    // triggers know a PARENT, not a child, and must not fork the ladder).
    //
    // No acting USER on a background job, but there IS a tenant: every event that
    // reaches derivation carries `workspaceId`, so the read binds the WORKSPACE
    // tier.
    //
    // ⚠️ THIS USED TO BE `withSystemContext`, AND IT WAS DEAD (MOTIR-2880). That
    // context binds only `app.system_admin`, and `work_item` /
    // `workspace_membership` carry no arm that reads it — so under `motir_app` the
    // very first statement here (`findById(childId)`) returned NULL and every
    // rollup answered `{ outcome: 'no_parent' }` without raising. Silent, because
    // RLS does not refuse a SELECT, it empties it. The same trap applies to
    // `recomputeParent` below, which is why it takes the workspace too rather
    // than resolving it from the row it is about to read.
    const parentId = await withWorkspaceServiceContext(workspaceId, async (tx) => {
      const child = await workItemRepository.findById(childId, tx);
      return child?.parentId ?? null;
    });
    if (!parentId) return { outcome: 'no_parent' };
    return parentStatusRollupService.recomputeParent(parentId, workspaceId);
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
   *
   * Takes the WORKSPACE explicitly, for MOTIR-2880's reason: the resolve phase is
   * an RLS-scoped read, and binding it to the tenant the triggering event named
   * is what makes it return rows at all under `motir_app`. Resolving the
   * workspace FROM the parent row would be circular — that read is the one being
   * scoped.
   */
  async recomputeParent(parentIdIn: string, workspaceId: string): Promise<RollupOutcome> {
    const resolved = await withWorkspaceServiceContext(workspaceId, async (tx) => {
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

    // `workspaceId` is the caller's — the phase-1 read was RLS-scoped to it, so the
    // parent it resolved is that workspace's by construction.
    const { parentId, projectId, ownerUserId } = resolved;
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

      // Resolve EVERY ladder rung against this project's workflow ONCE, dropping
      // the ones it has no status for and de-duplicating by KEY (two rungs can
      // resolve to the same key when a project has renamed a status away). The
      // resolution serves two different readers:
      //
      //   * `candidates` — the MATCHING rungs, highest first. These say what the
      //     recompute claims the parent IS.
      //   * `stones` — ALL of them, highest rank first. These are the statuses a
      //     forward walk may stand on. The distinction is the whole of MOTIR-2901:
      //     a stepping stone need not be a rung the current child set matches, but
      //     it is always a rung the ladder itself can produce — so the walk can
      //     never park the parent in a status the derivation was not entitled to
      //     choose in the first place.
      const resolved = new Map<(typeof LADDER)[number]['rung'], { key: string; rank: number }>();
      const stones: Array<{ key: string; rank: number }> = [];
      for (const entry of LADDER) {
        const key = await workflowsService.resolveStatusKey(projectId, workspaceId, entry.target);
        if (!key) continue;
        const known = stones.find((s) => s.key === key);
        const stone = known ?? {
          key,
          rank: await rankOfStatus(projectId, workspaceId, key, reviewKey),
        };
        if (!known) stones.push(stone);
        resolved.set(entry.rung, stone);
      }
      stones.sort((a, b) => b.rank - a.rank);

      const candidates: Array<{ key: string; rank: number }> = [];
      for (const rung of rungs) {
        const stone = resolved.get(rung.rung);
        if (!stone || candidates.some((c) => c.key === stone.key)) continue;
        candidates.push(stone);
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

      /** The status keys to set, in order — one for a backward system set, one or
       *  more for a forward walk. The last one is where the parent ends up. */
      let steps: string[];
      let system = false;
      if (wanted.rank < currentRank) {
        // BACKWARD — a privileged system set. ONE call: no `canTransition` probe,
        // no walk and no fallback, because a backward derivation must not depend
        // on a board edge existing (`done → todo` is not one in the default
        // workflow, and must NOT be added — those rows are user-draggable). There
        // is nothing for a walk to buy here either: a system set reaches any
        // status in one hop.
        steps = [wanted.key];
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
        // FORWARD — legality-gated, and a WALK rather than a single hop
        // (MOTIR-2901). From where the parent stands, repeatedly take the HIGHEST
        // stepping stone at or below the target that this project's graph can
        // legally reach, until the target is reached or nothing above the cursor
        // is legal.
        //
        // Why a walk and not one hop. MOTIR-1623 already found that taking only
        // the top rung STRANDS a parent whose workflow cannot make that jump, and
        // the answer then was to fall to the next MATCHING rung. That answer has
        // a hole, and MOTIR-2901 fell into it: when every child finishes before
        // the first derivation pass runs, the aggregate is all-done, `done` is
        // the ONLY matching rung, and there is nothing below it to fall to. A
        // `todo` parent then has no legal single edge to `done` (`todo → done` is
        // not one, deliberately — MOTIR-1625 added `in_progress → done` and
        // stopped there), so it sat in `todo` forever: the aggregate never
        // changes again, so no later event gives it another chance. Exactly the
        // stranding the fallback was added to fix, in the one shape the fallback
        // could not reach.
        //
        // Why this still RESPECTS the workflow, which is the promise at stake:
        //   * every hop is a real `workflow_transition` edge — no `system` bypass,
        //     no new row, and a graph with no path simply gets a logged no-op;
        //   * every status stood on is a LADDER RUNG, i.e. one the derivation
        //     could have set outright for some other child set. The walk can
        //     never invent a resting place, only reach one sooner.
        // The parent therefore ends where the recompute says it is, having taken
        // precisely the moves a person would have had to make by hand.
        //
        // Termination: each hop moves to a STRICTLY higher rank on a four-point
        // scale bounded above by the target, so the loop runs at most
        // `stones.length` times and cannot revisit a stone. It never walks
        // BACKWARDS either — a stone at or below the cursor is skipped rather
        // than becoming a system set, since the recompute already decided the
        // direction from the highest matching rung.
        const path: string[] = [];
        let cursor = parent.status;
        let cursorRank = currentRank;
        for (let hop = 0; hop < stones.length && cursorRank < wanted.rank; hop += 1) {
          let next: { key: string; rank: number } | null = null;
          for (const stone of stones) {
            if (stone.rank <= cursorRank || stone.rank > wanted.rank) continue;
            if (await workflowsService.canTransition(projectId, cursor, stone.key, workspaceId)) {
              next = stone;
              break;
            }
          }
          if (!next) break;
          path.push(next.key);
          cursor = next.key;
          cursorRank = next.rank;
        }

        if (path.length === 0) {
          // Nothing above the parent is legal from where it stands. If the parent
          // is ALREADY sitting on one of the MATCHING rungs, that is a no-op and
          // not a refusal — reporting it as `illegal_transition` would put a false
          // negative in the run log. Otherwise a logged no-op naming the rung it
          // WANTED, never a throw — see the catch below.
          const here = candidates.find((c) => c.key === parent.status);
          if (here) {
            return {
              outcome: { outcome: 'already_there', parentId, toStatus: here.key },
              emit: null,
            };
          }
          return {
            outcome: { outcome: 'illegal_transition', parentId, toStatus: wanted.key },
            emit: null,
          };
        }
        steps = path;
      }

      const toStatusKey = steps[steps.length - 1]!;
      try {
        // `system: true` ONLY on the backward arm — it skips `canTransition` and
        // nothing else, keeping the row lock, the tenant gate, the project-access
        // gate, the target-exists check, the `done ⇒ sessionBranch = null`
        // invariant and the revision (MOTIR-941's shipped bypass, the same one
        // the downward cascade uses).
        //
        // A forward WALK applies its hops in order, in THIS transaction, so the
        // whole path commits or none of it does. Each hop writes its own revision
        // — that is the honest record of the edges walked, and the activity feed
        // should show a status the item genuinely held — but the walk emits ONE
        // event for the NET move (below), because an event is a notification and
        // a watcher must not be told three times about one derivation.
        let first: { fromStatusKey: string; toStatusKey: string; revisionId: string } | null = null;
        let last: { fromStatusKey: string; toStatusKey: string; revisionId: string } | null = null;
        for (const step of steps) {
          const { transition } = await workItemsService.applyStatusTransition(
            parentId,
            step,
            ctx,
            tx,
            system ? { system: true } : {},
          );
          /* istanbul ignore next -- unreachable: every step strictly changes the status */
          if (!transition) continue;
          first ??= transition;
          last = transition;
        }
        // A null transition on every step would mean the status matched after all;
        // the equality check above already returned, so this is belt-and-braces.
        /* istanbul ignore next -- unreachable: the already-there check above returns first */
        if (!first || !last) {
          return {
            outcome: { outcome: 'already_there', parentId, toStatus: toStatusKey },
            emit: null,
          };
        }
        // The intermediate rungs, for the run log — present only when the walk
        // actually passed through one. The backward arm is always a single hop,
        // so `rolled_back` never carries them.
        const via = steps.slice(0, -1);
        const emit = {
          fromStatusKey: first.fromStatusKey,
          toStatusKey: last.toStatusKey,
          revisionId: last.revisionId,
        };
        if (system) {
          return { outcome: { outcome: 'rolled_back', parentId, toStatus: toStatusKey }, emit };
        }
        return {
          outcome: {
            outcome: 'rolled_up',
            parentId,
            toStatus: toStatusKey,
            ...(via.length > 0 ? { via } : {}),
          },
          emit,
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
