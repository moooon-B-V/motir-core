import { derivePrCiState, liveRowsAtLatestSha } from '@/lib/github/prCiState';
import type { GithubCheckRun, GithubPullRequestQueueExit, Prisma } from '@/generated/prisma/client';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type {
  RepairPullRequestDto,
  WorkItemRepairClaimDto,
  WorkItemRepairRefusal,
  WorkItemRepairViewDto,
} from '@/lib/dto/workItemRepair';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { resolveRunTargetFor } from '@/lib/services/runTarget';
import { classOfQueueExit } from '@/lib/mergeQueue/queueExit';
import { queueExitStandsAtHead } from '@/lib/workItems/deliverySet';
import { githubPullRequestQueueExitRepository } from '@/lib/repositories/githubPullRequestQueueExitRepository';
import { standingQueueFailures } from '@/lib/services/deliveryVerdict';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { RUNG_RANK, rankOfStatus } from '@/lib/workItems/statusLadder';
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

type Evaluation =
  | { ok: true; pullRequests: RepairPullRequestDto[] }
  | {
      ok: false;
      reason: WorkItemRepairRefusal;
      runTargetKey: string | null;
      /** The card's own failing open pull requests — what a child's pointer names. */
      failing: RepairPullRequestDto[];
    };

/** The Implemented rung's key set, resolved by KEY PRESENCE (see `claimRepair`). */
function ladderKeysOf(statuses: readonly WorkflowStatusDto[]) {
  const keyOf = (key: string) => statuses.find((s) => s.key === key)?.key ?? null;
  return {
    reviewKey: keyOf('in_review'),
    implementedKey: keyOf('implemented'),
    approvedKey: keyOf('approved'),
  };
}

/**
 * Every member's latest merge-queue exit that still STANDS at its current head, of any
 * disposition (MOTIR-5803). `standingQueueFailures` answers the narrower question the
 * promotion hold asks — a FAILURE holding the card — and the repair claim needs the
 * wider one, because a neutral removal is a real outcome to refuse rather than an
 * absence to report as *nothing is failing*.
 */
async function standingExitsAtHead(
  openRows: ReadonlyArray<{ pullRequest: { id: string; checkRuns: readonly GithubCheckRun[] } }>,
  tx: Prisma.TransactionClient,
): Promise<GithubPullRequestQueueExit[]> {
  const exits = await githubPullRequestQueueExitRepository.findLatestByPullRequests(
    openRows.map((row) => row.pullRequest.id),
    tx,
  );
  const standing: GithubPullRequestQueueExit[] = [];
  for (const row of openRows) {
    const exit = exits.get(row.pullRequest.id);
    const head = liveRowsAtLatestSha([...row.pullRequest.checkRuns])[0]?.commitSha;
    // The RULE is `deliverySet.ts`'s, never re-derived here — the promotion hold reads
    // its narrower twin, and the two must not drift.
    if (queueExitStandsAtHead(exit, head)) standing.push(exit!);
  }
  return standing;
}

/**
 * COULD A CODE CHANGE ANSWER THIS OUTCOME? (§4 FOURTH AMENDMENT, point 6; MOTIR-5803.)
 *
 * `motir fix` hands the pull request to an agent that changes code and pushes, so the
 * question is not whether the merge failed but whether the CODE is a plausible cause:
 *
 *  · a queue FAILURE whose class is `retryable` — the checks failed or timed out, the
 *    merge commit or tree could not be built: yes, the code may be at fault;
 *  · `cant_land` — a conflict: the code MUST change, and this is the only way forward;
 *  · `setting` (branch protection, a missing app permission) and every NEUTRAL removal
 *    (`MANUAL`, `QUEUE_CLEARED`, `ROLL_BACK`, an unmapped reason): no. Nothing in the
 *    repository is wrong, and a person is what is needed.
 */
function repairableOutcome(exit: { rawReason: string; disposition: string }): boolean {
  const landingClass = classOfQueueExit(exit.rawReason);
  if (landingClass === 'cant_land') return true;
  return landingClass === 'retryable' && exit.disposition === 'failure';
}

/**
 * THE PREDICATE — whether a card can be repaired, and with what. ONE function,
 * read by the claim (under its row lock) and by the Development block (without
 * one), so the page never offers a command the claim would refuse
 * (design § 21: *"the part and the claim read one predicate"*).
 *
 * The REFUSAL order is the claim's contract: not implemented → not the run target
 * → no pull requests → nothing failing. The deliveries are read before the run
 * target is resolved only because the child pointer names the child's own failing
 * rows; the reason returned is unchanged by that.
 */
async function evaluate(
  item: { id: string; status: string; archivedAt: Date | null },
  statuses: readonly WorkflowStatusDto[],
  ctx: ServiceContext,
  tx: Prisma.TransactionClient,
): Promise<Evaluation> {
  const rank = rankOfStatus(item.status, statuses, ladderKeysOf(statuses));
  // ⚠️ IN REVIEW IS ADMITTED TOO — but only for a card the merge queue threw out for a
  // reason a CODE CHANGE could fix (MOTIR-5803; `approval-gates.md` §4 FOURTH AMENDMENT,
  // point 6). A retryable or setting-blocked outcome returns the card to In Review with a
  // fresh approve-to-merge gate, and `motir fix` is the answer only where the code may be
  // at fault. An ordinary In Review card is waiting on a person, not on a repair, so it is
  // refused below as `not_failing`.
  const inReview = rank === RUNG_RANK.in_review;
  if (item.archivedAt !== null || (rank !== RUNG_RANK.implemented && !inReview)) {
    return { ok: false, reason: 'not_implemented', runTargetKey: null, failing: [] };
  }

  // The verdict is `derivePrCiState` — the one the Development pill and
  // `ciPromotion` read — per member. Only an OPEN member can be repaired: a push
  // cannot change a merged or closed pull request, so its colour says nothing
  // about what an agent could do.
  const deliveries = await workItemDeliveryRepository.listByWorkItemWithChecks(item.id, tx);
  const openRows = deliveries.filter(
    (d) => d.pullRequest.state === 'open' && !d.pullRequest.merged,
  );
  // ⚠️ A STANDING MERGE-QUEUE FAILURE IS A FAILING MEMBER (MOTIR-5719). The queue
  // ejected the pull request on its merge group, so its own checks are usually
  // green — and a repair it needs (a conflict above all) was refused `not_failing`.
  // The rule is the fold's and the promotion hold's (`queueExitHoldsAtHead`, read
  // through `standingQueueFailures`), never re-derived here.
  const queueHeld = await standingQueueFailures(
    new Map(openRows.map((d) => [d.pullRequest.id, d.pullRequest])),
    tx,
  );
  // In Review: the ONLY admission is a standing outcome at a member's current head whose
  // reason a CODE CHANGE could answer. The read is of EVERY disposition, not just the
  // failures `standingQueueFailures` holds the promotion on, because the two refusals
  // differ and a person deserves the true one: no outcome at all is `not_failing`, and an
  // outcome no agent can act on is `repair_not_code`.
  if (inReview) {
    const standing = await standingExitsAtHead(openRows, tx);
    if (standing.length === 0) {
      return { ok: false, reason: 'not_failing', runTargetKey: null, failing: [] };
    }
    // ⚠️ A REASON NO CODE CHANGE FIXES IS REFUSED BY NAME (point 6). `motir fix` sends an
    // agent to change code: against branch protection, a missing app permission or a hand
    // removal from the queue it has nothing to change, and the run would be spent finding
    // nothing. What helps there is a person — approving again, or changing the setting —
    // and the refusal says so.
    if (!standing.some(repairableOutcome)) {
      return { ok: false, reason: 'repair_not_code', runTargetKey: null, failing: [] };
    }
  }
  const open = openRows.map((d) => ({
    row: d,
    ci: derivePrCiState(d.pullRequest.checkRuns),
    exit: queueHeld.get(d.pullRequest.id) ?? null,
  }));
  const failing: RepairPullRequestDto[] = open
    .filter((m) => m.ci === 'failing' || m.exit !== null)
    .map(({ row, ci, exit }) => ({
      repo: `${row.repo.owner}/${row.repo.name}`,
      number: row.pullRequest.number,
      url: `https://github.com/${row.repo.owner}/${row.repo.name}/pull/${row.pullRequest.number}`,
      headRef: row.pullRequest.headRef,
      baseRef: row.pullRequest.baseRef,
      ci,
      // The names behind the verdict, from the SAME window `derivePrCiState`
      // judged — so a give-up can say which check is still red.
      failingChecks: [
        ...new Set(
          liveRowsAtLatestSha(row.pullRequest.checkRuns)
            .filter((c) => c.conclusion === 'failure')
            .map((c) => c.checkName),
        ),
      ].sort(),
      queueExit:
        exit === null
          ? null
          : {
              rawReason: exit.rawReason,
              exitedAt: exit.exitedAt.toISOString(),
              headSha: exit.headSha,
              failingCheckName: exit.failingCheckName,
              failingCheckUrl: exit.failingCheckUrl,
            },
    }));

  // The repair runs where the run that delivered the pull requests was launched.
  // The resolution is `runTarget.ts`'s, shared with How to test and the
  // approve-to-merge gate — one answer to "which card is this run about".
  const target = await resolveRunTargetFor({ id: item.id, workspaceId: ctx.workspaceId }, tx);
  if (target.kind === 'ancestor') {
    return {
      ok: false,
      reason: 'repair_on_run_target',
      runTargetKey: target.holder.identifier,
      failing,
    };
  }
  if (deliveries.length === 0) {
    return { ok: false, reason: 'no_pull_requests', runTargetKey: null, failing };
  }
  if (failing.length === 0) {
    return {
      ok: false,
      reason: open.some((m) => m.ci === 'running') ? 'ci_running' : 'not_failing',
      runTargetKey: null,
      failing,
    };
  }
  return { ok: true, pullRequests: failing };
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

        const verdict = await evaluate(
          { id: item.id, status: state.status, archivedAt: state.archivedAt },
          statuses,
          ctx,
          tx,
        );
        if (!verdict.ok) return refused(item, verdict.reason, verdict.runTargetKey);
        const pullRequests = verdict.pullRequests;

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
        const verdict = await evaluate(item, statuses, ctx, tx);
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

        const latest = await dispatchRunRepository.findLatestByCommandForWorkItem(
          item.id,
          'fix',
          tx,
        );
        if (latest?.status === 'running') {
          return {
            state: 'in_progress',
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
            failing,
            lastGaveUp: {
              attempts: attemptsOf(event?.data ?? null),
              endedAt: (latest.endedAt ?? latest.startedAt).toISOString(),
            },
          };
        }
        return { state: 'offer', failing, lastGaveUp: null };
      },
    );
  },
};
