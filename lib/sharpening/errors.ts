// Typed refusals of the Sharpen write-back door (Task MOTIR-1101 · Subtask
// MOTIR-8175). Kept in their own file so the route can import them without the
// Prisma client (the lib/<domain>/errors.ts convention). The service throws
// these; `app/api/internal/ai/plan-sharpening/route.ts` maps each `code` to a
// status.

/** The work item is in a `done`-category status (done, cancelled) — a
 *  finished card is not rewritten by a late answer. → 409 */
export class SharpeningTargetFinishedError extends Error {
  readonly code = 'SHARPENING_TARGET_FINISHED' as const;
  constructor(readonly workItemKey: string) {
    super(`${workItemKey} is finished; its acceptance and assumptions are no longer written.`);
    this.name = 'SharpeningTargetFinishedError';
  }
}

/** The plan has been decided (approved, declined) or has gone stale — it is no
 *  longer editable, so nothing is written to it. → 409 */
export class SharpeningPlanClosedError extends Error {
  readonly code = 'SHARPENING_PLAN_CLOSED' as const;
  constructor(
    readonly planId: string,
    readonly status: string,
  ) {
    super(`Plan ${planId} is ${status}; a sharpened requirement can no longer be written to it.`);
    this.name = 'SharpeningPlanClosedError';
  }
}

/** The write-back names something the door cannot write: a malformed work-item
 *  key, a `perItem` on work-item scope, or a `perItem` proposal that is not an
 *  `add` of this plan. → 422 */
export class SharpeningInputInvalidError extends Error {
  readonly code = 'SHARPENING_INPUT_INVALID' as const;
  constructor(message: string) {
    super(message);
    this.name = 'SharpeningInputInvalidError';
  }
}
