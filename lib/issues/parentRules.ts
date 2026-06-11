// Kind-parent rule logic for issue types — the SINGLE SOURCE OF TRUTH for
// which issue type may parent which, and the service-layer assertion that
// gates every write against it (Story 2.1 · Subtask 2.1.2).
//
// WHY THIS MODULE EXISTS (the 2.1.2 reconciliation). Two encodings of the
// kind-parent matrix existed before this Subtask:
//   1. Story 2.1.1's `ISSUE_TYPE_META[*].allowedChildTypes` + `canParent`
//      in lib/issues/issueTypes.ts — the product-facing metadata layer.
//   2. Story 1.4.4's private `ALLOWED_PARENT_KINDS` table inside
//      lib/services/workItemsService.ts — the service-layer pre-flight gate.
// Two copies of the same rule is exactly the drift hazard the planner's
// decision-authority ladder warns about. 2.1.2 collapses them to ONE: this
// module owns the matrix data, issueTypes.ts decorates it with UI metadata
// (label / icon / color) and re-exports the predicates, and the service
// validates through `assertValidParent` here. No second copy survives.
//
// WHY A SEPARATE PURE MODULE (not just exporting from issueTypes.ts). The
// service layer is server-only and is pulled into every route handler, the
// test harness, and Inngest jobs. issueTypes.ts imports `lucide-react` (icon
// component refs for pickers/badges). Importing the validation gate from
// there would drag the icon barrel into the service's module graph for no
// runtime benefit (the project sets no `optimizePackageImports` for lucide).
// Keeping the rule logic in this UI-free module is the clean layering split:
// pure domain rules here, presentation metadata in issueTypes.ts. This is the
// concrete, justified reason the data lives here rather than in the metadata
// module (per the planner's "no complexity for nothing" / justified-deviation
// discipline — the deviation from "one module" earns its keep).

import { IllegalParentTypeError } from '@/lib/workItems/errors';

/**
 * The five user-facing issue types, in display order (broadest → narrowest).
 * Identical to Story 1.4's `WorkItemKind` enum, so every map keyed off this is
 * total over every kind a `work_item` row can hold (a `subtask` row is a legal
 * DB state — see issueTypes.ts for the full rationale).
 */
export const ISSUE_TYPES = ['epic', 'story', 'task', 'bug', 'subtask'] as const;

export type IssueType = (typeof ISSUE_TYPES)[number];

/**
 * The kind-parent matrix in its product-readable PARENT → allowed-children
 * form. This is the single authoritative encoding; it is the exact inverse of
 * the DB trigger's child → allowed-parents rule
 * (prisma/sql/work_item_triggers.sql · enforce_work_item_kind_parent) and must
 * stay in lockstep with it:
 *
 *   DB (child → allowed parents)        this map (parent → allowed children)
 *   epic    : root only                 epic    → [story, task, bug]
 *   story   : {epic}                     story   → [task, bug, subtask]
 *   task    : {epic, story}              task    → [bug, subtask]
 *   bug     : {epic, story, task}        bug     → [subtask]
 *   subtask : {story, task, bug}         subtask → []   (the leaf)
 *
 * Note `bug` is NOT a leaf — a subtask may be parented to a bug. The single
 * leaf is `subtask` (nothing may parent to it). The matrix is intentionally
 * deeper than default Jira (it allows story→task, story→bug, task→bug) — a
 * justified deviation recorded in PRODECT_FINDINGS #41: Motir is AI-native
 * and the work-item tree IS the execution DAG, so scoping finer work under
 * coarser work earns rollup + coding-agent context inheritance.
 */
export const ALLOWED_CHILD_TYPES: Record<IssueType, readonly IssueType[]> = {
  epic: ['story', 'task', 'bug'],
  story: ['task', 'bug', 'subtask'],
  task: ['bug', 'subtask'],
  bug: ['subtask'],
  subtask: [],
};

/**
 * Issue types that may NOT be a tree root — they must always have a parent.
 * `subtask` is the only one (it has no legal top-level placement); every other
 * kind may sit at the top of a project's tree. This is the `parentType === null`
 * arm of the rule, which `ALLOWED_CHILD_TYPES` (a parent→children map) cannot
 * express on its own.
 */
export const TYPES_REQUIRING_PARENT: ReadonlySet<IssueType> = new Set<IssueType>(['subtask']);

/** Narrowing guard: true when `value` is one of the five issue types. */
export function isIssueType(value: unknown): value is IssueType {
  return typeof value === 'string' && (ISSUE_TYPES as readonly string[]).includes(value);
}

/**
 * True when an issue of `parentType` may directly parent an issue of
 * `childType`. Pure predicate over the matrix; throws nothing. The service
 * layer wraps it in `assertValidParent`; the DB trigger is the backstop.
 */
export function canParent(parentType: IssueType, childType: IssueType): boolean {
  return ALLOWED_CHILD_TYPES[parentType].includes(childType);
}

/**
 * The INVERSE of the matrix: the parent kinds that may legally hold a given
 * `childType`. DERIVED from `ALLOWED_CHILD_TYPES` (the one authoritative map) —
 * NOT a re-encoding — so the parent picker's candidate filter can never drift
 * from the gate `assertValidParent` enforces. Used by
 * `workItemsService.listCandidateParents` (Subtask 2.3.4) to pre-filter the
 * parent picker so an illegal (parent, child) pair is never constructible in
 * the UI; the service + DB trigger remain the defense-in-depth backstops.
 *
 *   epic → []   (root only)        bug     → [epic, story, task]
 *   story → [epic]                 subtask → [story, task, bug]
 *   task → [epic, story]
 */
export function allowedParentKinds(childType: IssueType): IssueType[] {
  return ISSUE_TYPES.filter((parentType) => ALLOWED_CHILD_TYPES[parentType].includes(childType));
}

/**
 * The service-layer gate: assert that an issue of `childType` may be placed
 * under `parentType` (or at top-level when `parentType` is null), throwing a
 * typed {@link IllegalParentTypeError} (→ HTTP 422) on a violation so callers
 * get a clean API error rather than the DB trigger's raw SQLSTATE 23514. The
 * trigger remains the structural backstop (defense in depth); this is the
 * friendly gate every create / re-parent / move flow calls BEFORE writing.
 *
 * Two illegal shapes are rejected:
 *   - top-level placement (`parentType === null`) of a type that requires a
 *     parent (a subtask), and
 *   - any (parent, child) pair the matrix forbids.
 */
export function assertValidParent(parentType: IssueType | null, childType: IssueType): void {
  if (parentType === null) {
    if (TYPES_REQUIRING_PARENT.has(childType)) {
      throw new IllegalParentTypeError(`A ${childType} must have a parent.`);
    }
    return;
  }
  if (!canParent(parentType, childType)) {
    throw new IllegalParentTypeError(`A ${childType} may not be parented to a ${parentType}.`);
  }
}
