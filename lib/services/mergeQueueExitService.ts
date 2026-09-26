import type { Prisma, WorkItem } from '@/generated/prisma/client';
import type { GitProviderId, NormalizedMergeQueueExit } from '@/lib/git/types';
import { classifyQueueExit, classOfQueueExit, type LandingClass } from '@/lib/mergeQueue/queueExit';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubMergeQueueAttemptRepository } from '@/lib/repositories/githubMergeQueueAttemptRepository';
import { githubPullRequestQueueExitRepository } from '@/lib/repositories/githubPullRequestQueueExitRepository';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { sendEvent } from '@/lib/jobs/sendEvent';
import {
  bindWorkspaceContext,
  withSystemContext,
  withWorkspaceContext,
} from '@/lib/workspaces/context';
import { resolveDeliveredWorkItems } from './changeRequestWorkItems';
import { recomputeWorkItemCiState } from './deliveryVerdict';
import { workItemsService } from './workItemsService';
import { reconcileGatesFor } from './gateSetFor';
import { readPlanHoldWithin } from './planTargetLockService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { IllegalTransitionError, UnknownStatusError } from '@/lib/workItems/errors';

// A MERGE QUEUE REMOVED A PULL REQUEST (Story MOTIR-5461 · MOTIR-5632).
//
// `docs/decisions/approval-gates.md` §4 THIRD AMENDMENT, decisions 1–4 and 9, as the
// FOURTH AMENDMENT (MOTIR-5805) amends them. The queue tested the pull request
// together with everything ahead of it and took it out. Motir records that on the
// PULL REQUEST, stops saying it is queued, and — when the reason is a FAILURE —
// moves every card it delivers:
//   * in a `manual` project, `approved → in_review`, and RE-ASKS the merge question
//     on ONE fresh awaiting approve-to-merge gate over the same commits. The yes that
//     sent them to the queue was about them landing, and they did not;
//   * in an `auto` project, `in_review → implemented` — committed code whose build
//     (the queue's merge commit) has not passed. No person is asked there.
//
// What it deliberately leaves alone:
//   * the card's DECIDED `pull_request_approval` gate — a decided gate is a record
//     and is never edited; the re-ask is computed from the exit row instead;
//   * the card's DECIDED design gate — the design was never the problem;
//   * the card's OTHER pull requests still in the queue — approved at their own
//     heads, which have not moved;
//   * any card at a status other than the one the mode puts an enqueued card in —
//     somebody moved it, and a queue verdict does not overrule a person.
//
// ⚠️ ONE TRANSACTION, AND NOTHING EXTERNAL INSIDE IT. A failure answers non-2xx;
// GitHub marks the delivery failed and does NOT retry by itself, so the recovery is
// a hand REDELIVERY — which repeats the `X-GitHub-Delivery` GUID (measured,
// MOTIR-5627), so the unique `delivery_id` makes it safe.
//
// ⚠️ THE MOVE IS A SYSTEM WRITE, THROUGH `applyStatusTransition`, AND IT IS NOT
// `updateStatus`. `updateStatus` runs the CI-green latch when a card ARRIVES at
// `implemented`, and the latch would promote this card straight back: its pull
// requests' own checks are still green. The promotion HOLD in `ciPromotion`
// (decision 6) stops that on every other door; here the latch is simply not asked.

const PROVIDER: GitProviderId = 'github';

/** Where an enqueued card sits, per merge mode — and so the one status a failure
 *  moves it FROM. `manual`: a person approved it. `auto`: nobody decides, so CI's
 *  promotion is the last move before the merge. */
const ENQUEUED_STATUS = { manual: 'approved', auto: 'in_review' } as const;

/** Where a FAILURE moves it TO (§4 FOURTH AMENDMENT, point 1). `manual`: back to
 *  review, where the merge question is asked again. `auto`: to `implemented`, as
 *  before — no person decides, and a push re-arms it. */
const EJECTED_STATUS = { manual: 'in_review', auto: 'implemented' } as const;

/**
 * WHERE A MANUAL CARD GOES when its merge did not land, by class (§4 FOURTH AMENDMENT,
 * point 2): back to review where a person can answer again, or to `implemented` where
 * `motir fix` claims it and nothing is asked until the head moves.
 */
const UNLANDED_STATUS = { reask: 'in_review', cantLand: 'implemented' } as const;

export type MergeQueueExitOutcome =
  /** A `landed` reason — nothing written, the merge webhook owns `done`. */
  | 'landed'
  /** This delivery GUID was recorded already — nothing written again. */
  | 'duplicate'
  /** The exit row was written (and, on a failure, the cards moved). */
  | 'recorded'
  | 'unknown_installation'
  | 'unknown_repo'
  /** A pull request Motir never mirrored — nothing can deliver a card. */
  | 'unknown_pull_request'
  | 'malformed';

export interface MergeQueueExitResult {
  event: 'pull_request_dequeued';
  outcome: MergeQueueExitOutcome;
  disposition?: 'failure' | 'neutral' | 'landed';
  rawReason?: string | null;
  /** Keys of the cards a failure moved (`in_review` in manual, `implemented` in auto). */
  moved?: string[];
  /** Keys of the cards a manual failure RE-ASKED — ONE fresh approve-to-merge gate raised. */
  reasked?: string[];
  /** Cards the pull request delivers that were NOT moved, and why. */
  skipped?: { key: string; status: string; reason: 'not_enqueued_status' | 'no_actor' }[];
  /** Whether a queued merge record was cleared. */
  clearedQueuedOutcome?: boolean;
}

interface Resolved {
  workspaceId: string;
  repoId: string;
  ownerUserId: string | null;
}

export const mergeQueueExitService = {
  /**
   * Record ONE removal. `deliveryId` is the delivery's `X-GitHub-Delivery` header;
   * a delivery without one is refused as malformed rather than recorded without an
   * idempotency key. `now` is the time the removal is recorded at.
   */
  async recordExit(input: {
    installationId: string | null;
    exit: NormalizedMergeQueueExit;
    deliveryId: string | null;
    now?: Date;
  }): Promise<MergeQueueExitResult> {
    const { exit } = input;
    const { disposition, recognised } = classifyQueueExit(exit.rawReason);
    const base = {
      event: 'pull_request_dequeued' as const,
      disposition,
      rawReason: exit.rawReason,
    };
    if (!recognised) {
      // Once per delivery, with the raw string — a new spelling is visible, and it
      // moves no card (`neutral`).
      console.warn('[mergeQueueExitService] unrecognised merge-queue removal reason', {
        provider: PROVIDER,
        providerRepoId: exit.providerRepoId,
        number: exit.number,
        rawReason: exit.rawReason,
      });
    }
    if (disposition === 'landed') return { ...base, outcome: 'landed' };
    if (!input.deliveryId) return { ...base, outcome: 'malformed' };
    if (!input.installationId) return { ...base, outcome: 'unknown_installation' };
    const installationId = input.installationId;
    const deliveryId = input.deliveryId;

    // Phase 1 — the connection tier and the tenant, read-only. The WRITE transaction
    // below runs as the workspace owner, the actor the status sync falls back to, so
    // the tenant must be known before it opens.
    const found = await withSystemContext(async (tx): Promise<Resolved | MergeQueueExitOutcome> => {
      const installation = await githubInstallationRepository.findByInstallationId(
        installationId,
        tx,
      );
      if (!installation) return 'unknown_installation';
      const repo = await githubRepoRepository.findByInstallationAndRepoId(
        installation.id,
        exit.providerRepoId,
        tx,
      );
      if (!repo) return 'unknown_repo';
      await bindWorkspaceContext(tx, repo.workspaceId);
      const owner = await workspaceMembershipRepository.findStandInManagerByWorkspace(
        repo.workspaceId,
        tx,
      );
      return { workspaceId: repo.workspaceId, repoId: repo.id, ownerUserId: owner?.userId ?? null };
    });
    if (typeof found === 'string') return { ...base, outcome: found };

    const ctx = found.ownerUserId
      ? { userId: found.ownerUserId, workspaceId: found.workspaceId }
      : null;
    const moved: { id: string; key: string; revisionId: string; from: string; to: string }[] = [];

    const write = async (tx: Prisma.TransactionClient): Promise<MergeQueueExitResult> => {
      const pr = await githubPullRequestRepository.findByRepoAndNumber(
        found.repoId,
        exit.number,
        tx,
      );
      if (!pr) return { ...base, outcome: 'unknown_pull_request' };
      // Serialises two copies of one delivery, and an exit against a merge record
      // being written for the same pull request.
      await githubPullRequestRepository.lockById(pr.id, tx);
      if (await githubPullRequestQueueExitRepository.findByDeliveryId(deliveryId, tx)) {
        return { ...base, outcome: 'duplicate' };
      }

      // A FAILURE names the check that failed, from the pull request's latest queue
      // attempt (MOTIR-5633; decision 8). A neutral removal says nothing about the
      // work, so it names none; a check that completes later is attached by
      // `mergeQueueCheckService.attachFailingCheck`.
      const attempt =
        disposition === 'failure'
          ? await githubMergeQueueAttemptRepository.findLatestByPullRequest(pr.id, tx)
          : null;
      await githubPullRequestQueueExitRepository.create(
        {
          pullRequestId: pr.id,
          deliveryId,
          rawReason: exit.rawReason ?? '',
          disposition,
          headSha: exit.headSha,
          exitedAt: input.now ?? new Date(),
          failingCheckName: attempt?.failingCheckName ?? null,
          failingCheckUrl: attempt?.failingCheckUrl ?? null,
        },
        tx,
      );
      const cleared = (await githubPullRequestRepository.clearQueuedOutcome(pr.id, tx)) > 0;
      // The exit changes the card's `ciState` without any new check arriving
      // (MOTIR-5717): a failure turns every delivered card red — including one the
      // loop below leaves where it is — and a neutral exit can supersede an earlier
      // failure. So every delivered card is recomputed here, in this transaction.
      await recomputeDeliveredCiState(pr.id, tx);
      const result: MergeQueueExitResult = {
        ...base,
        outcome: 'recorded',
        moved: [],
        reasked: [],
        skipped: [],
        clearedQueuedOutcome: cleared,
      };
      // ⚠️ EVERY DISPOSITION BUT `landed` REACHES THE CARDS NOW (§4 FOURTH AMENDMENT,
      // points 1–2; MOTIR-5805). A NEUTRAL removal spends the approval exactly as a
      // failure does — Yue, 2026-09-19: *"re-ask too"* — so it is settled by class like
      // any other. `landed` returned above, before anything was written.
      const landingClass = classOfQueueExit(exit.rawReason);

      for (const ref of await resolveDeliveredWorkItems(pr.id, tx)) {
        if (!ctx) {
          result.skipped!.push({ key: ref.identifier, status: ref.status, reason: 'no_actor' });
          continue;
        }
        // LOCK ORDER — the card's awaiting gates, then the card (ADR §6d amendment,
        // rule 8), exactly as `applyStatusTransition` takes them; then re-read the
        // status under that lock, because the resolve above read it unlocked.
        await lockCard(ref.id, tx);
        const item = await workItemRepository.findById(ref.id, tx);
        if (!item) continue;
        const mode = (await projectRepository.findPrMergeMode(item.projectId, tx))?.prMergeMode;
        const from = mode ? ENQUEUED_STATUS[mode] : null;
        if (item.status !== from) {
          result.skipped!.push({
            key: item.identifier,
            status: item.status,
            reason: 'not_enqueued_status',
          });
          continue;
        }
        if (mode === 'manual') {
          // §4 FOURTH AMENDMENT, points 1–2 (MOTIR-5805): settled by the reason's
          // CLASS — back to review with one fresh question, or held at `implemented`
          // where the commits cannot land. The same entry point the host refusal
          // (MOTIR-5833) and the convergence of stranded cards (MOTIR-5809) call.
          const settled = await settleUnlandedOutcome(item, landingClass, ctx, tx);
          if (settled.transition) {
            moved.push({
              id: item.id,
              key: item.identifier,
              revisionId: settled.transition.revisionId,
              from: settled.transition.fromStatusKey,
              to: settled.transition.toStatusKey,
            });
            result.moved!.push(item.identifier);
          }
          if (settled.raised) result.reasked!.push(item.identifier);
          continue;
        }
        // AUTO mode is unchanged: no gate, no person to ask, and only a FAILURE moves
        // the card (THIRD AMENDMENT, decision 3).
        if (disposition !== 'failure') continue;
        const { transition } = await workItemsService.applyStatusTransition(
          item.id,
          EJECTED_STATUS.auto,
          ctx,
          tx,
          { system: true },
        );
        if (transition) {
          moved.push({
            id: item.id,
            key: item.identifier,
            revisionId: transition.revisionId,
            from: transition.fromStatusKey,
            to: transition.toStatusKey,
          });
          result.moved!.push(item.identifier);
        }
        // `auto` raises nothing: no person decides, and a PUSH re-arms the card.
      }
      return result;
    };

    let result: MergeQueueExitResult;
    try {
      result = ctx
        ? await withWorkspaceContext(ctx, write)
        : await withSystemContext(async (tx) => {
            await bindWorkspaceContext(tx, found.workspaceId);
            return write(tx);
          });
    } catch (err) {
      // Two copies of one delivery racing past the read above: the unique index is
      // the backstop, and the loser recorded nothing.
      if ((err as { code?: string } | null)?.code === 'P2002') {
        return { ...base, outcome: 'duplicate' };
      }
      throw err;
    }

    // Post-commit, never inside the transaction — a rollback must not have notified.
    for (const m of moved) {
      await sendEvent('work-item/transitioned', {
        workspaceId: found.workspaceId,
        workItemId: m.id,
        actorId: ctx!.userId,
        fromStatusKey: m.from,
        toStatusKey: m.to,
        revisionId: m.revisionId,
      });
    }
    return result;
  },
};

/**
 * SETTLE AN UN-LANDED MERGE BY ITS REASON CLASS, in the caller's transaction
 * (`approval-gates.md` §4 FOURTH AMENDMENT, points 1–3; Story MOTIR-5799 · MOTIR-5802 ·
 * MOTIR-5805).
 *
 * ⚠️ THE CLASS IS THE WHOLE OF THE DECISION, and it answers one question: could
 * re-running these SAME commits land them?
 *
 *  · `retryable` / `setting` — YES (a flaky check, a cleared queue, a hand removal, a
 *    setting somebody can change). The card moves to `in_review` as a SYSTEM write —
 *    the status for *CI spoke and a person must decide*, and the only one a fresh
 *    approval can leave for `approved` — and {@link reconcileGatesFor} then raises
 *    exactly ONE awaiting `pull_request_approval` gate over the current set, because
 *    `resolveGateSet` reads the standing outcome as outranking the approval given
 *    before it. A decided design gate is not re-asked; the old merge gate row is never
 *    touched.
 *  · `cant_land` — NO. The commits cannot combine as they stand, so asking would offer
 *    a button guaranteed to fail. The card moves to `implemented`, where `motir fix`
 *    claims it (MOTIR-5803), and the promotion is HELD at that head: no gate is raised
 *    here and none is raised by a green check at the same commits. A PUSH is what ends
 *    the hold, and the next green asks about the new commits (MOTIR-5604's path).
 *  · `landed` — nothing happened that anybody has to answer.
 *
 * ⚠️ THE ONE ENTRY POINT for every source: a live queue exit (`recordExit`), a host
 * refusal at the press (MOTIR-5833) and the operator convergence of cards stranded
 * BEFORE this shipped (`scripts/converge-ejected-cards.ts`; MOTIR-5809). None of them
 * re-implements the move or the raise, which is what keeps one rule in one place.
 *
 * The caller holds the card's lock ({@link lockCard}) and has checked the mode. A card
 * already at the target status is not moved again; the raise is idempotent either way
 * (the reconciler never writes a second awaiting row).
 */
export async function settleUnlandedOutcome(
  item: WorkItem,
  landingClass: LandingClass,
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<{ transition: AppliedMove; raised: boolean }> {
  if (landingClass === 'landed') return { transition: null, raised: false };
  // THE PLAN HOLD (MOTIR-6265; `agent-authored-plans.md` AMENDMENT 21 §5(b)). This
  // move is a SYSTEM write, so the funnel's refusal cannot see it — and it would
  // walk a card an undecided plan is rewriting out of `planning` on the strength of
  // its OLD pull request. Declined here, for every caller at once: nothing moves
  // and nothing is re-asked until the plan is decided.
  if (await readPlanHoldWithin(item, tx)) return { transition: null, raised: false };
  const target = landingClass === 'cant_land' ? UNLANDED_STATUS.cantLand : UNLANDED_STATUS.reask;
  let transition: AppliedMove = null;
  if (item.status !== target) {
    ({ transition } = await workItemsService.applyStatusTransition(item.id, target, ctx, tx, {
      system: true,
    }));
  }
  const fresh = (await workItemRepository.findById(item.id, tx)) ?? item;
  await reconcileGatesFor(fresh, tx);
  // Asked as a FACT rather than read off the reconcile's return: arriving at
  // `in_review` may already have raised the gate through the transition's own
  // reconcile, and either way the answer is whether the card is now asking.
  const raised = (await approvalGateRepository.findAwaitingByWorkItem(item.id, tx)).some(
    (gate) => gate.kind === 'pull_request_approval',
  );
  return { transition, raised };
}

// ── The card moves Queue again makes (MOTIR-5634) ───────────────────────────────
//
// They live HERE, beside the ejection that made them necessary, and not in
// `pullRequestMergeService`: the merge path writes no work-item status
// (`tests/merge-story-guards.test.ts` guard (b)); the merge webhook is the single
// writer of `done`. Returning a card an ejection moved is this story's write
// (`approval-gates.md` §4 THIRD AMENDMENT, decision 5), and the merge service only
// calls it.

type AppliedMove = { fromStatusKey: string; toStatusKey: string; revisionId: string } | null;

/** The card's lock, in the funnel's order: its awaiting gates, then the card (ADR §6d
 *  amendment, rule 8) — `applyStatusTransition` takes the same two, so a press and a
 *  status move never take them in opposite orders. */
async function lockCard(workItemId: string, tx: Prisma.TransactionClient): Promise<void> {
  await approvalGateRepository.lockAwaitingByWorkItem(workItemId, tx);
  await workItemRepository.lockById(workItemId, tx);
}

/**
 * RECOMPUTE the stored `ciState` of every card a pull request delivers (Story
 * MOTIR-5628 · MOTIR-5717).
 *
 * A merge-queue exit folds into the card's verdict (`queueExitHoldsAtHead`), so the
 * three writes that change an exit — recording it, *Queue again*'s stamp, and the
 * release of a stamp the host refused — change the card's badge with no check event
 * to recompute it. Each calls this in its own transaction.
 *
 * Each card is locked in the funnel's order first ({@link lockCard}); the recompute
 * then takes the card's row lock again, which is re-entrant inside one transaction.
 */
async function recomputeDeliveredCiState(
  pullRequestId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  for (const ref of await resolveDeliveredWorkItems(pullRequestId, tx)) {
    await lockCard(ref.id, tx);
    await recomputeWorkItemCiState(ref.id, tx);
  }
}

/**
 * Return a card an `auto`-mode merge-queue failure moved to `implemented` to `in_review`,
 * the status it was moved from, when it is still there (*Queue again* in `auto` mode).
 * ⚠️ `approved` is no longer a target (MOTIR-5802): a manual failure is re-asked on a
 * fresh gate, and nothing writes `implemented → approved`. A card somebody has since moved elsewhere is left where
 * they put it, and a workflow that refuses the move leaves it too — the re-enqueue has
 * happened either way, and the move is secondary to it.
 */
async function returnCard(
  item: { id: string; status: string },
  to: 'in_review',
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
  opts: { decidingGateId?: string },
): Promise<AppliedMove> {
  if (item.status !== 'implemented') return null;
  try {
    const { transition } = await workItemsService.applyStatusTransition(item.id, to, ctx, tx, opts);
    return transition;
  } catch (err) {
    if (err instanceof IllegalTransitionError || err instanceof UnknownStatusError) {
      console.warn('[mergeQueueExitService] Queue again could not return the card', {
        workItemId: item.id,
        to,
        error: err.message,
      });
      return null;
    }
    throw err;
  }
}

async function emitMoved(workItemId: string, moved: AppliedMove, ctx: ServiceContext) {
  if (!moved) return;
  await sendEvent('work-item/transitioned', {
    workspaceId: ctx.workspaceId,
    workItemId,
    actorId: ctx.userId,
    fromStatusKey: moved.fromStatusKey,
    toStatusKey: moved.toStatusKey,
    revisionId: moved.revisionId,
  });
}

export const queueExitCardMoves = { lockCard, returnCard, emitMoved, recomputeDeliveredCiState };
