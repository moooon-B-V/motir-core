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
import { isWorkItemType, WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';
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
  /**
   * `add` only — the gate reads the two CLOSED-SET columns it can reject before
   * a write: the proposed `kind` and the proposed `type` (MOTIR-3654).
   */
  proposedFields: { kind?: string | null; type?: string | null } | null;
  /**
   * `modify` only — the gate reads the edge refs, and (MOTIR-3859) the
   * `parentRef` a re-parent travels on. `undefined` and `null` are DIFFERENT
   * here, as everywhere in a sparse patch: absent leaves the parent alone, an
   * explicit `null` moves the target to the project root.
   */
  patch: {
    parentRef?: string | null;
    blockedByAdd?: string[] | null;
    blockedByRemove?: string[] | null;
  } | null;
}

/** A live work item the plan references (a real parent, or a modify/remove target). */
export interface LiveWorkItemState {
  id: string;
  kind: string;
  status: string;
  /**
   * The project the live row sits in. Read by the PARENT-tenancy check only —
   * a `blocked_by` ref deliberately does NOT consult it, because a cross-project
   * dependency edge is supported (MOTIR-3581).
   */
  projectId: string;
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
  /**
   * The project the PLAN belongs to — the project every card it materializes is
   * created in. Read by the parent-tenancy check (step 3b), which is the only
   * question in this gate whose answer depends on WHERE a live row sits.
   */
  planProjectId: string;
  /**
   * The ANCESTOR CHAIN of every work item a `modify` proposes as a new parent
   * (MOTIR-3859) — `parentId → … → root`, nearest first — resolved by the
   * service in one batched read (`workItemRepository.findAncestorIdsForItems`).
   *
   * It is what makes the CYCLE and DEPTH questions answerable in a pure
   * function: a re-parent's legality is a property of the tree above the new
   * parent, which is the only thing in this gate that neither the proposal set
   * nor a single row can supply. An id with no entry reads as a ROOT (an empty
   * chain), which is what an item with no parent actually has — so a caller that
   * resolves nothing degrades to "the parent is a root", the permissive answer,
   * and the DB triggers stay the backstop.
   *
   * REQUIRED rather than optional, deliberately: an optional map defaulting to
   * empty would let a caller that forgot it pass a cycle silently.
   */
  ancestorIdsById: ReadonlyMap<string, readonly string[]>;
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
 * The proposed `type`, checked against the fourteen `WorkItemType` members, or a
 * typed rejection (MOTIR-3654).
 *
 * The twin of `issueKindOf` above, owed by this module's own header argument:
 * the approved set can be edited between generation and approve
 * (`updateProposal`), so the proposal is NOT trusted here and core re-checks.
 * `kind` had that arm from the start; `type` did not, and the asymmetry is the
 * whole defect — an out-of-enum `type` passed `validate_plan` cleanly and then
 * raised a `PrismaClientValidationError` from inside `materialize`.
 *
 * A null / absent `type` is legal (a leaf may be untyped, and a container may
 * not carry one at all), so only a PRESENT non-member is a violation. The
 * message lists the legal members, because the caller correcting this is
 * usually an agent that can act on a list and cannot act on a refusal.
 */
function assertProposedTypeKnown(item: ProposalNode): void {
  const type = item.proposedFields?.type;
  if (type == null || type === '') return;
  if (isWorkItemType(type)) return;
  throw new PlanGrammarError(
    'unknown_type',
    item.id,
    `Proposal ${item.id} proposes type "${String(type)}", which is not a valid work type. Legal members: ${WORK_ITEM_TYPES.join(', ')}.`,
  );
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
    // The RE-PARENT target (MOTIR-3859) — the new parent has to be in `liveById`
    // for every one of its guards, and it is the one ref site that is a single
    // nullable value rather than a list.
    if (item.op === 'modify' && item.patch?.parentRef) addReal(item.patch.parentRef);
    for (const ref of item.patch?.blockedByAdd ?? []) addReal(ref);
    for (const ref of item.patch?.blockedByRemove ?? []) addReal(ref);
  }
  return [...ids];
}

/** Where a ref was written, for the rejection message. */
type RefSite =
  | 'parentRef'
  | 'blockedByRefs'
  | 'patch.parentRef'
  | 'patch.blockedByAdd'
  | 'patch.blockedByRemove';

/**
 * Every (site, refs) pair one proposal carries, so the two passes below walk the
 * SAME set of refs and cannot drift apart. A `modify`'s patch sides are read
 * only for a `modify`, exactly as before.
 */
function refSitesOf(item: ProposalNode): Array<[RefSite, readonly string[]]> {
  const sites: Array<[RefSite, readonly string[]]> = [];
  if (item.parentRef !== null) sites.push(['parentRef', [item.parentRef]]);
  sites.push(['blockedByRefs', item.blockedByRefs]);
  if (item.op === 'modify') {
    // An explicit `null` is a move to the ROOT and names nothing, so it carries
    // no ref to resolve — only a non-null value is a site (MOTIR-3859).
    if (item.patch?.parentRef) sites.push(['patch.parentRef', [item.patch.parentRef]]);
    sites.push(['patch.blockedByAdd', item.patch?.blockedByAdd ?? []]);
    sites.push(['patch.blockedByRemove', item.patch?.blockedByRemove ?? []]);
  }
  return sites;
}

/**
 * The PURE half of the ref check (MOTIR-3573): a ref list may not repeat a ref,
 * and a proposal may not name ITSELF. Both are facts about the proposal set
 * alone — no workspace read can change either answer — which is why they run at
 * the APPEND rather than waiting for approve.
 */
function assertRefsSelfConsistent(
  item: ProposalNode,
  refs: readonly string[],
  where: RefSite,
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

    if (isTempRef(ref) && tempRefId(ref) === item.id) {
      throw new PlanRefGraphError(
        'cycle',
        item.id,
        `Proposal ${item.id} references ITSELF in ${where}.`,
      );
    }
  }
}

/**
 * The half that needs LIVE STATE: every ref resolves — to a same-plan `add`
 * (temp-ref) or to a work item that exists in this workspace (real id). The
 * real-id arm is what costs a batched read, which is why this pass cannot run at
 * the append and runs at the CLOSE instead (`plansService.markPlanned`).
 */
function assertRefsResolvable(
  item: ProposalNode,
  refs: readonly string[],
  liveById: ValidatePlanProposalsInput['liveById'],
  addIds: ReadonlySet<string>,
  where: RefSite,
): void {
  for (const ref of refs) {
    if (isTempRef(ref)) {
      const targetId = tempRefId(ref);
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
 * THE PURE GATE (MOTIR-3573) — everything about a proposal set that is knowable
 * WITHOUT a workspace read: no ref is listed twice, no proposal references
 * itself, and the intra-plan `parentRef` graph admits a parent-before-child
 * order. Takes no `liveById` BY DESIGN: a real work-item id is not this
 * function's business, and a plan may legitimately reference an item created
 * between the append and the close.
 *
 * `plansService.addProposals` calls it under the plan lock before the first
 * insert, and `validatePlanProposals` calls it as its own first step — one
 * implementation, so the append and the approve can never disagree about what a
 * self-consistent plan is.
 */
export function assertProposalSetSelfConsistent(items: readonly ProposalNode[]): void {
  for (const item of items) {
    for (const [where, refs] of refSitesOf(item)) {
      assertRefsSelfConsistent(item, refs, where);
    }
  }
  assertParentRefsAcyclic(items.filter((i) => i.op === 'add'));
}

/**
 * Assert the intra-plan `parentRef` graph is ACYCLIC — i.e. a parent-before-child
 * creation order exists (`materialize`'s topological walk). A cycle is caught
 * HERE, before any write, rather than by that walk mid-transaction.
 *
 * PURE, and it runs BEFORE resolution (MOTIR-3573), so an unresolvable temp-ref
 * is simply not walked — `byId.get` misses and the guarded `if (parent)` skips
 * it. The dangling ref is then reported by `assertRefsResolvable`, which is the
 * more specific reason for it.
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
      // A ref that resolves to nothing is left to `assertRefsResolvable`.
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
    // Resolution is guaranteed by `assertRefsResolvable`.
    const parent = addsById.get(tempRefId(ref))!;
    return issueKindOf(parent);
  }

  // Resolution is guaranteed by `assertRefsResolvable`.
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

// ── The RE-PARENT gate (MOTIR-3859) ──────────────────────────────────────────
//
// A `modify` may now move its target (`patch.parentRef`), which is the ONE patch
// key whose legality is a question about the TREE rather than about the row. The
// five checks below are the same five the interactive path is subject to — three
// of them asserted by `workItemsService.moveWorkItem` and two by the `work_item`
// triggers — collected into one pure function so the APPEND and the APPROVE ask
// them identically. That is the whole reason it is a function and not two
// inlined copies: a re-parent refused at the append and admitted at approve, or
// the reverse, is worse than either answer.

/**
 * The tree's depth cap, mirrored from `enforce_work_item_depth_limit`
 * (`prisma/sql/work_item_triggers.sql`): a root is depth 1, and a row whose
 * resulting depth exceeds this raises `WI_DEPTH_LIMIT_EXCEEDED`.
 *
 * ⚠️ A MIRROR, and therefore a thing to keep in lockstep — the trigger is the
 * backstop and stays authoritative. It is duplicated here for the reason the
 * kind-parent matrix is NOT (that one is a shared module this file imports): the
 * cap lives in SQL, there is no TypeScript module owning it, and inventing one
 * to hold a single integer would put a third name on a two-name fact.
 */
const MAX_WORK_ITEM_DEPTH = 4;

/**
 * Assert one `modify`'s proposed re-parent is legal, or throw the typed
 * rejection that says why (MOTIR-3859). A no-op for every proposal that does not
 * carry `patch.parentRef` — which is all of them, on the overwhelming majority
 * of plans.
 *
 * PURE. Everything it needs is resolved by the caller: the live rows in
 * `liveById` (the target and the new parent), and `ancestorIdsById` — the new
 * parent's ancestor chain, which is what makes the CYCLE and DEPTH questions
 * answerable without a query. `workItemRepository.findAncestorIdsForItems` is
 * the one batched read that supplies it.
 *
 * The order is the same discipline the gate above follows — a malformed
 * re-parent fails with the MOST specific reason:
 *
 *   1. a temp-ref parent (refused outright — see `PlanItemPatch.parentRef`)
 *   2. tenancy — the parent is in this project
 *   3. self / descendant — the move would create a cycle
 *   4. depth — the resulting depth is within the cap
 *   5. the kind-parent matrix, and the parent is not terminal
 *
 * A target that resolves to NOTHING is left alone: `materialize` raises
 * `PlanItemTargetMissingError` for it and rolls the approve back, which is the
 * more specific reason, and step 4 of the gate already declines to invent one.
 */
export function assertReparentLegal(
  item: ProposalNode,
  liveById: ValidatePlanProposalsInput['liveById'],
  ancestorIdsById: ValidatePlanProposalsInput['ancestorIdsById'],
  terminalStatusKeys: ReadonlySet<string>,
  planProjectId: string,
): void {
  if (item.op !== 'modify') return;
  const ref = item.patch?.parentRef;
  if (ref === undefined) return;

  const target = item.workItemId ? liveById.get(item.workItemId) : undefined;
  // Left to `materialize`, which raises the specific reason (see the doc above).
  if (!target) return;
  if (!isIssueType(target.kind)) {
    // Unreachable through the schema, guarded for the same reason
    // `effectiveParentKind`'s twin is.
    throw new PlanGrammarError(
      'unknown_kind',
      item.id,
      `Proposal ${item.id}'s target ${target.id} has kind "${target.kind}", which is not a valid issue type.`,
    );
  }

  // An explicit `null` moves the target to the PROJECT ROOT. The only thing that
  // can be wrong with it is the kind — a subtask has no legal top-level
  // placement — and `assertValidParent` is the arm that says so.
  if (ref === null) {
    assertParentKindLegal(item, null, target.kind);
    return;
  }

  // 1. A proposal is not a legal parent for an existing card. The refusal is
  //    also made at the append boundary (`validateProposal`), where it reaches
  //    the author first; this is the backstop that keeps the two gate stages
  //    total over the same input.
  if (isTempRef(ref)) {
    throw new PlanGrammarError(
      'illegal_parent',
      item.id,
      `Proposal ${item.id}'s patch.parentRef "${ref}" names a proposal in this plan. A \`modify\` may only re-parent onto a work item that ALREADY EXISTS: every check a re-parent owes — the kind-parent matrix, same-project tenancy, the no-cycle walk, the depth cap and the terminal-parent refusal — is a question about a live row, and a proposal has none until approve. To land a card under one this plan is adding, \`add\` it with that \`parentRef\` instead.`,
    );
  }

  // Resolution is guaranteed by `assertRefsResolvable`.
  const parent = liveById.get(ref)!;

  // 2. TENANCY — same rule, same reason and deliberately the same message shape
  //    as an `add`'s parentRef (step 3b): parentage is same-project by invariant
  //    on three enforcing layers, while a `blocked_by` edge is workspace-scoped
  //    by design.
  if (parent.projectId !== planProjectId) {
    throw new PlanGrammarError(
      'illegal_parent',
      item.id,
      `Proposal ${item.id}'s patch.parentRef "${ref}" names a work item in a DIFFERENT project of this workspace. A work item's parent must live in the same project (a cross-project parent is refused by workItemsService and by the work_item parent-tenancy trigger).`,
    );
  }

  // 3. CYCLE — the target itself, or anything below it. `enforce_work_item_no_cycle`
  //    walks UP from the new parent and rejects when the chain reaches the row
  //    being moved; this is that walk, taken from the chain the caller resolved.
  const chain = ancestorIdsById.get(parent.id) ?? [];
  if (parent.id === target.id) {
    throw new PlanRefGraphError(
      'cycle',
      item.id,
      `Proposal ${item.id} would re-parent work item ${target.id} under ITSELF.`,
    );
  }
  if (chain.includes(target.id)) {
    throw new PlanRefGraphError(
      'cycle',
      item.id,
      `Proposal ${item.id} would re-parent work item ${target.id} under ${parent.id}, which is one of its own DESCENDANTS — the move would create a cycle.`,
    );
  }

  // 4. DEPTH — the new parent's own chain plus the parent plus the moved row.
  //    `chain` holds the parent's ANCESTORS, so the parent sits at
  //    `chain.length + 1` and the target would land at `chain.length + 2`, which
  //    is exactly `ancestor_depth + 1` in the trigger's arithmetic.
  const resultingDepth = chain.length + 2;
  if (resultingDepth > MAX_WORK_ITEM_DEPTH) {
    throw new PlanGrammarError(
      'parent_depth_limit',
      item.id,
      `Proposal ${item.id} would place work item ${target.id} at depth ${resultingDepth}, past the limit of ${MAX_WORK_ITEM_DEPTH}.`,
    );
  }

  // 5a. The kind-parent matrix — asked of `lib/issues/parentRules.ts`, the same
  //     single source of truth every human create / move is gated on.
  if (!isIssueType(parent.kind)) {
    throw new PlanGrammarError(
      'unknown_kind',
      item.id,
      `Proposal ${item.id}'s patch.parentRef work item ${parent.id} has kind "${parent.kind}", which is not a valid issue type.`,
    );
  }
  assertParentKindLegal(item, parent.kind, target.kind);

  // 5b. …and the parent is not FINISHED. See `PlanGrammarViolation`'s
  //     `parent_terminal` member for why this one is not cosmetic: the derived
  //     re-open walks the whole ancestor chain, and an approve has nobody
  //     watching it.
  if (terminalStatusKeys.has(parent.status)) {
    throw new PlanGrammarError(
      'parent_terminal',
      item.id,
      `Proposal ${item.id} would re-parent work item ${target.id} under ${parent.id}, which is in the terminal status "${parent.status}". Completing work is derived from a container's CURRENT child set, so giving a finished parent a new open child re-opens it and every ancestor above it.`,
    );
  }
}

/** `assertValidParent`, with its `IllegalParentTypeError` re-thrown as the plan
 *  gate's own typed rejection — the same translation step 3 makes for an `add`. */
function assertParentKindLegal(
  item: ProposalNode,
  parentKind: IssueType | null,
  childKind: IssueType,
): void {
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

/**
 * THE GATE. Re-validate an approved proposal set independently, before it
 * becomes rows. Throws the first violation as a typed error — `PlanRefGraphError`
 * / `PlanGrammarError` (→ 400) or `PlanTargetImmutableError` (→ 409) — and
 * writes nothing, ever (it is pure). An empty / all-declined plan is a valid
 * no-op and passes.
 *
 * Order matters: the plan is self-consistent → its refs resolve → the grammar
 * holds → done work is immutable. Each step's guarantees are what the next one
 * relies on, so a malformed plan always fails with the MOST specific reason.
 *
 * ⚠️ STEP 1 IS THE SAME FUNCTION `addProposals` RUNS AT THE APPEND (MOTIR-3573).
 * It is called here rather than re-implemented so the two stages cannot disagree
 * about what a self-consistent plan is; everything below it needs `liveById` and
 * therefore cannot move earlier than the CLOSE.
 */
export function validatePlanProposals(input: ValidatePlanProposalsInput): void {
  const { items, liveById, terminalStatusKeys, planProjectId, ancestorIdsById } = input;

  const adds = items.filter((i) => i.op === 'add');
  const addsById = new Map(adds.map((a) => [a.id, a]));
  const addIds = new Set(addsById.keys());

  // 1. PURE — no blocker listed twice, no self-reference, no `parentRef` cycle.
  //    Already enforced at the append; re-run here because the approve path
  //    trusts nothing (a proposal set can be edited between the two).
  assertProposalSetSelfConsistent(items);

  // 2. Every ref resolves — the arm that needs the batched workspace read.
  for (const item of items) {
    for (const [where, refs] of refSitesOf(item)) {
      assertRefsResolvable(item, refs, liveById, addIds, where);
    }
  }

  // 3. The kind-parent grammar — asked of `lib/issues/parentRules.ts`, the same
  //    matrix every human create/move is gated on. Independent of whatever the
  //    planner self-checked, and of any human edit through `updateProposal`.
  for (const item of adds) {
    // 3a. The proposed `type` is a member of the schema enum (MOTIR-3654). Runs
    //     BEFORE the parent grammar for the same reason step 1 runs before step
    //     2: a malformed plan should fail with the most specific reason, and a
    //     bad `type` is a property of the proposal alone — it needs no graph.
    assertProposedTypeKnown(item);
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

  // 3b. PARENT TENANCY — a `parentRef` naming a live work item in ANOTHER
  //     project is refused HERE, with the real reason, rather than by the
  //     `WI_PARENT_CROSS_PROJECT` trigger halfway through `materialize`.
  //
  //     ⚠️ THIS IS NOT THE CROSS-PROJECT RULE — a `blocked_by` ref is checked by
  //     step 2 and NOTHING ELSE, and that asymmetry is the product's, not this
  //     gate's (MOTIR-3581):
  //
  //       * A DEPENDENCY is workspace-scoped BY DESIGN. `work_item_link` carries
  //         the workspace gate and deliberately no project narrowing ("cross-project
  //         links inside one workspace are a v1 use case" —
  //         `20260601074342_add_work_item_rls`), `link_work_items` promises it in
  //         its own contract, and `planValidityService` treats a cross-project
  //         blocker as a first-class case. A shared platform project gating an
  //         application's work is the ordinary shape.
  //       * PARENTAGE is same-project BY INVARIANT, on three enforcing layers:
  //         `workItemsService` throws `CrossProjectParentError` on create and on
  //         both re-parent paths, the `work_item` parent-tenancy trigger raises
  //         `WI_PARENT_CROSS_PROJECT` (`20260817160000_work_item_parent_tenancy`),
  //         and `move_to_parent` refuses it. A plan cannot be the one door that
  //         admits it.
  //
  //     So the two refs are treated differently because they ARE different, and
  //     the message says which is which — the failure this whole card is about was
  //     a refusal whose stated reason the caller could observe to be false.
  for (const item of adds) {
    const ref = item.parentRef;
    if (!ref || isTempRef(ref)) continue;
    // Resolution is guaranteed by `assertRefsResolvable`.
    const parent = liveById.get(ref)!;
    if (parent.projectId !== planProjectId) {
      throw new PlanGrammarError(
        'illegal_parent',
        item.id,
        `Proposal ${item.id}'s parentRef "${ref}" names a work item in a DIFFERENT project of this workspace. ` +
          `A work item's parent must live in the same project (a cross-project parent is refused by ` +
          `workItemsService and by the work_item parent-tenancy trigger). A cross-project ` +
          `blocked_by edge IS supported — if this is a dependency rather than a placement, move the ref to ` +
          `blockedByRefs.`,
      );
    }
  }

  // 3c. The RE-PARENT a `modify` may now propose (MOTIR-3859) — tenancy, cycle,
  //     depth, the kind matrix, and the terminal-parent refusal, in that order.
  //     It sits with the other placement questions rather than with step 4
  //     because it IS one: everything it asks is about where a card may SIT.
  //     `addProposals` runs the same function at the APPEND, which is where the
  //     author still has the plan to fix.
  for (const item of items) {
    assertReparentLegal(item, liveById, ancestorIdsById, terminalStatusKeys, planProjectId);
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
