import type {
  RepairPullRequestDto,
  WorkItemRepairClaimDto,
  WorkItemRepairRefusal,
  WorkItemRepairViewDto,
} from '@/lib/dto/workItemRepair';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { evaluateRepair } from '@/lib/services/repairPredicate';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { dispatchRunEventRepository } from '@/lib/repositories/dispatchRunEventRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// THE REPAIR CLAIM (Story MOTIR-5460 · MOTIR-5464) — hand an `implemented` card's
// red pull requests to ONE fixing agent, after the run that opened them has ended.
// Since MOTIR-5803 it also takes an `in_review` card the merge queue EJECTED (a
// standing failure exit at a member's head), where a manual ejection now leaves it.
//
// ── Why the keyed claim cannot do it ────────────────────────────────────────
// `workItemsService.claimWorkItem` admits the to-do category (or the caller's own
// `in_progress`) and FLIPS the card to `in_progress`. An `implemented` card is
// `not_claimable` there, and moving it would say the work was never finished —
// which contradicts `packages/cli/src/ciWatch.ts`'s rule that red CI leaves a card
// at `implemented`. So a repair is recorded as a dispatch RUN (command `fix`), and
// the run's open state is the lock. Nothing here writes the card's status or its
// assignee; `ciPromotion` moves the card when the build goes green.
//
// ── An acceptance sent back with Re-run is a repair too (MOTIR-6502) ────────
// A story run whose acceptance video was refused with **Re-run** has GREEN checks and
// is admitted as the `acceptance_rerun` class (`acceptance-refusal-verdict.md` §4):
// every open member is handed over with the reviewer's reason, and the class ends when
// a newer receipt asks again (`lib/approvalGates/acceptanceRefusal.ts`).
//
// ── Why one transaction under the CARD's lock ───────────────────────────────
// The lock read is "is an open `fix` run holding this card?", and it guards the
// insert of exactly that run. Both claimants lock the card's row first, so the
// second one waits for the first one's COMMIT and then reads the run it wrote —
// which is what lets `taken` name the holder, and what keeps it to ONE run.
// `lockById` filters on `id` alone, for the reason `claimWorkItem` records.
//
// ── The PREDICATE is `repairPredicate.evaluateRepair` ───────────────────────
// Both methods below decide through it, and so does the stored `WorkItem.fixReason`
// (MOTIR-6600) — three readers, one rule, which is why it is not in this file.

/** A refusal: no run, no pull requests, only the reason. */
function refused(
  item: { identifier: string; title: string },
  reason: WorkItemRepairRefusal,
  runTargetKey: string | null = null,
): WorkItemRepairClaimDto {
  return {
    key: item.identifier,
    title: item.title,
    outcome: 'not_repairable',
    reason,
    runTargetKey,
    runId: null,
    holder: null,
    startedAt: null,
    repairClass: 'ci',
    acceptanceRefusal: null,
    pullRequests: [],
  };
}

/** The `attempts` a `ci_gave_up` event carries, or null when it carries none. */
function attemptsOf(data: unknown): number | null {
  if (data === null || typeof data !== 'object') return null;
  const attempts = (data as { attempts?: unknown }).attempts;
  return typeof attempts === 'number' && Number.isInteger(attempts) ? attempts : null;
}

const refOf = (pr: RepairPullRequestDto) => ({
  repo: pr.repo,
  number: pr.number,
  ci: pr.ci,
  queueExit:
    pr.queueExit === null
      ? null
      : { rawReason: pr.queueExit.rawReason, failingCheckName: pr.queueExit.failingCheckName },
  conflict: pr.conflicted ? { baseRef: pr.baseRef } : null,
});

export const workItemRepairService = {
  /**
   * CLAIM the repair of one `implemented` card's failing pull requests.
   *
   * The decision order is the contract (the card's table), and each step reads
   * only what the steps before it left standing: archived / not implemented →
   * not the run target → no pull requests → nothing failing → somebody holds it →
   * open the run.
   */
  async claimRepair(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
  ): Promise<WorkItemRepairClaimDto> {
    // Tenancy + browse, with the 404-not-403 answer for a foreign key — the same
    // read every keyed operation opens with.
    const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);

    // The CI-credit gate, BEFORE the transaction, as the keyed claim runs it: a
    // refused dispatch takes no lock and opens no run.
    await ciAllowanceService.assertDispatchAllowed(ctx);

    // ⚠️ THE EDIT GATE IS UP FRONT, where the keyed claim asserts it only on its
    // write arm. That claim's refusal is a read a browse-only caller may make;
    // this operation exists to START WORK on the card, so a caller who may not
    // edit the project has no answer here worth giving.
    await projectAccessService.assertCanEdit(projectId, ctx);

    // The project's statuses depend only on its workflow — read once, outside the
    // lock. The Implemented rung is resolved by KEY PRESENCE, as the approval-gate
    // guard in `applyStatusTransition` resolves it: a workflow with no status
    // keyed `implemented` has nothing at that rung, so nothing there is repairable.
    const statuses = await workflowsService.listStatusesByProject(projectId, ctx.workspaceId);

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      async (tx) => {
        await workItemRepository.lockById(item.id, tx);
        const state = await workItemRepository.findClaimStateById(item.id, tx);
        /* v8 ignore next -- the row was resolved above; only a delete between the two reads gets here */
        if (!state) throw new WorkItemNotFoundError(identifier);

        const verdict = await evaluateRepair(
          { id: item.id, status: state.status, archivedAt: state.archivedAt },
          statuses,
          ctx,
          tx,
        );
        if (!verdict.ok) return refused(item, verdict.reason, verdict.runTargetKey);
        const pullRequests = verdict.pullRequests;
        const { repairClass, acceptanceRefusal } = verdict;

        const held = await dispatchRunRepository.findRunningByCommandForWorkItem(
          item.id,
          'fix',
          tx,
        );
        if (held) {
          const mine = held.createdById === ctx.userId;
          return {
            key: item.identifier,
            title: item.title,
            outcome: mine ? 'mine' : 'taken',
            reason: null,
            runTargetKey: null,
            runId: held.id,
            holder: held.createdBy,
            startedAt: held.startedAt.toISOString(),
            repairClass,
            // The holder is handed the reason and the branches again; a rival nothing.
            acceptanceRefusal: mine ? acceptanceRefusal : null,
            pullRequests: mine ? pullRequests : [],
          };
        }

        await dispatchRunService.openWithin(
          projectId,
          { command: 'fix', cards: [{ key: item.identifier, disposition: 'queued' }] },
          ctx,
          tx,
        );
        // Read back through the SAME lock read, so `claimed` names its holder
        // exactly as a later `taken` will — one projection, not two.
        const opened = await dispatchRunRepository.findRunningByCommandForWorkItem(
          item.id,
          'fix',
          tx,
        );
        /* v8 ignore next -- the run was just written inside this transaction */
        if (!opened) throw new WorkItemNotFoundError(identifier);
        return {
          key: item.identifier,
          title: item.title,
          outcome: 'claimed',
          reason: null,
          runTargetKey: null,
          runId: opened.id,
          holder: opened.createdBy,
          startedAt: opened.startedAt.toISOString(),
          repairClass,
          acceptanceRefusal,
          pullRequests,
        };
      },
    );
  },

  /**
   * What the item page's Development block draws about a repair (MOTIR-5466) —
   * the claim's own evaluation, WITHOUT a lock and without opening anything, plus
   * the card's latest `fix` run.
   *
   * A read a browse-only viewer may make: it names who is fixing the card and
   * offers a command, and the command itself is what asks for edit.
   */
  async getRepairView(workItemId: string, ctx: ServiceContext): Promise<WorkItemRepairViewDto> {
    const item = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => workItemRepository.findById(workItemId, tx),
    );
    if (!item) throw new WorkItemNotFoundError(workItemId);
    await projectAccessService.assertCanBrowse(item.projectId, ctx);
    const statuses = await workflowsService.listStatusesByProject(item.projectId, ctx.workspaceId);

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: item.projectId },
      async (tx): Promise<WorkItemRepairViewDto> => {
        const verdict = await evaluateRepair(item, statuses, ctx, tx);
        if (!verdict.ok) {
          // A child is pointed at its run target only when it has something red
          // of its own to point about; every other refusal is state 5.
          return verdict.reason === 'repair_on_run_target' && verdict.failing.length > 0
            ? {
                state: 'pointer',
                failing: verdict.failing.map(refOf),
                runTargetKey: verdict.runTargetKey as string,
              }
            : { state: 'hidden' };
        }
        const failing = verdict.pullRequests.map(refOf);
        const { repairClass, acceptanceRefusal } = verdict;

        const latest = await dispatchRunRepository.findLatestByCommandForWorkItem(
          item.id,
          'fix',
          tx,
        );
        if (latest?.status === 'running') {
          return {
            state: 'in_progress',
            repairClass,
            acceptanceRefusal,
            failing,
            holder: latest.createdBy,
            byViewer: latest.createdById === ctx.userId,
            startedAt: latest.startedAt.toISOString(),
          };
        }
        // Only a run that FAILED gave up. A stopped (cancelled) or reaped repair
        // draws F1 with no history line — nothing is running and nothing gave up.
        if (latest?.status === 'failed') {
          const event = await dispatchRunEventRepository.findLatestOfKind(
            latest.id,
            'ci_gave_up',
            tx,
          );
          return {
            state: 'offer',
            repairClass,
            acceptanceRefusal,
            failing,
            lastGaveUp: {
              attempts: attemptsOf(event?.data ?? null),
              endedAt: (latest.endedAt ?? latest.startedAt).toISOString(),
            },
          };
        }
        return { state: 'offer', repairClass, acceptanceRefusal, failing, lastGaveUp: null };
      },
    );
  },
};
