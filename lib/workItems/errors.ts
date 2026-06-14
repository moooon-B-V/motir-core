// Typed errors for the work-items domain. Kept in their own file so callers
// — the service layer (1.4.4), route handlers, server actions — can import
// them without pulling in the Prisma client.
//
// These wrap the DB-layer reality: the kind-parent / depth / cycle rules are
// enforced by Postgres triggers (prisma/sql/work_item_triggers.sql), which
// reject with SQLSTATE 23514 + a message marker. workItemRepository catches
// those at its edge and rethrows the matching class here, so the service
// layer never inspects raw Postgres error codes (the 4-layer rule).
//
// Every class carries a string `tag` discriminant. The service layer can
// `switch (err.tag)` over a `WorkItemError` union exhaustively without
// `instanceof` chains or Prisma-code sniffing. `code` mirrors `tag` and is
// what the route layer (Epic 2) maps to an HTTP status, matching the
// `readonly code` convention the workspaces/projects domains established.

export type WorkItemErrorTag =
  | 'ILLEGAL_PARENT_TYPE'
  | 'DEPTH_LIMIT_EXCEEDED'
  | 'PARENT_CYCLE'
  | 'WORK_ITEM_NOT_FOUND'
  | 'KEY_CONFLICT'
  | 'CROSS_PROJECT_PARENT'
  | 'REPORTER_NOT_IN_WORKSPACE'
  | 'ASSIGNEE_NOT_IN_WORKSPACE'
  | 'UNKNOWN_STATUS'
  | 'ILLEGAL_TRANSITION'
  | 'STALE_WORK_ITEM'
  | 'TYPE_NOT_ALLOWED_ON_KIND'
  | 'NOT_EPIC';

/**
 * Base class for every work-items typed error. Concrete subclasses set a
 * literal `tag` (the discriminant) and a matching `code`.
 */
export abstract class WorkItemError extends Error {
  abstract readonly tag: WorkItemErrorTag;
  abstract readonly code: WorkItemErrorTag;
}

/**
 * The kind-parent matrix was violated — either an illegal parent kind for the
 * child's kind, or the orphan-subtask case (a subtask with no parent). Both
 * trigger markers (WI_ILLEGAL_PARENT_TYPE and WI_SUBTASK_NEEDS_PARENT) map
 * here: structurally they are both "this parent configuration is illegal."
 */
export class IllegalParentTypeError extends WorkItemError {
  readonly tag = 'ILLEGAL_PARENT_TYPE' as const;
  readonly code = 'ILLEGAL_PARENT_TYPE' as const;
  constructor(message = 'Illegal parent for this work-item kind.') {
    super(message);
    this.name = 'IllegalParentTypeError';
  }
}

/**
 * The tree-depth limit (4 levels) would be exceeded by this insert/move.
 */
export class DepthLimitExceededError extends WorkItemError {
  readonly tag = 'DEPTH_LIMIT_EXCEEDED' as const;
  readonly code = 'DEPTH_LIMIT_EXCEEDED' as const;
  constructor(message = 'Work-item tree depth limit (4 levels) exceeded.') {
    super(message);
    this.name = 'DepthLimitExceededError';
  }
}

/**
 * A re-parent would create a cycle (an ancestor moved under its descendant,
 * or a self-parent).
 */
export class ParentCycleError extends WorkItemError {
  readonly tag = 'PARENT_CYCLE' as const;
  readonly code = 'PARENT_CYCLE' as const;
  constructor(message = 'Re-parenting would create a cycle in the work-item tree.') {
    super(message);
    this.name = 'ParentCycleError';
  }
}

/**
 * No work item matched the id / identifier looked up.
 */
export class WorkItemNotFoundError extends WorkItemError {
  readonly tag = 'WORK_ITEM_NOT_FOUND' as const;
  readonly code = 'WORK_ITEM_NOT_FOUND' as const;
  readonly idOrIdentifier: string;
  constructor(idOrIdentifier: string) {
    super(`Work item ${idOrIdentifier} not found.`);
    this.name = 'WorkItemNotFoundError';
    this.idOrIdentifier = idOrIdentifier;
  }
}

/**
 * A unique-constraint violation on (projectId, key) or (projectId, identifier)
 * — translated from Prisma P2002. In practice the service allocates keys
 * gap-free inside the create transaction, so this should not surface in normal
 * operation; it exists so the repository never leaks a raw Prisma error past
 * its boundary.
 */
export class WorkItemKeyConflictError extends WorkItemError {
  readonly tag = 'KEY_CONFLICT' as const;
  readonly code = 'KEY_CONFLICT' as const;
  constructor(message = 'A work item with this key or identifier already exists in the project.') {
    super(message);
    this.name = 'WorkItemKeyConflictError';
  }
}

/**
 * A parent was specified that lives in a DIFFERENT project than the child
 * (Subtask 1.4.4). This is a service-layer pre-flight check — the work-item
 * tree is project-local, so a cross-project parent is structurally illegal.
 * Distinct from IllegalParentTypeError (the DB trigger's kind-matrix class):
 * a cross-project parent might still be a kind-legal pair, so it needs its
 * own typed error. There is no DB trigger backstop for THIS rule today (the
 * kind/depth/cycle triggers don't compare projectId), so this assertion is
 * the primary guard — kept friendly + explicit at the service edge.
 */
export class CrossProjectParentError extends WorkItemError {
  readonly tag = 'CROSS_PROJECT_PARENT' as const;
  readonly code = 'CROSS_PROJECT_PARENT' as const;
  constructor(message = 'A work item parent must belong to the same project as the child.') {
    super(message);
    this.name = 'CrossProjectParentError';
  }
}

/**
 * The reporter (the acting user creating the work item) is not a member of
 * the project's workspace (Subtask 1.4.4). A service-layer membership gate;
 * the RLS policy landing in 1.4.5 is the structural backstop.
 */
export class ReporterNotInWorkspaceError extends WorkItemError {
  readonly tag = 'REPORTER_NOT_IN_WORKSPACE' as const;
  readonly code = 'REPORTER_NOT_IN_WORKSPACE' as const;
  constructor(message = 'The reporter is not a member of this workspace.') {
    super(message);
    this.name = 'ReporterNotInWorkspaceError';
  }
}

/**
 * The proposed assignee is not a member of the project's workspace (Subtask
 * 1.4.4). Guards createWorkItem / updateWorkItem / assignWorkItem — you
 * cannot assign an issue to someone outside its tenant. Un-assigning (null
 * assignee) skips this check.
 */
export class AssigneeNotInWorkspaceError extends WorkItemError {
  readonly tag = 'ASSIGNEE_NOT_IN_WORKSPACE' as const;
  readonly code = 'ASSIGNEE_NOT_IN_WORKSPACE' as const;
  constructor(message = 'The assignee is not a member of this workspace.') {
    super(message);
    this.name = 'AssigneeNotInWorkspaceError';
  }
}

/**
 * The target status key isn't one of the project's workflow statuses (Subtask
 * 2.2.4). Thrown by updateStatus (the move target) and by createWorkItem when
 * a caller supplies an explicit status that the project's workflow doesn't
 * define. A client error → 422.
 */
export class UnknownStatusError extends WorkItemError {
  readonly tag = 'UNKNOWN_STATUS' as const;
  readonly code = 'UNKNOWN_STATUS' as const;
  readonly statusKey: string;
  constructor(statusKey: string) {
    super(`Unknown status "${statusKey}" for this project's workflow.`);
    this.name = 'UnknownStatusError';
    this.statusKey = statusKey;
  }
}

/**
 * The requested status move is not a legal transition under the project's
 * workflow (Subtask 2.2.4) — `restricted` mode with no `workflow_transition`
 * row connecting the (from, to) pair. The message names the offending pair.
 * A client error → 422.
 */
export class IllegalTransitionError extends WorkItemError {
  readonly tag = 'ILLEGAL_TRANSITION' as const;
  readonly code = 'ILLEGAL_TRANSITION' as const;
  readonly fromKey: string;
  readonly toKey: string;
  constructor(fromKey: string, toKey: string) {
    super(`Illegal status transition: "${fromKey}" → "${toKey}".`);
    this.name = 'IllegalTransitionError';
    this.fromKey = fromKey;
    this.toKey = toKey;
  }
}

/**
 * Optimistic-concurrency conflict (Subtask 2.3.6): the edit form submitted the
 * `updatedAt` it read at render time, and by commit the row's `updatedAt` had
 * moved — someone else edited the issue in between. A client error → 409. The
 * UI surfaces "this issue was edited by someone else — refresh and retry";
 * last-write-wins is the shipped behavior, but the user sees the conflict
 * instead of silently clobbering the other edit.
 */
export class StaleWorkItemError extends WorkItemError {
  readonly tag = 'STALE_WORK_ITEM' as const;
  readonly code = 'STALE_WORK_ITEM' as const;
  constructor() {
    super('This issue was edited by someone else. Refresh and try again.');
    this.name = 'StaleWorkItemError';
  }
}

/**
 * A `type` / `executor` was set on a work item whose `kind` is a CONTAINER
 * (epic / story), not an executable leaf (Story 2.7 · Subtask 2.7.3). `type`
 * is the nature of executable work and is leaf-only by the 2.7.2 ADR; epics
 * and stories organise work, they don't execute it. A client error → 422
 * (the route layer's blanket `WorkItemError` mapping). There is no DB-trigger
 * backstop for this rule (a single nullable column can't express "only on
 * these kinds"), so this service-layer assertion is the primary guard.
 */
export class TypeNotAllowedOnKindError extends WorkItemError {
  readonly tag = 'TYPE_NOT_ALLOWED_ON_KIND' as const;
  readonly code = 'TYPE_NOT_ALLOWED_ON_KIND' as const;
  constructor(kind: string) {
    super(`A ${kind} cannot carry a type or executor (those are leaf-only).`);
    this.name = 'TypeNotAllowedOnKindError';
  }
}

/**
 * Epic privacy (Story 6.14 · `publicChildrenHidden`) was set on a non-epic work
 * item. The flag is meaningful ONLY for an epic-kind item (ADR §1) — hiding "an
 * epic's children + aggregate tells" has no meaning on a story/task/subtask. The
 * write layer (`setEpicPrivacy`) REJECTS rather than silently coercing to a
 * no-op, so a caller bug surfaces instead of returning a misleading 200. The
 * route maps this to 422 (a malformed-for-this-target request).
 */
export class NotEpicError extends WorkItemError {
  readonly tag = 'NOT_EPIC' as const;
  readonly code = 'NOT_EPIC' as const;
  constructor(kind: string) {
    super(`Epic privacy can only be set on an epic — this work item is a ${kind}.`);
    this.name = 'NotEpicError';
  }
}

/**
 * A project has no initial workflow status (Subtask 2.2.4) — a corrupt/missing
 * seed. This is a SERVER INVARIANT violation, not a client error: every
 * project is seeded with exactly one initial status at creation (2.2.2). So it
 * is deliberately NOT a `WorkItemError` (the route layer blanket-maps those to
 * 422); it propagates unhandled → 500, the right signal for "the data is in a
 * state that should be impossible."
 */
export class NoInitialStatusError extends Error {
  readonly code = 'NO_INITIAL_STATUS' as const;
  constructor(projectId: string) {
    super(`Project ${projectId} has no initial workflow status (corrupt seed).`);
    this.name = 'NoInitialStatusError';
  }
}
