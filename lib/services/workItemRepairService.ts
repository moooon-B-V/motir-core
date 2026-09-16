import { derivePrCiState } from '@/lib/github/prCiState';
import type {
  RepairPullRequestDto,
  WorkItemRepairClaimDto,
  WorkItemRepairRefusal,
} from '@/lib/dto/workItemRepair';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { resolveRunTargetFor } from '@/lib/services/runTarget';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { RUNG_RANK, rankOfStatus } from '@/lib/workItems/statusLadder';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// THE REPAIR CLAIM (Story MOTIR-5460 · MOTIR-5464) — hand an `implemented` card's
// red pull requests to ONE fixing agent, after the run that opened them has ended.
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
// ── Why one transaction under the CARD's lock ───────────────────────────────
// The lock read is "is an open `fix` run holding this card?", and it guards the
// insert of exactly that run. Both claimants lock the card's row first, so the
// second one waits for the first one's COMMIT and then reads the run it wrote —
// which is what lets `taken` name the holder, and what keeps it to ONE run.
// `lockById` filters on `id` alone, for the reason `claimWorkItem` records.

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
    pullRequests: [],
  };
}

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
    const keyOf = (key: string) => statuses.find((s) => s.key === key)?.key ?? null;
    const ladderKeys = {
      reviewKey: keyOf('in_review'),
      implementedKey: keyOf('implemented'),
      approvedKey: keyOf('approved'),
    };

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      async (tx) => {
        await workItemRepository.lockById(item.id, tx);
        const state = await workItemRepository.findClaimStateById(item.id, tx);
        /* v8 ignore next -- the row was resolved above; only a delete between the two reads gets here */
        if (!state) throw new WorkItemNotFoundError(identifier);

        if (
          state.archivedAt !== null ||
          rankOfStatus(state.status, statuses, ladderKeys) !== RUNG_RANK.implemented
        ) {
          return refused(item, 'not_implemented');
        }

        // The repair runs where the run that delivered the pull requests was
        // launched. The resolution is `runTarget.ts`'s, shared with How to test
        // and the approve-to-merge gate — one answer to "which card is this run
        // about", never a copy.
        const target = await resolveRunTargetFor({ id: item.id, workspaceId: ctx.workspaceId }, tx);
        if (target.kind === 'ancestor') {
          return refused(item, 'repair_on_run_target', target.holder.identifier);
        }

        const deliveries = await workItemDeliveryRepository.listByWorkItemWithChecks(item.id, tx);
        if (deliveries.length === 0) return refused(item, 'no_pull_requests');

        // The verdict is `derivePrCiState` — the one the Development pill and
        // `ciPromotion` read — per member. Only an OPEN member can be repaired: a
        // push cannot change a merged or closed pull request, so its colour says
        // nothing about what an agent could do.
        const open = deliveries
          .filter((d) => d.pullRequest.state === 'open' && !d.pullRequest.merged)
          .map((d) => ({ row: d, ci: derivePrCiState(d.pullRequest.checkRuns) }));
        const failing = open.filter((m) => m.ci === 'failing');
        if (failing.length === 0) {
          return refused(item, open.some((m) => m.ci === 'running') ? 'ci_running' : 'not_failing');
        }
        const pullRequests: RepairPullRequestDto[] = failing.map(({ row, ci }) => ({
          repo: `${row.repo.owner}/${row.repo.name}`,
          number: row.pullRequest.number,
          url: `https://github.com/${row.repo.owner}/${row.repo.name}/pull/${row.pullRequest.number}`,
          headRef: row.pullRequest.headRef,
          baseRef: row.pullRequest.baseRef,
          ci,
        }));

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
            // The holder is handed the branches again; a rival is handed nothing.
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
          pullRequests,
        };
      },
    );
  },
};
