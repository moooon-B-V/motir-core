import type { Prisma } from '@/generated/prisma/client';
import type { GitProviderId, NormalizedMergeQueueExit } from '@/lib/git/types';
import { classifyQueueExit } from '@/lib/mergeQueue/queueExit';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
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
import { workItemsService } from './workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { IllegalTransitionError, UnknownStatusError } from '@/lib/workItems/errors';

// A MERGE QUEUE REMOVED A PULL REQUEST (Story MOTIR-5461 · MOTIR-5632).
//
// `docs/decisions/approval-gates.md` §4 THIRD AMENDMENT, decisions 1–4 and 9. The
// queue tested the pull request together with everything ahead of it and took it
// out. Motir records that on the PULL REQUEST, stops saying it is queued, and — when
// the reason is a FAILURE — moves every card it delivers back to `implemented`:
// committed code whose build (the queue's merge commit) has not passed.
//
// What it deliberately leaves alone:
//   * the card's DECIDED `pull_request_approval` gate — a decided gate is a record,
//     and while the heads are unchanged it still describes the code (decision 5);
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
const IMPLEMENTED = 'implemented';

/** Where an enqueued card sits, per merge mode — and so the one status a failure
 *  moves it FROM. `manual`: a person approved it. `auto`: nobody decides, so CI's
 *  promotion is the last move before the merge. */
const ENQUEUED_STATUS = { manual: 'approved', auto: 'in_review' } as const;

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
  /** Keys of the cards moved to `implemented`. */
  moved?: string[];
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
      const owner = await workspaceMembershipRepository.findOwnerByWorkspace(repo.workspaceId, tx);
      return { workspaceId: repo.workspaceId, repoId: repo.id, ownerUserId: owner?.userId ?? null };
    });
    if (typeof found === 'string') return { ...base, outcome: found };

    const ctx = found.ownerUserId
      ? { userId: found.ownerUserId, workspaceId: found.workspaceId }
      : null;
    const moved: { id: string; key: string; revisionId: string; from: string }[] = [];

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

      await githubPullRequestQueueExitRepository.create(
        {
          pullRequestId: pr.id,
          deliveryId,
          rawReason: exit.rawReason ?? '',
          disposition,
          headSha: exit.headSha,
          exitedAt: input.now ?? new Date(),
        },
        tx,
      );
      const cleared = (await githubPullRequestRepository.clearQueuedOutcome(pr.id, tx)) > 0;
      const result: MergeQueueExitResult = {
        ...base,
        outcome: 'recorded',
        moved: [],
        skipped: [],
        clearedQueuedOutcome: cleared,
      };
      if (disposition !== 'failure') return result;

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
        const { transition } = await workItemsService.applyStatusTransition(
          item.id,
          IMPLEMENTED,
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
          });
          result.moved!.push(item.identifier);
        }
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
        toStatusKey: IMPLEMENTED,
        revisionId: m.revisionId,
      });
    }
    return result;
  },
};

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
 * Return a card a merge-queue failure moved to `implemented` to the status it was moved
 * from, when it is still there. A card somebody has since moved elsewhere is left where
 * they put it, and a workflow that refuses the move leaves it too — the re-enqueue has
 * happened either way, and the move is secondary to it.
 */
async function returnCard(
  item: { id: string; status: string },
  to: 'approved' | 'in_review',
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

export const queueExitCardMoves = { lockCard, returnCard, emitMoved };
