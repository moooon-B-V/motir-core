// Typed errors of the Visitor's consent (Story MOTIR-6170 · MOTIR-6666).

/**
 * A person who can ENTER the project asked to consent as its Visitor. They belong
 * in their own view and have nothing to agree to, so nothing is written.
 */
export class VisitorConsentNotApplicableError extends Error {
  readonly code = 'VISITOR_CONSENT_NOT_APPLICABLE' as const;
  constructor(identifier: string) {
    super(`A member of ${identifier} does not consent as its Visitor.`);
    this.name = 'VisitorConsentNotApplicableError';
  }
}

// The three refusals of a VISITOR-ONLY read — one addressed by the public
// project's identifier and served to nobody else (MOTIR-6768, the pending
// requests of Requested features). A data door that ALSO serves members falls
// back to the member answer instead (`lib/visitor/readActor.ts`); this one has
// no member answer, so it names why the reader was not served. The not-found
// verdict is the ordinary `ProjectNotFoundError`, so a private project stays
// indistinguishable from a missing one.

/** A public project, and no session: the reader signs in first. */
export class VisitorSignInRequiredError extends Error {
  readonly code = 'VISITOR_SIGN_IN_REQUIRED' as const;
  constructor(readonly identifier: string) {
    super(`Sign in to read ${identifier}.`);
    this.name = 'VisitorSignInRequiredError';
  }
}

/** Signed in, unable to enter, and not yet consented: the consent screen first. */
export class VisitorConsentRequiredError extends Error {
  readonly code = 'VISITOR_CONSENT_REQUIRED' as const;
  constructor(readonly identifier: string) {
    super(`Consent to be seen by ${identifier}'s Managers before reading it.`);
    this.name = 'VisitorConsentRequiredError';
  }
}

/**
 * The reader can ENTER the project: they read its requests in their own
 * Triage inbox (`/triage`), not as its Visitor.
 */
export class VisitorEntersProjectError extends Error {
  readonly code = 'VISITOR_ENTERS_PROJECT' as const;
  constructor(readonly identifier: string) {
    super(`A member of ${identifier} reads it in their own view.`);
    this.name = 'VisitorEntersProjectError';
  }
}
