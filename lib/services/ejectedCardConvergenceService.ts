import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { githubPullRequestQueueExitRepository } from '@/lib/repositories/githubPullRequestQueueExitRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { sendEvent } from '@/lib/jobs/sendEvent';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import { githubPullRequestMergeRefusalRepository } from '@/lib/repositories/githubPullRequestMergeRefusalRepository';
import { liveRowsAtLatestSha } from '@/lib/github/prCiState';
import { queueExitStandsAtHead } from '@/lib/workItems/deliverySet';
import { queueExitCardMoves, settleUnlandedOutcome } from './mergeQueueExitService';
import { classOfMergeRefusal, classOfQueueExit } from '@/lib/mergeQueue/queueExit';
import type { Prisma, WorkItem } from '@/generated/prisma/client';

/**
 * How long an approval must have stood before a press that never landed counts as one
 * that never will (population D). A press is a round trip to a host; ten minutes is far
 * longer than one takes and far shorter than anybody waits before asking why.
 */
const PRESS_GRACE_MS = 10 * 60 * 1000;

/** The code population D writes. No press ever writes it — `classOfMergeRefusal` answers
 *  `retryable` for it exactly as it does for any code this deployment does not know. */
const UNRECORDED_REFUSAL_CODE = 'unrecorded';

/** The same actor a live outcome writes as: the workspace owner, the one the status sync
 *  falls back to. */
async function actorFor(
  item: WorkItem,
  tx: Prisma.TransactionClient,
): Promise<{ userId: string; workspaceId: string }> {
  const owner = await workspaceMembershipRepository.findStandInManagerByWorkspace(
    item.workspaceId,
    tx,
  );
  if (!owner) throw new Error(`workspace ${item.workspaceId} has no owner to write as`);
  return { userId: owner.userId, workspaceId: item.workspaceId };
}

// CONVERGE THE CARDS LEFT STRANDED BEFORE THE FOURTH AMENDMENT SHIPPED (Story
// MOTIR-5799 · MOTIR-5809; `docs/decisions/approval-gates.md` §4 FOURTH AMENDMENT,
// point 9).
//
// One approval authorizes ONE merge or enqueue action. Until that shipped, a card whose
// merge did not land kept its approval and was offered a button that reused it. Those
// buttons are gone, so every card the old rules left holding a spent approval has to be
// put where the new rules would have put it — otherwise it sits with nothing to press
// and nothing to say.
//
// ⚠️ IT NEVER RE-IMPLEMENTS THE MOVE OR THE RAISE. Every converged card goes through
// `settleUnlandedOutcome` — the entry point a live queue exit and a live host refusal
// both call — so there is no second version of the rule to drift.
//
// THE FOUR POPULATIONS, each checked per card under its row lock:
//
//   A. `implemented` with a standing RETRYABLE or SETTING exit at a member's current
//      head → `in_review` plus ONE fresh gate.
//   B. `implemented` with a standing CAN'T-LAND exit (a conflict) → ALREADY where the
//      new rules put it. Counted and left alone.
//   C. `approved` with a standing NEUTRAL exit at a member's head → the removal spent
//      the approval, so the card is asked again.
//   D. `approved` holding an un-landed member with NO outcome at all, under an approval
//      decided more than ten minutes ago → a host refusal the press never recorded
//      (the record is MOTIR-5833's, and it did not exist then). A refusal row is written
//      with the backfill-only code `unrecorded`, classed RETRYABLE, and the card is
//      asked again. RETRYABLE is the safe default: a person is asked, and can still
//      reach for `motir fix` from the page.
//
// A card failing a clause is SKIPPED AND COUNTED by the clause — never silently dropped.
//
// IDEMPOTENT BY CONSTRUCTION: a converged card is at `in_review`, so a second apply
// skips it as `already_in_review` and converges 0; population D writes its refusal row
// only for a member with no outcome, and the row it writes IS an outcome. The dry run
// takes the same path and writes nothing. Each card commits in its own transaction.

export type ConvergeSkipReason =
  /** A push moved the member's head: the outcome no longer stands, and the next green
   *  re-arms the card on its own, as today. */
  | 'head_moved'
  /** `auto` mode: no person decides, and the card's ejection path is unchanged. */
  | 'auto_mode'
  /** Already where a live outcome leaves it. */
  | 'already_in_review'
  /** Population B: a CAN'T-LAND outcome holds the card at `implemented`, which is
   *  exactly where the new rules put it. Counted, never moved. */
  | 'cant_land_held'
  /** Not at `implemented` and not at `approved` — somebody moved it; a sweep does not
   *  overrule a person. */
  | 'other_status'
  /** No approved merge gate: nobody said yes, so there is nothing to ask again. */
  | 'no_approved_gate'
  /** An `approved` card whose members are all landed, queued or already carrying an
   *  outcome — nothing was stranded. */
  | 'nothing_stranded'
  /** An `approved` card whose approval is younger than the grace window: a press may
   *  still be in flight, and a sweep must not race it. */
  | 'too_recent'
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

    // The candidates — cross-tenant, read once, from BOTH ends:
    //   · every pull request whose latest exit still stands, of any disposition
    //     (populations A, B and C — a neutral removal strands a card exactly as a
    //     failure does, which is the half the first cut could not see);
    //   · every card holding an APPROVED merge gate older than the grace window
    //     (population D — a press whose refusal nobody recorded).
    // The delivery row carries its tenant, which is what lets each card be read under
    // its OWN workspace context below: `work_item` has no system arm to read it by.
    const workItemIds = await withSystemContext(async (tx) => {
      const pullRequestIds =
        await githubPullRequestQueueExitRepository.listPullRequestIdsWithStandingExit(tx);
      const latest = await githubPullRequestQueueExitRepository.findLatestByPullRequests(
        pullRequestIds,
        tx,
      );
      const standing = [...latest.values()]
        .filter((exit) => exit.requeuedAt === null)
        .map((exit) => exit.pullRequestId);
      const deliveries = await workItemDeliveryRepository.listByPullRequests(standing, tx);
      const candidates = new Map<string, string>(
        deliveries.map((delivery) => [delivery.workItemId, delivery.workspaceId]),
      );

      // ⚠️ THE SECOND SCAN IS FROM THE PULL-REQUEST SIDE, NOT THE GATE'S. `approval_gate`
      // carries no `system_admin` arm, so a cross-tenant read of it returns NOTHING —
      // the candidate has to be found by something armed, and `github_pull_request` is.
      // An open member Motir never merged or queued is the shape a lost refusal leaves;
      // whether its card holds an old approval is asked below, under that card's own
      // workspace.
      const unacted = await githubPullRequestRepository.listOpenWithNoMergeOutcome(tx);
      for (const delivery of await workItemDeliveryRepository.listByPullRequests(unacted, tx)) {
        if (!candidates.has(delivery.workItemId)) {
          candidates.set(delivery.workItemId, delivery.workspaceId);
        }
      }
      return [...candidates.entries()];
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
          if (item.status !== 'implemented' && item.status !== 'approved') {
            return skip('other_status');
          }

          const gate = await approvalGateRepository.findLatestByWorkItem(
            item.id,
            'pull_request_approval',
            tx,
          );
          if (gate?.state !== 'approved' || !gate.decidedAt) return skip('no_approved_gate');

          const deliveries = await workItemDeliveryRepository.listByWorkItemWithChecks(item.id, tx);
          const latestExits = await githubPullRequestQueueExitRepository.findLatestByPullRequests(
            deliveries.map((d) => d.githubPullRequestId),
            tx,
          );
          const latestRefusals =
            await githubPullRequestMergeRefusalRepository.findLatestByPullRequests(
              deliveries.map((d) => d.githubPullRequestId),
              tx,
            );

          // The STANDING outcome, if there is one — the rule `deliverySet.ts` owns, read
          // over every disposition (populations A, B and C).
          const standing = deliveries.flatMap((d) => {
            const head = liveRowsAtLatestSha([...d.pullRequest.checkRuns])[0]?.commitSha;
            const exit = latestExits.get(d.githubPullRequestId);
            return queueExitStandsAtHead(exit, head)
              ? [{ exit: exit!, landingClass: classOfQueueExit(exit!.rawReason) }]
              : [];
          });

          if (standing.length > 0) {
            const landingClass = standing[0]!.landingClass;
            // POPULATION B: a conflict already holds the card at `implemented`, which is
            // where the new rules put it. Nothing to do, and saying so is the point.
            if (landingClass === 'cant_land' && item.status === 'implemented') {
              return skip('cant_land_held');
            }
            if (opts.dryRun) return { kind: 'converged', item, move: null } as const;
            const ctx = await actorFor(item, tx);
            const settled = await settleUnlandedOutcome(item, landingClass, ctx, tx);
            if (landingClass !== 'cant_land' && !settled.raised) {
              // Rolls the move back with it: a card at `in_review` asking nothing is
              // worse than the stranded state it started in.
              throw new Error('the re-ask raised no approve-to-merge gate');
            }
            return {
              kind: 'converged',
              item,
              move: settled.transition,
              actorId: ctx.userId,
            } as const;
          }

          // POPULATION D — an `approved` card holding a member that never landed and
          // carries NO outcome at all. Before MOTIR-5833 a host refusal wrote nothing, so
          // this is what one looks like from here: approved a while ago, open, unmerged,
          // never queued, and nothing on the pull request saying why.
          if (item.status !== 'approved') return skip('head_moved');
          if (gate.decidedAt.getTime() > Date.now() - PRESS_GRACE_MS) return skip('too_recent');
          const stranded = deliveries.filter((d) => {
            const pr = d.pullRequest;
            if (pr.state !== 'open' || pr.merged) return false;
            if (pr.mergeOutcomeRef !== null) return false;
            const head = liveRowsAtLatestSha([...pr.checkRuns])[0]?.commitSha;
            if (!head) return false;
            const refusal = latestRefusals.get(d.githubPullRequestId);
            return !refusal || refusal.supersededAt !== null || refusal.headSha !== head;
          });
          if (stranded.length === 0) return skip('nothing_stranded');
          if (opts.dryRun) return { kind: 'converged', item, move: null } as const;

          const ctx = await actorFor(item, tx);
          for (const delivery of stranded) {
            const head = liveRowsAtLatestSha([...delivery.pullRequest.checkRuns])[0]!.commitSha;
            await githubPullRequestMergeRefusalRepository.create(
              {
                pullRequestId: delivery.githubPullRequestId,
                // ⚠️ A BACKFILL-ONLY CODE. No press writes it; it exists so a refusal
                // nobody recorded still becomes a FACT the page can read back, and the
                // class map answers `retryable` for it as for any code it does not know.
                code: UNRECORDED_REFUSAL_CODE,
                headSha: head,
                approvalGateId: gate.id,
                refusedAt: gate.decidedAt!,
              },
              tx,
            );
          }
          const settled = await settleUnlandedOutcome(
            item,
            classOfMergeRefusal(UNRECORDED_REFUSAL_CODE) ?? 'retryable',
            ctx,
            tx,
          );
          if (!settled.raised) throw new Error('the re-ask raised no approve-to-merge gate');
          return {
            kind: 'converged',
            item,
            move: settled.transition,
            actorId: ctx.userId,
          } as const;
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
