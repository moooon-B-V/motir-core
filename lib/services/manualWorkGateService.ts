import type { Prisma, WorkItem } from '@/generated/prisma/client';
import { routingTargetId } from '@/lib/approvalGates/routing';
import { isManualReadyItem } from '@/lib/dto/ready';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { workItemRevisionsService } from './workItemRevisionsService';
import { workflowsService } from './workflowsService';

// THE `manual_work` GATE'S RAISE AND WITHDRAWALS (Story MOTIR-7460 · Subtask MOTIR-7474;
// `docs/decisions/manual-work-gate.md` §2, §3, §6).
//
// The handler (`lib/approvalGates/manualWorkHandler.ts`) is what the decide door
// dispatches to. This module is everything that happens to the gate OUTSIDE the door:
//
//   · RAISE — a run reached a manual card it could not do (§2). One awaiting gate per
//     CARD, whichever run reports it and however often. An unassigned card is assigned
//     to the run's starter first, with a revision, so §2's routing answers them (§3).
//   · WITHDRAW, `no_longer_manual` — the card was edited so a person no longer owes the
//     work (§6). Called from `updateWorkItem` in the edit's transaction.
//   · WITHDRAW, `closed_without_decision` — the card reached a done status by a write
//     nobody decided: the parent cascade, the rollup (§6). Called from
//     `applyStatusTransition` in the move's transaction.
//
// Cancel and archive need nothing here: the shipped pull-back rule and
// `withdrawQuestionsOnArchive` supersede every kind's awaiting gate as `pulled_back`.
//
// ⚠️ IT OPENS NO TRANSACTION: every caller is already inside the card's write
// transaction, so the gate and the write it follows commit together or not at all.

const KIND = 'manual_work' as const;

/**
 * The card TYPES a person is already asked about by a kind of their own — a choice by
 * `decision_choice`, a human decision by `decision_confirmation` — so a run meeting one
 * raises no second question beside it. Both are `needs_human` to a run, and both own
 * the same Done.
 */
const ASKED_BY_THEIR_OWN_KIND: ReadonlySet<string> = new Set(['choice', 'decision']);

/** Why a raise wrote nothing — enough for a caller to log and a test to assert. */
export type ManualWorkRaiseSkip =
  | 'not_found'
  | 'archived'
  | 'not_manual'
  | 'asked_by_own_kind'
  | 'done'
  | 'already_awaiting';

export interface ManualWorkRaise {
  raised: boolean;
  /** Set when the raise wrote nothing. */
  skipped: ManualWorkRaiseSkip | null;
  /** True when the raise assigned an unassigned card to the run's starter (§3). */
  assignedToStarter: boolean;
  /** Who the gate is routed to — the card's assignee, else its reporter. */
  routedToId: string | null;
}

/**
 * The status keys to walk, by DECLARED edges, from where the card stands to `targetKey`
 * — shortest first, never THROUGH another done-category status (a cancel is not a road to
 * Done). Mark done is pressed on a card a run SKIPPED, so it usually stands in To do,
 * from which no workflow declares a direct edge to Done. Empty when the card is already
 * there; null when no path exists (the move then refuses as it always did).
 */
export async function hopsToStatus(
  item: Pick<WorkItem, 'projectId' | 'workspaceId' | 'status'>,
  targetKey: string,
  tx: Prisma.TransactionClient,
): Promise<string[] | null> {
  if (item.status === targetKey) return [];
  const [project, statuses, transitions] = await Promise.all([
    projectRepository.findById(item.projectId, tx),
    workflowsRepository.findStatuses(item.projectId, item.workspaceId, tx),
    workflowsRepository.findTransitions(item.projectId, item.workspaceId, tx),
  ]);
  const target = statuses.find((status) => status.key === targetKey);
  const from = statuses.find((status) => status.key === item.status);
  if (!project || !target || !from) return null;
  if (project.workflowPolicyMode === 'open') return [targetKey];

  const byId = new Map(statuses.map((status) => [status.id, status]));
  const cameFrom = new Map<string, string>([[from.id, from.id]]);
  const queue = [from.id];
  while (queue.length > 0) {
    const at = queue.shift()!;
    if (at === target.id) break;
    for (const edge of transitions) {
      if (edge.fromStatusId !== at || cameFrom.has(edge.toStatusId)) continue;
      const to = byId.get(edge.toStatusId);
      if (!to || (to.category === 'done' && to.id !== target.id)) continue;
      cameFrom.set(edge.toStatusId, at);
      queue.push(edge.toStatusId);
    }
  }
  if (!cameFrom.has(target.id)) return null;
  const path: string[] = [];
  for (let at = target.id; at !== from.id; at = cameFrom.get(at)!) path.unshift(byId.get(at)!.key);
  return path;
}

export const manualWorkGateService = {
  /**
   * RAISE the gate on a manual card a run reached (§2). Idempotent on the CARD: a
   * second run, or the same run reporting twice, finds the awaiting gate and writes
   * nothing. A DECIDED gate does not stop it — a reopened card is owed again.
   *
   * The server does not take the run's word for it: the card must resolve in the
   * caller's workspace, be unarchived, be manual (`isManualReadyItem`) and not be in a
   * done-category status, as read in this transaction.
   *
   * @param run the run that reached the card — its starter (`DispatchRun.createdById`)
   *   is who an UNASSIGNED card is assigned to.
   */
  async raise(
    workItemId: string,
    run: { createdById: string | null },
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ManualWorkRaise> {
    const skip = (skipped: ManualWorkRaiseSkip, item?: WorkItem): ManualWorkRaise => ({
      raised: false,
      skipped,
      assignedToStarter: false,
      routedToId: item ? routingTargetId(item) : null,
    });

    const item = await workItemRepository.findById(workItemId, tx);
    if (!item || item.workspaceId !== workspaceId) return skip('not_found');
    if (item.archivedAt) return skip('archived', item);
    if (!isManualReadyItem(item)) return skip('not_manual', item);
    if (item.type !== null && ASKED_BY_THEIR_OWN_KIND.has(item.type)) {
      return skip('asked_by_own_kind', item);
    }
    const doneKeys = await workflowsService.getTerminalStatusKeysByProjects(
      [item.projectId],
      item.workspaceId,
      tx,
    );
    if (doneKeys.get(item.projectId)?.has(item.status)) return skip('done', item);

    const awaiting = await approvalGateRepository.findAwaitingByWorkItem(item.id, tx);
    if (awaiting.some((gate) => gate.kind === KIND)) return skip('already_awaiting', item);

    // §3: an UNASSIGNED card goes to whoever started the run, written as the card's
    // assignee so routing AND authority (`assigneeId ?? reporterId`) both answer them.
    // Never `routed_to_id` alone: card rows re-derive routing from the card.
    let card = item;
    let assignedToStarter = false;
    if (item.assigneeId === null && run.createdById) {
      card = await workItemRepository.update(item.id, { assigneeId: run.createdById }, tx);
      await workItemRevisionsService.recordRevision(
        {
          workItemId: item.id,
          changedById: run.createdById,
          changeKind: 'updated',
          diff: { assigneeId: { from: null, to: run.createdById } },
        },
        tx,
      );
      assignedToStarter = true;
    }

    const routedToId = routingTargetId(card);
    const raised = await approvalGateRepository.createAwaitingIfAbsent(
      {
        workspaceId: card.workspaceId,
        projectId: card.projectId,
        workItemId: card.id,
        kind: KIND,
        subjectId: card.id,
        subjectVersion: null,
        routedToId,
      },
      tx,
    );
    return {
      raised,
      skipped: raised ? null : 'already_awaiting',
      assignedToStarter,
      routedToId,
    };
  },

  /**
   * WITHDRAW the gate when an edit left the card no longer manual (§6,
   * `no_longer_manual`). A card that is still manual keeps its question, whatever
   * else the edit changed. Returns how many gates were withdrawn.
   */
  async withdrawIfNoLongerManual(
    item: Pick<WorkItem, 'id' | 'executor' | 'type'>,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (isManualReadyItem(item)) return 0;
    return approvalGateRepository.supersedeAwaitingByWorkItem(
      item.id,
      KIND,
      'no_longer_manual',
      tx,
    );
  },

  /**
   * WITHDRAW the gate when the card reached a done status that nobody decided (§6,
   * `closed_without_decision`) — the cascade, the rollup. The deciding gate's own move
   * never reaches here, so a Mark done is recorded as `approved`, not as this.
   */
  async withdrawOnUndecidedClose(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return approvalGateRepository.supersedeAwaitingByWorkItem(
      workItemId,
      KIND,
      'closed_without_decision',
      tx,
    );
  },
};
