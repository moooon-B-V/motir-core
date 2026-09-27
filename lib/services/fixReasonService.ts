import type { Prisma } from '@/generated/prisma/client';
import { deliveryMemberVersion, deliverySetVersion } from '@/lib/approvalGates/deliverySetVersion';
import { toWorkflowStatusDto } from '@/lib/mappers/workflowMappers';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { evaluateRepair } from '@/lib/services/repairPredicate';
import {
  NOTHING_TO_FIX,
  changesRequestedOf,
  pullRequestReasonOf,
  sameFixReason,
  standingMergeRefusalOf,
  type FixReasonValue,
} from '@/lib/workItems/fixReason';

// WHY A CARD IS STUCK UNTIL SOMETHING IS REPAIRED, STORED (Story MOTIR-6588 ·
// MOTIR-6600) — `WorkItem.fixReason` + `WorkItem.fixDetail`, the column the
// Workbench's To fix tab lists, pages and counts by.
//
// ── One rule, read THROUGH the command's own predicate ──────────────────────
// The tab's promise is that it lists exactly the cards `motir fix` would claim, plus
// the ones a reviewer sent back. So the pull-request half is `evaluateRepair` — the
// predicate the claim and the Development block already decide by — and nothing here
// restates a single one of its rules: an `ok` evaluation is classed by the members IT
// handed over, and a refusal is not a pull-request reason whatever the members look
// like. The one reason the predicate cannot see is a reviewer's Request changes on the
// approve-to-merge gate, which MOVES NOTHING (`approval-gates.md`'s kind table): the
// card waits at In Review with no awaiting gate, and without this column nothing
// anywhere says so.
//
// ── The shape is `recomputeWorkItemCiState`'s ───────────────────────────────
// A read-derived write, so the card's row lock is taken FIRST and everything is read
// under it: two events racing on one card serialise, and the last to commit is the
// one that read the most. Idempotent — an unchanged answer writes nothing — and it
// emits no event. It runs INSIDE the caller's transaction and bound tenant context;
// `work_item` has no system arm.

/**
 * What the card's to-fix answer is NOW, read inside `tx` without writing it. The
 * caller holds the card's row lock (the recompute below takes it).
 *
 * `null` for a card outside the `in_progress` status CATEGORY or archived: a card
 * that has not started or has finished is not waiting on a repair, whatever its pull
 * requests say.
 */
export async function deriveFixReason(
  item: {
    id: string;
    projectId: string;
    workspaceId: string;
    status: string;
    archivedAt: Date | null;
  },
  tx: Prisma.TransactionClient,
): Promise<FixReasonValue> {
  if (item.archivedAt !== null) return NOTHING_TO_FIX;
  const statuses = (
    await workflowsRepository.findStatuses(item.projectId, item.workspaceId, tx)
  ).map(toWorkflowStatusDto);
  if (statuses.find((s) => s.key === item.status)?.category !== 'in_progress') {
    return NOTHING_TO_FIX;
  }

  const [verdict, deliveries] = await Promise.all([
    evaluateRepair(item, statuses, { workspaceId: item.workspaceId }, tx),
    workItemDeliveryRepository.listByWorkItemWithChecks(item.id, tx),
  ]);
  // The predicate's own notion of an open member, so `total` counts what it counted.
  const total = deliveries.filter(
    (d) => d.pullRequest.state === 'open' && !d.pullRequest.merged,
  ).length;

  if (verdict.ok) {
    // A claimable card is classed by the members the predicate handed over. On the
    // `ci` class every one of them is failing, so a reason always results; on an
    // `acceptance_rerun` they are every open member, and when none is red the reason
    // is the reviewer's refusal the class exists for.
    const byMembers = pullRequestReasonOf(verdict.pullRequests, total);
    if (byMembers) return byMembers;
    if (verdict.repairClass === 'acceptance_rerun' && verdict.acceptanceRefusal) {
      return changesRequestedOf(
        {
          gate: 'acceptance_result',
          decidedByLabel: verdict.acceptanceRefusal.decidedByLabel,
          noteMd: verdict.acceptanceRefusal.reasonMd,
        },
        total,
      );
    }
    /* v8 ignore next 2 -- NO PRODUCER: an `ok` evaluation of the `ci` class hands over
       only failing members, and `acceptance_rerun` always carries its refusal. */
    return NOTHING_TO_FIX;
  }

  // Not claimable. The one reason left is a reviewer's standing Request changes.
  const latest = await approvalGateRepository.findLatestDecidedByWorkItem(item.id, tx);
  const currentVersion = deliverySetVersion(deliveries.map((d) => deliveryMemberVersion(d)));
  if (latest && standingMergeRefusalOf(latest, currentVersion)) {
    return changesRequestedOf(
      {
        gate: 'pull_request_approval',
        decidedByLabel: latest.decidedByLabel,
        noteMd: latest.noteMd,
      },
      total,
    );
  }
  return NOTHING_TO_FIX;
}

/**
 * RECOMPUTE one card's stored `fixReason` / `fixDetail`, and write them if they moved.
 *
 * Called by every writer that can change the answer (MOTIR-6602) and by the backfill
 * (MOTIR-6603), inside the writer's own transaction. Returns what it settled on, which
 * is also what is stored.
 */
export async function recomputeWorkItemFixReason(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<FixReasonValue> {
  const locked = await workItemRepository.lockById(workItemId, tx);
  if (!locked) return NOTHING_TO_FIX;
  const item = await workItemRepository.findById(workItemId, tx);
  /* v8 ignore next -- a granted lock on an immutable id implies a readable row
     (`recomputeWorkItemCiState` records why); the read is nullable, so it is guarded. */
  if (!item) return NOTHING_TO_FIX;

  const next = await deriveFixReason(item, tx);
  if (!sameFixReason(item, next)) {
    await workItemRepository.updateFixReason(workItemId, next, tx);
  }
  return next;
}
