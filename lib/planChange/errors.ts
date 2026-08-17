// Typed errors for the plan-change conversation (Story 7.30 · MOTIR-1728). Kept
// in their own file so route handlers can import them without pulling in the
// Prisma client (the lib/<domain>/errors.ts convention). The service throws
// these; the route layer translates the stable `code` to an HTTP status.

/** The project has no plan-change conversation yet (a read/append/submit against
 *  a thread that was never opened). → 404 */
export class PlanChangeSessionNotFoundError extends Error {
  readonly code = 'PLAN_CHANGE_SESSION_NOT_FOUND' as const;
  constructor(projectId: string) {
    super(`No plan-change conversation exists for project ${projectId}.`);
    this.name = 'PlanChangeSessionNotFoundError';
  }
}

/**
 * A concurrent append claimed the same position on the thread. Turn order is
 * allocated under the session row's `SELECT … FOR UPDATE` lock with a re-read
 * inside the transaction, so two concurrent appends normally SERIALIZE into two
 * ordered turns; this error is what the `(session_id, seq)` unique backstop
 * becomes when that ordering is nonetheless lost (a desynced `turn_count`, a
 * writer that bypassed the lock). The point is that a raw Prisma `P2002` never
 * escapes the service — the caller gets a typed, retryable conflict. → 409
 */
export class PlanChangeTurnConflictError extends Error {
  readonly code = 'PLAN_CHANGE_TURN_CONFLICT' as const;
  constructor(sessionId: string, seq: number) {
    super(
      `Turn ${seq} on plan-change conversation ${sessionId} was claimed by a concurrent append; retry.`,
    );
    this.name = 'PlanChangeTurnConflictError';
  }
}

/** Submit was called on a thread with no `user` turns to submit — there is no
 *  intent to send (an empty conversation, or one holding only system markers).
 *  → 409: a state conflict, not a malformed request. */
export class EmptyPlanChangeIntentError extends Error {
  readonly code = 'PLAN_CHANGE_EMPTY_INTENT' as const;
  constructor(sessionId: string) {
    super(
      `Plan-change conversation ${sessionId} has no turns to submit — add what you want changed first.`,
    );
    this.name = 'EmptyPlanChangeIntentError';
  }
}

/**
 * A contextual planning turn named more anchors than one thread may carry
 * (7.12.3 · MOTIR-909). The scope is pushed to motir-ai as the UNION of every
 * anchor's neighborhood, so the bound is a real resource limit, not a style
 * preference — see `MAX_SCOPE_TARGETS`. → 400: the request is malformed, and no
 * retry of the same body will succeed.
 */
export class TooManyPlanChangeTargetsError extends Error {
  readonly code = 'PLAN_CHANGE_TOO_MANY_TARGETS' as const;
  constructor(count: number, max: number) {
    super(`A planning conversation can be anchored at at most ${max} work items (got ${count}).`);
    this.name = 'TooManyPlanChangeTargetsError';
  }
}

/**
 * Another planning session already holds one of this scope's targets (Story
 * MOTIR-2786 · MOTIR-2787). → 409: a state conflict, and a retryable one — the
 * body was fine, the item is simply taken.
 *
 * It NAMES the item and the holder, deliberately. "Planning is locked" with no
 * subject is an error a user cannot act on: with a scope of up to
 * `MAX_SCOPE_TARGETS` anchors they do not know WHICH of their targets is taken,
 * and with no holder they do not know whom to ask or whether to wait. The holder
 * name is nullable because the holding user may since have been deleted, and a
 * lease outliving its owner is exactly the case the expiry sweep exists for.
 */
export class PlanTargetLockedError extends Error {
  readonly code = 'PLAN_TARGET_LOCKED' as const;
  constructor(
    readonly targetIdentifier: string,
    readonly holderName: string | null,
    readonly expiresAt: Date,
  ) {
    super(
      `${targetIdentifier} is being planned by ${holderName ?? 'another session'} right now. ` +
        `The hold releases when that session finishes, or by ${expiresAt.toISOString()} at the latest.`,
    );
    this.name = 'PlanTargetLockedError';
  }
}

/** The turn body was empty / blank. → 400 */
export class EmptyPlanChangeTurnError extends Error {
  readonly code = 'PLAN_CHANGE_EMPTY_TURN' as const;
  constructor() {
    super('A plan-change turn cannot be empty.');
    this.name = 'EmptyPlanChangeTurnError';
  }
}
