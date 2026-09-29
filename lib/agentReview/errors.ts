// The REVIEW RUN's own refusals (Story MOTIR-1626 · MOTIR-6821; ADR
// `docs/decisions/hosted-agent-run.md` §8.2 / §8.4, `approval-gates.md` §12.3 / §12.5).
//
// Raised by `agentReviewRunService` — the review prompt read and the verdict route —
// and mapped to v1 statuses by CODE in `lib/api/v1/errors.ts`'s `DOMAIN_ERROR_STATUS`.
// A refusal of the card BINDING (a review run's token naming another card) is not here:
// it is the shared `DISPATCH_RUN_TOKEN_OUT_OF_SCOPE`, raised by `runTokenScopeService`
// exactly as for every other run-token route.

/**
 * 403 — the caller is not a REVIEW run's own credential. Both review routes answer only
 * the token of a `command: review` run (`hosted-agent-run.md` §3's pointer): a person's
 * PAT, a CLI device token, and a BUILD run's token (`run`, `continue`, `fix`, …) are all
 * refused here, before anything about the card is read.
 */
export class ReviewRunTokenRequiredError extends Error {
  readonly code = 'REVIEW_RUN_TOKEN_REQUIRED';
  constructor() {
    super(
      'Only a hosted review run’s own credential may read the review prompt or submit a verdict.',
    );
    this.name = 'ReviewRunTokenRequiredError';
  }
}

/**
 * 404 — the card has no `agent_review` gate at all, so there is nothing to review and no
 * question a verdict could answer. A card with a withdrawn or decided review is NOT this:
 * that verdict is late ({@link ReviewStaleError}).
 */
export class ReviewGateNotFoundError extends Error {
  readonly code = 'REVIEW_GATE_NOT_FOUND';
  constructor(readonly workItemKey: string) {
    super(`${workItemKey} has no agent review to answer.`);
    this.name = 'ReviewGateNotFoundError';
  }
}

/**
 * 409 — this run has already submitted its ONE verdict (`hosted-agent-run.md` §8.4). The
 * first verdict the run submitted — accepted or recorded late — ends the question for the
 * run; a second is refused and recorded nowhere.
 */
export class ReviewVerdictAlreadySubmittedError extends Error {
  readonly code = 'REVIEW_VERDICT_ALREADY_SUBMITTED';
  constructor(readonly dispatchRunId: string) {
    super('This review run has already submitted its verdict.');
    this.name = 'ReviewVerdictAlreadySubmittedError';
  }
}

/** Why a verdict was LATE — what the gate had become by the time it arrived. */
export type ReviewStaleCause =
  /** The version the run names is not the gate's, or the set moved under it. */
  | 'stale_version'
  /** The review was withdrawn — a head move, a close, a red build, the switch (§12.5). */
  | 'superseded'
  /** The gate was already decided — a person continued without the review (§12.3). */
  | 'already_decided';

/**
 * 409 — a LATE verdict (`approval-gates.md` §12.5): a version that is not the gate's, a
 * gate already superseded, or one already decided. It was RECORDED on the run (a
 * `review_verdict` event naming the verdict and the version) and decided nothing.
 */
export class ReviewStaleError extends Error {
  readonly code = 'REVIEW_STALE';
  constructor(
    readonly staleCause: ReviewStaleCause,
    readonly subjectVersion: string,
  ) {
    super(
      staleCause === 'superseded'
        ? 'The review was withdrawn before this verdict arrived; it was recorded on the run and decided nothing.'
        : staleCause === 'already_decided'
          ? 'The review was already decided; this verdict was recorded on the run and decided nothing.'
          : 'This verdict is about a version the review is no longer asking about; it was recorded on the run and decided nothing.',
    );
    this.name = 'ReviewStaleError';
  }
}
