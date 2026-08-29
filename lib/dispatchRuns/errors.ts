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
