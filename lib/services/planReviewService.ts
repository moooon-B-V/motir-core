import type { WorkItem } from '@/generated/prisma/client';

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
  PlanItemChangeField,
  PlanReviewDto,
  PlanReviewItemDto,
} from '@/lib/dto/planReview';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

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
  // Typed to the CLOSED wire vocabulary, so a new `field:` literal here is a
  // compile error until it is added to `PLAN_ITEM_CHANGE_FIELDS` — which is what
  // `plan-change-field-labels.test.tsx` then demands copy for. MOTIR-1532 added
  // two of these and their labels never followed (MOTIR-3151); nothing on this
  // path could have noticed.
  const changes: (PlanItemChangeDto & { field: PlanItemChangeField })[] = [];
  if (patch.title !== undefined && patch.title !== target?.title) {
    changes.push({ field: 'title', from: target?.title ?? null, to: patch.title });
  }
  if (patch.priority !== undefined && patch.priority !== (target?.priority ?? null)) {
    changes.push({ field: 'priority', from: target?.priority ?? null, to: patch.priority ?? null });
  }
  if (patch.type !== undefined && patch.type !== (target?.type ?? null)) {
    changes.push({ field: 'type', from: target?.type ?? null, to: patch.type ?? null });
  }
  // Leaf sizing re-scope (MOTIR-1532) — surface it so the approver SEES the new
  // points/estimate before approving. `storyPoints` is a Prisma Decimal on the
  // target; compare + render it numerically (as a string, the change-cell shape).
  const targetPoints = target?.storyPoints == null ? null : Number(target.storyPoints);
  if (patch.storyPoints !== undefined && patch.storyPoints !== targetPoints) {
    changes.push({
      field: 'storyPoints',
      from: targetPoints === null ? null : String(targetPoints),
      to: patch.storyPoints === null ? null : String(patch.storyPoints),
    });
  }
  if (
    patch.estimateMinutes !== undefined &&
    patch.estimateMinutes !== (target?.estimateMinutes ?? null)
  ) {
    changes.push({
      field: 'estimateMinutes',
      from: target?.estimateMinutes == null ? null : String(target.estimateMinutes),
      to: patch.estimateMinutes === null ? null : String(patch.estimateMinutes),
    });
  }
  if (
    patch.descriptionMd !== undefined &&
    patch.descriptionMd !== (target?.descriptionMd ?? null)
  ) {
    // Descriptions are long prose — surface only THAT it changed, not the text.
    changes.push({ field: 'description', from: null, to: 'updated' });
  }
  // …and the SECOND body (MOTIR-3111). Same treatment as the description above —
  // long prose, so the cell says only that it moved. It is listed because the
  // explanation is the half a reviewer reads to decide whether a proposed
  // re-shape is right: a `modify` that silently rewrote the WHY while the review
  // surface showed nothing would defeat the point of putting the plan in front of
  // a person at all.
  if (
    patch.explanationMd !== undefined &&
    patch.explanationMd !== (target?.explanationMd ?? null)
  ) {
    changes.push({ field: 'explanation', from: null, to: 'updated' });
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
    //
    // ⚠️ A MATERIALIZED `add` is in this set too (MOTIR-3160). `approvePlan`
    // stamps `plan_item.workItemId` for every add it creates, so an approved
    // proposal HAS a live target — and until this filter stopped excluding it by
    // `op`, the review model could not read the identifier of the very card the
    // approval produced.
    const targetIds = plan.items.filter((i) => i.workItemId).map((i) => i.workItemId!);
    // …AND every COMMITTED parent (MOTIR-3083). A `parentRef` is either an
    // intra-plan temp-ref (`planItem:<id>`, which already has a node in the
    // proposed set) or a real work-item id — and the second kind is the one the
    // canvas has to open a LEVEL at and the breadcrumb has to name. It rides the
    // SAME batched read rather than a per-item query: a plan of thirty proposals
    // under one parent must still cost one round trip.
    const committedParentIds = plan.items
      .map((i) => i.parentRef)
      .filter((ref): ref is string => !!ref && !ref.startsWith(TEMP_REF_PREFIX));
    const lookupIds = Array.from(new Set([...targetIds, ...committedParentIds]));
    const targets = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findByIdsInWorkspace(lookupIds, ctx.workspaceId, tx),
    );
    const targetById = new Map(targets.map((t) => [t.id, t]));

    const staleByItem = new Map(staleness.items.map((s) => [s.planItemId, s]));

    // Resolve node ids first, so `hasChildren` can be computed across the forest.
    //
    // ONE rule for all three ops (MOTIR-3160): the work item this proposal is
    // ABOUT, falling back to the plan-item id when there is not one yet. An
    // un-materialized `add` still keys by its own id — it is not about anything
    // yet — and `modify` / `remove` are unchanged, since they always had a
    // target. What changes is the `add` that has BEEN materialized: it used to
    // keep the plan-item id even after approve wrote down which work item it
    // became, so `mergePlanLevel` (which matches proposals to committed nodes by
    // node id) could never land it ON that node and pushed it out as a second,
    // keyless ghost beside the real one.
    const withNodeIds = plan.items.map((item) => ({
      item,
      nodeId: item.workItemId ?? item.id,
    }));
    // …and once a node id can DIFFER from the plan-item id, an intra-plan
    // (`planItem:<id>`) ref can no longer resolve to the referenced id itself:
    // it has to resolve to that item's NODE id, or a materialized parent's
    // children point at a node that is not on the canvas. Same for a
    // `blocked_by` edge between two proposals in one plan.
    const nodeIdByPlanItemId = new Map(withNodeIds.map(({ item, nodeId }) => [item.id, nodeId]));
    const resolveNodeRef = (ref: string): string => {
      const resolved = resolveRef(ref);
      return ref.startsWith(TEMP_REF_PREFIX)
        ? (nodeIdByPlanItemId.get(resolved) ?? resolved)
        : resolved;
    };
    const parentNodeIdOf = (item: PlanItemDto): string | null =>
      item.parentRef ? resolveNodeRef(item.parentRef) : null;
    const childParentIds = new Set(
      withNodeIds.map(({ item }) => parentNodeIdOf(item)).filter((p): p is string => p !== null),
    );

    const items: PlanReviewItemDto[] = withNodeIds.map(({ item, nodeId }) => {
      const target = item.workItemId ? targetById.get(item.workItemId) : undefined;
      const stale = staleByItem.get(item.id);
      const reasons: StaleReason[] = stale?.reasons ?? [];
      const proposed = item.proposedFields as PlanItemProposedFields | null;

      const targetMissing = item.op !== 'add' && !target;

      // The COMMITTED parent, when there is one. A `planItem:` parent already has
      // a node in the proposed set, so it needs no resolution; an archived or
      // hard-deleted parent simply does not come back from the read, and the item
      // then reads as a root — degrade, never throw (MOTIR-3083 AC 5).
      const committedParent =
        item.parentRef && !item.parentRef.startsWith(TEMP_REF_PREFIX)
          ? targetById.get(item.parentRef)
          : undefined;

      return {
        planItemId: item.id,
        op: item.op,
        nodeId,
        parentNodeId: parentNodeIdOf(item),
        parentIdentifier: committedParent?.identifier ?? null,
        parentTitle: committedParent?.title ?? null,
        parentKind: committedParent?.kind ?? null,
        blockedByNodeIds: item.blockedByRefs.map(resolveNodeRef),
        // The target's key, for EVERY op that has a target (MOTIR-3160). An
        // un-materialized `add` still reports null — it has no key and inventing
        // one would be the surface asserting a work item that does not exist —
        // but an approved one now names the card it became, which is what lets a
        // reader answer *what did I just say yes to?* on the surface that asked.
        identifier: target?.identifier ?? null,
        title:
          item.op === 'add'
            ? (proposed?.title ?? 'Untitled item')
            : (target?.title ?? 'Unavailable item'),
        kind: item.op === 'add' ? (proposed?.kind ?? 'task') : (target?.kind ?? 'task'),
        // The add's editable proposed values (the inline edit form seeds from
        // these); null for modify/remove — only an `add` is editable (7.21.6).
        priority: item.op === 'add' ? (proposed?.priority ?? null) : null,
        type: item.op === 'add' ? (proposed?.type ?? null) : null,
        descriptionMd: item.op === 'add' ? (proposed?.descriptionMd ?? null) : null,
        // The rest of the proposed set (MOTIR-3084) — everything `materialize`
        // writes onto the created item, so the reviewer sees what approval will
        // make. Read off `proposed` rather than enumerated by hand anywhere else;
        // the parity test is what keeps this list honest as the type grows.
        explanationMd: item.op === 'add' ? (proposed?.explanationMd ?? null) : null,
        explanationSource: item.op === 'add' ? (proposed?.explanationSource ?? null) : null,
        storyPoints: item.op === 'add' ? (proposed?.storyPoints ?? null) : null,
        estimateMinutes: item.op === 'add' ? (proposed?.estimateMinutes ?? null) : null,
        targetRepo: item.op === 'add' ? (proposed?.targetRepo ?? null) : null,
        targetRepoRole: item.op === 'add' ? (proposed?.targetRepoRole ?? null) : null,
        executor: item.op === 'add' ? (proposed?.executor ?? null) : null,
        planningProvenance: item.op === 'add' ? (proposed?.planningProvenance ?? null) : null,
        // Same rule, same source, same read (MOTIR-3160): a materialized `add`
        // has a live status because it is a live work item. Populating the
        // identifier off `target` and leaving the status null would split one
        // batched read across two cards for no reason.
        status: target?.status ?? null,
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
    // WHO ASKED (MOTIR-2991) — resolved exactly as the decider is, one plan and
    // one lookup. (The LIST does this batched, across a page; here there is a
    // single row, so a second `findById` is the right shape and matches the
    // pattern immediately above rather than inventing one.)
    const createdByName = plan.createdById
      ? ((await userRepository.findById(plan.createdById))?.name ?? null)
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
      // The three-party attribution the header renders (`design-notes.md`
      // Part III §6). `origin` + `sourceJobId` are carried because they are what
      // separate *Motir generated it* from *nobody asked* from *unattributed* —
      // the authorship columns alone cannot tell those apart.
      origin: plan.origin,
      sourceJobId: plan.sourceJobId,
      createdByName,
      authorSource: plan.authorSource,
      authorHarness: plan.authorHarness,
      authorModel: plan.authorModel,
      history,
      items,
      stale: staleCount > 0,
      staleCount,
    };
  },
};
