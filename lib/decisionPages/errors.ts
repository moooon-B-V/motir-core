// The DECISION-PAGE publish refusals (Story MOTIR-5761 · MOTIR-7432;
// `docs/decisions/approval-gates.md` §8 NINTH AMENDMENT, clause 1). Each is
// named, each leaves nothing written: the publish runs in one transaction and
// every check precedes its first write.

export abstract class DecisionPageError extends Error {
  abstract readonly code: string;
  /** HTTP status the route should return. */
  abstract readonly status: number;
}

/** The card is not a `decision` card, so it has no decision to publish. */
export class NotADecisionCardError extends DecisionPageError {
  readonly code = 'NOT_A_DECISION_CARD' as const;
  readonly status = 422 as const;
  constructor(readonly identifier: string) {
    super(`${identifier} is not a decision card, so a page cannot be published as its decision.`);
    this.name = 'NotADecisionCardError';
  }
}

/**
 * No such page — or one the caller cannot read under `page:view`. ONE answer for
 * both, so the publish door never confirms a page exists.
 */
export class DecisionPageNotFoundError extends DecisionPageError {
  readonly code = 'PAGE_NOT_FOUND' as const;
  readonly status = 404 as const;
  constructor(readonly pageId: string) {
    super('Page not found.');
    this.name = 'DecisionPageNotFoundError';
  }
}

/** The page is readable, but filed in another project than the card. */
export class DecisionPageInAnotherProjectError extends DecisionPageError {
  readonly code = 'PAGE_IN_ANOTHER_PROJECT' as const;
  readonly status = 422 as const;
  constructor(
    readonly pageId: string,
    readonly identifier: string,
  ) {
    super(
      `That page belongs to another project than ${identifier}. A decision page must be filed in ` +
        "the card's own project.",
    );
    this.name = 'DecisionPageInAnotherProjectError';
  }
}

/** The page's body is blank, so there is nothing for a person to approve. */
export class DecisionPageEmptyError extends DecisionPageError {
  readonly code = 'PAGE_IS_EMPTY' as const;
  readonly status = 422 as const;
  constructor(readonly pageId: string) {
    super('That page is empty. Write the decision on the page, then publish it.');
    this.name = 'DecisionPageEmptyError';
  }
}

/** The page is archived, so it is read-only and cannot become a decision. */
export class DecisionPageArchivedError extends DecisionPageError {
  readonly code = 'PAGE_ARCHIVED' as const;
  readonly status = 409 as const;
  constructor(readonly pageId: string) {
    super('That page is archived. Restore it before publishing it as a decision.');
    this.name = 'DecisionPageArchivedError';
  }
}

/** The card is in its project's done category: its decision is settled. */
export class DecisionCardFinishedError extends DecisionPageError {
  readonly code = 'CARD_IS_FINISHED' as const;
  readonly status = 409 as const;
  constructor(
    readonly identifier: string,
    readonly statusKey: string,
  ) {
    super(
      `${identifier} is ${statusKey}, so its decision is settled and it takes no new page. ` +
        'Reopen the card by hand to publish again.',
    );
    this.name = 'DecisionCardFinishedError';
  }
}
