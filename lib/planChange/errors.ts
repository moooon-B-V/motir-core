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

/**
 * A turn id that does not name a turn ON THIS THREAD (MOTIR-1818) — the read a
 * CORRECTION makes before it re-runs a turn under the other intent. Also what a
 * turn id from another tenant becomes: the lookup is scoped by session AND
 * workspace, so a foreign id is simply absent. → 404, the no-existence-leak
 * posture the rest of this file takes.
 */
export class PlanChangeTurnNotFoundError extends Error {
  readonly code = 'PLAN_CHANGE_TURN_NOT_FOUND' as const;
  constructor(turnId: string) {
    super(`No turn ${turnId} on this plan-change conversation.`);
    this.name = 'PlanChangeTurnNotFoundError';
  }
}

// ── The BOUNDARY MAILBOX (Story MOTIR-4054 · MOTIR-4067) ────────────────────

/**
 * A turn was addressed to a planning job that is no longer RUNNING — it
 * succeeded, failed or was cancelled before the turn arrived. → 409: a state
 * conflict, and the one the card names outright, because the alternative is
 * worse than an error. A mailbox nobody will ever check accepts the turn, hands
 * the user a delivered-looking message, and then changes nothing for ever; the
 * refusal is what lets the composer say so.
 *
 * It NAMES the status, deliberately. "That run is over" leaves the client
 * guessing whether to resubmit as a new turn (succeeded / stopped) or to surface
 * a failure (failed), and those are opposite next steps.
 */
export class PlanChangeJobNotRunningError extends Error {
  readonly code = 'PLAN_CHANGE_JOB_NOT_RUNNING' as const;
  constructor(
    readonly jobId: string,
    readonly status: string,
  ) {
    super(
      `Planning job ${jobId} is ${status}, not running — there is no boundary left for this turn to be read at.`,
    );
    this.name = 'PlanChangeJobNotRunningError';
  }
}

/**
 * A turn was addressed to a job that is not the one THIS thread is running. →
 * 404, the no-existence-leak posture the rest of this file takes: from the
 * caller's side the job simply is not on their conversation.
 *
 * The check is not ceremony. `job_id` is an opaque motir-ai token and the
 * mailbox is keyed by `(session, job)`, so without it a caller who learned any
 * job id could attach a turn under their OWN session addressed at somebody
 * else's run — invisible to them, and read by nobody, but a row that exists.
 * Binding the turn to the thread's own `last_job_id` is what makes the address
 * derivable rather than asserted.
 */
export class PlanChangeMailboxJobMismatchError extends Error {
  readonly code = 'PLAN_CHANGE_MAILBOX_JOB_MISMATCH' as const;
  constructor(readonly jobId: string) {
    super(`Job ${jobId} is not the run this plan-change conversation is on.`);
    this.name = 'PlanChangeMailboxJobMismatchError';
  }
}
