import type { WorkItem } from '@prisma/client';

import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { userRepository } from '@/lib/repositories/userRepository';

import { plansService } from '@/lib/services/plansService';
import { planStalenessService } from '@/lib/services/planStalenessService';

import type {
  PlanItemDto,
  PlanItemPatch,
  PlanItemProposedFields,
  StaleReason,
} from '@/lib/dto/plans';
import type {
  PlanHistoryEventDto,
  PlanItemChangeDto,
  PlanReviewDto,
  PlanReviewItemDto,
} from '@/lib/dto/planReview';

// The plan-detail READ assembly (Story 7.21 · Subtask 7.4.5 / MOTIR-847). A pure
// READ orchestrator: it composes the substrate's own reads — `getPlan`
// (MOTIR-1336) + `computePlanStaleness` (MOTIR-1340) — and enriches each
// proposed item with what the canvas needs to DRAW it: the live target's fields
// (the OLD side of a `modify` diff, the node identity of a `modify`/`remove`),
// the proposed forest's parent/blocker node ids (refs resolved), and the
// decider's NAME for the history timeline. No writes, no transaction; the live
// targets load in ONE batched, workspace-scoped read (no N+1). It NEVER reads the
// 7.4 generation stream — the "live while generating" UI re-calls this read
// (poll), so 7.21 keeps no dependency on 7.4.

const TEMP_REF_PREFIX = 'planItem:';

/** Resolve a PlanItem ref to a canvas node id: an intra-plan temp-ref
 *  (`planItem:<id>`) → the referenced add's node id; a real work-item id → itself. */
function resolveRef(ref: string): string {
  return ref.startsWith(TEMP_REF_PREFIX) ? ref.slice(TEMP_REF_PREFIX.length) : ref;
}

/** The OLD → NEW field changes a `modify` proposes (its diff overlay). */
function buildChanges(
  patch: PlanItemPatch | null,
  target: WorkItem | undefined,
): PlanItemChangeDto[] {
  if (!patch) return [];
  const changes: PlanItemChangeDto[] = [];
  if (patch.title !== undefined && patch.title !== target?.title) {
    changes.push({ field: 'title', from: target?.title ?? null, to: patch.title });
  }
  if (patch.priority !== undefined && patch.priority !== (target?.priority ?? null)) {
    changes.push({ field: 'priority', from: target?.priority ?? null, to: patch.priority ?? null });
  }
  if (patch.type !== undefined && patch.type !== (target?.type ?? null)) {
    changes.push({ field: 'type', from: target?.type ?? null, to: patch.type ?? null });
  }
  if (
    patch.descriptionMd !== undefined &&
    patch.descriptionMd !== (target?.descriptionMd ?? null)
  ) {
    // Descriptions are long prose — surface only THAT it changed, not the text.
    changes.push({ field: 'description', from: null, to: 'updated' });
  }
  const added = patch.blockedByAdd?.length ?? 0;
  const removed = patch.blockedByRemove?.length ?? 0;
  if (added > 0 || removed > 0) {
    const parts: string[] = [];
    if (added > 0) parts.push(`+${added}`);
    if (removed > 0) parts.push(`−${removed}`);
    changes.push({
      field: 'links',
      from: null,
      to: `${parts.join(' / ')} blocker${added + removed === 1 ? '' : 's'}`,
    });
  }
  return changes;
}

export const planReviewService = {
  /**
   * Assemble the plan-detail review model for `planId`. Reads the plan + its
   * items (`getPlan`), the per-item staleness (`computePlanStaleness`), the live
   * `modify`/`remove` targets (one batched read), and the decider's name. Access
   * is enforced by `getPlan` (it asserts `canBrowse` on the plan's project, and a
   * missing/cross-tenant plan throws `PlanNotFoundError`).
   */
  async getPlanReview(planId: string, ctx: ServiceContext): Promise<PlanReviewDto> {
    const plan = await plansService.getPlan(planId, ctx);
    const staleness = await planStalenessService.computePlanStaleness(planId, ctx);

    // One batched, workspace-scoped read of every existing target (modify/remove)
    // — includes archived rows, so a "will be archived" / drifted target still
    // resolves; a hard-deleted / cross-tenant id simply doesn't come back.
    const targetIds = Array.from(
      new Set(plan.items.filter((i) => i.op !== 'add' && i.workItemId).map((i) => i.workItemId!)),
    );
    const targets = await workItemRepository.findByIdsInWorkspace(targetIds, ctx.workspaceId);
    const targetById = new Map(targets.map((t) => [t.id, t]));

    const staleByItem = new Map(staleness.items.map((s) => [s.planItemId, s]));

    // Resolve node ids first, so `hasChildren` can be computed across the forest.
    const withNodeIds = plan.items.map((item) => ({
      item,
      nodeId: item.op === 'add' ? item.id : (item.workItemId ?? item.id),
    }));
    const parentNodeIdOf = (item: PlanItemDto): string | null =>
      item.parentRef ? resolveRef(item.parentRef) : null;
    const childParentIds = new Set(
      withNodeIds.map(({ item }) => parentNodeIdOf(item)).filter((p): p is string => p !== null),
    );

    const items: PlanReviewItemDto[] = withNodeIds.map(({ item, nodeId }) => {
      const target = item.workItemId ? targetById.get(item.workItemId) : undefined;
      const stale = staleByItem.get(item.id);
      const reasons: StaleReason[] = stale?.reasons ?? [];
      const proposed = item.proposedFields as PlanItemProposedFields | null;

      const targetMissing = item.op !== 'add' && !target;

      return {
        planItemId: item.id,
        op: item.op,
        nodeId,
        parentNodeId: parentNodeIdOf(item),
        blockedByNodeIds: item.blockedByRefs.map(resolveRef),
        identifier: item.op === 'add' ? null : (target?.identifier ?? null),
        title:
          item.op === 'add'
            ? (proposed?.title ?? 'Untitled item')
            : (target?.title ?? 'Unavailable item'),
        kind: item.op === 'add' ? (proposed?.kind ?? 'task') : (target?.kind ?? 'task'),
        status: item.op === 'add' ? null : (target?.status ?? null),
        hasChildren: childParentIds.has(nodeId),
        changes: item.op === 'modify' ? buildChanges(item.patch, target) : [],
        stale: reasons.length > 0,
        staleReasons: reasons,
        targetMissing,
      };
    });

    const decidedByName = plan.decidedById
      ? ((await userRepository.findById(plan.decidedById))?.name ?? null)
      : null;

    const history: PlanHistoryEventDto[] = [{ kind: 'created', at: plan.createdAt }];
    if (plan.plannedAt) history.push({ kind: 'planned', at: plan.plannedAt });
    if (plan.status === 'approved' || plan.status === 'declined') {
      history.push({ kind: plan.status, at: plan.decidedAt, byName: decidedByName });
    }

    const staleCount = items.filter((i) => i.stale).length;

    return {
      id: plan.id,
      projectId: plan.projectId,
      status: plan.status,
      title: plan.title,
      summary: plan.summary,
      itemCount: plan.itemCount,
      createdAt: plan.createdAt,
      plannedAt: plan.plannedAt,
      decidedAt: plan.decidedAt,
      decidedByName,
      history,
      items,
      stale: staleCount > 0,
      staleCount,
    };
  },
};
