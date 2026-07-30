// Typed errors for the AI-planning Plan substrate (Story 7.21 · MOTIR-1336).
// Kept in their own file so route handlers can import them without pulling in
// the Prisma client (the lib/<domain>/errors.ts convention). The service
// throws these; the route layer translates the stable `code` to an HTTP status.

/**
 * A proposal's fields are inconsistent with its `op` (an `add` with no
 * `proposedFields.title`, a `modify` with no `workItemId`/`patch`, a `remove`
 * with no `workItemId`). → 422
 */
export class InvalidProposalError extends Error {
  readonly code = 'INVALID_PROPOSAL' as const;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProposalError';
  }
}

/**
 * No `generating` plan resolves for a generation job (the internal proposals
 * seam, 7.4.4 · MOTIR-846): the job token's `sourceJobId` names no plan in this
 * workspace — the plan was never opened, belongs to another tenant, or the
 * generate seam's `createPlan` has not committed yet (the handler may retry).
 * → 404 (never 403 — no cross-tenant existence leak). */
export class NoPlanForJobError extends Error {
  readonly code = 'NO_PLAN_FOR_JOB' as const;
  constructor(jobId: string) {
    super(`No generation plan was found for job ${jobId}.`);
    this.name = 'NoPlanForJobError';
  }
}

/** The plan id does not resolve (in this workspace). → 404 */
export class PlanNotFoundError extends Error {
  readonly code = 'PLAN_NOT_FOUND' as const;
  constructor(planId: string) {
    super(`Plan ${planId} was not found.`);
    this.name = 'PlanNotFoundError';
  }
}

/** The plan-item id does not resolve within the given plan (the proposal-edit
 *  path, 7.21.6 · MOTIR-1370). → 404 */
export class PlanItemNotFoundError extends Error {
  readonly code = 'PLAN_ITEM_NOT_FOUND' as const;
  constructor(planItemId: string) {
    super(`Plan item ${planItemId} was not found in this plan.`);
    this.name = 'PlanItemNotFoundError';
  }
}

/**
 * A proposal append was attempted on a plan that is no longer `generating`
 * (it has been planned/decided). Appending only makes sense while the producer
 * is still generating. → 409
 */
export class PlanNotGeneratingError extends Error {
  readonly code = 'PLAN_NOT_GENERATING' as const;
  constructor(planId: string, status: string) {
    super(`Plan ${planId} is ${status}, not generating — no more proposals can be appended.`);
    this.name = 'PlanNotGeneratingError';
  }
}

/**
 * `markPlanned` / `approvePlan` / `declinePlan` was called from a status the
 * transition does not allow. The lifecycle is generating → planned →
 * approved|declined; each hop is legal only from its predecessor. Idempotency
 * + the lost-race loser both land here (the plan row is locked + re-read, so a
 * concurrent winner that already moved the status makes the loser observe the
 * new status and throw this). → 409
 */
export class PlanNotInExpectedStatusError extends Error {
  readonly code = 'PLAN_NOT_IN_EXPECTED_STATUS' as const;
  constructor(planId: string, actual: string, expected: string) {
    super(`Plan ${planId} is ${actual}; this action requires it to be ${expected}.`);
    this.name = 'PlanNotInExpectedStatusError';
  }
}

/**
 * A PlanItem references (parentRef / a blockedByRef) an intra-plan temp-ref
 * that does not resolve to a materialized add in the same plan, or a real
 * work-item id that does not exist. Surfaced at materialize (approve). → 422
 */
export class UnresolvedPlanRefError extends Error {
  readonly code = 'UNRESOLVED_PLAN_REF' as const;
  constructor(ref: string) {
    super(`Plan reference "${ref}" could not be resolved to a work item.`);
    this.name = 'UnresolvedPlanRefError';
  }
}

/**
 * A modify/remove PlanItem whose target work item is missing (archived/deleted
 * out from under the plan after the proposal was appended). Surfaced at
 * materialize. → 422
 */
export class PlanItemTargetMissingError extends Error {
  readonly code = 'PLAN_ITEM_TARGET_MISSING' as const;
  constructor(workItemId: string) {
    super(`Plan item target work item ${workItemId} no longer exists.`);
    this.name = 'PlanItemTargetMissingError';
  }
}

/**
 * A proposal's `targetRepo` names a repository that is NOT in the PROJECT's
 * repository set (Story MOTIR-1775 · MOTIR-1884) — a typo, or a repo that belongs
 * to a sibling project of the same workspace.
 *
 * Why its own class rather than re-throwing `UnknownTargetRepoError`: a plan is a
 * SET of proposals, so "unknown repo X" is not actionable on its own — the
 * reviewer needs to know WHICH proposal carries it. The underlying message (which
 * names the project's known repositories, so the author can self-correct) is
 * carried through verbatim.
 *
 * → 422, the same status the identical mistake gets on the direct work-item write
 * path (`UnknownTargetRepoError` through the route layer's blanket
 * `WorkItemError` mapping) — a bad pin means the same thing however it arrived.
 * Raised BEFORE the approve transaction opens, so the tree and the plan's status
 * are untouched, exactly like the confirmation gate below.
 */
export class PlanItemUnknownTargetRepoError extends Error {
  readonly code = 'PLAN_ITEM_UNKNOWN_TARGET_REPO' as const;
  constructor(
    readonly planItemId: string,
    readonly repoName: string,
    message: string,
  ) {
    super(message);
    this.name = 'PlanItemUnknownTargetRepoError';
  }
}

/**
 * A proposal's `targetRepoRole` is not one of ADR §1.1's roles (Story MOTIR-1775 ·
 * MOTIR-1912) — `'backend'`, `''`, a number, anything the closed vocabulary does
 * not admit.
 *
 * A sibling of {@link PlanItemUnknownTargetRepoError}, and deliberately NOT the
 * same class: the two pins fail for different reasons and are fixed differently.
 * An unknown repo NAME is a fact about THIS project (its set does not hold that
 * repository); an unknown ROLE is a fact about the producer (it emitted a word
 * outside the enum the two repos share, `PROJECT_REPO_ROLES` ⟷ motir-ai's
 * proposal-schema role). Collapsing them would tell the author to check their
 * project's repositories for a mistake that is not there.
 *
 * Raised at BOTH boundaries a role can arrive through, so a bad value can never
 * reach the `targetRepoRole` column:
 *
 *   * `addProposals` — the append, where the PlanItem does not exist yet, so
 *     {@link planItemId} is `null` and {@link proposalLabel} identifies the
 *     offending proposal by its title (an `add`) or its target (a `modify`);
 *   * `approvePlan` — BEFORE the transaction opens, where the row exists and
 *     {@link planItemId} names it exactly. Cheap (the check is pure), and it is
 *     what makes "an unrecognised role materializes nothing" true even for a plan
 *     whose proposals were written before this validation shipped.
 *
 * → 422 at both, the same status a bad repo pin gets — a malformed pin means the
 * same thing however it arrived.
 */
export class PlanItemUnknownTargetRepoRoleError extends Error {
  readonly code = 'PLAN_ITEM_UNKNOWN_TARGET_REPO_ROLE' as const;
  constructor(
    /** The PlanItem's id, or `null` when it is not persisted yet (the append). */
    readonly planItemId: string | null,
    /** The offending proposal, as the author can recognise it. */
    readonly proposalLabel: string,
    /** The rejected value, stringified for a message (it may not be a string). */
    readonly role: string,
    message: string,
  ) {
    super(message);
    this.name = 'PlanItemUnknownTargetRepoRoleError';
  }
}

// ── The persist-time confirmation gate (Subtask 7.12.5 · MOTIR-911) ───────────
// The three rejections `validatePlanProposals` raises BEFORE approve writes
// anything. They are deliberately distinct from the errors above: those surface
// a proposal that went bad DURING materialize; these say the approved proposal
// set may not be persisted AT ALL, and are raised while the tree is still
// byte-identical.

/** Why a proposal set violates the kind-parent grammar. */
export type PlanGrammarViolation =
  /** The proposed (parent kind → child kind) pair the matrix forbids, or a
   *  top-level placement of a kind that requires a parent. */
  | 'illegal_parent'
  /** An `add` proposing a `kind` that is not one of the five issue types. */
  | 'unknown_kind';

/**
 * The proposal set does not satisfy the kind-parent grammar
 * (`lib/issues/parentRules.ts` — the SAME single-source matrix
 * `workItemsService` enforces), re-validated at persist independently of
 * whatever the planner self-checked. Raised BEFORE any write, so the tree and
 * the plan's status are untouched. → 400 (the proposal is malformed; the DB
 * trigger's raw SQLSTATE 23514 mid-transaction is exactly what this prevents).
 */
export class PlanGrammarError extends Error {
  readonly code = 'PLAN_GRAMMAR_VIOLATION' as const;
  constructor(
    readonly reason: PlanGrammarViolation,
    readonly planItemId: string,
    message: string,
  ) {
    super(message);
    this.name = 'PlanGrammarError';
  }
}

/** Why a plan's `parentRef` / `blockedByRefs` graph cannot be materialized. */
export type PlanRefGraphViolation =
  /** A ref resolving to neither a same-plan `add` nor an existing work item. */
  | 'dangling'
  /** The same blocker listed twice on one proposal (the `is_blocked_by` edge is
   *  `@@unique([fromId, toId, kind])`, so materializing it would 500). */
  | 'duplicate'
  /** A `parentRef` cycle among the plan's `add`s (no parent-before-child order
   *  exists), or a proposal blocking/parenting itself. */
  | 'cycle';

/**
 * The plan's intra-plan ref graph is not materializable — a dangling ref, a
 * duplicate blocker, or a cycle. Raised BEFORE any write. → 400
 */
export class PlanRefGraphError extends Error {
  readonly code = 'INVALID_PLAN_REF_GRAPH' as const;
  constructor(
    readonly reason: PlanRefGraphViolation,
    readonly planItemId: string,
    message: string,
  ) {
    super(message);
    this.name = 'PlanRefGraphError';
  }
}

/**
 * DONE-WORK IMMUTABILITY: a `modify` / `remove` proposal targets a work item in
 * a TERMINAL status (any `category = done` — resolved through
 * `workflowsService.getTerminalStatusKeys`, never a hardcoded `'done'`).
 * Completed work is not rewritten by an approve. Raised before any write, and
 * re-raised from the locked in-transaction re-read (the verdict taken from a
 * pre-transaction snapshot goes stale under a concurrent transition —
 * `notes.html` #35). → 409 (the target moved under the proposal).
 */
export class PlanTargetImmutableError extends Error {
  readonly code = 'PLAN_TARGET_IMMUTABLE' as const;
  constructor(
    readonly planItemId: string,
    readonly workItemId: string,
    readonly status: string,
  ) {
    super(
      `Work item ${workItemId} is in the terminal status "${status}" — completed work cannot be modified or removed by approving a plan.`,
    );
    this.name = 'PlanTargetImmutableError';
  }
}
