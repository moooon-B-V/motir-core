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
