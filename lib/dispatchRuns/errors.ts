// Typed errors for the DISPATCH RUN domain (Story MOTIR-1789 · MOTIR-1792).
//
// Kept in their own file, like every other domain's, so route handlers and the
// v1 error map import them without pulling in the Prisma client. Each carries a
// stable string `code`; `lib/api/v1/errors.ts`'s `DOMAIN_ERROR_STATUS` owns the
// translation to a status, and `tests/api/v1/dispatch-runs-route.test.ts` drives
// the REAL error through the wrapper for each — an unproven row in that map is
// indistinguishable from a missing one, and a missing one is a silent 500.
//
// Status map (the v1 layer owns the translation):
//   DispatchRunNotFoundError        → 404  (also every cross-workspace read)
//   DispatchRunTerminalError        → 409
//   DuplicateDispatchRunError       → 409
//   UnknownDispatchRunCardError     → 422
//   DispatchRunEventBodyTooLargeError → 413
//   DispatchRunEventLimitError      → 422
//   DispatchRunNoTargetError        → 422
//   RunFoundReportReasonInvalidError → 422 (MCP only — `report_unbuildable_target`
//                                     has no `/api/v1` door, so no status row)

/**
 * 404 — no such run FOR THIS CALLER.
 *
 * ⚠️ A run in another workspace raises THIS, never a 403. RLS makes the read
 * return nothing, so the service cannot tell "does not exist" from "not yours"
 * even if it wanted to — which is the ADR §4 existence-oracle contract falling
 * out of the tenancy gate rather than being re-implemented on top of it.
 */
export class DispatchRunNotFoundError extends Error {
  readonly code = 'DISPATCH_RUN_NOT_FOUND';
  constructor(id: string) {
    super(`No dispatch run ${id}.`);
    this.name = 'DispatchRunNotFoundError';
  }
}

/**
 * 409 — the run is already closed, and this call would re-open or re-close it.
 *
 * Raised by BOTH the append and the close, from the same locked read, because
 * they are the same fact: a terminal run's history is finished. A 409 rather
 * than a 422: the request is well-formed and would have been accepted a moment
 * earlier, which is exactly what a conflict status means.
 */
export class DispatchRunTerminalError extends Error {
  readonly code = 'DISPATCH_RUN_TERMINAL';
  constructor(
    id: string,
    readonly status: string,
  ) {
    super(`Dispatch run ${id} is already ${status}; its history is closed.`);
    this.name = 'DispatchRunTerminalError';
  }
}

/**
 * 409 — two opens raced on one `idempotencyKey` and this one lost.
 *
 * ⚠️ IT EXISTS SO A `P2002` NEVER ESCAPES. The happy path for a REPEATED open is
 * not this error at all — it is the existing run, returned — and the read that
 * finds it runs first. This is the narrow window between that read and the
 * insert, where the unique index is the arbiter. The caller's remedy is to read
 * the run it already has, so the message says so.
 */
export class DuplicateDispatchRunError extends Error {
  readonly code = 'DUPLICATE_DISPATCH_RUN';
  constructor(idempotencyKey: string) {
    super(
      `A dispatch run with idempotency key '${idempotencyKey}' was opened concurrently. ` +
        'Read it rather than opening a second.',
    );
    this.name = 'DuplicateDispatchRunError';
  }
}

/**
 * 422 — an event names a work item that is not in this run's SET.
 *
 * A run's set is settled at open, deliberately, so an event for a card the run
 * does not own is a client bug rather than a card to add: silently creating a
 * leg here would let the set grow behind the plan the run published, and the
 * plan is the thing the record exists to hold.
 *
 * The one exception is `motir auto`, which discovers its set one card at a time
 * — it APPENDS legs through the open operation's own `cards` list on each
 * iteration rather than through an event.
 */
export class UnknownDispatchRunCardError extends Error {
  readonly code = 'UNKNOWN_DISPATCH_RUN_CARD';
  constructor(key: string) {
    super(`This run does not own ${key}; an event cannot add a card to a run's set.`);
    this.name = 'UnknownDispatchRunCardError';
  }
}

/**
 * 413 — one event's opt-in log body is over the cap.
 *
 * ⚠️ REFUSED, NOT TRUNCATED (ADR Q4). A silently shortened log is worse than an
 * absent one: it reads as the whole tail, and the line that mattered is the one
 * that was cut. The reporter's remedy is to split the body across events, which
 * is what the stream is for.
 */
export class DispatchRunEventBodyTooLargeError extends Error {
  readonly code = 'DISPATCH_RUN_BODY_TOO_LARGE';
  constructor(
    readonly limitBytes: number,
    readonly actualBytes: number,
  ) {
    super(
      `An event body of ${actualBytes} bytes exceeds the ${limitBytes}-byte limit. ` +
        'Split it across events rather than truncating it.',
    );
    this.name = 'DispatchRunEventBodyTooLargeError';
  }
}

/**
 * 422 — the run has reached its event ceiling.
 *
 * The ceiling is per RUN and is the bound that makes an opt-in log body safe to
 * accept at all: without it a chatty agent's stream is unbounded tenant storage.
 * The run stays OPEN and closable — refusing the close as well would leave a run
 * permanently `running`, which is the state the reap exists to eliminate.
 */
export class DispatchRunEventLimitError extends Error {
  readonly code = 'DISPATCH_RUN_EVENT_LIMIT';
  constructor(
    id: string,
    readonly limit: number,
  ) {
    super(
      `Dispatch run ${id} has reached its ${limit}-event limit; no further events are recorded. ` +
        'The run can still be closed.',
    );
    this.name = 'DispatchRunEventLimitError';
  }
}

/**
 * 422 — a close-out prompt was asked for a run with NO RUN TARGET (Story
 * MOTIR-4906 · MOTIR-5357): an unscoped batch, whose every card was its own
 * target and published in its own prompt. Refused rather than answered with a
 * plausible default target, which would write one run's How to test onto an item
 * the run was never launched against.
 */
export class DispatchRunNoTargetError extends Error {
  readonly code = 'NO_RUN_TARGET';
  constructor(id: string) {
    super(
      `Dispatch run ${id} was not launched against a work item, so it has no run target to ` +
        'write How to test onto — each of its cards is its own target.',
    );
    this.name = 'DispatchRunNoTargetError';
  }
}

/** The bounds of a run-found report's `reason`, after trimming. */
export const RUN_FOUND_REPORT_REASON_MAX = 4000;

/**
 * 422 — a run-found report's `reason` is empty or longer than
 * {@link RUN_FOUND_REPORT_REASON_MAX} characters once trimmed (Story MOTIR-5544 ·
 * MOTIR-6285, `runFoundReportService.reportUnbuildableTarget`).
 *
 * Refused, not truncated: the reason is the runner's verbatim account of why the
 * card could not be built, and a cut account reads as a whole one. Checked
 * BEFORE anything is resolved, so the refusal is the same for every target and
 * says nothing about the card, its run or its plan.
 */
export class RunFoundReportReasonInvalidError extends Error {
  readonly code = 'RUN_FOUND_REPORT_REASON_INVALID';
  constructor(readonly length: number) {
    super(
      `A run-found report's reason must be 1-${RUN_FOUND_REPORT_REASON_MAX} characters once ` +
        `trimmed; this one is ${length}. Send the same text as your comment on the card.`,
    );
    this.name = 'RunFoundReportReasonInvalidError';
  }
}

/**
 * 403 — a hosted run's own credential (MOTIR-688) reaching a DIFFERENT run's
 * ingest, or opening a run at all. A run token is bound to exactly one
 * `DispatchRun` (`ApiToken.dispatchRunId`) and may report to that run alone;
 * the server opens hosted runs itself, so it never opens one.
 *
 * ⚠️ CHECKED BEFORE THE RUN IS READ, so the answer is the same whether the run
 * it named exists, is closed, or lives in another workspace — the refusal says
 * nothing about any run but the token's own.
 */
export class DispatchRunTokenOutOfScopeError extends Error {
  readonly code = 'DISPATCH_RUN_TOKEN_OUT_OF_SCOPE';
  constructor() {
    super('This credential is bound to a different dispatch run.');
    this.name = 'DispatchRunTokenOutOfScopeError';
  }
}

/**
 * A run credential was asked for a run that is no longer `running` (MOTIR-688).
 * A credential minted for a closed run would be a live key to nothing — or, worse,
 * a live key that outlived the run's own end path, which is the only thing that
 * revokes it. Raised by `runCredentialService.mintRunCredential`, a server-side
 * call with no route of its own.
 */
export class RunCredentialRunNotLiveError extends Error {
  readonly code = 'RUN_CREDENTIAL_RUN_NOT_LIVE';
  constructor(
    readonly dispatchRunId: string,
    readonly status: string,
  ) {
    super(
      `Dispatch run ${dispatchRunId} is ${status}; a run credential is minted only for a running run.`,
    );
    this.name = 'RunCredentialRunNotLiveError';
  }
}

/**
 * A run credential was asked to live past its run's timeout (MOTIR-688,
 * `docs/decisions/hosted-agent-run.md` §5): nothing a run holds may outlive it by
 * more than the settle margin, and the expiry is the backstop when the end
 * path's revoke fails — so an expiry past that bound is refused, never clamped.
 */
export class RunCredentialExpiryTooLateError extends Error {
  readonly code = 'RUN_CREDENTIAL_EXPIRY_TOO_LATE';
  constructor(
    readonly requested: Date,
    readonly latest: Date,
  ) {
    super(
      `A run credential may expire no later than ${latest.toISOString()} (the run's timeout plus ` +
        `the settle margin); ${requested.toISOString()} was requested.`,
    );
    this.name = 'RunCredentialExpiryTooLateError';
  }
}
