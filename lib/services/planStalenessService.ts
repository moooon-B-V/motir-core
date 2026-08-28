import type { PlanItem, WorkItem } from '@/generated/prisma/client';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

import type { ServiceContext } from '@/lib/workItems/serviceContext';

import { planRepository } from '@/lib/repositories/planRepository';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';

import { projectAccessService } from '@/lib/services/projectAccessService';

import { PlanNotFoundError } from '@/lib/plans/errors';

import type { PlanItemStalenessDto, PlanStalenessDto, StaleReason } from '@/lib/dto/plans';

// Plan staleness detection (Story 7.21 · MOTIR-1340) — the foundation the plan
// review UIs read. Between when a Plan is generated (`planned`) and when the
// user reviews/approves it, the COMMITTED work-item tree can change (another
// plan is approved, a manual edit lands, items are archived). A proposed item
// generated against the OLD tree can DRIFT; this service computes — per proposed
// `PlanItem` — WHY, so the user can SEE it and decide (approve anyway / decline
// / regenerate).
//
// ⚠️ DRIFT IS MEASURED ON WHAT THE PROPOSAL NAMED (MOTIR-3777) — its parent, its
// declared blockers, its modify/remove target — never on what happened NEARBY. A
// warning on the one surface whose entire purpose is to be trustworthy about a
// decision costs the reviewer's trust every time it fires, so a rule that cannot
// tell a related change from an unrelated one does not belong here.
//
// Contracts (the card):
//   - PURE READ. Staleness NEVER blocks approve; it WARNS. Writes nothing, opens
//     no transaction (read-only paths use the `db` singleton via the repos).
//   - BATCHED. Every cross-tree read is one round-trip over the whole plan
//     (no N+1): the referenced work items, the new siblings, the latest
//     revisions — each a single query, regardless of how many PlanItems.
//   - TENANT-SCOPED. The plan is loaded workspace-scoped (404-not-403 via
//     PlanNotFoundError), browse access is asserted (ProjectAccessDeniedError →
//     404), and every tree read is workspace-scoped (finding-#26). A
//     cross-tenant referenced id simply never comes back → treated as removed.
//   - SWAPPABLE / EXTENSIBLE. The verdict is a REASON LIST, not a boolean, and
//     the rule set is an ordered array (`RULES`) behind the service interface —
//     a new rule is one entry, no caller change.
//   - A plan unchanged since `plannedAt` returns all-clear.

const TEMP_REF_PREFIX = 'planItem:';

/** A ref is "real" (points at a committed work item) when it is NOT an
 *  intra-plan temp-ref `planItem:<id>` (which points at another `add` in the
 *  same plan — not in the tree, so nothing to be stale against). */
function isRealRef(ref: string): boolean {
  return !ref.startsWith(TEMP_REF_PREFIX);
}

/** The batched tree snapshot every rule reads from — built once per plan.
 *
 *  ⚠️ NOTHING HERE IS `plannedAt`-RELATIVE ANY MORE (MOTIR-3777). Every rule now
 *  keys on something the PROPOSAL named — its parent, its declared blockers, its
 *  modify/remove target — so the snapshot is a snapshot of those referents and
 *  not of the tree's recent traffic. */
interface StalenessContext {
  /** A referenced work item is REMOVED when it is missing (hard-deleted /
   *  cross-tenant) OR archived. Archived counts as removed (the card). */
  isRemoved: (workItemId: string) => boolean;
  /** Each (modify/remove) target's CURRENT latest revision id, for the
   *  base-revision drift compare. Absent = the target has no revisions. */
  latestRevByTarget: Map<string, string | undefined>;
}

/** A staleness rule: maps one PlanItem (against the batched snapshot) to the
 *  reasons it triggers. Self-guards by `op`, so the engine applies them all
 *  uniformly and concatenates the results. */
type StalenessRule = (item: PlanItem, sctx: StalenessContext) => StaleReason[];

/** `add`: the proposal's real parent is archived/deleted → it would be orphaned
 *  on approve. (Intra-plan parents resolve at materialize, so they're skipped;
 *  a null parent is a root with no parent to lose.) */
const parentRemovedRule: StalenessRule = (item, sctx) => {
  if (item.op !== 'add') return [];
  const ref = item.parentRef;
  if (!ref || !isRealRef(ref) || !sctx.isRemoved(ref)) return [];
  return [{ code: 'parent_removed', parentId: ref }];
};

/** `add`: real `blocked_by` targets of the proposal that are now
 *  archived/deleted → a dangling dependency. */
const blockerRemovedRule: StalenessRule = (item, sctx) => {
  if (item.op !== 'add') return [];
  const blockerIds = item.blockedByRefs.filter(isRealRef).filter(sctx.isRemoved);
  return blockerIds.length > 0 ? [{ code: 'blocker_removed', blockerIds }] : [];
};

/** `modify`/`remove`: the target changed since the patch's `baseRevision`
 *  (`edited`), was `archived`, or is `missing` — applying the patch may conflict
 *  with a newer edit / clobber it. `edited` needs a `baseRevision` to anchor
 *  against; missing/archived are detectable without one. */
const baseRevisionDriftRule: StalenessRule = (item, sctx) => {
  if (item.op === 'add' || !item.workItemId) return [];
  // `isRemoved` distinguishes archived from missing via the snapshot map.
  if (sctx.isRemoved(item.workItemId)) {
    const change = sctx.latestRevByTarget.has(item.workItemId) ? 'archived' : 'missing';
    // `has` is true only for targets that came back from the batched read; a
    // missing (hard-deleted/cross-tenant) target never appears there.
    return [{ code: 'base_revision_drift', change }];
  }
  if (item.baseRevision == null) return [];
  const current = sctx.latestRevByTarget.get(item.workItemId);
  return current !== item.baseRevision ? [{ code: 'base_revision_drift', change: 'edited' }] : [];
};

/** The ordered rule set — extend by appending (the card's "swappable interface
 *  so the rule set can grow").
 *
 *  ⚠️ A NEW RULE ANSWERS *DID SOMETHING THIS PROPOSAL NAMED MOVE?* (MOTIR-3777).
 *  `siblingsAddedRule` sat second here and answered a different question — *is
 *  this parent busy?* — which is why it is gone rather than tuned. */
const RULES: StalenessRule[] = [parentRemovedRule, blockerRemovedRule, baseRevisionDriftRule];

export interface PlanStalenessService {
  /**
   * Compute per-item staleness for a plan against the CURRENT tree. Read-only;
   * tenant-scoped (404-not-403); batched (no N+1). Throws PlanNotFoundError when
   * the plan does not resolve in the workspace, and ProjectAccessDeniedError
   * (→ 404) when the actor cannot browse the project.
   *
   * ⚠️ ONLY AN UNDECIDED PLAN CAN BE STALE — `planned` OR `stale` (MOTIR-3165,
   * WIDENED by MOTIR-3578 per `docs/decisions/agent-authored-plans.md`
   * AMENDMENT 9 D3). Staleness answers one question — *would approving this now
   * still be correct?* — and on a DECIDED plan that question cannot be asked
   * again, which is the whole of MOTIR-3165's reasoning and is preserved here
   * exactly rather than overturned.
   *
   * What changed is that its predicate stopped matching its intent. `planned`
   * was a proxy for *is this plan still awaiting a decision?*, and a fifth
   * status is what makes the proxy and the intent come apart: a `stale` plan is
   * NOT decided — it is live, it is awaiting action, and it is the plan for
   * which that question matters MOST. Left at `planned` only, entering the new
   * status would silently stop producing per-proposal reasons, so the reviewer
   * would lose the one thing they need — *which proposal went stale* — at the
   * exact moment they need it. That is MOTIR-3560's own complaint arriving
   * through MOTIR-3560's own fix, which is why the amendment settles it.
   *
   * This rule OWNS itself here rather than in its callers: `planRowView`'s
   * `staleCountFor` and `autoPlanCadenceService`'s both wrote it by hand and
   * were right, while `getPlanReview` called the engine unconditionally — and
   * that one caller is the surface a person actually reads.
   *
   * On an approved plan the warning was not merely useless but CAUSED by the
   * approval: the retired `siblings_added` rule read the parent's post-`plannedAt`
   * children with no exclusion for the items the plan itself materialized, and
   * `isRealRef` drops every intra-plan `planItem:` edge, so N proposals under one
   * committed parent each saw the other N−1 as unexplained new siblings. The more
   * thoroughly a plan was approved, the more alarming its own record looked.
   *
   * ⚠️ THE STATUS GUARD IS NOT WHAT MOTIR-3777 CHANGED — read them as two layers.
   * This guard decides WHICH PLANS can be stale (undecided ones) and is
   * MOTIR-3165's, untouched. MOTIR-3777 changed WHAT MAKES A PROPOSAL STALE, one
   * layer in: `siblings_added` fired on a still-`planned` plan for every unrelated
   * card logged under its parent, because its predicate was the parent's child
   * count and its one excuse — *unless the proposal declared an edge to that
   * sibling* — was unreachable by construction (the sibling is younger than the
   * proposal that would have to name it). Every surviving rule is keyed on
   * something the proposal ITSELF named.
   */
  computePlanStaleness(planId: string, ctx: ServiceContext): Promise<PlanStalenessDto>;
}

export const planStalenessService: PlanStalenessService = {
  async computePlanStaleness(planId: string, ctx: ServiceContext): Promise<PlanStalenessDto> {
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findById(planId, ctx.workspaceId, tx),
    );
    if (!plan) throw new PlanNotFoundError(planId);
    await projectAccessService.assertCanBrowse(plan.projectId, ctx);

    const items = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planItemRepository.findByPlan(planId, tx),
    );

    // A DECIDED (or still `generating`) plan is all-clear by construction — see
    // the `planned`-only rule above. The verdict is still shaped per item, so a
    // caller that maps over `items` needs no second code path; it just has
    // nothing to report. The access checks above still run, so this is not a
    // cheaper answer to a question the caller was not allowed to ask.
    if (plan.status !== 'planned' && plan.status !== 'stale') {
      return {
        planId,
        stale: false,
        items: items.map((item) => ({
          planItemId: item.id,
          workItemId: item.workItemId,
          stale: false,
          reasons: [],
        })),
      };
    }

    // --- Collect the distinct work-item ids the rules will read (real refs
    //     only; intra-plan temp-refs resolve at materialize, never stale). ---
    const referencedIds = new Set<string>(); // parents + blockers + targets — for isRemoved
    const targetIds = new Set<string>(); // modify/remove targets — for latest revision

    for (const item of items) {
      if (item.op === 'add') {
        if (item.parentRef && isRealRef(item.parentRef)) {
          referencedIds.add(item.parentRef);
        }
        for (const ref of item.blockedByRefs) {
          if (isRealRef(ref)) referencedIds.add(ref);
        }
      } else if (item.workItemId) {
        referencedIds.add(item.workItemId);
        targetIds.add(item.workItemId);
      }
    }

    // --- Two batched reads (each one round-trip, regardless of plan size). The
    //     third — the parent's children created after `plannedAt` — went with
    //     `siblings_added` (MOTIR-3777), so a plan review no longer pays for a
    //     scan of every busy parent's recent arrivals to answer a question about
    //     the proposal. ---
    const presentById = new Map<string, WorkItem>();
    if (referencedIds.size > 0) {
      const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.findByIdsInWorkspace([...referencedIds], ctx.workspaceId, tx),
      );
      for (const row of rows) presentById.set(row.id, row);
    }

    const latestRevByTarget = new Map<string, string | undefined>();
    if (targetIds.size > 0) {
      const latest = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRevisionRepository.findLatestIdsByWorkItemIds([...targetIds], tx),
      );
      // Seed an entry for EVERY target that's still present, so the drift rule
      // can tell "archived" (present, key set) from "missing" (absent, no key).
      for (const id of targetIds) {
        if (presentById.has(id)) latestRevByTarget.set(id, latest.get(id));
      }
    }

    const sctx: StalenessContext = {
      isRemoved: (id) => {
        const wi = presentById.get(id);
        return !wi || wi.archivedAt != null;
      },
      latestRevByTarget,
    };

    const itemVerdicts: PlanItemStalenessDto[] = items.map((item) => {
      const reasons = RULES.flatMap((rule) => rule(item, sctx));
      return {
        // The work item the verdict is ABOUT, whenever there is one (MOTIR-3165).
        // A `modify` / `remove` always has a target; an `add` has one once
        // materialize has stamped it, and the `op` test used to null that out —
        // so a verdict about an approved proposal could not name the card it
        // concerned. An un-materialized `add` still reports null, correctly.
        planItemId: item.id,
        workItemId: item.workItemId,
        stale: reasons.length > 0,
        reasons,
      };
    });

    return {
      planId,
      stale: itemVerdicts.some((v) => v.stale),
      items: itemVerdicts,
    };
  },
};
