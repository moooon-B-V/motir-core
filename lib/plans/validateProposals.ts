// ── The confirmation gate, at the persist boundary (Subtask 7.12.5 · MOTIR-911) ─
//
// No proposed tree change becomes rows except through an explicit human approve
// of that proposal — and that approve RE-VALIDATES the proposal INDEPENDENTLY
// before it writes anything. This module is that re-validation: a PURE function
// (no DB, no Prisma client) over a plan's PlanItems plus the small live-state
// bag the service resolves for it, so it can run BEFORE the approve transaction
// opens and again INSIDE it, under the row locks, without a second code path.
//
// WHY IT EXISTS. `plansService.materialize` took `kind = pf.kind ?? 'task'` and
// inserted straight through `workItemRepository.create`, so the only backstop
// against a malformed proposal was the DB trigger — which surfaces a raw
// SQLSTATE 23514 as a 500, mid-transaction, for what is really a bad proposal.
// And nothing stopped a `modify`/`remove` from rewriting COMPLETED work: the
// planner locks done nodes (7.4.4), but the approved proposal set can be edited
// between generation and approve (`updateProposal`), so the proposal is NOT
// trusted here. Core re-checks — defense in depth.
//
// WHAT IT DOES NOT DO. It never re-encodes the kind-parent matrix: the grammar
// verdict comes from `lib/issues/parentRules.ts` (`assertValidParent`), the SAME
// single source of truth `workItemsService` gates every human create/move on.
// This module only resolves each proposal's EFFECTIVE parent kind (through the
// intra-plan temp-ref graph) and asks that gate.
//
// ATOMICITY is the point of doing all of it up front: a rejection must leave the
// tree byte-identical, so every check completes before the first write.

import { assertValidParent, isIssueType, type IssueType } from '@/lib/issues/parentRules';
import { IllegalParentTypeError } from '@/lib/workItems/errors';
import { isTempRef, tempRefId, TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { PlanGrammarError, PlanRefGraphError, PlanTargetImmutableError } from '@/lib/plans/errors';

/** The kind `materialize` falls back to when an `add` proposes none. */
export const DEFAULT_PROPOSED_KIND = 'task';

/**
 * One proposal, in the minimal shape the gate reads. A structural subset of the
 * Prisma `PlanItem` row (whose `proposedFields` / `patch` are `Json`), so the
 * validator stays free of Prisma types and is unit-testable without a DB.
 */
export interface ProposalNode {
  id: string;
  op: 'add' | 'modify' | 'remove';
  /** The existing target of a `modify`/`remove` (null on an un-materialized `add`). */
  workItemId: string | null;
  /** A real work-item id, an intra-plan `planItem:<id>` temp-ref, or null. */
  parentRef: string | null;
  blockedByRefs: string[];
  /** `add` only — the gate reads just the proposed `kind`. */
  proposedFields: { kind?: string | null } | null;
  /** `modify` only — the gate reads just the edge refs. */
  patch: { blockedByAdd?: string[] | null; blockedByRemove?: string[] | null } | null;
}

/** A live work item the plan references (a real parent, or a modify/remove target). */
export interface LiveWorkItemState {
  id: string;
  kind: string;
  status: string;
}

export interface ValidatePlanProposalsInput {
  /** Every PlanItem bundled in the plan being approved. */
  items: readonly ProposalNode[];
  /**
   * The live rows for every REAL work-item id the plan references, by id.
   * Resolved by the service (workspace-scoped) so this stays pure. An id absent
   * from the map is a ref that resolves to nothing in this workspace.
   */
  liveById: ReadonlyMap<string, LiveWorkItemState>;
  /**
   * The project's TERMINAL status keys — every `category = 'done'` status
   * (`workflowsService.getTerminalStatusKeys`), never a hardcoded `'done'`, so
   * `cancelled` is terminal too.
   */
  terminalStatusKeys: ReadonlySet<string>;
}

/** The proposed kind of an `add`, defaulted the way `materialize` defaults it. */
function proposedKindOf(item: ProposalNode): string {
  const kind = item.proposedFields?.kind;
  return typeof kind === 'string' && kind.length > 0 ? kind : DEFAULT_PROPOSED_KIND;
}

/** The proposed kind as a validated `IssueType`, or a typed rejection. */
function issueKindOf(item: ProposalNode): IssueType {
  const kind = proposedKindOf(item);
  if (!isIssueType(kind)) {
    throw new PlanGrammarError(
      'unknown_kind',
      item.id,
      `Proposal ${item.id} proposes kind "${kind}", which is not a valid issue type.`,
    );
  }
  return kind;
}

/**
 * Every REAL (non-temp) work-item id a plan references — the parents its `add`s
 * hang from, the blockers its edges name, and the targets its `modify`/`remove`
 * ops touch. The service resolves exactly this set into `liveById` (one batched
 * read), so the gate never issues a query itself.
 */
export function collectReferencedWorkItemIds(items: readonly ProposalNode[]): string[] {
  const ids = new Set<string>();
  const addReal = (ref: string | null | undefined): void => {
    if (ref && !isTempRef(ref)) ids.add(ref);
  };
  for (const item of items) {
    addReal(item.parentRef);
    for (const ref of item.blockedByRefs) addReal(ref);
    if (item.op === 'modify' || item.op === 'remove') addReal(item.workItemId);
    for (const ref of item.patch?.blockedByAdd ?? []) addReal(ref);
    for (const ref of item.patch?.blockedByRemove ?? []) addReal(ref);
  }
  return [...ids];
}

/**
 * Assert every ref resolves — to a same-plan `add` (temp-ref) or to a live work
 * item (real id) — and that no proposal lists the same blocker twice.
 */
function assertRefsResolve(
  item: ProposalNode,
  refs: readonly string[],
  liveById: ValidatePlanProposalsInput['liveById'],
  addIds: ReadonlySet<string>,
  where: 'parentRef' | 'blockedByRefs' | 'patch.blockedByAdd' | 'patch.blockedByRemove',
): void {
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref)) {
      throw new PlanRefGraphError(
        'duplicate',
        item.id,
        `Proposal ${item.id} lists "${ref}" twice in ${where}; a blocked-by edge can only be created once.`,
      );
    }
    seen.add(ref);

    if (isTempRef(ref)) {
      const targetId = tempRefId(ref);
      if (targetId === item.id) {
        throw new PlanRefGraphError(
          'cycle',
          item.id,
          `Proposal ${item.id} references ITSELF in ${where}.`,
        );
      }
      if (!addIds.has(targetId)) {
        throw new PlanRefGraphError(
          'dangling',
          item.id,
          `Proposal ${item.id}'s ${where} "${ref}" names no \`add\` in this plan.`,
        );
      }
    } else if (!liveById.has(ref)) {
      throw new PlanRefGraphError(
        'dangling',
        item.id,
        `Proposal ${item.id}'s ${where} "${ref}" names no work item in this workspace.`,
      );
    }
  }
}

/**
 * Assert the intra-plan `parentRef` graph is ACYCLIC — i.e. a parent-before-child
 * creation order exists (`materialize`'s topological walk). A cycle is caught
 * HERE, before any write, rather than by that walk mid-transaction.
 */
function assertParentRefsAcyclic(adds: readonly ProposalNode[]): void {
  const byId = new Map(adds.map((a) => [a.id, a]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (item: ProposalNode): void => {
    if (visited.has(item.id)) return;
    if (visiting.has(item.id)) {
      throw new PlanRefGraphError(
        'cycle',
        item.id,
        `The plan's ${TEMP_REF_PREFIX} parent refs form a cycle through proposal ${item.id}; no parent-before-child order exists.`,
      );
    }
    visiting.add(item.id);
    if (item.parentRef && isTempRef(item.parentRef)) {
      // Resolution is guaranteed by `assertRefsResolve`, which runs first.
      const parent = byId.get(tempRefId(item.parentRef));
      if (parent) visit(parent);
    }
    visiting.delete(item.id);
    visited.add(item.id);
  };

  for (const add of adds) visit(add);
}

/**
 * The EFFECTIVE parent kind an `add` would be created under: `null` for a
 * top-level add, the referenced same-plan `add`'s proposed kind for a temp-ref,
 * the live row's kind for a real id.
 */
function effectiveParentKind(
  item: ProposalNode,
  addsById: ReadonlyMap<string, ProposalNode>,
  liveById: ValidatePlanProposalsInput['liveById'],
): IssueType | null {
  const ref = item.parentRef;
  if (!ref) return null;

  if (isTempRef(ref)) {
    // Resolution is guaranteed by `assertRefsResolve`.
    const parent = addsById.get(tempRefId(ref))!;
    return issueKindOf(parent);
  }

  // Resolution is guaranteed by `assertRefsResolve`.
  const live = liveById.get(ref)!;
  if (!isIssueType(live.kind)) {
    // Unreachable through the schema (`work_item.kind` is an enum of exactly the
    // five issue types) — guarded so a future kind can never fall through the
    // grammar check silently.
    throw new PlanGrammarError(
      'unknown_kind',
      item.id,
      `Proposal ${item.id}'s parent work item ${live.id} has kind "${live.kind}", which is not a valid issue type.`,
    );
  }
  return live.kind;
}

/**
 * THE GATE. Re-validate an approved proposal set independently, before it
 * becomes rows. Throws the first violation as a typed error — `PlanRefGraphError`
 * / `PlanGrammarError` (→ 400) or `PlanTargetImmutableError` (→ 409) — and
 * writes nothing, ever (it is pure). An empty / all-declined plan is a valid
 * no-op and passes.
 *
 * Order matters: refs resolve → the ref graph is acyclic → the grammar holds →
 * done work is immutable. Each step's guarantees are what the next one relies
 * on, so a malformed plan always fails with the MOST specific reason.
 */
export function validatePlanProposals(input: ValidatePlanProposalsInput): void {
  const { items, liveById, terminalStatusKeys } = input;

  const adds = items.filter((i) => i.op === 'add');
  const addsById = new Map(adds.map((a) => [a.id, a]));
  const addIds = new Set(addsById.keys());

  // 1. Every ref resolves, and no blocker is listed twice.
  for (const item of items) {
    if (item.parentRef !== null) {
      assertRefsResolve(item, [item.parentRef], liveById, addIds, 'parentRef');
    }
    assertRefsResolve(item, item.blockedByRefs, liveById, addIds, 'blockedByRefs');
    if (item.op === 'modify') {
      assertRefsResolve(
        item,
        item.patch?.blockedByAdd ?? [],
        liveById,
        addIds,
        'patch.blockedByAdd',
      );
      assertRefsResolve(
        item,
        item.patch?.blockedByRemove ?? [],
        liveById,
        addIds,
        'patch.blockedByRemove',
      );
    }
  }

  // 2. The intra-plan parent graph admits a parent-before-child order.
  assertParentRefsAcyclic(adds);

  // 3. The kind-parent grammar — asked of `lib/issues/parentRules.ts`, the same
  //    matrix every human create/move is gated on. Independent of whatever the
  //    planner self-checked, and of any human edit through `updateProposal`.
  for (const item of adds) {
    const childKind = issueKindOf(item);
    const parentKind = effectiveParentKind(item, addsById, liveById);
    try {
      assertValidParent(parentKind, childKind);
    } catch (err) {
      if (err instanceof IllegalParentTypeError) {
        throw new PlanGrammarError(
          'illegal_parent',
          item.id,
          `Proposal ${item.id} is not a legal placement: ${err.message}`,
        );
      }
      throw err;
    }
  }

  // 4. Done-work immutability. A `modify`/`remove` never rewrites completed work.
  //    A target that resolves to nothing is left to `materialize`, which raises
  //    `PlanItemTargetMissingError` and rolls the whole approve back.
  for (const item of items) {
    if (item.op !== 'modify' && item.op !== 'remove') continue;
    if (!item.workItemId) continue;
    const target = liveById.get(item.workItemId);
    if (target && terminalStatusKeys.has(target.status)) {
      throw new PlanTargetImmutableError(item.id, target.id, target.status);
    }
  }
}
