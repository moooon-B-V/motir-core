// Typed errors for the triage ACTIONS service (Story 6.11 · Subtask 6.11.5).
// The route layer maps each `code` to an HTTP status. The queue READ's
// `InvalidTriageCursorError` lives in `triageQueue.ts` (6.11.3); these are the
// action-side failures (accept / promote / decline / mark-duplicate / snooze).
//
// A triage item that the actor can't see, or a cross-workspace / missing id,
// is a `WorkItemNotFoundError` (from `lib/workItems/errors`) → 404, never one of
// these — these all assume an already-resolved, visible item whose triage
// STATE or the action's own ARGUMENT is what's wrong.

/**
 * The action targets an item that is not in triage (`triagedAt IS NULL`) — it
 * has already graduated to the planned tree (or was never a submission). A
 * triage action on it is a conflict with current state, not a missing item, so
 * the route maps this to 409. Promotion is the one thing that clears the
 * marker; once cleared, the triage verbs no longer apply.
 */
export class NotInTriageError extends Error {
  readonly code = 'NOT_IN_TRIAGE' as const;
  constructor(workItemId: string) {
    super(`Work item ${workItemId} is not in the triage queue.`);
    this.name = 'NotInTriageError';
  }
}

/**
 * Mark-duplicate / merge was asked to fold an item into ITSELF (the canonical
 * id equals the duplicate id). The link grammar's DB trigger also forbids a
 * self-link, but we reject it up front with a clear 422 rather than surfacing a
 * raw trigger violation.
 */
export class TriageSelfMergeError extends Error {
  readonly code = 'TRIAGE_SELF_MERGE' as const;
  constructor(workItemId: string) {
    super(`Cannot mark work item ${workItemId} as a duplicate of itself.`);
    this.name = 'TriageSelfMergeError';
  }
}

/**
 * Snooze was given a `snoozedUntil` that is not a valid future ISO-8601
 * instant (unparseable, or at/​before now). Snoozing into the past would leave
 * the item immediately back in the active queue, defeating the action — so the
 * route maps this to 422.
 */
export class InvalidSnoozeUntilError extends Error {
  readonly code = 'INVALID_SNOOZE_UNTIL' as const;
  constructor() {
    super('`snoozedUntil` must be a valid ISO-8601 instant in the future.');
    this.name = 'InvalidSnoozeUntilError';
  }
}
