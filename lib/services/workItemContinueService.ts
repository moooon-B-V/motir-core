import type { Prisma } from '@/generated/prisma/client';
import type { ClaimActorDto } from '@/lib/dto/claim';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type {
  ContinuePullRequestDto,
  DeadRunDto,
  RunDiedReason,
  WorkItemContinueClaimDto,
  WorkItemContinueRefusal,
  WorkItemContinueViewDto,
} from '@/lib/dto/workItemContinue';
import { dispatchRunCardRepository } from '@/lib/repositories/dispatchRunCardRepository';
import { dispatchRunEventRepository } from '@/lib/repositories/dispatchRunEventRepository';
import {
  dispatchRunRepository,
  type LatestRunForWorkItem,
} from '@/lib/repositories/dispatchRunRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { isRunAlive, lastHeardFrom } from '@/lib/runs/runLiveness';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { IN_PROGRESS_STATUS_KEY } from '@/lib/workItems/claimOutcome';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { RUNG_RANK, rankOfStatus } from '@/lib/workItems/statusLadder';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// THE CONTINUE CLAIM (Story MOTIR-6526 · MOTIR-6532,
// `docs/decisions/run-death-keeps-work.md` §4) — hand a work item whose last run
// DIED to ONE continuing agent, on the dead run's branch.
//
// It is the repair claim's shape (`workItemRepairService`) one lifecycle over: an
// open dispatch run is the lock (command `continue`), the outcomes are an enum,
// and no STATUS is written. The one card write is the ASSIGNEE — the takeover is
// exactly the change of who is on the card, and it is what makes the board say so.
//
// ── Why one transaction under the CARD's lock ───────────────────────────────
// The decision is read-derived — "the last run is dead, so take it over" — and two
// people can press continue in the same second. Both lock the card's row first, so
// the second waits for the first one's COMMIT and then reads the `continue` run it
// opened: `taken`, naming the holder, never a second agent on one branch. A run
// the rule reads as LAPSED is closed `abandoned` inside the same transaction, so
// the record agrees with the takeover the moment it commits.
//
// ── Why "is it alive?" is asked of `isRunAlive` and nothing else ────────────
// The marker on the card, the lapse reap and this claim must agree to the second
// about whether a run is dead; the rule lives in `lib/runs/runLiveness.ts` and is
// only READ here.

/** The run ended without success — the only runs there is anything to continue. */
const DIED_STATUSES = new Set(['failed', 'cancelled', 'timed_out']);

function actor(row: { id: string; name: string } | null): ClaimActorDto | null {
  return row ? { id: row.id, name: row.name } : null;
}

function toDeadRun(run: LatestRunForWorkItem): DeadRunDto {
  return {
    id: run.id,
    command: run.command,
    origin: run.origin,
    status: run.status,
    stopReason: run.stopReason,
    startedAt: run.startedAt.toISOString(),
    lastHeardAt: (run.lastHeartbeatAt ?? run.endedAt ?? lastHeardFrom(run)).toISOString(),
    dispatcher: actor(run.createdBy),
  };
}

function ladderKeysOf(statuses: readonly WorkflowStatusDto[]) {
  const keyOf = (key: string) => statuses.find((s) => s.key === key)?.key ?? null;
  return {
    reviewKey: keyOf('in_review'),
    implementedKey: keyOf('implemented'),
    approvedKey: keyOf('approved'),
  };
}

/**
 * The STATUS refusals — the pull request's rungs are `motir fix`'s business, and
 * anything that is not In Progress is not a run's to continue.
 */
function statusRefusal(
  status: string,
  archived: boolean,
  statuses: readonly WorkflowStatusDto[],
): WorkItemContinueRefusal | null {
  const rank = rankOfStatus(status, statuses, ladderKeysOf(statuses));
  if (
    !archived &&
    (rank === RUNG_RANK.implemented || rank === RUNG_RANK.in_review || rank === RUNG_RANK.approved)
  ) {
    return 'use_fix';
  }
  if (archived || status !== IN_PROGRESS_STATUS_KEY) return 'not_in_progress';
  return null;
}

/**
 * WHERE THE WORK IS — the open pull request's head, else the branch the dead
 * run's `checkout_ready` recorded (MOTIR-6530), else the leg's session branch.
 * The same resolution the CONTINUE prompt uses (MOTIR-6531), so the claim and the
 * prompt name one branch.
 */
export async function resolveContinueBranch(
  itemId: string,
  run: LatestRunForWorkItem,
  tx: Prisma.TransactionClient,
): Promise<{ branch: string | null; pullRequest: ContinuePullRequestDto | null }> {
  const deliveries = await workItemDeliveryRepository.listByWorkItemWithChecks(itemId, tx);
  const open = deliveries.find((d) => d.pullRequest.state === 'open' && !d.pullRequest.merged);
  if (open) {
    const repo = `${open.repo.owner}/${open.repo.name}`;
    return {
      branch: open.pullRequest.headRef,
      pullRequest: {
        repo,
        number: open.pullRequest.number,
        url: `https://github.com/${repo}/pull/${open.pullRequest.number}`,
        headRef: open.pullRequest.headRef,
      },
    };
  }
  const leg = run.cards[0] ?? null;
  const recorded = await dispatchRunEventRepository.findLatestCheckoutBranch(
    run.id,
    leg?.id ?? null,
    tx,
  );
  if (recorded !== null) return { branch: recorded, pullRequest: null };
  if (leg?.sessionBranch) return { branch: leg.sessionBranch, pullRequest: null };
  // A SCOPE run's container holds no leg of its own: its branch is the session
  // branch its legs were integrated onto (MOTIR-6535) — one name across repos.
  if (leg === null) {
    const legs = await dispatchRunCardRepository.listByRun(run.id, tx);
    const session = legs.find((l) => l.sessionBranch !== null)?.sessionBranch ?? null;
    if (session !== null) return { branch: session, pullRequest: null };
  }
  // A `continue` run that has not checked out yet still KNOWS its branch: the
  // claim wrote it onto the run's `run_opened` event. Without this, a continue
  // that dies before its checkout could not be continued again.
  const opened = await dispatchRunEventRepository.findLatestOfKind(run.id, 'run_opened', tx);
  const openedBranch = (opened?.data as { branch?: unknown } | null)?.branch;
  return { branch: typeof openedBranch === 'string' ? openedBranch : null, pullRequest: null };
}

/**
 * How a dead run ended, in the words the CONTINUE prompt hands the next agent.
 * Read off the stop reason first (it says WHY), then the status.
 */
export function endedHow(run: {
  status: string;
  stopReason: string | null;
  origin: string;
}): string {
  if (run.status === 'running' || run.stopReason === 'abandoned') {
    return 'the run stopped reporting (no heartbeat reached Motir)';
  }
  if (run.stopReason === 'interrupted') return 'it was stopped from its terminal';
  if (run.status === 'failed') return 'the agent exited with an error';
  if (run.status === 'cancelled') return 'it was cancelled';
  if (run.status === 'timed_out' && run.origin === 'hosted') {
    return 'the hosted run stalled or reached its time limit';
  }
  return `it ended ${run.status}`;
}

/**
 * The reason line's key (MOTIR-6534, design D3). A hosted `timed_out` is split by
 * its closing `log` line: the 12-hour backstop names itself, anything else is the
 * stall watchdog.
 */
async function diedReason(
  run: LatestRunForWorkItem,
  tx: Prisma.TransactionClient,
): Promise<RunDiedReason> {
  if (run.status === 'running' || run.stopReason === 'abandoned') return 'lapsed';
  if (run.stopReason === 'interrupted') return 'interrupted';
  if (run.status === 'failed') return 'failed';
  if (run.status === 'cancelled') return 'cancelled';
  if (run.origin === 'hosted') {
    const last = await dispatchRunEventRepository.findLatestOfKind(run.id, 'log', tx);
    const message = String((last?.data as { message?: unknown } | null)?.message ?? '');
    return /12[- ]hour|backstop/i.test(message) ? 'backstop' : 'stalled';
  }
  return 'lapsed';
}

type Evaluation =
  | { kind: 'none' }
  | { kind: 'alive'; run: LatestRunForWorkItem }
  | { kind: 'continuing'; run: LatestRunForWorkItem }
  | {
      kind: 'died';
      run: LatestRunForWorkItem;
      /** The rule reads it dead but its row still says `running` — the sweep has
       *  not got to it. The claim closes it; the view only reads it. */
      lapsed: boolean;
      branch: string | null;
      pullRequest: ContinuePullRequestDto | null;
      refusal: Exclude<WorkItemContinueRefusal, 'run_alive' | 'no_dead_run'> | null;
      parentKey: string | null;
    };

/**
 * THE PREDICATE — ONE function, read by the claim (under its row lock) and by the
 * item page (without one), so the page never offers a command the claim would
 * refuse (design `design/runs/design-notes.md` § Run died).
 */
async function evaluate(
  item: { id: string; status: string; archivedAt: Date | null },
  statuses: readonly WorkflowStatusDto[],
  now: Date,
  tx: Prisma.TransactionClient,
): Promise<Evaluation> {
  const run = await dispatchRunRepository.findLatestForWorkItem(item.id, tx);
  if (!run) return { kind: 'none' };

  if (run.status === 'running') {
    const alive = isRunAlive(
      {
        status: run.status,
        origin: run.origin,
        startedAt: run.startedAt,
        lastHeartbeatAt: run.lastHeartbeatAt,
      },
      now,
    );
    if (alive)
      return run.command === 'continue' ? { kind: 'continuing', run } : { kind: 'alive', run };
  } else if (!DIED_STATUSES.has(run.status)) {
    // It SUCCEEDED: the work moved on through the run's own delivery.
    return { kind: 'none' };
  }

  const refusalByStatus = statusRefusal(item.status, item.archivedAt !== null, statuses);
  // A leg of a PARENT run is continued with its parent — the whole run resumes on
  // its session branch and skips what already landed (MOTIR-6535).
  const parentKey =
    run.scopeWorkItemId !== null && run.scopeWorkItemId !== item.id
      ? (run.scope?.identifier ?? null)
      : null;
  const { branch, pullRequest } = await resolveContinueBranch(item.id, run, tx);
  const refusal: Exclude<WorkItemContinueRefusal, 'run_alive' | 'no_dead_run'> | null =
    refusalByStatus === 'use_fix'
      ? 'use_fix'
      : parentKey !== null
        ? 'continue_the_parent'
        : refusalByStatus === 'not_in_progress'
          ? 'not_in_progress'
          : branch === null
            ? 'no_branch'
            : null;
  return {
    kind: 'died',
    run,
    lapsed: run.status === 'running',
    branch,
    pullRequest,
    refusal,
    parentKey,
  };
}

function refused(
  item: { identifier: string; title: string },
  reason: WorkItemContinueRefusal,
  extra: Partial<WorkItemContinueClaimDto> = {},
): WorkItemContinueClaimDto {
  return {
    key: item.identifier,
    title: item.title,
    outcome: 'not_continuable',
    reason,
    parentKey: null,
    runId: null,
    holder: null,
    startedAt: null,
    deadRun: null,
    branch: null,
    pullRequest: null,
    previousAssignee: null,
    mode: 'card',
    landedKeys: [],
    ...extra,
  };
}

export const workItemContinueService = {
  /**
   * CLAIM the continue of one work item whose last run died.
   *
   * The decision order is the contract: a `continue` run already open (mine /
   * taken) → a live run (`run_alive`) → the status (`use_fix`, `not_in_progress`)
   * → a parent run's leg (`continue_the_parent`) → nothing died (`no_dead_run`) →
   * nothing to continue on (`no_branch`) → take it over.
   */
  async claimContinue(
    projectId: string,
    identifier: string,
    ctx: ServiceContext,
    now: Date = new Date(),
  ): Promise<WorkItemContinueClaimDto> {
    const item = await workItemsService.getWorkItemByIdentifier(projectId, identifier, ctx);
    // A continue starts an agent, exactly like a dispatch — the same credit gate,
    // before any lock.
    await ciAllowanceService.assertDispatchAllowed(ctx);
    // The operation exists to START WORK on the card; a caller who may not edit
    // the project has no answer here worth giving.
    await projectAccessService.assertCanEdit(projectId, ctx);
    const statuses = await workflowsService.listStatusesByProject(projectId, ctx.workspaceId);

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      async (tx): Promise<WorkItemContinueClaimDto> => {
        await workItemRepository.lockById(item.id, tx);
        const state = await workItemRepository.findClaimStateById(item.id, tx);
        /* v8 ignore next -- the row was resolved above; only a delete between the two reads gets here */
        if (!state) throw new WorkItemNotFoundError(identifier);

        const verdict = await evaluate(
          { id: item.id, status: state.status, archivedAt: state.archivedAt },
          statuses,
          now,
          tx,
        );

        if (verdict.kind === 'continuing') {
          const mine = verdict.run.createdById === ctx.userId;
          const branch = mine
            ? (await resolveContinueBranch(item.id, verdict.run, tx)).branch
            : null;
          return {
            key: item.identifier,
            title: item.title,
            outcome: mine ? 'mine' : 'taken',
            reason: null,
            parentKey: null,
            runId: verdict.run.id,
            holder: actor(verdict.run.createdBy),
            startedAt: verdict.run.startedAt.toISOString(),
            // The holder is handed the branch again; a rival is handed nothing.
            deadRun: null,
            branch,
            pullRequest: null,
            previousAssignee: null,
            mode: verdict.run.scopeWorkItemId === item.id ? 'parent' : 'card',
            landedKeys: [],
          };
        }
        if (verdict.kind === 'alive') {
          return refused(item, 'run_alive', {
            holder: actor(verdict.run.createdBy),
            startedAt: verdict.run.startedAt.toISOString(),
          });
        }
        if (verdict.kind === 'none') {
          const byStatus = statusRefusal(state.status, state.archivedAt !== null, statuses);
          return refused(item, byStatus ?? 'no_dead_run');
        }

        if (verdict.refusal !== null) {
          return refused(item, verdict.refusal, { parentKey: verdict.parentKey });
        }

        // THE TAKEOVER. A lapsed run is closed first — under this lock, with the
        // reason the lapse reap would give — so the record says it ended.
        let deadRun = toDeadRun(verdict.run);
        if (verdict.lapsed) {
          const lastHeard = lastHeardFrom(verdict.run).toISOString();
          await dispatchRunService.closeWithin(
            verdict.run.id,
            { stopReason: 'abandoned' },
            { userId: ctx.userId, workspaceId: ctx.workspaceId },
            tx,
            { message: `no heartbeat since ${lastHeard}`, lastHeartbeatAt: lastHeard },
          );
          deadRun = {
            ...deadRun,
            status: 'timed_out',
            stopReason: 'abandoned',
            lastHeardAt: lastHeard,
          };
        }

        // A PARENT run (MOTIR-6535): the dead run was SCOPED to this container, so
        // the takeover is of the whole scope — its legs that are still In Progress
        // are re-assigned too (so the scope claim that follows answers `mine`),
        // and the ones already landed are named, so they are never re-dispatched.
        const parent = verdict.run.scopeWorkItemId === item.id;
        const deadLegs = parent ? await dispatchRunCardRepository.listByRun(deadRun.id, tx) : [];
        const legKeys = deadLegs.map((l) => l.workItemKey).filter((k): k is string => k !== null);
        const legItems = await workItemRepository.findByIdentifiers(projectId, legKeys, tx);
        const landedKeys: string[] = [];
        const inFlight: string[] = [];
        for (const leg of legItems) {
          const rank = rankOfStatus(leg.status, statuses, ladderKeysOf(statuses));
          if (rank >= RUNG_RANK.implemented) landedKeys.push(leg.identifier);
          else if (leg.status === IN_PROGRESS_STATUS_KEY) inFlight.push(leg.id);
        }
        if (inFlight.length > 0) await workItemRepository.lockByIds(inFlight, tx);
        for (const id of inFlight) {
          await workItemRepository.update(id, { assigneeId: ctx.userId }, tx);
        }

        const previousAssignee =
          state.assigneeId === null
            ? null
            : actor(await userRepository.findById(state.assigneeId, tx));
        if (state.assigneeId !== ctx.userId) {
          await workItemRepository.update(item.id, { assigneeId: ctx.userId }, tx);
        }

        const opened = await dispatchRunService.openWithin(
          projectId,
          parent
            ? {
                command: 'continue',
                scopeKey: item.identifier,
                scopeLabel: item.identifier,
                cards: legKeys.map((key) => ({ key, disposition: 'queued' as const })),
              }
            : { command: 'continue', cards: [{ key: item.identifier, disposition: 'queued' }] },
          ctx,
          tx,
        );
        await dispatchRunEventRepository.createMany(
          [
            {
              workspaceId: ctx.workspaceId,
              dispatchRunId: opened.run.id,
              seq: 1,
              kind: 'run_opened',
              data: {
                command: 'continue',
                key: item.identifier,
                continuesRunId: deadRun.id,
                previousAssignee: previousAssignee ? { ...previousAssignee } : null,
                branch: verdict.branch,
              },
            },
          ],
          tx,
        );
        return {
          key: item.identifier,
          title: item.title,
          outcome: 'claimed',
          reason: null,
          parentKey: null,
          runId: opened.run.id,
          holder: actor(await userRepository.findById(ctx.userId, tx)),
          startedAt: opened.run.startedAt,
          deadRun,
          branch: verdict.branch,
          pullRequest: verdict.pullRequest,
          previousAssignee,
          mode: parent ? 'parent' : 'card',
          landedKeys: landedKeys.sort(),
        };
      },
    );
  },

  /**
   * What the item page draws about a run that died (MOTIR-6534) — the claim's own
   * evaluation, WITHOUT a lock and without closing or opening anything. A read a
   * browse-only viewer may make.
   */
  async getContinueView(
    workItemId: string,
    ctx: ServiceContext,
    now: Date = new Date(),
  ): Promise<WorkItemContinueViewDto> {
    const item = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => workItemRepository.findById(workItemId, tx),
    );
    if (!item) throw new WorkItemNotFoundError(workItemId);
    await projectAccessService.assertCanBrowse(item.projectId, ctx);
    const statuses = await workflowsService.listStatusesByProject(item.projectId, ctx.workspaceId);

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: item.projectId },
      async (tx): Promise<WorkItemContinueViewDto> => {
        const verdict = await evaluate(item, statuses, now, tx);
        if (verdict.kind === 'none') return { state: 'none' };
        if (verdict.kind === 'alive') return { state: 'alive' };
        if (verdict.kind === 'continuing') {
          const opened = await dispatchRunEventRepository.findLatestOfKind(
            verdict.run.id,
            'run_opened',
            tx,
          );
          const data = (opened?.data ?? null) as {
            continuesRunId?: unknown;
            branch?: unknown;
          } | null;
          const tookOverId = typeof data?.continuesRunId === 'string' ? data.continuesRunId : null;
          const tookOver = tookOverId
            ? await dispatchRunRepository.findRunStarterById(tookOverId, tx)
            : null;
          return {
            state: 'continuing',
            holder: actor(verdict.run.createdBy),
            byViewer: verdict.run.createdById === ctx.userId,
            startedAt: verdict.run.startedAt.toISOString(),
            branch: typeof data?.branch === 'string' ? data.branch : null,
            tookOverFrom: tookOverId
              ? { runId: tookOverId, dispatcher: actor(tookOver?.createdBy ?? null) }
              : null,
          };
        }
        return {
          state: 'died',
          deadRun: toDeadRun(verdict.run),
          reason: await diedReason(verdict.run, tx),
          branch: verdict.branch,
          pullRequest: verdict.pullRequest,
          refusal: verdict.refusal,
          parentKey: verdict.parentKey,
        };
      },
    );
  },
};
