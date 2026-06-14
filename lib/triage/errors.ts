// Typed errors for the triage ACTIONS service (Story 6.11 · Subtask 6.11.5) and
// the triage INTAKE path (Subtask 6.11.4 — at the bottom of this file).
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

// ─── Triage INTAKE (Subtask 6.11.4) ─────────────────────────────────────────
// The WRITE-path (submission intake) validation errors, distinct from the
// action errors above. The intake route (`mapTriageSubmissionError`) maps these.

/** The longest a triage submission title may be (mirrors the create modal's
 *  `MAX_TITLE_LENGTH`). A submission IS a `work_item`, so it shares the issue
 *  title bound rather than inventing a separate one. */
export const MAX_TRIAGE_TITLE_LENGTH = 200;

/**
 * The submission `kind` was not one of the two request-grammar kinds. A triage
 * submission is born a `bug` (a bug report) or a `task` (a feature request) —
 * ADR §1; an epic/story/subtask is never a submission. The route maps this to
 * 422 (a well-formed request whose body fails a domain rule).
 */
export class InvalidTriageSubmissionKindError extends Error {
  readonly code = 'INVALID_TRIAGE_SUBMISSION_KIND' as const;
  constructor() {
    super('A triage submission must be a bug report or a feature request.');
    this.name = 'InvalidTriageSubmissionKindError';
  }
}

/**
 * The submission title was blank or over the length bound. The route maps this
 * to 422. (Empty and too-long share one error — the inbox UI / 6.11.7 widget
 * gate both client-side; this is the server backstop.)
 */
export class InvalidTriageSubmissionTitleError extends Error {
  readonly code = 'INVALID_TRIAGE_SUBMISSION_TITLE' as const;
  constructor(reason: 'empty' | 'too_long') {
    super(
      reason === 'empty'
        ? 'A triage submission title is required.'
        : `A triage submission title must be at most ${MAX_TRIAGE_TITLE_LENGTH} characters.`,
    );
    this.name = 'InvalidTriageSubmissionTitleError';
  }
}
