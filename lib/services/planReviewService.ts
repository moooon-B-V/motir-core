import type { WorkItem } from '@/generated/prisma/client';

import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { fullestContainer } from '@/lib/planning/planShape';
import { TREE_LEVEL_MAX_TAKE } from '@/lib/planning/levelCaps';
import { userRepository } from '@/lib/repositories/userRepository';
import { planRevisionRepository } from '@/lib/repositories/planRevisionRepository';
import { DERIVED_EVENT_KINDS, mergeTimeline, revisionCount } from '@/lib/plans/timeline';
import {
  revisionLeaseOf,
  REVISION_STARTED_KIND,
  REVISION_ENDED_KIND,
} from '@/lib/planChange/revisionLease';

import { plansService } from '@/lib/services/plansService';
import { planStalenessService } from '@/lib/services/planStalenessService';
import { workflowsService } from '@/lib/services/workflowsService';

import type {
  PlanItemDto,
  PlanItemPatch,
  PlanItemProposedFields,
  StaleReason,
} from '@/lib/dto/plans';
import type { PlanRevision } from '@/generated/prisma/client';
import type {
  PlanHistoryEventDto,
  PlanItemChangeDto,
  PlanItemChangeField,
  PlanParentCrumbDto,
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

/**
 * How much of a long prose body the diff cell carries per side (bug MOTIR-3191).
 *
 * A PREVIEW rather than the whole body, and the bound is deliberate: the review
 * model is read on every poll of a `generating` plan, and a plan of thirty
 * `modify` proposals would otherwise put sixty full descriptions on the wire to
 * fill two truncated cells. 140 characters is roughly the first sentence, which
 * is where a rewritten description tells you it was rewritten.
 */
const PROSE_PREVIEW_CHARS = 140;

/**
 * One long Markdown body as a single readable line: whitespace squeezed (a body
 * is multi-paragraph and the cell is one line) and cut at
 * {@link PROSE_PREVIEW_CHARS}. `null` for an absent or blank body, which is what
 * the diff cell renders as "nothing there before".
 */
function prosePreview(value: string | null | undefined): string | null {
  if (value == null) return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  return flat.length > PROSE_PREVIEW_CHARS ? `${flat.slice(0, PROSE_PREVIEW_CHARS - 1)}…` : flat;
}

/** A repo pin as the APPROVE will store it: a blank / whitespace-only string is
 *  an UNPIN, exactly as `PlanItemPatch.targetRepo` documents and as
 *  `resolveAuthoredTargetRepoInProject` applies it (MOTIR-3868). Diffing the raw
 *  string instead would render `motir-core → "  "` as a change to a repository
 *  whose name is two spaces, and would report a no-op unpin of an already-null
 *  pin as a change. */
function blankToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** The OLD → NEW field changes a `modify` proposes (its diff overlay).
 *
 *  `nameParent` renders a parent id as the reader's own word for it — the
 *  identifier where one is resolvable, `null` for the project root — so the
 *  re-parent row reads `PROD-14 → PROD-9` rather than as two cuids (MOTIR-3859).
 */
function buildChanges(
  patch: PlanItemPatch | null,
  target: WorkItem | undefined,
  nameParent: (id: string | null) => string | null,
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
    // ⚠️ A REAL old→new pair, not the word "updated" (bug MOTIR-3191). This cell
    // used to read `— → updated`, which is a notification rather than a diff: it
    // told a reviewer that the half of the card they most need to judge had moved
    // and refused to say where to. Panel B of `design/ai-planning/design-notes.md`
    // has always specified *"an inline old→new diff (old read live from the
    // target, new from `patch`)"* for a `modify`, and prose is the one field that
    // never honoured it. It is a PREVIEW of each side (see `prosePreview`) — the
    // cell is one line — but it is a preview of the ACTUAL values.
    changes.push({
      field: 'description',
      from: prosePreview(target?.descriptionMd),
      to: prosePreview(patch.descriptionMd),
    });
  }
  // …and the SECOND body (MOTIR-3111). Same treatment as the description above —
  // long prose, so each side is previewed. It is listed because the
  // explanation is the half a reviewer reads to decide whether a proposed
  // re-shape is right: a `modify` that silently rewrote the WHY while the review
  // surface showed nothing would defeat the point of putting the plan in front of
  // a person at all.
  if (
    patch.explanationMd !== undefined &&
    patch.explanationMd !== (target?.explanationMd ?? null)
  ) {
    changes.push({
      field: 'explanation',
      from: prosePreview(target?.explanationMd),
      to: prosePreview(patch.explanationMd),
    });
  }
  // WHERE THE CARD SITS (MOTIR-3859) — the SITS half of D3's pair, and the most
  // structural thing a `modify` can now say. It is listed for the same reason the
  // explanation is: routing a re-parent through the proposal door buys nothing at
  // all if the surface the approver reads does not show the move. An explicit
  // `null` renders as an empty NEW side, which is what "the project root" looks
  // like in a diff cell.
  if (patch.parentRef !== undefined) {
    const from = nameParent(target?.parentId ?? null);
    const to = nameParent(patch.parentRef ?? null);
    if (from !== to) changes.push({ field: 'parent', from, to });
  }
  // WHERE THE CARD SHIPS (MOTIR-1884 / MOTIR-1912, surfaced by bug MOTIR-3868) —
  // the SHIPS half of the pair `parent` above completes. Both keys reached
  // `applyModify` and neither reached this producer, so a `modify` carrying only
  // a re-pin rendered with an EMPTY change list. That is silent in the direction
  // that hides it: an empty `changes` array is a legal, ordinary shape (a
  // `remove` has one), so nothing rendered wrong and nothing failed — the
  // approver's only options were to approve a change they could not see or
  // decline a plan that may have been entirely correct.
  //
  // Blank normalizes to null, mirroring the patch's own documented contract
  // (*"an explicit `null` (or a blank string, which normalizes to `null`)
  // UNPINS"*) and `resolveAuthoredTargetRepoInProject`, which is what actually
  // applies it — so the cell renders the value the approve will write, not the
  // string that was typed. An explicit unpin is an empty NEW side.
  if (patch.targetRepo !== undefined) {
    const from = blankToNull(target?.targetRepo ?? null);
    const to = blankToNull(patch.targetRepo);
    if (from !== to) changes.push({ field: 'targetRepo', from, to });
  }
  // …and the ROLE, which is emitted on KEY PRESENCE rather than on a difference,
  // because there is NO OLD SIDE TO COMPARE AGAINST.
  //
  // ⚠️ `work_item.targetRepoRole` is RETIRED (Story MOTIR-2732 · MOTIR-3040, ADR
  // `work-item-repository-set.md` §A3). The role is an ADDRESSING MODE resolved
  // at approve — `proposalRepoRef(name, role, refs)` picks a `project_repo` row
  // by name first and by role second — not an attribute stored on the item, so
  // `target` cannot supply a `from` and a difference cannot be computed. Presence
  // is exactly the right trigger regardless: `applyModify` rewrites the item's
  // repository reference whenever this key is present (`repoPins.has(item.id) ||
  // patch.targetRepoRole !== undefined`), including when the resolved name does
  // not change. So the row appears precisely when the approve will act.
  //
  // A null `from` is honest here and is NOT MOTIR-3191's `— → updated`: that cell
  // hid a value that EXISTED. This one names the new role on the side that has
  // one, and the absent old side is the schema's own shape.
  if (patch.targetRepoRole !== undefined) {
    changes.push({ field: 'targetRepoRole', from: null, to: patch.targetRepoRole ?? null });
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

/**
 * When the plan's LATEST revision began, or null if it has never been revised.
 *
 * Walks backwards to the most recent `revision_started`, whether or not it has
 * been terminated — a LANDED revision is exactly the case the *Revised* pill
 * exists for, so stopping at a terminator (as the lease predicate must) would
 * blank the marker the moment the thing it marks finished.
 */
function lastRevisionStartAt(
  rows: readonly { changeKind: string; changedAt: Date }[],
): Date | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]!.changeKind === REVISION_STARTED_KIND) return rows[i]!.changedAt;
  }
  return null;
}

/**
 * The proposals the latest revision touched — every trail row at or after
 * `startedAt` that names one.
 *
 * The two BRACKET rows are excluded: they carry no `planItemId` (they are about
 * the plan, not a proposal), so they contribute nothing either way, and naming
 * them here would be a claim about a row that has no target.
 */
function revisedSince(
  rows: readonly { changeKind: string; changedAt: Date; planItemId: string | null }[],
  startedAt: Date | null,
): Set<string> {
  const touched = new Set<string>();
  if (!startedAt) return touched;
  for (const r of rows) {
    if (r.changedAt < startedAt) continue;
    if (r.changeKind === REVISION_STARTED_KIND || r.changeKind === REVISION_ENDED_KIND) continue;
    if (r.planItemId) touched.add(r.planItemId);
  }
  return touched;
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
    // The plan's CONTENT trail (MOTIR-3536) — ONE query for the whole history,
    // walking the `(plan_id, changed_at)` index. It rides the plan read rather
    // than a per-event query because this model is re-read on every poll of a
    // `generating` plan, which is exactly the surface a row-per-round-trip would
    // punish hardest.
    //
    // ⚠️ BOUND, not the `db` singleton: `plan_revision` carries no `workspace_id`
    // and its policy joins to the parent `plan`, so an unbound read returns an
    // EMPTY trail rather than an error — a plan's whole history silently gone.
    const revisions = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRevisionRepository.listByPlan(planId, tx),
    );

    // ── THE REVISION, read off the SAME trail (Subtask MOTIR-3601) ────────────
    // The lease IS a `revision_started` with no `revision_ended` after it, inside
    // the window (`agent-authored-plans.md` AMENDMENT 10 D2) — so the surface
    // that must hold Approve and the timeline that tells the reviewer WHY read
    // one fact from one place, and nothing needed a column.
    const lease = revisionLeaseOf(revisions, new Date());
    const revisionStartedAt = lastRevisionStartAt(revisions);
    // WHICH proposals the latest revision touched. Every trail row written at or
    // after that start names its `planItemId`, so the set falls out of rows this
    // method already has. An unrevised plan yields an empty set and every row
    // renders exactly as it did before this story.
    const revisedItemIds = revisedSince(revisions, revisionStartedAt);

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
    // …AND the parent a `modify` proposes to MOVE its target to (MOTIR-3859).
    // It is a committed work item like any other parent — the append refuses a
    // temp-ref there — so it rides the same batched read, and both the diff cell
    // and the canvas placement below need its row.
    const reparentIds = plan.items
      .map((i) => (i.op === 'modify' ? (i.patch?.parentRef ?? null) : null))
      .filter((ref): ref is string => !!ref && !ref.startsWith(TEMP_REF_PREFIX));
    const lookupIds = Array.from(new Set([...targetIds, ...committedParentIds, ...reparentIds]));
    const targets = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.findByIdsInWorkspace(lookupIds, ctx.workspaceId, tx),
    );
    const targetById = new Map(targets.map((t) => [t.id, t]));

    // …AND the LIVE PARENT of every proposal that names a TARGET instead of a
    // parent (bug MOTIR-3191).
    //
    // A `modify` / `remove` carries NO `parentRef` and cannot: its parent is
    // whatever the live card already has, and the contract deliberately forbids a
    // proposal from re-parenting anything (`docs/decisions/agent-authored-plans.md`).
    // Reading placement off `parentRef` ALONE therefore gave it a null parent —
    // which every consumer reads as *a root*. So an amendment to a subtask five
    // levels down drew at the PROJECT ROOT, beside the `add`s the plan rules
    // reserve that level for, and a reviewer applying the root-is-for-epics rule
    // to what the surface showed was correct to decline it. The parent is not
    // absent; it is on the TARGET, one field away.
    const targetParentIds = plan.items
      .map((i) => (i.workItemId ? (targetById.get(i.workItemId)?.parentId ?? null) : null))
      .filter((id): id is string => id !== null);

    // …AND the committed parents' OWN ancestors (bug MOTIR-3152), because the
    // breadcrumb the canvas opens with is the whole CHAIN down to the level, not
    // its last link. The read above resolves the parent; walking UP from it is a
    // second question and needs a second read.
    //
    // ONE batched read PER TREE LEVEL, not one per item: the ids of each round's
    // parents are collected and fetched together, and the loop stops when a round
    // adds nothing new. The tree is depth-capped (Story 1.4), so a plan of thirty
    // proposals under one parent still costs at most a handful of round trips —
    // the same "never an N+1" property the target read above has.
    //
    // A `findAncestors` per parent would be the obvious alternative and is the
    // one this deliberately avoids: it is one query PER PARENT, and a plan may
    // legitimately propose under many.
    //
    // The frontier is seeded with every id that must END UP in `ancestorById`:
    // the committed parents' own parents (their rows came back in round 1), and
    // — MOTIR-3191 — the inherited parents themselves, which did not.
    const ancestorById = new Map(targets.map((t) => [t.id, t]));
    let frontier = Array.from(
      new Set([
        ...committedParentIds
          .map((id) => targetById.get(id)?.parentId)
          .filter((id): id is string => !!id),
        ...targetParentIds,
      ]),
    );
    // A hard bound as well as the natural one: a cycle in `parentId` is not
    // representable through the API, but this loop must terminate on a corrupt
    // row rather than hang the plan page.
    for (let depth = 0; depth < 16 && frontier.length > 0; depth++) {
      const unseen = frontier.filter((id) => !ancestorById.has(id));
      if (unseen.length === 0) break;
      const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.findByIdsInWorkspace(unseen, ctx.workspaceId, tx),
      );
      for (const row of rows) ancestorById.set(row.id, row);
      frontier = Array.from(
        new Set(rows.map((r) => r.parentId).filter((id): id is string => !!id)),
      );
    }

    /**
     * The committed ancestor path down to `parentId`, ROOT FIRST and the parent
     * itself LAST. `[]` when there is no committed parent, and a chain that runs
     * out (an archived / hard-deleted ancestor the read did not return) simply
     * STOPS there — the crumbs above it are lost, the ones below it are not, and
     * nothing throws. That is the same degrade-rather-than-fail contract the
     * parent fields themselves carry.
     */
    const trailFor = (parentId: string | null): PlanParentCrumbDto[] => {
      const trail: PlanParentCrumbDto[] = [];
      let cursor = parentId;
      const guard = new Set<string>();
      while (cursor && !guard.has(cursor)) {
        guard.add(cursor);
        const row = ancestorById.get(cursor);
        if (!row) break;
        trail.unshift({ id: row.id, identifier: row.identifier, title: row.title });
        cursor = row.parentId;
      }
      return trail;
    };

    /** A parent id as the reader's own word for it (MOTIR-3859): its identifier
     *  when the row is resolvable, `null` for the project root — and, for a row
     *  neither read returned (archived, hard-deleted), the id itself rather than
     *  nothing, so the cell degrades to something checkable instead of claiming
     *  the card moved to the root. */
    const nameParent = (id: string | null): string | null => {
      if (id === null) return null;
      const row = targetById.get(id) ?? ancestorById.get(id);
      return row?.identifier ?? id;
    };

    const staleByItem = new Map(staleness.items.map((s) => [s.planItemId, s]));

    // The project's WORKFLOW, so a target's status can carry its own identity —
    // label + lifecycle category — to the canvas chip (bug MOTIR-3170). The chip
    // used to receive a bare key and narrow it against a six-member literal,
    // which drew a `modify` whose target sits at `implemented` as "To Do". One
    // read per plan page; the statuses are per-project and there is one project.
    const statusByKey = new Map(
      (await workflowsService.listStatusesByProject(plan.projectId, ctx.workspaceId)).map((s) => [
        s.key,
        s,
      ]),
    );

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
    /**
     * Every blocker this proposal declares, as canvas NODE ids — from BOTH
     * carriers (bug MOTIR-3366).
     *
     * A plan states a `blocked_by` edge in two places, and which one it uses is
     * decided by the OP, not by the author: an `add` names its blockers in its
     * own `blockedByRefs`, while a `modify` names them in `patch.blockedByAdd` —
     * the only way to propose an edge ONTO a card that already exists, and
     * therefore the shape of every mid-run correction (`add` the prerequisite,
     * `modify` the in-flight card to be blocked by it, one approval for both).
     *
     * This read took the first carrier alone, so a `modify`'s edges reached the
     * canvas as an empty array: `mergePlanLevel` draws one arrow per entry, had
     * none, and the proposed card rendered beside the card it blocks with no
     * line between them. The patch was already being read eleven lines up to
     * produce the `links` diff row, so the edge was present as a counted word
     * and absent as a shape — which is why nothing looked broken.
     *
     * `blockedByRemove` is deliberately NOT here, and STILL is not: an edge the
     * plan would DELETE is not a blocker this proposal declares, and drawing it
     * as one would say the opposite of what the plan proposes. That reasoning
     * was right and is unchanged — what was missing is the OTHER half, and it
     * is {@link blockedByRemovedNodeIdsOf} below (bug MOTIR-4092).
     *
     * `planProjectionService` unions the same two carriers for the projected
     * reads — one rule, two consumers.
     */
    const blockedByNodeIdsOf = (item: PlanItemDto): string[] => {
      const refs = [...item.blockedByRefs, ...(item.patch?.blockedByAdd ?? [])];
      return [...new Set(refs.map(resolveNodeRef))];
    };
    /**
     * Every COMMITTED blocked-by edge this proposal would DELETE, as canvas node
     * ids (bug MOTIR-4092) — the second half of the sentence above.
     *
     * The exclusion from `blockedByNodeIdsOf` deferred a *treatment the canvas
     * does not have* to "its own card". Until that card, the consequence was
     * that a removal reached the canvas as NOTHING: `mergePlanLevel` started
     * from the committed deps verbatim, so the edge the plan is deleting kept
     * rendering exactly like one it is keeping.
     *
     * ⚠️ THE SHAPE THAT MAKES IT WRONG RATHER THAN MERELY INCOMPLETE is an EDGE
     * SWAP — the correction for an inverted dependency, and the standard output
     * of the run-time correction path. It is necessarily two proposals
     * (`modify A` removing `B`, `modify B` adding `A`), so with the removal
     * unread the canvas drew A → B AND B → A: a mutual block, i.e. a cycle the
     * approve will not produce. The only correct reading of that picture is
     * *"this plan is broken"*, and the plan is fine — so the surface was at its
     * least accurate on exactly the plans a reviewer cannot re-derive by hand.
     *
     * The canvas answers it by SUBTRACTION, not by a marking (bug MOTIR-4098):
     * `mergePlanLevel`
     * drops the committed dep this names, so the graph shows the edge set the
     * approve would leave behind. A marked-as-going-away edge was tried first
     * and reverted — a drawn arrow is read as structure however it is skinned,
     * and the words for the change already exist in the `links` diff row.
     *
     * A removal only bites where the edge EXISTS to begin with, so this resolves
     * refs and leaves it to the level builder to intersect them with the
     * committed deps — a `blockedByRemove` naming an edge that is not on this
     * level simply subtracts nothing, which is the same tolerance the add
     * carrier already has.
     */
    const blockedByRemovedNodeIdsOf = (item: PlanItemDto): string[] => {
      const refs = item.patch?.blockedByRemove ?? [];
      return [...new Set(refs.map(resolveNodeRef))];
    };
    /**
     * Where this proposal SITS — one rule for all three ops (bug MOTIR-3191).
     *
     * An `add` says so itself, in `parentRef`. A `modify` says so too now — in
     * `patch.parentRef`, the re-parent key (MOTIR-3859). A `remove` cannot, and a
     * `modify` that does not touch the parent cannot either: its placement is the
     * live card's, read off that card.
     *
     * ⚠️ THIS COMMENT USED TO SAY *"a proposal may not move anything"*, and that
     * was true when it was written. It is the sentence MOTIR-3859 makes false, and
     * the canvas is the surface where the difference has to show: a re-parent that
     * drew the card in its OLD level would be the plan review showing the approver
     * the opposite of what approving does. The `undefined` / `null` split is
     * load-bearing here as everywhere in a sparse patch — absent means the parent
     * is unchanged, an explicit `null` means the PROJECT ROOT.
     *
     * A materialized `add` has both; `parentRef` wins, and the two agree.
     */
    const parentNodeIdOf = (item: PlanItemDto): string | null => {
      if (item.parentRef) return resolveNodeRef(item.parentRef);
      if (item.op === 'modify' && item.patch?.parentRef !== undefined) {
        return item.patch.parentRef === null ? null : resolveNodeRef(item.patch.parentRef);
      }
      const target = item.workItemId ? targetById.get(item.workItemId) : undefined;
      return target?.parentId ?? null;
    };
    const childParentIds = new Set(
      withNodeIds.map(({ item }) => parentNodeIdOf(item)).filter((p): p is string => p !== null),
    );

    const items: PlanReviewItemDto[] = withNodeIds.map(({ item, nodeId }) => {
      const target = item.workItemId ? targetById.get(item.workItemId) : undefined;
      const stale = staleByItem.get(item.id);
      const reasons: StaleReason[] = stale?.reasons ?? [];
      const proposed = item.proposedFields as PlanItemProposedFields | null;

      const targetMissing = item.op !== 'add' && !target;

      // The COMMITTED parent, when there is one. Two sources now (MOTIR-3191):
      // a `parentRef` naming a real work item — an `add`, saying where it wants
      // to land — and the parent a `modify` / `remove` INHERITS from its target,
      // which is the only way a proposal about an existing card can name one. An
      // intra-plan (`planItem:`) parent is neither: it already has a node in the
      // proposed set, so the canvas draws it and the breadcrumb does not.
      //
      // The row comes from either batched map: a `parentRef` target was read in
      // round 1, an inherited parent by the ancestor walk. An archived or
      // hard-deleted parent is in neither, and the item then reads as a root —
      // degrade, never throw (MOTIR-3083 AC 5).
      const parentNodeId = parentNodeIdOf(item);
      const committedParentId = item.parentRef
        ? item.parentRef.startsWith(TEMP_REF_PREFIX)
          ? null
          : item.parentRef
        : parentNodeId;
      // `parentNodeIdOf` already prefers a `modify`'s `patch.parentRef`
      // (MOTIR-3859), so the breadcrumb and the level follow the PROPOSED
      // placement rather than the one the card is leaving.
      const committedParent = committedParentId
        ? (targetById.get(committedParentId) ?? ancestorById.get(committedParentId))
        : undefined;

      return {
        planItemId: item.id,
        op: item.op,
        nodeId,
        parentNodeId,
        parentIdentifier: committedParent?.identifier ?? null,
        parentTitle: committedParent?.title ?? null,
        parentKind: committedParent?.kind ?? null,
        // MOTIR-3152's committed ancestor trail — unchanged by this merge.
        parentTrail: committedParent ? trailFor(committedParent.id) : [],
        blockedByNodeIds: blockedByNodeIdsOf(item),
        blockedByRemovedNodeIds: blockedByRemovedNodeIdsOf(item),
        // The target's key, for EVERY op that has a target (MOTIR-3160). An
        // un-materialized `add` still reports null — it has no key and inventing
        // one would be the surface asserting a work item that does not exist —
        // but an approved one now names the card it became, which is what lets a
        // reader answer *what did I just say yes to?* on the surface that asked.
        identifier: target?.identifier ?? null,
        // THE TITLE THE PROPOSAL IS ASKING FOR (MOTIR-4018, Part XIII §1).
        //
        // A `modify` carrying `patch.title` reports THAT, not the name the card
        // is about to stop being called. `buildChanges` eleven lines up already
        // knew — it emits `{ field: 'title', from: target, to: patch.title }` —
        // so the same response was carrying the proposed title in one field and
        // refusing it in the other.
        //
        // The fix is at the PRODUCER, once: every consumer reads this field and
        // none of them should have to learn about `patch` (the shape MOTIR-3191
        // established one axis over, for the same model getting a `modify`'s
        // PLACEMENT wrong). The patch is SPARSE, so `?? target?.title` is
        // load-bearing: an absent `title` means the name is unchanged.
        title:
          item.op === 'add'
            ? (proposed?.title ?? 'Untitled item')
            : ((item.op === 'modify' ? item.patch?.title : undefined) ??
              target?.title ??
              'Unavailable item'),
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
        // The status's own IDENTITY (bug MOTIR-3170) — its label and lifecycle
        // category, so the canvas chip can name a status it has no per-key
        // treatment for instead of coercing it to `todo`. Resolved off the SAME
        // `target`, and therefore under MOTIR-3160's rule directly above rather
        // than the `op === 'add'` guard that rule removed: a status that is
        // non-null must be nameable, or the chip is back to guessing.
        statusLabel: statusByKey.get(target?.status ?? '')?.label ?? null,
        statusCategory: statusByKey.get(target?.status ?? '')?.category ?? null,
        hasChildren: childParentIds.has(nodeId),
        changes: item.op === 'modify' ? buildChanges(item.patch, target, nameParent) : [],
        // A RECENCY fact, not a second reading of `op` (Part XII §E).
        revised: revisedItemIds.has(item.id),
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

    const derived: PlanHistoryEventDto[] = [
      { id: 'lifecycle:created', kind: 'created', at: plan.createdAt },
    ];
    if (plan.plannedAt)
      derived.push({ id: 'lifecycle:planned', kind: 'planned', at: plan.plannedAt });
    if (plan.status === 'approved' || plan.status === 'declined') {
      // The EVENT kind, which for a `declined` plan is not the status
      // (MOTIR-3189). One status covers three histories — a person rejected a
      // finished plan, a person discarded one mid-generation, the sweep
      // terminated a dead producer — and the timeline is where the difference
      // has to be visible. `reviewed` and a null reason both land on `declined`:
      // an unrecorded reason is the pre-column default, and inventing a more
      // specific event for it would be a guess.
      const kind =
        plan.status === 'declined' && plan.decisionReason && plan.decisionReason !== 'reviewed'
          ? plan.decisionReason
          : plan.status;
      derived.push({ id: `lifecycle:${kind}`, kind, at: plan.decidedAt, byName: decidedByName });
    }

    // The CONTENT half. Every actor NAME the trail needs resolves in ONE batched
    // read — a plan deepened proposal by proposal has a row per proposal, and a
    // `findById` per row is the N+1 this surface cannot afford.
    const actorIds = Array.from(
      new Set(revisions.map((r) => r.changedById).filter((id): id is string => !!id)),
    );
    const actorNameById = new Map(
      (actorIds.length > 0 ? await userRepository.findByIds(actorIds) : []).map((u) => [
        u.id,
        u.name,
      ]),
    );
    const stored: PlanHistoryEventDto[] = revisions
      // The four the derived events already say, dropped HERE rather than at the
      // write: the trail is the audit record and must be complete; the timeline
      // is a reading of it and must not say the same thing twice.
      .filter((r: PlanRevision) => !DERIVED_EVENT_KINDS.has(r.changeKind))
      .map((r: PlanRevision) => ({
        id: r.id,
        kind: r.changeKind,
        at: r.changedAt.toISOString(),
        count: revisionCount(r.diff),
        byName: r.changedById ? (actorNameById.get(r.changedById) ?? null) : null,
        actorSource: r.actorSource,
        actorHarness: r.actorHarness,
        actorModel: r.actorModel,
      }));

    const history = mergeTimeline(derived, stored);

    const staleCount = items.filter((i) => i.stale).length;

    // ── HOW BIG IS THE LEVEL THE CANVAS ARRIVES AT (MOTIR-4024, Part XIII §6) ──
    //
    // The derived default view has to answer *can the canvas hold this plan's
    // cards together?* BEFORE the canvas has drawn anything, and the answer is
    // about the level's COMMITTED neighbourhood, which the plan's own items say
    // nothing about. So it is read once, here, where the arrival container is
    // already resolved — `fullestContainer` is the same function the arrival
    // level itself reads, so the two cannot name different levels.
    //
    // A container that is ITSELF a proposal has no committed children, and the
    // count comes back 0 without a special case: no work item carries that id.
    const arrivalContainer = fullestContainer(items);
    const arrivalParentId = arrivalContainer?.parentNodeId ?? null;
    const arrivalLevelTotal =
      (await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.countSiblingsInWorkspace(
          plan.projectId,
          arrivalParentId,
          ctx.workspaceId,
          tx,
        ),
      )) +
      // The plan's own `add`s draw a node each and no committed row backs them.
      // A `modify` / `remove` SHARES its node with the committed card it targets,
      // so counting it again would double it.
      items.filter((i) => i.op === 'add' && (i.parentNodeId ?? null) === arrivalParentId).length;
    // What the canvas will actually DRAW: the level read is capped, so a level
    // past the cap draws the cap, not its total. Both numbers are carried because
    // the two arms of the rule read different ones — the legibility arm reads what
    // is drawn, the truncation arm reads what was dropped.
    const arrivalLevelSize = Math.min(arrivalLevelTotal, TREE_LEVEL_MAX_TAKE);

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
      // WHY it ended (MOTIR-3189) — read by the outcome block, which otherwise
      // tells somebody their half-generated plan was reviewed and rejected.
      decisionReason: plan.decisionReason,
      // The three-party attribution the header renders (`design-notes.md`
      // Part III §6). `origin` separates *nobody asked* from a plan somebody
      // requested; the authorship triple now answers *who wrote it* on its own,
      // so `sourceJobId` is no longer carried (MOTIR-2996) — it named WHICH JOB
      // and was only ever here to stand in for WHO.
      origin: plan.origin,
      createdByName,
      authorSource: plan.authorSource,
      authorHarness: plan.authorHarness,
      authorModel: plan.authorModel,
      // Present ⟺ the lease is HELD. A null is one check at the call site and
      // cannot be misread as *a revision that finished*.
      revision: lease
        ? {
            heldBy: lease.heldBy,
            expiresAt: lease.expiresAt.toISOString(),
            startedAt: (revisionStartedAt ?? new Date()).toISOString(),
          }
        : null,
      history,
      items,
      stale: staleCount > 0,
      staleCount,
      arrivalLevelSize,
      arrivalLevelTotal,
    };
  },
};
