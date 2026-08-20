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
  /**
   * The status the plan is ACTUALLY in, carried as DATA (MOTIR-3025).
   *
   * ⚠️ A CALLER HAS TO TELL TWO OF THESE APART and cannot do it from the
   * sentence. `generating` means *not yet — the planner is still writing*, and
   * `approved` / `declined` mean *someone already decided*. An unattended loop
   * should wait for the first and stop on the second, and parsing a message to
   * learn which is exactly what `public-api-conventions.md` §8 forbids. So it
   * rides the field, the same way `POST …/transitions` carries its allowed
   * targets rather than folding them into prose.
   */
  readonly actual: string;
  constructor(planId: string, actual: string, expected: string) {
    super(`Plan ${planId} is ${actual}; this action requires it to be ${expected}.`);
    this.name = 'PlanNotInExpectedStatusError';
    this.actual = actual;
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

/**
 * The op a plan may hold at most one of per existing target. `add` is absent
 * deliberately: an `add` has no target until materialize (its `workItemId` is
 * null), which is exactly why the unique index constrains real targets only.
 */
export type PlanTargetOp = 'modify' | 'remove';

/**
 * A second proposal in ONE plan targets a work item the plan already proposes
 * against (MOTIR-3194) — a second `modify`, or a `modify` alongside a `remove`.
 *
 * ## The rule, and why it is KEPT rather than relaxed
 *
 * `PlanItem @@unique([planId, workItemId])` is a decided rule, not an incidental
 * one — its schema comment says *"one op per target per plan"*, and NULLs being
 * distinct in Postgres is what still admits many `add`s in the same plan. This
 * card (MOTIR-3194) re-opened the question, because `materialize` walks
 * `for (const item of items)` and applies each `modify` in sequence, so nothing
 * DOWNSTREAM requires uniqueness. Three things upstream do:
 *
 *  1. **The review surface would show a wrong diff.** A PlanItem stores only the
 *     NEW values; the OLD side of every diff is read LIVE from the target. Two
 *     `modify` rows for one card therefore render as two independent diffs whose
 *     "from" is the same committed value — the second one silently omitting the
 *     first's changes. A person approves what they read, so a diff that cannot be
 *     rendered honestly is not a presentation problem.
 *  2. **`baseRevision` is per target, not per row.** It is the optimistic-concurrency
 *     anchor a `modify`/`remove` is computed against; two rows for one target carry
 *     two anchors with no defined precedence between them.
 *  3. **The constraint spans `modify` AND `remove`,** so relaxing it wholesale would
 *     admit a plan that patches a card and archives it in the same approval. A
 *     partial relaxation for `modify`+`modify` alone buys a caller nothing that
 *     merging the two patches does not already buy.
 *
 * And the caller loses nothing: two patches that would merge cleanly can simply BE
 * one patch, and a dependency edge between two work items that ALREADY exist never
 * needed a proposal at all (`link_work_items` writes it directly). The message says
 * both, because the mistake this replaces was an ORM string that said neither.
 *
 * → 409 (the plan already holds a proposal for that target), and the MCP surface's
 * `DUPLICATE_PLAN_TARGET`.
 */
export class DuplicatePlanTargetError extends Error {
  readonly code = 'DUPLICATE_PLAN_TARGET' as const;
  constructor(
    /** The target both proposals name. */
    readonly workItemId: string,
    /** The op the plan ALREADY holds for it. */
    readonly existingOp: PlanTargetOp,
    /** The op that was refused. */
    readonly op: PlanTargetOp,
  ) {
    super(
      `This plan already holds a \`${existingOp}\` proposal for work item ${workItemId}, and a ` +
        `plan holds at most ONE proposal per existing target — so this \`${op}\` is refused. ` +
        `Fold everything you want to change about ${workItemId} into that one proposal instead; ` +
        `or, if what you are recording is a dependency edge between two work items that ALREADY ` +
        `exist, call \`link_work_items\` — an edge between committed items needs no proposal at all.`,
    );
    this.name = 'DuplicatePlanTargetError';
  }
}

/**
 * An ORM failure escaping the plan-append boundary, CONTAINED (MOTIR-3194).
 *
 * ⚠️ THIS CLASS EXISTS SO THAT A PRISMA STRING CANNOT BE A PRODUCT SURFACE. The
 * defect it closes was not the duplicate-target rule above; it was that the rule
 * announced itself as
 * `Invalid \`prisma.planItem.create()\` invocation: Unique constraint failed on the
 * (not available)` — an ORM method name, no subject, and a constraint field that
 * renders as literally nothing. `toToolError` re-throws what it does not
 * recognise, so an unmapped ORM error reaches an agent as a JSON-RPC internal
 * error carrying that text verbatim.
 *
 * Naming the ONE duplicate case would have left every other Prisma failure on the
 * same path (a foreign key, a broken connection, a validation error) escaping the
 * same way. So the append wraps its whole transaction and converts ANY Prisma
 * error to this — a stable `code`, a message written for the caller, and the ORM's
 * own code carried as DATA rather than folded into prose.
 *
 * It is deliberately NOT actionable-sounding: reaching it means the write failed
 * for a reason the boundary does not model, and the honest thing to tell an agent
 * is that its proposals are not at fault and nothing was appended. The one code
 * worth a hint is `P2002`, which is the duplicate-target rule arriving through a
 * race the pre-check cannot see.
 *
 * → 500 (it IS a server-side failure — what changes is that it is typed).
 */
export class PlanPersistenceError extends Error {
  readonly code = 'PLAN_PERSISTENCE_FAILED' as const;
  constructor(
    /**
     * The boundary that failed, phrased so BOTH doors onto it can carry the same
     * string: the `add_plan_items` MCP tool and the internal generator seam
     * (`POST /api/internal/ai/plan-proposals`) both reach `addProposals`, and
     * naming either one would misdescribe the other's caller.
     */
    readonly operation: string,
    /** The ORM's own error code (`P2002`, …) when it had one, else null. */
    readonly ormCode: string | null,
  ) {
    super(
      `The database refused the ${operation}` +
        (ormCode ? ` (${ormCode})` : '') +
        `. Nothing was appended and the plan is unchanged.` +
        (ormCode === 'P2002'
          ? ' A uniqueness constraint fired: a plan holds at most one `modify`/`remove` proposal' +
            ' per target work item, so append one proposal per target.'
          : ''),
    );
    this.name = 'PlanPersistenceError';
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

/**
 * There is no plan for this work item to approve (MOTIR-3021 / MOTIR-3023,
 * `docs/decisions/run-findings-protocol.md` Q2 bound B1). → 422
 *
 * ⚠️ THIS IS THE BOUND, and it is what keeps the public approval entrance from
 * being "approve any pending plan in the workspace". An unattended loop may
 * approve the plan its own refused card CAUSED, and nothing else — every other
 * plan (a cadence plan, an onboarding generation, one submitted from the
 * project-wide panel) keeps the human gate it was written under.
 *
 * A plan belongs to a card when the plan-change conversation ANCHORED at that
 * card submitted the job the plan was produced by. No such conversation, or one
 * that has never submitted, means there is nothing here for an automated
 * approval to act on — refused, deliberately, rather than read as
 * unanchored-so-allowed.
 */
export class NoPlanForWorkItemError extends Error {
  readonly code = 'NO_PLAN_FOR_WORK_ITEM' as const;
  constructor(readonly workItemKey: string) {
    super(
      `No submitted plan is anchored to ${workItemKey}. Automatic approval acts only on the plan a run's own refused card produced; approve any other plan in Motir.`,
    );
    this.name = 'NoPlanForWorkItemError';
  }
}
