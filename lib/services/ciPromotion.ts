import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import { derivePrCiState } from '@/lib/github/prCiState';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemsService } from './workItemsService';
import { resolveChangeRequestWorkItemSet } from './changeRequestWorkItems';
import {
  ContainerHasOpenChildrenError,
  IllegalTransitionError,
  UnknownStatusError,
} from '@/lib/workItems/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';

// CI GREEN IS WHAT MAKES A CARD REVIEWABLE (MOTIR-3006).
//
// `implemented` says the code is pushed and the pull request is open; In Review
// says a human should look at it. The only thing entitled to move a card between
// those two is the build, and this module is where that happens — for EVERY card
// the pull request delivers, not for the one its link column happens to name.
//
// ── TWO EDGES, ONE VERDICT ──────────────────────────────────────────────────
// The run pushes BEFORE it transitions (MOTIR-3004 — `implemented` confirms the
// push rather than predicting it), so the green verdict can arrive first:
//
//   agent pushes → CI starts → CI goes GREEN → agent transitions to implemented
//                                   ↑                       ↑
//                        edge 1 fires and finds        edge 2 fires here
//                        nothing at `implemented`      and finds the green
//
// So the promotion is a LATCH, not an edge: it is evaluated both when CI reports
// and when a card ARRIVES at `implemented`, from the SAME durable verdict. The
// check rows are persisted, so edge 2 re-reads state that already exists rather
// than inventing a record or a queue.
//
// ⚠️ The window is NOT closed by widening the source states. Accepting
// `in_progress → in_review` on green would promote a card whose agent died
// before it finished, and would break the idempotence the `implemented` guard
// gives for free. The state stays `implemented`; what changes is WHEN the
// question gets asked.
//
// ── THE VERDICT IS `derivePrCiState`, DELIBERATELY ──────────────────────────
// Both edges ask the shipped per-PR derivation over ALL of a change request's
// rows, which computes at the LATEST recorded sha. That single choice buys three
// of this card's guards at once: a still-pending aggregate is `running` (not
// promoted), a failure is `failing` (not promoted), and a green run for a
// SUPERSEDED sha loses to the newer push's rows (not promoted). Re-deriving any
// of them here would be a second opinion that could drift from the pill a person
// reads on the Development surface.

/**
 * The refusals a promotion TOLERATES, per card.
 *
 * Each is a legitimate answer from a project's own workflow or permissions —
 * a custom workflow with no `in_review`, a missing edge to it, an actor without
 * edit rights there — and none of them says anything about the OTHER cards the
 * same run delivered. Anything not on this list is a real fault and is rethrown.
 */
const SKIPPABLE = [
  IllegalTransitionError,
  UnknownStatusError,
  ProjectAccessDeniedError,
  // The container-completeness gate (MOTIR-3229). A green build says nothing
  // about a card's own children, so a CONTAINER whose children are not landed is
  // refused In Review — and that refusal is precisely what the card is for: In
  // Review is a promise to a person, and MOTIR-1343 made it over two `todo`
  // children. Skippable rather than fatal for this list's stated reason: it says
  // nothing about the OTHER cards the same run delivered.
  ContainerHasOpenChildrenError,
];

/** The ONLY status a promotion moves a card out of. */
const SOURCE_STATUS = 'implemented';
/** The status CI green moves it to. */
const TARGET_STATUS = 'in_review';

/**
 * EDGE 1 — CI has just reported a terminal verdict for one change request.
 *
 * Promotes every card that change request delivers and that currently sits at
 * `implemented`. Best-effort by construction: it runs AFTER the feedback
 * comment and the `ciState` write have committed, and a failure here must never
 * turn a recorded verdict into a webhook the host retries forever.
 *
 * Returns the ids it promoted, so a caller can report how many rather than
 * asserting one.
 */
export async function promoteDeliveredCardsOnGreen(args: {
  changeRequestId: string;
  workspaceId: string;
  actorUserId: string;
}): Promise<string[]> {
  const targets = await withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, args.workspaceId);
    const pr = await githubPullRequestRepository.findByIdWithInstallation(args.changeRequestId, tx);
    if (!pr) return [];
    if (derivePrCiState(pr.checkRuns) !== 'passing') return [];

    const linked = pr.workItemId ? await workItemRepository.findById(pr.workItemId, tx) : null;
    const set = await resolveChangeRequestWorkItemSet({
      workspaceId: args.workspaceId,
      headRef: pr.headRef,
      linked: linked
        ? {
            id: linked.id,
            identifier: linked.identifier,
            projectId: linked.projectId,
            status: linked.status,
            targetRepos: linked.targetRepos,
          }
        : null,
      tx,
    });
    // Only the cards at `implemented`. A sibling a human moved back to In
    // Progress to rework must not be yanked forward by a green run.
    return set.items.filter((item) => item.status === SOURCE_STATUS).map((item) => item.id);
  });

  return promoteEach(targets, { userId: args.actorUserId, workspaceId: args.workspaceId });
}

/**
 * EDGE 2 — a card has just ARRIVED at `implemented`.
 *
 * Re-reads the change request's already-recorded verdict and promotes
 * immediately when it is terminally green, which is the case the push-first
 * ordering opens. A clean no-op for a card with no change request, an untracked
 * one, or one with no check rows yet — which is the ordinary case for a human
 * moving a card to Implemented by hand.
 *
 * Returns whether it promoted, so the caller can log it; never throws.
 */
export async function promoteIfCiAlreadyGreen(
  workItemId: string,
  ctx: { userId: string; workspaceId: string },
): Promise<boolean> {
  const shouldPromote = await withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, ctx.workspaceId);
    const item = await workItemRepository.findById(workItemId, tx);
    // Re-read rather than trusting the caller: between the transition committing
    // and this running, the card may have moved again.
    if (!item || item.status !== SOURCE_STATUS) return false;

    // The card's change requests, by whichever join it has: the link column for
    // an own-pull-request card, the session branch for a card integrated onto a
    // run's branch (whose pull request names no card at all).
    const linked = await githubPullRequestRepository.listByWorkItemWithContext(item.id, tx);
    const onBranch = item.sessionBranch
      ? await githubPullRequestRepository.listByHeadRefWithChecks(item.sessionBranch, tx)
      : [];
    const candidates = [...linked, ...onBranch];
    return candidates.some((pr) => derivePrCiState(pr.checkRuns) === 'passing');
  });

  if (!shouldPromote) return false;
  const promoted = await promoteEach([workItemId], ctx);
  return promoted.length > 0;
}

/**
 * Move each card through the SHIPPED authority, one transaction each, and treat
 * a per-card refusal as a skip rather than a failure of the whole promotion.
 *
 * A custom workflow with no `in_review`, an item whose status moved underneath
 * us, or an actor without edit rights on one project must not stop the other
 * cards of the same run from being promoted — the same per-item tolerance
 * `completeSession` applies to a session close-out.
 */
async function promoteEach(
  workItemIds: string[],
  ctx: { userId: string; workspaceId: string },
): Promise<string[]> {
  const promoted: string[] = [];
  for (const id of workItemIds) {
    try {
      await workItemsService.updateStatus(id, TARGET_STATUS, ctx);
      promoted.push(id);
    } catch (err) {
      if (!SKIPPABLE.some((kind) => err instanceof kind)) throw err;
      console.warn('[ciPromotion] skipped a card CI green could not promote', {
        workItemId: id,
        // Every member of SKIPPABLE extends Error, which the `.some()` above
        // cannot tell the compiler.
        error: (err as Error).message,
      });
    }
  }
  return promoted;
}
