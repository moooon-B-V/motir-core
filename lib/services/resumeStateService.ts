import type { Prisma, WorkItemResumeState } from '@/generated/prisma/client';
import { toWorkflowStatusDto } from '@/lib/mappers/workflowMappers';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { dispatchRunHeldGateRepository } from '@/lib/repositories/dispatchRunHeldGateRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// WHETHER A CARD WAITS TO RESUME, STORED (Story MOTIR-7701 · MOTIR-7707) —
// `WorkItem.resumeState` + `WorkItem.resumeRunId`, the column the Workbench's To
// resume tab lists, pages and counts by.
//
// ── A sibling of `fixReason`, never a sixth value of it ─────────────────────
// To fix means *a repair would claim this card*. A run that stopped because its
// remaining work waits on a person's approval is not broken, and nothing repairs
// it: the approval releases it. So it is its own column, carved out of In progress
// the way `fixReason` is, and To fix wins on the rare card where both hold.
//
// ── A pure function of runs and gates ──────────────────────────────────────
// The card's LATEST run (the continue claim's own read, `findLatestForWorkItem`)
// decides it: a run that closed `gated` makes the card wait; anything newer — a
// continue, a fresh run, a run that died — takes it off, and a died run is To fix's
// `run_died`, unchanged. While it waits, the run's held gates (MOTIR-7703) say
// which way: `ready_to_resume` once one of them is approved, else
// `waiting_on_gate`. Each held gate is read as the LATEST gate of its kind on its
// card, so a design republished after the run stopped (its first gate superseded)
// is answered by the version a person actually decided.
//
// ── The shape is `recomputeWorkItemFixReason`'s ─────────────────────────────
// A read-derived write under the card's row lock, idempotent (an unchanged answer
// writes nothing), inside the caller's transaction.

/** What `WorkItem.resumeState` / `resumeRunId` hold together. */
export interface ResumeStateValue {
  resumeState: WorkItemResumeState | null;
  resumeRunId: string | null;
}

export const NOTHING_TO_RESUME: ResumeStateValue = { resumeState: null, resumeRunId: null };

/**
 * What the card's To resume answer is NOW, read inside `tx` without writing it.
 * `null` state for a card outside the `in_progress` status CATEGORY or archived.
 */
export async function deriveResumeState(
  item: {
    id: string;
    projectId: string;
    workspaceId: string;
    status: string;
    archivedAt: Date | null;
  },
  tx: Prisma.TransactionClient,
): Promise<ResumeStateValue> {
  if (item.archivedAt !== null) return NOTHING_TO_RESUME;
  const statuses = (
    await workflowsRepository.findStatuses(item.projectId, item.workspaceId, tx)
  ).map(toWorkflowStatusDto);
  if (statuses.find((s) => s.key === item.status)?.category !== 'in_progress') {
    return NOTHING_TO_RESUME;
  }

  const run = await dispatchRunRepository.findLatestForWorkItem(item.id, tx);
  if (!run || run.status !== 'succeeded' || run.stopReason !== 'gated') return NOTHING_TO_RESUME;

  const ready: ResumeStateValue = { resumeState: 'ready_to_resume', resumeRunId: run.id };
  const held = await dispatchRunHeldGateRepository.listByRun(run.id, tx);
  // A `gated` close that found no awaiting gate (it was decided in the same minute)
  // has nothing left to wait on (MOTIR-7703).
  if (held.length === 0) return ready;
  const seen = new Set<string>();
  for (const row of held) {
    const slot = `${row.workItemId}:${row.kind}`;
    if (seen.has(slot)) continue;
    seen.add(slot);
    const latest = await approvalGateRepository.findLatestByWorkItem(row.workItemId, row.kind, tx);
    if (latest?.state === 'approved') return ready;
  }
  // Every held gate still awaiting — or sent back, which stays waiting: a refusal
  // releases nothing, and the entry says so (MOTIR-7712).
  return { resumeState: 'waiting_on_gate', resumeRunId: run.id };
}

/**
 * RECOMPUTE one card's stored `resumeState` / `resumeRunId`, and write them if they
 * moved. Inside the writer's own transaction; takes the card's row lock first.
 */
export async function recomputeWorkItemResumeState(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<ResumeStateValue> {
  const locked = await workItemRepository.lockById(workItemId, tx);
  if (!locked) return NOTHING_TO_RESUME;
  const item = await workItemRepository.findById(workItemId, tx);
  /* v8 ignore next -- a granted lock on an immutable id implies a readable row */
  if (!item) return NOTHING_TO_RESUME;

  const next = await deriveResumeState(item, tx);
  if (item.resumeState !== next.resumeState || item.resumeRunId !== next.resumeRunId) {
    await workItemRepository.updateResumeState(workItemId, next, tx);
  }
  return next;
}

export const resumeStateService = {
  /**
   * AFTER A GATE ON THIS CARD WAS DECIDED — recompute every card a run held by it
   * covers (MOTIR-7707). Called by the decide door and by the design-approval-off
   * system approval AFTER their transaction commits, never inside it.
   *
   * ⚠️ WHY AFTER THE COMMIT. The decision holds the gate's card lock, and the cards
   * waiting on the run are its SIBLINGS and its parent. A run close locks those same
   * cards in its own order (scope first, then legs ascending — `lockCoveredCards`),
   * and it covers the gate's card as a leg. Taking the siblings inside the decision
   * would lock in the inverse order and could deadlock against a close racing the
   * press. So each run's cards are recomputed in their own transaction, in the
   * close's order, once the decision is visible.
   */
  async afterGateDecided(
    workItemId: string,
    ctx: { userId: string; workspaceId: string },
  ): Promise<void> {
    const runIds = await withWorkspaceContext(ctx, (tx) =>
      dispatchRunHeldGateRepository.listRunIdsByWorkItem(workItemId, tx),
    );
    for (const runId of runIds) {
      await withWorkspaceContext(ctx, async (tx) => {
        const run = await dispatchRunRepository.findByIdWithCards(runId, tx);
        if (!run) return;
        const legs = [
          ...new Set(
            run.cards
              .map((card) => card.workItemId)
              .filter((id): id is string => id !== null && id !== run.scopeWorkItemId),
          ),
        ].sort();
        if (run.scopeWorkItemId) await recomputeWorkItemResumeState(run.scopeWorkItemId, tx);
        for (const id of legs) await recomputeWorkItemResumeState(id, tx);
      });
    }
  },
};
