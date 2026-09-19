import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { githubPullRequestQueueExitRepository } from '@/lib/repositories/githubPullRequestQueueExitRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import { standingQueueFailures } from './deliveryVerdict';
import { queueExitCardMoves, reaskMergeAfterEjection } from './mergeQueueExitService';

// CONVERGE THE CARDS EJECTED BEFORE THE FOURTH AMENDMENT SHIPPED (Story MOTIR-5799 ·
// MOTIR-5809; `docs/decisions/approval-gates.md` §4 FOURTH AMENDMENT, point 7).
//
// Until the re-ask shipped, a `manual` project's FAILURE ejection moved the card to
// `implemented` and raised nothing: *Queue again* reused the old approval. That shortcut
// is retired (MOTIR-5802), so a card ejected BEFORE the deploy would sit at
// `implemented` holding a decided gate and no way back but a push. This sweep puts each
// such card where a live ejection now puts it — `in_review`, with ONE fresh awaiting
// approve-to-merge gate over the same commits.
//
// ⚠️ IT NEVER RE-IMPLEMENTS THE MOVE OR THE RAISE. Every converged card goes through
// `reaskMergeAfterEjection` — the entry point `recordExit` calls for a live ejection —
// so there is no second version of the rule to drift.
//
// THE POPULATION, every clause checked per card under its row lock:
//   · a delivered member's LATEST exit is a FAILURE, not re-queued, at that member's
//     CURRENT head (`standingQueueFailures`, the rule the fold and the hold share);
//   · the project is in `manual` mode;
//   · the card is at `implemented`;
//   · its latest approve-to-merge gate is `approved`.
// A card failing a clause is SKIPPED AND COUNTED by the clause — never silently dropped.
//
// IDEMPOTENT BY CONSTRUCTION: a converged card is at `in_review`, so a second apply
// skips it as `already_in_review` and converges 0. The dry run takes the same path and
// writes nothing. Each card commits in its own transaction.

export type ConvergeSkipReason =
  /** A push moved the member's head: the exit no longer stands, and the next green
   *  re-arms the card on its own, as today. */
  | 'head_moved'
  /** `auto` mode: no person decides, and the card's ejection path is unchanged. */
  | 'auto_mode'
  /** Already where a live ejection leaves it. */
  | 'already_in_review'
  /** Not at `implemented` and not at `in_review` — somebody moved it; a sweep does
   *  not overrule a person. */
  | 'other_status'
  /** No approved merge gate: nobody said yes, so there is nothing to ask again. */
  | 'no_approved_gate'
  /** Archived: a person decided the card should not be worked. */
  | 'archived';

export interface ConvergeReport {
  dryRun: boolean;
  /** Cards delivered by a pull request whose latest exit is a standing failure. */
  scanned: number;
  converged: { workItemId: string; identifier: string }[];
  skipped: { workItemId: string; identifier: string; reason: ConvergeSkipReason }[];
  failed: { workItemId: string; error: string }[];
}

export const ejectedCardConvergenceService = {
  async converge(opts: { dryRun: boolean }): Promise<ConvergeReport> {
    const report: ConvergeReport = {
      dryRun: opts.dryRun,
      scanned: 0,
      converged: [],
      skipped: [],
      failed: [],
    };

    // The candidates — cross-tenant, read once. A pull request counts when its LATEST
    // exit is a standing failure; the head check is per card, below, under its lock.
    const workItemIds = await withSystemContext(async (tx) => {
      const pullRequestIds =
        await githubPullRequestQueueExitRepository.listPullRequestIdsWithStandingFailure(tx);
      const latest = await githubPullRequestQueueExitRepository.findLatestByPullRequests(
        pullRequestIds,
        tx,
      );
      const standing = [...latest.values()]
        .filter((exit) => exit.disposition === 'failure' && exit.requeuedAt === null)
        .map((exit) => exit.pullRequestId);
      const deliveries = await workItemDeliveryRepository.listByPullRequests(standing, tx);
      // The delivery row carries its tenant, which is what lets each card be read under
      // its OWN workspace context below — `work_item` has no system arm to read it by.
      return [
        ...new Map(
          deliveries.map((delivery) => [delivery.workItemId, delivery.workspaceId]),
        ).entries(),
      ];
    });
    report.scanned = workItemIds.length;

    for (const [workItemId, workspaceId] of workItemIds) {
      try {
        const outcome = await withSystemContext(async (tx) => {
          await bindWorkspaceContext(tx, workspaceId);
          await queueExitCardMoves.lockCard(workItemId, tx);
          const item = await workItemRepository.findById(workItemId, tx);
          if (!item) return null;
          const skip = (reason: ConvergeSkipReason) => ({ kind: 'skipped', item, reason }) as const;

          if (item.archivedAt !== null) return skip('archived');
          const mode = (await projectRepository.findPrMergeMode(item.projectId, tx))?.prMergeMode;
          if (mode !== 'manual') return skip('auto_mode');
          if (item.status === 'in_review') return skip('already_in_review');
          if (item.status !== 'implemented') return skip('other_status');

          const deliveries = await workItemDeliveryRepository.listByWorkItemWithChecks(item.id, tx);
          const held = await standingQueueFailures(
            new Map(deliveries.map((d) => [d.githubPullRequestId, d.pullRequest])),
            tx,
          );
          if (held.size === 0) return skip('head_moved');

          const gate = await approvalGateRepository.findLatestByWorkItem(
            item.id,
            'pull_request_approval',
            tx,
          );
          if (gate?.state !== 'approved') return skip('no_approved_gate');

          if (opts.dryRun) return { kind: 'converged', item, move: null } as const;

          // The same actor a live ejection writes as: the workspace owner, the one the
          // status sync falls back to.
          const owner = await workspaceMembershipRepository.findOwnerByWorkspace(
            item.workspaceId,
            tx,
          );
          if (!owner) throw new Error(`workspace ${item.workspaceId} has no owner to write as`);
          const ctx = { userId: owner.userId, workspaceId: item.workspaceId };
          const reask = await reaskMergeAfterEjection(item, ctx, tx);
          if (!reask.raised) {
            // Rolls the move back with it: a card at `in_review` asking nothing is
            // worse than the stranded state it started in.
            throw new Error('the re-ask raised no approve-to-merge gate');
          }
          return { kind: 'converged', item, move: reask.transition, actorId: ctx.userId } as const;
        });
        if (!outcome) continue;
        const ref = { workItemId: outcome.item.id, identifier: outcome.item.identifier };
        if (outcome.kind === 'skipped') {
          report.skipped.push({ ...ref, reason: outcome.reason });
          continue;
        }
        report.converged.push(ref);
        // Post-commit, never inside the transaction — a rollback must not have notified.
        if (outcome.move && 'actorId' in outcome) {
          await sendEvent('work-item/transitioned', {
            workspaceId: outcome.item.workspaceId,
            workItemId: outcome.item.id,
            actorId: outcome.actorId,
            fromStatusKey: outcome.move.fromStatusKey,
            toStatusKey: outcome.move.toStatusKey,
            revisionId: outcome.move.revisionId,
          });
        }
      } catch (err) {
        report.failed.push({
          workItemId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return report;
  },
};
